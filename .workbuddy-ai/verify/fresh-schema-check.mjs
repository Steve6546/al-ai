/**
 * Applies infra/schema.sql to a throwaway database created from nothing.
 *
 * This is the only check that catches the ordering trap: a migration that runs
 * cleanly against an existing database can still be wrong, because the existing
 * one already has the columns the new statements are supposed to add.
 *
 *   node .workbuddy-ai/verify/fresh-schema-check.mjs
 */

import { Client } from "pg";
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(".env", "utf8")
    .split(/\r?\n/)
    .filter(line => line && !line.startsWith("#") && line.includes("="))
    .map(line => {
      const at = line.indexOf("=");
      return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
    })
);

const PROBE = "al_ai_probe";

const admin = new Client({ connectionString: env.DATABASE_URL });
await admin.connect();
const live = (await admin.query("select current_database() as name")).rows[0].name;

// Dropping the live database would be the worst possible outcome of a check.
if (PROBE === live) throw new Error("the probe name collides with the live database");

await admin.query(`DROP DATABASE IF EXISTS ${PROBE}`);
await admin.query(`CREATE DATABASE ${PROBE}`);

const url = new URL(env.DATABASE_URL);
url.pathname = `/${PROBE}`;
const probe = new Client({ connectionString: url.toString() });
await probe.connect();

try {
  await probe.query(readFileSync("infra/schema.sql", "utf8"));

  const columns = await probe.query(
    `select column_name, data_type, is_nullable, column_default
       from information_schema.columns
      where table_name = 'guild_command_flags'
      order by ordinal_position`
  );

  console.log(`fresh database "${PROBE}" created and migrated from zero\n`);
  console.log("guild_command_flags columns, in table order:");
  for (const row of columns.rows) {
    const defaultText = row.column_default === null ? "—" : row.column_default;
    console.log(`  ${row.column_name.padEnd(28)} ${row.data_type.padEnd(26)} null=${row.is_nullable.padEnd(3)} default=${defaultText}`);
  }

  const expected = {
    muted_role_id: { type: "text", nullable: "YES", def: null },
    prison_role_id: { type: "text", nullable: "YES", def: null },
    prison_channel_id: { type: "text", nullable: "YES", def: null },
    blacklist_role_ids: { type: "jsonb", nullable: "NO", def: "'[]'::jsonb" },
    admin_role_ids_to_strip: { type: "jsonb", nullable: "NO", def: "'[]'::jsonb" },
    blockable_role_ids: { type: "jsonb", nullable: "NO", def: "'[]'::jsonb" },
    aliases: { type: "jsonb", nullable: "NO", def: "'[]'::jsonb" },
    delete_response_on_leave: { type: "boolean", nullable: "NO", def: "false" },
    allowed_role_ids: { type: "jsonb", nullable: "NO", def: "'[]'::jsonb" }
  };

  const findings = [];
  const byName = new Map(columns.rows.map(row => [row.column_name, row]));
  for (const [name, want] of Object.entries(expected)) {
    const got = byName.get(name);
    const ok = got && got.data_type === want.type && got.is_nullable === want.nullable && got.column_default === want.def;
    findings.push({ label: `${name} is ${want.type} null=${want.nullable} default=${want.def}`, ok, got: got ? `${got.data_type} null=${got.is_nullable} default=${got.column_default}` : "MISSING" });
  }

  // The rename guard must have produced allowed_role_ids, not custom_role_ids:
  // on a fresh database the CREATE TABLE declares the new name, and the guard
  // must recognise that and skip rather than rename.
  findings.push({
    label: "custom_role_ids is absent on a fresh database",
    ok: !byName.has("custom_role_ids"),
    got: byName.has("custom_role_ids") ? "present" : "absent"
  });

  // Ordering: the new columns must land after the rename guard, so they must
  // appear after allowed_role_ids in the table.
  const order = columns.rows.map(row => row.column_name);
  findings.push({
    label: "the new columns come after allowed_role_ids (the rename guard ran first)",
    ok: order.indexOf("muted_role_id") > order.indexOf("allowed_role_ids"),
    got: `allowed_role_ids@${order.indexOf("allowed_role_ids")} muted_role_id@${order.indexOf("muted_role_id")}`
  });

  const failed = findings.filter(finding => !finding.ok);
  console.log("");
  for (const finding of findings) console.log(`${finding.ok ? "PASS" : "FAIL"}  ${finding.label}  →  ${finding.got}`);
  console.log(`\n${findings.length - failed.length}/${findings.length} checks passed`);

  process.exitCode = failed.length ? 1 : 0;
} finally {
  await probe.end();
  await admin.query(`DROP DATABASE IF EXISTS ${PROBE}`);
  await admin.end();
}
