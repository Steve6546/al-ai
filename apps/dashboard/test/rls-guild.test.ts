import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { createDatabase, createPool } from "../server/db.js";
import { runAsSession } from "../server/db-scope.js";

/**
 * Multi-tenant isolation, proved against a real PostgreSQL as `al_ai_app`.
 *
 * Every statement here goes through the application role and the same
 * transaction-scoped identity a request uses (`SET LOCAL al_ai.session_id`).
 * No administrative connection is used to make an assertion pass: an owner
 * connection would bypass the very policies under test.
 */
const envFile = resolve(import.meta.dirname, "../../../.env");
if (!process.env.DATABASE_URL && existsSync(envFile)) {
  process.loadEnvFile(envFile);
}
const url = process.env.DATABASE_URL;
const skip = url ? false : "DATABASE_URL is not set";

const accountA = `rls-a-${randomUUID()}`;
const accountB = `rls-b-${randomUUID()}`;
const guildA = `71${Math.floor(Math.random() * 1e15)}`;
const guildB = `72${Math.floor(Math.random() * 1e15)}`;
const sessionA = randomUUID();
const sessionB = randomUUID();

let pool: pg.Pool;
let expiredPool: pg.Pool;

async function as(sessionId: string | null, text: string, values: unknown[] = []) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('al_ai.session_id', $1, true)", [sessionId ?? ""]);
    const result = await client.query(text, values);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function count(sessionId: string | null, table: string, guildId: string) {
  const { rows } = await as(sessionId, `SELECT count(*)::int AS n FROM ${table} WHERE guild_id = $1`, [guildId]);
  return rows[0].n as number;
}

before(async () => {
  if (!url) return;
  pool = new pg.Pool({ connectionString: url, max: 3 });
  expiredPool = new pg.Pool({ connectionString: url, max: 1 });
  // Two accounts, each with a live session and its own guild. The sessions are
  // created through the application role's policies, not from an owner login.
  for (const [sessionId, account] of [
    [sessionA, accountA],
    [sessionB, accountB]
  ]) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('al_ai.actor', $1, true)", [account]);
      await client.query(
        `INSERT INTO oauth_sessions (id, discord_user_id, discord_username, access_token_ciphertext, scopes, expires_at, second_factor_satisfied)
         VALUES ($1, $2, 'rls-fixture', 'fixture-ciphertext', 'identify', now() + interval '2 hours', true)`,
        [sessionId, account]
      );
      await client.query("COMMIT");
      await client.query("BEGIN");
      await client.query("SELECT set_config('al_ai.session_id', $1, true)", [sessionId]);
      await client.query(
        `INSERT INTO guild_acl (guild_id, discord_user_id, tier) VALUES ($1, $2, 'owner')`,
        [sessionId === sessionA ? guildA : guildB, account]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    // The guild row itself is created through the same guard path production
    // uses: the access row exists first, then the metadata.
    await as(sessionId, `INSERT INTO guilds (id, name, icon_url, member_count, bot_present) VALUES ($1, $2, NULL, 0, true)`, [
      sessionId === sessionA ? guildA : guildB,
      sessionId === sessionA ? "A" : "B"
    ]);
  }
  // Rows in four shapes: a text-keyed table, a flag row, a settings row, and an
  // append-only audit row. Each must be invisible to the other guild.
  await as(sessionA, `INSERT INTO guild_command_flags (guild_id, command) VALUES ($1, 'ban')`, [guildA]);
  await as(sessionA, `INSERT INTO guild_levels (guild_id) VALUES ($1)`, [guildA]);
  await as(sessionA, `INSERT INTO guild_welcome (guild_id) VALUES ($1)`, [guildA]);
  await as(sessionA, `INSERT INTO guild_role_tiers (guild_id) VALUES ($1)`, [guildA]);
  await as(sessionB, `INSERT INTO guild_command_flags (guild_id, command) VALUES ($1, 'ban')`, [guildB]);
  await as(sessionB, `INSERT INTO guild_levels (guild_id) VALUES ($1)`, [guildB]);
  await as(sessionB, `INSERT INTO guild_welcome (guild_id) VALUES ($1)`, [guildB]);
  await as(sessionB, `INSERT INTO guild_role_tiers (guild_id) VALUES ($1)`, [guildB]);
  for (const [sessionId, guildId] of [
    [sessionA, guildA],
    [sessionB, guildB]
  ]) {
    await as(
      sessionId,
      `INSERT INTO audit_trail (id, guild_id, severity, event_id, correlation_id, actor_hash, source_layer, payload_ciphertext)
       VALUES (gen_random_uuid(), $1, 'info', 'rls.probe', 'c', 'h', 'dashboard', 'x')`,
      [guildId]
    );
  }
});

after(async () => {
  if (!url) return;
  for (const [sessionId, guildId] of [
    [sessionA, guildA],
    [sessionB, guildB]
  ]) {
    // The trail is append-only by trigger, so it cannot be cleaned up here; the
    // ids are random per run and carry no data.
    await as(sessionId, `DELETE FROM guilds WHERE id = $1`, [guildId]).catch(() => undefined);
  }
  await as(null, `DELETE FROM guild_acl WHERE discord_user_id = ANY($1::text[])`, [[accountA, accountB]]).catch(() => undefined);
  await as(accountA, `DELETE FROM oauth_sessions WHERE discord_user_id = ANY($1::text[])`, [[accountA, accountB]]).catch(async () => {
    // Sessions are only deletable by their own identity, so remove them one at a
    // time under the account that owns each row.
    for (const account of [accountA, accountB]) {
      await as(account, `DELETE FROM oauth_sessions WHERE discord_user_id = $1`, [account]).catch(() => undefined);
    }
  });
  await pool.end().catch(() => undefined);
  await expiredPool.end().catch(() => undefined);
});

test("every table with a guild_id is protected by the access list", { skip }, async () => {
  const { rows } = await as(null, `
    SELECT t.tablename,
           c.relrowsecurity AS rls,
           (SELECT string_agg(p.qual, ' | ') FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = t.tablename AND p.roles = '{al_ai_app}') AS qual,
           EXISTS (SELECT 1 FROM information_schema.columns col
                    WHERE col.table_schema = 'public' AND col.table_name = t.tablename AND col.column_name = 'guild_id') AS guild_scoped
      FROM pg_tables t JOIN pg_class c ON c.relname = t.tablename AND c.relnamespace = 'public'::regnamespace
     WHERE t.schemaname = 'public'
     ORDER BY t.tablename`);
  assert.ok(rows.length >= 29, `expected the full schema, saw ${rows.length} tables`);
  for (const row of rows) {
    assert.equal(row.rls, true, `${row.tablename} must have row level security enabled`);
    if (row.guild_scoped && row.tablename === "guild_acl") {
      // The access list cannot be scoped by itself; it is scoped by account.
      assert.match(String(row.qual), /al_ai_session_user/, "guild_acl must scope rows by the session's account");
      continue;
    }
    if (row.guild_scoped) {
      assert.match(String(row.qual), /al_ai_can_access_guild/, `${row.tablename} must scope rows by the caller's guilds`);
    }
  }
  const leaked = rows.filter(row => row.qual === "true" && row.guild_scoped);
  assert.equal(leaked.length, 0, `permissive policy on ${leaked.map(row => row.tablename).join(", ")}`);
});

test("account A reads its own guild and none of account B's rows", { skip }, async () => {
  for (const table of ["guilds", "guild_command_flags", "guild_levels", "guild_welcome", "guild_role_tiers", "audit_trail"]) {
    const key = table === "guilds" ? "id" : "guild_id";
    const own = await as(sessionA, `SELECT count(*)::int AS n FROM ${table} WHERE ${key} = $1`, [guildA]);
    const other = await as(sessionA, `SELECT count(*)::int AS n FROM ${table} WHERE ${key} = $1`, [guildB]);
    assert.equal(own.rows[0].n, 1, `${table}: the owner of the guild must see its row`);
    assert.equal(other.rows[0].n, 0, `${table}: another guild's row must be invisible`);
  }
  // And the same in the other direction, so the result is not an artefact of
  // which guild the fixture happened to write first.
  for (const table of ["guilds", "guild_command_flags", "audit_trail"]) {
    const key = table === "guilds" ? "id" : "guild_id";
    const seen = await as(sessionB, `SELECT count(*)::int AS n FROM ${table} WHERE ${key} = $1`, [guildA]);
    assert.equal(seen.rows[0].n, 0, `${table}: B must not see A's guild`);
  }
});

test("a statement with no identity sees no guild row at all", { skip }, async () => {
  for (const table of ["guilds", "guild_command_flags", "guild_levels", "guild_welcome", "guild_role_tiers", "audit_trail"]) {
    const key = table === "guilds" ? "id" : "guild_id";
    const { rows } = await as(null, `SELECT count(*)::int AS n FROM ${table} WHERE ${key} = ANY($1::text[])`, [[guildA, guildB]]);
    assert.equal(rows[0].n, 0, `${table}: no identity must mean no rows`);
  }
});

test("an expired session is not an identity", { skip }, async () => {
  const expired = randomUUID();
  const account = `rls-expired-${randomUUID()}`;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('al_ai.actor', $1, true)", [account]);
    await client.query(
      `INSERT INTO oauth_sessions (id, discord_user_id, discord_username, access_token_ciphertext, scopes, expires_at)
       VALUES ($1, $2, 'expired', 'x', 'identify', now() - interval '1 minute')`,
      [expired, account]
    );
    await client.query("COMMIT");
  } finally {
    client.release();
  }
  try {
    const { rows } = await as(expired, `SELECT count(*)::int AS n FROM guilds WHERE id = $1`, [guildA]);
    assert.equal(rows[0].n, 0, "an expired session resolves to nobody");
  } finally {
    await as(account, `DELETE FROM oauth_sessions WHERE id = $1`, [expired]).catch(() => undefined);
  }
});

test("A cannot write into B's guild: insert, update, delete and a moved row", { skip }, async () => {
  await assert.rejects(
    () => as(sessionA, `INSERT INTO guild_command_flags (guild_id, command) VALUES ($1, 'kick')`, [guildB]),
    (error: { code?: string }) => error.code === "42501",
    "an INSERT into another guild must be refused by WITH CHECK"
  );
  const update = await as(sessionA, `UPDATE guild_command_flags SET enabled = false WHERE guild_id = $1`, [guildB]);
  assert.equal(update.rowCount, 0, "an UPDATE must match no rows in another guild");
  const remove = await as(sessionA, `DELETE FROM guild_command_flags WHERE guild_id = $1`, [guildB]);
  assert.equal(remove.rowCount, 0, "a DELETE must match no rows in another guild");
  // Moving a row out of the caller's guild is the same class of attack as
  // inserting one there: `WITH CHECK` runs on the new row, so it fails.
  await assert.rejects(
    () => as(sessionA, `UPDATE guild_command_flags SET guild_id = $1 WHERE guild_id = $2`, [guildB, guildA]),
    (error: { code?: string }) => error.code === "42501",
    "a row cannot be moved into a guild the caller does not hold"
  );
  const stillThere = await count(sessionB, "guild_command_flags", guildB);
  assert.equal(stillThere, 1, "B's row survived every attempt");
});

test("the access list itself is per account", { skip }, async () => {
  const own = await as(sessionA, `SELECT count(*)::int AS n FROM guild_acl WHERE discord_user_id = $1`, [accountA]);
  const other = await as(sessionA, `SELECT count(*)::int AS n FROM guild_acl WHERE discord_user_id = $1`, [accountB]);
  assert.equal(own.rows[0].n, 1);
  assert.equal(other.rows[0].n, 0, "an account cannot enumerate who else has access");
  // An account cannot write access for somebody else. Whether *this* account
  // may be granted a guild is decided by the route guard after Discord answered;
  // the database's guarantee is narrower and is stated as such: a statement acts
  // under one session, every row it can see belongs to that session's list, and
  // no query can see across that line.
  await assert.rejects(
    () => as(sessionA, `INSERT INTO guild_acl (guild_id, discord_user_id, tier) VALUES ($1, $2, 'owner')`, [guildA, accountB]),
    (error: { code?: string }) => error.code === "42501"
  );
  const untouched = await as(sessionB, `SELECT count(*)::int AS n FROM guild_acl WHERE discord_user_id = $1 AND guild_id = $2`, [accountB, guildA]);
  assert.equal(untouched.rows[0].n, 0, "the refused row does not exist");
});

test("a reused connection cannot carry one identity into the next statement", { skip }, async () => {
  // One connection, two statements, two identities. If the wrapper leaked the
  // first identity, the second read would see the first account's guild.
  const single = new pg.Pool({ connectionString: url, max: 1 });
  try {
    const read = async (sessionId: string, guildId: string) => {
      const client = await single.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('al_ai.session_id', $1, true)", [sessionId]);
        const { rows } = await client.query(`SELECT count(*)::int AS n FROM guilds WHERE id = $1`, [guildId]);
        await client.query("COMMIT");
        return rows[0].n as number;
      } finally {
        client.release();
      }
    };
    assert.equal(await read(sessionA, guildA), 1);
    assert.equal(await read(sessionB, guildA), 0, "B must not inherit A's identity");
    assert.equal(await read(sessionA, guildB), 0, "A must not inherit B's identity");
    assert.equal(await read(sessionB, guildB), 1);
  } finally {
    await single.end().catch(() => undefined);
  }
});

test("a failed transaction leaves no access row behind", { skip }, async () => {
  const account = `rls-rollback-${randomUUID()}`;
  const sessionId = randomUUID();
  const owner = await pool.connect();
  try {
    await owner.query("BEGIN");
    await owner.query("SELECT set_config('al_ai.actor', $1, true)", [account]);
    await owner.query(`INSERT INTO oauth_sessions (id, discord_user_id, discord_username, access_token_ciphertext, scopes, expires_at)
      VALUES ($1, $2, 'rollback', 'x', 'identify', now() + interval '1 hour')`, [sessionId, account]);
    await owner.query("COMMIT");
  } finally {
    owner.release();
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('al_ai.session_id', $1, true)", [sessionId]);
    await client.query(`INSERT INTO guild_acl (guild_id, discord_user_id, tier) VALUES ($1, $2, 'owner')`, [guildA, account]);
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
  const { rows } = await as(sessionId, `SELECT count(*)::int AS n FROM guild_acl WHERE discord_user_id = $1`, [account]);
  assert.equal(rows[0].n, 0, "a rolled back grant must not exist");
  await as(sessionId, `DELETE FROM oauth_sessions WHERE id = $1`, [sessionId]).catch(() => undefined);
});

test("the storage facade reads only what the request identity may see", { skip }, async () => {
  // The facade is what routes call; the same identity must reach its queries.
  const facade = createDatabase(createPool(url!));
  try {
    const seenByA = await runAsSession(sessionA, () => facade.getGuild(guildB));
    assert.equal(seenByA, null, "A must not read B's guild through the facade");
    const seenOwn = await runAsSession(sessionA, () => facade.getGuild(guildA));
    assert.ok(seenOwn, "A must still read its own guild");
    const deniedCount = await runAsSession(sessionA, () => facade.countAudit(guildB));
    assert.equal(deniedCount.total, 0, "the trail count for another guild must be zero");
  } finally {
    await facade.close().catch(() => undefined);
  }
});

test("an expired pool identity cannot become a back door", { skip }, async () => {
  // `sessionIdForContextlessQueries` is for scripts and fixtures; it must still
  // obey the policies, so pointing it at an expired session yields nothing.
  const expired = randomUUID();
  const account = `rls-script-${randomUUID()}`;
  const owner = await pool.connect();
  try {
    await owner.query("BEGIN");
    await owner.query("SELECT set_config('al_ai.actor', $1, true)", [account]);
    await owner.query(`INSERT INTO oauth_sessions (id, discord_user_id, discord_username, access_token_ciphertext, scopes, expires_at)
      VALUES ($1, $2, 'script', 'x', 'identify', now() - interval '1 minute')`, [expired, account]);
    await owner.query("COMMIT");
  } finally {
    owner.release();
  }
  const scripted = createPool(url!, { sessionIdForContextlessQueries: expired });
  try {
    const { rows } = await scripted.query(`SELECT count(*)::int AS n FROM guilds`);
    assert.equal(rows[0].n, 0, "a contextless identity is still checked against the session table");
  } finally {
    await scripted.end().catch(() => undefined);
    await as(expired, `DELETE FROM oauth_sessions WHERE id = $1`, [expired]).catch(() => undefined);
  }
});
