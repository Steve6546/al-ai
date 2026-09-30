/**
 * One-shot database backup.
 *
 * The audit flagged that the only durable copy of the data was the live data
 * directory — a disk loss would have taken the guilds, the warnings and the
 * append-only audit trail with it. This script writes a timestamped
 * custom-format dump (pg_dump -Fc, restorable with pg_restore) into
 * `.workbuddy-ai/backups/`, keeps the newest N, and prints where it landed.
 *
 * Usage: node --env-file=.env scripts/backup-db.mjs [keepCount=10]
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("backup-db: DATABASE_URL is not set (run with --env-file=.env)");
  process.exit(1);
}

// The installed PostgreSQL bin dir first, then whatever is on PATH.
const CANDIDATES = [
  "C:\\Program Files\\PostgreSQL\\17\\bin\\pg_dump.exe",
  "pg_dump"
];
let pgDump = null;
for (const candidate of CANDIDATES) {
  const probe = spawnSyncSafe(candidate, ["--version"]);
  if (probe) {
    pgDump = candidate;
    break;
  }
}
if (!pgDump) {
  console.error("backup-db: pg_dump not found (install PostgreSQL client tools)");
  process.exit(1);
}

function spawnSyncSafe(cmd, args) {
  const result = spawnSync(cmd, args, { stdio: "ignore" });
  return result.error ? null : result;
}

import { spawnSync } from "node:child_process";

const outDir = join(process.cwd(), ".workbuddy-ai", "backups");
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outFile = join(outDir, `db-${stamp}.dump`);

// -Fc: custom format, compressed, restorable selectively. -w: never prompt —
// a prompt in an unattended backup is a silent hang.
await run(pgDump, ["-Fc", "-w", "-f", outFile, databaseUrl], { timeout: 120_000 });

const keep = Number(process.argv[2] ?? 10);
const dumps = readdirSync(outDir)
  .filter(name => name.startsWith("db-") && name.endsWith(".dump"))
  .sort()
  .reverse();
for (const stale of dumps.slice(keep)) {
  unlinkSync(join(outDir, stale));
}

const size = statSync(outFile).size;
console.log(`backup-db: wrote ${outFile} (${(size / 1024).toFixed(0)} KB); keeping ${Math.min(keep, dumps.length)} newest`);
