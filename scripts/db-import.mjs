#!/usr/bin/env node
/**
 * Restore or migrate a snapshot written by `scripts/db-export.mjs`.
 *
 * This is the other half of the portable backup: it reads the gzipped JSON
 * Lines snapshot and inserts every row through `jsonb_populate_record`, which
 * lets PostgreSQL coerce each JSON value into the column's real type. The same
 * file therefore restores into the embedded database or migrates into Supabase,
 * Neon, a VPS — anything speaking the PostgreSQL wire protocol.
 *
 * Safety: everything runs in ONE transaction. A failure rolls the whole import
 * back, so a half-written database is never left behind. `--fresh` truncates
 * first (all tables at once, CASCADE); without it the insert is
 * `ON CONFLICT DO NOTHING`, so re-running an import is idempotent.
 *
 * Usage:
 *   DATABASE_URL=postgres://… node scripts/db-import.mjs <snapshot.json.gz> [--fresh] [--schema]
 *
 * The schema is applied automatically when the target has no tables yet, or
 * when `--schema` is passed (idempotent: infra/schema.sql uses IF NOT EXISTS).
 */
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith("--"));
const FRESH = args.includes("--fresh");
const FORCE_SCHEMA = args.includes("--schema");

if (!file) {
  console.error("usage: DATABASE_URL=… node scripts/db-import.mjs <snapshot.json.gz> [--fresh] [--schema]");
  process.exit(2);
}
if (!process.env.DATABASE_URL) {
  console.error("db:import needs DATABASE_URL pointing at the TARGET database.");
  process.exit(2);
}

/**
 * Verify the snapshot against its `.sha256` sidecar before touching the target.
 *
 * A gzip that decompresses is not necessarily the snapshot you meant: an older
 * dump, or one written to a nearly-full disk, still parses and would silently
 * restore stale or partial data over good data. The sidecar is what turns "it
 * imported" into "it is the file that was taken". Snapshots made before the
 * sidecar existed still import, with a warning.
 */
async function verifySidecar(path) {
  const sidecar = `${path}.sha256`;
  if (!existsSync(sidecar)) {
    console.warn("[db:import] no .sha256 sidecar — importing without an integrity check");
    return;
  }
  const expected = readFileSync(sidecar, "utf8").trim().split(/\s+/)[0].toLowerCase();
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  const actual = hash.digest("hex");
  if (actual !== expected) {
    throw new Error(
      `snapshot checksum mismatch: sidecar says ${expected.slice(0, 16)}…, file hashes to ${actual.slice(0, 16)}…`
    );
  }
  console.log(`[db:import] checksum ok (sha256 ${actual.slice(0, 16)}…)`);
}

try {
  await verifySidecar(file);
} catch (error) {
  // Refuse before connecting: a mismatch must never reach a live database.
  console.error(`[db:import] ${error.message}`);
  process.exit(1);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

try {
  const { rows: existing } = await client.query(
    `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'`
  );
  if (FORCE_SCHEMA || existing[0].n === 0) {
    console.log("[db:import] applying infra/schema.sql");
    await client.query(readFileSync(join(ROOT, "infra/schema.sql"), "utf8"));
  }

  await client.query("BEGIN");

  // Collect the meta line first so --fresh can truncate exactly the tables the
  // snapshot contains, in one statement.
  const lines = createInterface({ input: createReadStream(file).pipe(createGunzip()), crlfDelay: Infinity });
  let meta = null;
  const buffered = [];
  for await (const line of lines) {
    if (!line.trim()) continue;
    const obj = JSON.parse(line);
    if (obj.type === "meta") meta = obj;
    else buffered.push(obj);
  }
  if (!meta) throw new Error("snapshot has no meta line");

  if (FRESH) {
    // An append-only table refuses TRUNCATE by design — `infra/schema.sql`
    // installs a `BEFORE TRUNCATE … FOR EACH STATEMENT` trigger on
    // `audit_trail`, because a row-level trigger never fires for TRUNCATE and
    // would leave the guarantee cosmetic. A restore must not erase history to
    // make its own life easier: those tables are skipped here, and the inserts
    // below stay `ON CONFLICT DO NOTHING`, so history is added to, never
    // rewritten. Without this the whole import aborted on the first snapshot
    // that contained audit rows.
    const { rows: guarded } = await client.query(`
      SELECT c.relname AS tbl
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND NOT t.tgisinternal AND (t.tgtype & 32) <> 0
    `);
    const frozen = new Set(guarded.map(r => r.tbl));
    const list = meta.tables.filter(t => !frozen.has(t)).map(t => `"${t}"`).join(", ");
    if (list) await client.query(`TRUNCATE ${list} CASCADE`);
    if (frozen.size) {
      console.log(
        `[db:import] append-only, left intact: ${[...frozen].join(", ")} (rows are added, never rewritten)`
      );
    }
  }

  let inserted = 0;
  for (const part of buffered) {
    if (part.type !== "rows" || part.rows.length === 0) continue;
    // One statement per chunk: unnest the JSON array and coerce each element
    // into the table's row type. The record is expanded in the select list
    // (`(…).*`), not in a second FROM — `SELECT * FROM f(...) FROM g(...)` is a
    // syntax error, which is what this used to be: the import never inserted a
    // single row and only reported the failure after the truncate.
    // ON CONFLICT DO NOTHING makes a re-run safe.
    await client.query(
      `INSERT INTO "${part.table}"
         SELECT (jsonb_populate_record(NULL::"${part.table}", r)).*
         FROM jsonb_array_elements($1::jsonb) AS r
       ON CONFLICT DO NOTHING`,
      [JSON.stringify(part.rows)]
    );
    inserted += part.rows.length;
  }

  const seqPart = buffered.find(p => p.type === "sequences");
  if (seqPart?.values) {
    const { rows: present } = await client.query(
      `SELECT sequencename FROM pg_sequences WHERE schemaname='public'`
    );
    const have = new Set(present.map(r => r.sequencename));
    for (const [name, value] of Object.entries(seqPart.values)) {
      if (value == null || !have.has(name)) continue;
      await client.query(`SELECT setval($1::regclass, $2::bigint, true)`, [`public."${name}"`, value]);
    }
  }

  await client.query("COMMIT");
  console.log(`[db:import] restored ${inserted} rows across ${meta.tables.length} tables${FRESH ? " (fresh)" : ""}`);
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  console.error(`[db:import] failed, rolled back: ${error.message}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
