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
 * Memory: the snapshot is **streamed twice**, never buffered whole. The first
 * pass reads the `meta` line (it is always first) and stops; the second streams
 * the rows and inserts each chunk as it arrives, in slices of
 * `AL_AI_IMPORT_BATCH` rows (default 500). Peak memory is therefore one
 * decompressed chunk plus one insert parameter, not the size of the dump — a
 * 2 GB snapshot restores in the same 256 MB container as a 2 KB one. The file
 * is read twice on purpose: `--fresh` must truncate before the first insert,
 * and the table list lives in `meta`.
 *
 * Safety: everything runs in ONE transaction. A failure rolls the whole import
 * back, so a half-written database is never left behind. `--fresh` truncates
 * first (all tables at once, CASCADE, except append-only ones); without it the
 * insert is `ON CONFLICT DO NOTHING`, so re-running an import is idempotent.
 *
 * Usage:
 *   DATABASE_URL=postgres://… node scripts/db-import.mjs <snapshot.json.gz> [--fresh] [--schema] [--verbose]
 *
 * The schema is applied automatically when the target has no tables yet, or
 * when `--schema` is passed (idempotent: infra/schema.sql uses IF NOT EXISTS).
 */
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createGunzip } from "node:zlib";
import { StringDecoder } from "node:string_decoder";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith("--"));
const FRESH = args.includes("--fresh");
const FORCE_SCHEMA = args.includes("--schema");
const VERBOSE = args.includes("--verbose");
// Rows per INSERT statement. The exporter writes 2 000-row chunks; splitting
// them again bounds both the JSON parameter we build and the temporary heap
// jsonb_populate_record allocates on the server.
const BATCH = Math.max(1, Number(process.env.AL_AI_IMPORT_BATCH || 500));

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

/**
 * Walk the snapshot line by line with **pull-based** backpressure.
 *
 * `createInterface` over a piped stream is not enough: readline consumes in
 * flowing mode and queues decoded lines while the consumer waits on a database
 * round-trip, so a 64 MB dump still ended in "JavaScript heap out of memory"
 * under a 64 MB cap. Iterating the gunzip stream directly means the next chunk
 * is only pulled once the previous line has been handled, so peak memory is one
 * compressed chunk plus one line. `StringDecoder` keeps multi-byte UTF-8 (the
 * Arabic rows) intact across chunk boundaries.
 *
 * The handler may return `false` to stop early.
 */
async function forEachLine(path, handler) {
  const src = createReadStream(path);
  const gunzip = src.pipe(createGunzip());
  const decoder = new StringDecoder("utf8");
  let carry = "";
  let stopped = false;
  try {
    for await (const chunk of gunzip) {
      carry += decoder.write(chunk);
      let idx;
      while ((idx = carry.indexOf("\n")) !== -1) {
        const line = carry.slice(0, idx);
        carry = carry.slice(idx + 1);
        if (line.trim() && (await handler(line)) === false) {
          stopped = true;
          break;
        }
      }
      if (stopped) break;
    }
    if (!stopped) {
      carry += decoder.end();
      if (carry.trim()) await handler(carry);
    }
  } finally {
    gunzip.destroy();
    src.destroy();
  }
}

/** The `meta` line is written first by the exporter, so this pass reads one line. */
async function readMeta(path) {
  let meta = null;
  await forEachLine(path, line => {
    const obj = JSON.parse(line);
    if (obj.type !== "meta") return false; // not a db:export snapshot
    meta = obj;
    return false;
  });
  return meta;
}

try {
  await verifySidecar(file);
} catch (error) {
  // Refuse before connecting: a mismatch must never reach a live database.
  console.error(`[db:import] ${error.message}`);
  process.exit(1);
}

const meta = await readMeta(file);
if (!meta) {
  console.error("[db:import] snapshot has no meta line — not a db:export snapshot.");
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

  /**
   * One statement per slice: unnest the JSON array and coerce each element into
   * the table's row type. The record is expanded in the select list (`(…).*`),
   * not in a second FROM — `SELECT * FROM f(...) FROM g(...)` is a syntax error,
   * which is what this used to be: the import never inserted a single row.
   * ON CONFLICT DO NOTHING makes a re-run safe.
   */
  const insertRows = async (table, rows) => {
    for (let i = 0; i < rows.length; i += BATCH) {
      await client.query(
        `INSERT INTO "${table}"
           SELECT (jsonb_populate_record(NULL::"${table}", r)).*
           FROM jsonb_array_elements($1::jsonb) AS r
         ON CONFLICT DO NOTHING`,
        [JSON.stringify(rows.slice(i, i + BATCH))]
      );
    }
  };

  // Second pass: stream the rows and insert as they arrive. Nothing here holds
  // more than one decompressed chunk.
  let inserted = 0;
  const sequences = {};
  await forEachLine(file, async line => {
    const part = JSON.parse(line);
    if (part.type === "rows") {
      if (!part.rows?.length) return;
      await insertRows(part.table, part.rows);
      inserted += part.rows.length;
      if (VERBOSE) console.log(`  ${part.table}: ${part.rows.length}`);
    } else if (part.type === "sequences" && part.values) {
      Object.assign(sequences, part.values);
    }
  });

  if (Object.keys(sequences).length) {
    const { rows: present } = await client.query(
      `SELECT sequencename FROM pg_sequences WHERE schemaname='public'`
    );
    const have = new Set(present.map(r => r.sequencename));
    for (const [name, value] of Object.entries(sequences)) {
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
