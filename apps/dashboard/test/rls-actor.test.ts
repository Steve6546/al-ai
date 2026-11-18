import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";

const envFile = resolve(import.meta.dirname, "../../../.env");
if (!process.env.DATABASE_URL && existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

/**
 * Live proof that the row policies on the account tables isolate accounts.
 *
 * These run against a real PostgreSQL with `infra/schema.sql` applied, because
 * the only honest way to show a policy works is to ask the database as the
 * application role. The fixtures are created and removed through the same
 * role, which means the test also proves the owner of a row can still write it.
 */
const url = process.env.DATABASE_URL;
const skip = url ? false : "DATABASE_URL is not set";

let pool: pg.Pool;
before(() => {
  if (url) pool = new pg.Pool({ connectionString: url, max: 2 });
});
after(async () => {
  await pool?.end();
});

/** One statement, one declared identity — the same contract db.ts uses. */
async function as(
  settings: Record<string, string>,
  text: string,
  values: unknown[] = []
): Promise<pg.QueryResult<Record<string, unknown>>> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const [key, value] of Object.entries(settings)) {
      await client.query("SELECT set_config($1, $2, true)", [key, value]);
    }
    const result = await client.query<Record<string, unknown>>(text, values);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function insertSession(id: string, discordUserId: string, expiresInSeconds: number) {
  await as(
    { "al_ai.actor": discordUserId },
    `INSERT INTO oauth_sessions (id, discord_user_id, discord_username, access_token_ciphertext, scopes, expires_at)
     VALUES ($1, $2, 'rls-fixture', 'fixture-ciphertext', 'identify', now() + ($3 || ' seconds')::interval)`,
    [id, discordUserId, String(expiresInSeconds)]
  );
}

async function countSession(id: string, settings: Record<string, string>) {
  const { rows } = await as(settings, `SELECT count(*)::int AS n FROM oauth_sessions WHERE id = $1`, [id]);
  return rows[0].n as number;
}

test("a session row is invisible without an identity, and only its account sees it", { skip }, async () => {
  const id = randomUUID();
  const account = `rls-account-${randomUUID()}`;
  await insertSession(id, account, 3600);
  try {
    // No identity: the default is deny, not "every row for the app password".
    assert.equal(await countSession(id, {}), 0);
    // Another account, and a session id that is not this one: still deny.
    assert.equal(await countSession(id, { "al_ai.actor": `rls-other-${randomUUID()}` }), 0);
    assert.equal(await countSession(id, { "al_ai.session_id": randomUUID() }), 0);
    // The two legitimate ways in: the row's account, or the cookie being resumed.
    assert.equal(await countSession(id, { "al_ai.actor": account }), 1);
    assert.equal(await countSession(id, { "al_ai.session_id": id }), 1);
  } finally {
    await as({ "al_ai.actor": account }, `DELETE FROM oauth_sessions WHERE id = $1`, [id]);
  }
});

test("a statement cannot create a session for another account", { skip }, async () => {
  const id = randomUUID();
  const victim = `rls-victim-${randomUUID()}`;
  await assert.rejects(
    () =>
      as(
        { "al_ai.actor": `rls-attacker-${randomUUID()}` },
        `INSERT INTO oauth_sessions (id, discord_user_id, discord_username, access_token_ciphertext, scopes, expires_at)
         VALUES ($1, $2, 'rls-fixture', 'fixture-ciphertext', 'identify', now() + interval '1 hour')`,
        [id, victim]
      ),
    // The actor is somebody else, so `WITH CHECK` refuses the row.
    (error: { code?: string }) => error.code === "42501"
  );
  assert.equal(await countSession(id, {}), 0);
});

test("housekeeping still deletes an expired session with no identity", { skip }, async () => {
  const id = randomUUID();
  const account = `rls-expired-${randomUUID()}`;
  // An already-expired row is the one case a policy must allow without an
  // identity, otherwise the purge timer would quietly stop cleaning up.
  await insertSession(id, account, -60);
  const { rowCount } = await as({}, `DELETE FROM oauth_sessions WHERE id = $1 AND expires_at <= now()`, [id]);
  assert.equal(rowCount, 1);
});

test("preferences belong to one account and are writable only by it", { skip }, async () => {
  const account = `rls-prefs-${randomUUID()}`;
  const stranger = `rls-stranger-${randomUUID()}`;
  try {
    await as(
      { "al_ai.actor": account },
      `INSERT INTO user_preferences (discord_user_id, language, appearance) VALUES ($1, 'de', '{"theme":"dark"}'::jsonb)
       ON CONFLICT (discord_user_id) DO UPDATE SET language = 'de'`,
      [account]
    );
    assert.equal(
      (await as({ "al_ai.actor": account }, `SELECT count(*)::int AS n FROM user_preferences WHERE discord_user_id = $1`, [account]))
        .rows[0].n,
      1
    );
    assert.equal(
      (await as({ "al_ai.actor": stranger }, `SELECT count(*)::int AS n FROM user_preferences WHERE discord_user_id = $1`, [account]))
        .rows[0].n,
      0
    );
    // A stranger's UPDATE matches no row rather than editing it.
    const { rowCount } = await as(
      { "al_ai.actor": stranger },
      `UPDATE user_preferences SET language = 'en' WHERE discord_user_id = $1`,
      [account]
    );
    assert.equal(rowCount, 0);
    assert.equal(
      (await as({ "al_ai.actor": account }, `SELECT language FROM user_preferences WHERE discord_user_id = $1`, [account]))
        .rows[0].language,
      "de"
    );
  } finally {
    await as({ "al_ai.actor": account }, `DELETE FROM user_preferences WHERE discord_user_id = $1`, [account]);
  }
});

test("housekeeping can delete an expired authenticator setup without an identity", { skip }, async () => {
  // The five-minute sweep runs outside any request, so it has no session. An
  // expired row is the one case a policy must allow without one; otherwise the
  // encrypted enrolment envelope is never cleaned up and the job fails silently.
  const account = `rls-setup-${randomUUID()}`;
  await as(
    { "al_ai.actor": account },
    `INSERT INTO admin_two_factor_setup (discord_user_id, enrollment_ciphertext, expires_at)
     VALUES ($1, 'fixture-envelope', now() - interval '1 minute')`,
    [account]
  );
  const { rowCount } = await as(
    {},
    `DELETE FROM admin_two_factor_setup WHERE discord_user_id = $1 AND expires_at <= now()`,
    [account]
  );
  assert.equal(rowCount, 1, "an expired setup row must be purged without an identity");
});
