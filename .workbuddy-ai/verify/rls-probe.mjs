/**
 * Proves the application role is least-privilege under RLS.
 *
 * Every probe runs in its own transaction that is always rolled back, so the
 * live database is never changed — including the probes that succeed.
 *
 *   node .workbuddy-ai/verify/rls-probe.mjs
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

const client = new Client({ connectionString: env.DATABASE_URL });
await client.connect();

const probe = async (label, sql) => {
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("ROLLBACK");
    console.log(`ALLOWED   ${label}`);
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* the connection is gone; the next probe will say so */
    }
    console.log(`DENIED    ${label} -> ${error.code ?? ""} ${error.message.split("\n")[0]}`);
  }
};

const role = (
  await client.query(
    "select current_user u, (select rolsuper from pg_roles where rolname = current_user) super, (select rolbypassrls from pg_roles where rolname = current_user) bypass"
  )
).rows[0];
console.log("role:", JSON.stringify(role));

await probe("select guilds", "select 1 from guilds limit 1");
await probe("insert + delete preference", "insert into user_preferences (discord_user_id) values ('rls-probe') on conflict do nothing; delete from user_preferences where discord_user_id = 'rls-probe'");
await probe("update audit_trail", "update audit_trail set severity = 'info' where false");
await probe("delete audit_trail", "delete from audit_trail where false");
await probe("truncate audit_trail", "truncate audit_trail");
await probe("create table", "create table rls_probe_should_fail (id int)");
await probe("alter table", "alter table guilds add column rls_probe int");
await probe("read server file", "select pg_read_file('/etc/passwd')");
await probe("delete a guild (RLS allows, FK cascade applies)", "delete from guilds where id = 'rls-probe-never-exists'");

await client.end();
