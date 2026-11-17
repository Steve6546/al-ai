import test, { after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createPool } from "../server/db.js";

/**
 * Row-level security is a schema guarantee, so it is asserted against the schema
 * and — when a database is reachable — against the catalog it produced.
 *
 * The failure this guards against is quiet: RLS is per-table, so a new table
 * added without `ENABLE ROW LEVEL SECURITY` (or without a policy after it is
 * enabled) is simply world-readable to every role that holds a grant, and
 * nothing in the application notices. The live half also proves the promise the
 * security report makes: the application role cannot rewrite the audit trail
 * even though it holds INSERT/SELECT on it.
 *
 * The live half skips cleanly without a database, the same way `storage.test.ts`
 * does, so `npm test` stays usable on a machine with no PostgreSQL.
 */

const schema = readFileSync(resolve(import.meta.dirname, "../../../infra/schema.sql"), "utf8");

const declaredTables = [...schema.matchAll(/CREATE TABLE IF NOT EXISTS\s+([a-z_][a-z0-9_]*)/gi)].map(match => match[1]);

test("the schema declares the feature tables the RLS pass must cover", () => {
  // A guard that matches nothing would pass every assertion below forever.
  assert.ok(declaredTables.length >= 25, `expected the feature tables, saw ${declaredTables.length}`);
  assert.ok(declaredTables.includes("audit_trail"), "audit_trail is the table the append-only policy names");
});

test("the schema enables RLS for every table it creates, not a hand-picked list", () => {
  // A per-table list goes stale the first time a table is added. The schema
  // loops over `pg_tables`, which is what makes "every table" true by
  // construction rather than by review.
  assert.match(schema, /ALTER TABLE public\.%I ENABLE ROW LEVEL SECURITY/);
  assert.match(schema, /FOR t IN\s*\r?\n\s*SELECT tablename FROM pg_tables WHERE schemaname = 'public'/);
});

test("the application role is created least-privilege and cannot bypass RLS", () => {
  assert.match(schema, /CREATE ROLE %I[^']*NOSUPERUSER[^']*NOBYPASSRLS/);
  assert.match(schema, /REVOKE UPDATE, DELETE ON public\.audit_trail FROM %I/);
  assert.match(schema, /GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I/);
  assert.match(schema, /GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES[\s\S]*GRANT USAGE, SELECT ON ALL SEQUENCES/);
});

const envFile = resolve(import.meta.dirname, "../../../.env");
if (!process.env.DATABASE_URL && existsSync(envFile)) {
  try {
    process.loadEnvFile(envFile);
  } catch {
    /* a malformed .env is not this test's subject */
  }
}

const pool = process.env.DATABASE_URL ? createPool(process.env.DATABASE_URL!) : null;

let reachable = false;
if (pool) {
  try {
    await pool.query("select 1");
    reachable = true;
  } catch {
    reachable = false;
  }
}
const skip = reachable ? false : "no reachable database at DATABASE_URL";

test("every table in public has RLS enabled and at least one policy", { skip }, async () => {
  const { rows } = await pool!.query(
    `select c.relname,
            c.relrowsecurity as rls,
            (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
      order by c.relname`
  );
  assert.ok(rows.length > 0, "expected the feature tables to exist");
  const unprotected = rows.filter(row => !row.rls).map(row => row.relname);
  const policyless = rows.filter(row => row.rls && row.policies === 0).map(row => row.relname);
  assert.deepEqual(unprotected, [], `RLS is off for: ${unprotected.join(", ")}`);
  assert.deepEqual(policyless, [], `RLS is on but no policy allows the app to use: ${policyless.join(", ")}`);
});

test("the audit trail grants no rewrite path to the application role", { skip }, async () => {
  const { rows } = await pool!.query(
    `select pol.polname, pol.polcmd
       from pg_policy pol
       join pg_class c on c.oid = pol.polrelid
      where c.relname = 'audit_trail'`
  );
  const commands = rows.map(row => row.polcmd).sort();
  assert.ok(!commands.includes("w"), "an UPDATE policy on audit_trail would reopen the append-only hole");
  assert.ok(!commands.includes("d"), "a DELETE policy on audit_trail would reopen the append-only hole");
  assert.ok(commands.includes("r"), "the panel reads the trail");
  assert.ok(commands.includes("a"), "the panel appends to the trail");
});

// Registered last on purpose: an `after` hook declared before the async tests
// are registered ran while they were still pending and closed the pool under
// them ("Cannot use a pool after calling end").
after(async () => {
  await pool?.end().catch(() => {});
});
