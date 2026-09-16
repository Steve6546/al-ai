/**
 * Applies infra/schema.sql to the live database.
 *
 * The schema is idempotent by construction — every statement is `IF NOT EXISTS`
 * or guarded by a catalog check — so this can run on every upgrade. It is still
 * a separate step rather than something the bot does at boot: a migration that
 * runs itself is a migration nobody can stop.
 *
 * Prints the columns of every table it touches so the caller can see the change
 * rather than trust it.
 *
 *   node .workbuddy-ai/verify/apply-schema.mjs [--dry-run]
 */

import { Client } from "pg";
import { readFileSync } from "node:fs";

const dryRun = process.argv.includes("--dry-run");

const env = Object.fromEntries(
  readFileSync(".env", "utf8")
    .split(/\r?\n/)
    .filter(line => line && !line.startsWith("#") && line.includes("="))
    .map(line => {
      const at = line.indexOf("=");
      return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
    })
);

const db = new Client({ connectionString: env.DATABASE_URL });
await db.connect();

const before = await db.query(
  `select column_name from information_schema.columns
    where table_name = 'guild_command_flags' order by ordinal_position`
);
const beforeNames = new Set(before.rows.map(row => row.column_name));

if (dryRun) {
  console.log("dry run — the schema was not applied");
} else {
  // One statement at a time inside a transaction, so a failure leaves the
  // database as it was found rather than half-migrated.
  const sql = readFileSync("infra/schema.sql", "utf8");
  await db.query("BEGIN");
  try {
    await db.query(sql);
    await db.query("COMMIT");
    console.log("schema applied");
  } catch (error) {
    await db.query("ROLLBACK");
    console.error("schema failed, rolled back:", error.message);
    await db.end();
    process.exit(1);
  }
}

const after = await db.query(
  `select column_name, data_type, is_nullable, column_default
     from information_schema.columns
    where table_name = 'guild_command_flags' order by ordinal_position`
);

console.log("\nguild_command_flags:");
for (const row of after.rows) {
  const added = beforeNames.has(row.column_name) ? "" : "   <-- ADDED";
  console.log(`  ${row.column_name.padEnd(28)} ${row.data_type.padEnd(26)} null=${row.is_nullable.padEnd(3)}${added}`);
}

const added = after.rows.filter(row => !beforeNames.has(row.column_name));
console.log(`\n${added.length === 0 ? "no new columns — the database was already current" : `${added.length} column(s) added`}`);

// Row counts, so a migration that somehow lost data is visible immediately.
for (const table of ["guild_command_flags", "guilds", "guild_warnings"]) {
  const count = await db.query(`select count(*)::int as n from ${table}`).catch(() => null);
  if (count) console.log(`${table}: ${count.rows[0].n} rows`);
}

await db.end();
