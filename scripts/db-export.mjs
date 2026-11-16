#!/usr/bin/env node
/**
 * Portable logical backup — no `pg_dump` required.
 *
 * Why this exists: the embedded PostgreSQL on a one-slot host
 * (`scripts/host/pg.mjs`) is tuned with `fsync=off` for the 256 MB cgroup, so
 * the data directory alone is **not crash-safe**, and the embedded build ships
 * no `pg_dump` binary. This tool reads every table through the ordinary `pg`
 * wire protocol and writes a self-describing, gzip-compressed, SHA-256
 * checksummed snapshot that `db-import.mjs` can restore into *any* PostgreSQL
 * (the same embedded one, Supabase, Neon, a VPS…).
 *
 * Format: JSON Lines, gzipped. First a `meta` line (tables in foreign-key-safe
 * order), then `rows` chunks (bounded, so a large table never has to fit in
 * memory on a 256 MB box), then a `sequences` line. Every value round-trips
 * through `jsonb_populate_record` on import, which coerces JSON to each
 * column's real type (jsonb, uuid, timestamptz, numeric) exactly.
 *
 * Usage:
 *   node scripts/db-export.mjs [--quiet]
 *   DATABASE_URL=… node scripts/db-export.mjs
 *
 * Env: AL_AI_BACKUP_DIR (default .al-ai-host/backups), AL_AI_BACKUP_KEEP (5).
 */
import { createWriteStream, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import pg from "pg";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.AL_AI_BACKUP_DIR || join(ROOT, ".al-ai-host", "backups");
const KEEP = Number(process.env.AL_AI_BACKUP_KEEP || 5);
const QUIET = process.argv.includes("--quiet");
const CHUNK = 2_000;

function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  // The embedded bootstrapper mints/stores the password and prints the URL
  // without starting a server (`--print-url` returns before any spawn).
  const out = execFileSync(process.execPath, [join(ROOT, "scripts/host/pg.mjs"), "--print-url"], { encoding: "utf8" });
  return out.trim();
}

/** Parents before children, so inserts never violate a foreign key. */
function topoSort(names, fks) {
  const set = new Set(names);
  const children = new Map(names.map(n => [n, new Set()]));
  const indeg = new Map(names.map(n => [n, 0]));
  for (const { child, parent } of fks) {
    if (!set.has(child) || !set.has(parent) || child === parent) continue;
    if (!children.get(parent).has(child)) {
      children.get(parent).add(child);
      indeg.set(child, indeg.get(child) + 1);
    }
  }
  const queue = names.filter(n => indeg.get(n) === 0);
  const out = [];
  while (queue.length) {
    const n = queue.shift();
    out.push(n);
    for (const c of children.get(n)) {
      indeg.set(c, indeg.get(c) - 1);
      if (indeg.get(c) === 0) queue.push(c);
    }
  }
  for (const n of names) if (!out.includes(n)) out.push(n); // FK cycle fallback
  return out;
}

async function main() {
  const url = databaseUrl();
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const { rows: tables } = await client.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'`
    );
    const names = tables.map(r => r.table_name).sort();
    const { rows: fks } = await client.query(`
      SELECT tc.table_name AS child, ccu.table_name AS parent
      FROM information_schema.table_constraints tc
      JOIN information_schema.constraint_column_usage ccu
        ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'`);
    const order = topoSort(names, fks);

    mkdirSync(OUT_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const file = join(OUT_DIR, `db-${stamp}.json.gz`);
    const hash = createHash("sha256");
    const gz = createGzip({ level: 9 });
    gz.on("data", chunk => hash.update(chunk));
    const done = pipeline(gz, createWriteStream(file));

    const write = obj =>
      new Promise(res => {
        const ok = gz.write(JSON.stringify(obj) + "\n");
        if (ok) res();
        else gz.once("drain", res);
      });

    await write({ type: "meta", version: 1, createdAt: new Date().toISOString(), tables: order });

    let rowCount = 0;
    for (const table of order) {
      let offset = 0;
      for (;;) {
        // ctid gives a stable page order inside this transaction without
        // assuming a primary key, and LIMIT/OFFSET bounds peak memory.
        const { rows } = await client.query(
          `SELECT row_to_json(t) AS row FROM "${table}" t ORDER BY t.ctid LIMIT $1 OFFSET $2`,
          [CHUNK, offset]
        );
        if (rows.length === 0) break;
        await write({ type: "rows", table, rows: rows.map(r => r.row) });
        rowCount += rows.length;
        offset += rows.length;
        if (rows.length < CHUNK) break;
      }
    }

    const { rows: seqs } = await client.query(
      `SELECT sequencename AS name, last_value FROM pg_sequences WHERE schemaname='public'`
    );
    await write({ type: "sequences", values: Object.fromEntries(seqs.map(s => [s.name, s.last_value])) });

    gz.end();
    await done;
    const sha = hash.digest("hex");
    const size = statSync(file).size;

    // Keep only the newest KEEP snapshots.
    const dumps = readdirSync(OUT_DIR).filter(n => /^db-.*\.json\.gz$/.test(n)).sort().reverse();
    for (const stale of dumps.slice(KEEP)) unlinkSync(join(OUT_DIR, stale));

    if (!QUIET) {
      console.log(
        `db:export ${file} — ${(size / 1024).toFixed(0)} KB, ${rowCount} rows, ${order.length} tables, sha256 ${sha.slice(0, 16)}…`
      );
    }
  } finally {
    await client.end();
  }
}

main().catch(error => {
  if (!QUIET) console.error(`db:export failed: ${error.message}`);
  process.exit(1);
});
