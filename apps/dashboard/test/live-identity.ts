import { randomUUID } from "node:crypto";
import pg from "pg";

/**
 * A real identity for tests that exercise the storage layer directly.
 *
 * Those tests call `db.*` outside a request, so there is no cookie to derive an
 * identity from — and the row policies on guild tables would answer "no rows"
 * to every statement. Instead of weakening a policy for tests, this creates
 * exactly what a request would have: a session row and the access-list rows
 * for the fixture guilds, written through the application role's own policies.
 *
 * The account id is fixed so a leftover row is recognisable and removable; the
 * session id is fresh every run.
 */
export const FIXTURE_ACCOUNT = "900000000000000900";

/** Every guild id the storage fixtures write to. */
export const FIXTURE_GUILDS = [
  "900000000000000001",
  "900000000000000002",
  "900000000000000003",
  "100000000000000002",
  "111111111111111111",
  "222222222222222222",
  "333333333333333333",
  "444444444444444444",
  "555555555555555555",
  "666666666666666666",
  "811111111111111111",
  "822222222222222222",
  "833333333333333331",
  "833333333333333332",
  "911111111111111111",
  "912222222222222222",
  "913333333333333333",
  "933333333333333333"
];

/**
 * Creates the session and access rows the policies read, and returns the
 * session id to hand to `createPool`.
 */
export async function seedIdentity(databaseUrl: string, guildIds: string[] = FIXTURE_GUILDS): Promise<string> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const sessionId = randomUUID();
  try {
    // The session row is written under the account it belongs to, which is the
    // only identity the session policy accepts for an INSERT.
    await client.query("BEGIN");
    await client.query("SELECT set_config('al_ai.actor', $1, true)", [FIXTURE_ACCOUNT]);
    await client.query(
      `INSERT INTO oauth_sessions (id, discord_user_id, discord_username, access_token_ciphertext, scopes, expires_at, second_factor_satisfied)
       VALUES ($1, $2, 'storage-fixture', 'fixture-ciphertext', 'identify', now() + interval '2 hours', true)`,
      [sessionId, FIXTURE_ACCOUNT]
    );
    await client.query("COMMIT");

    // The access rows are written under that session, which is what the policy
    // on `guild_acl` resolves the account from.
    await client.query("BEGIN");
    await client.query("SELECT set_config('al_ai.session_id', $1, true)", [sessionId]);
    for (const guildId of guildIds) {
      await client.query(
        `INSERT INTO guild_acl (guild_id, discord_user_id, tier) VALUES ($1, $2, 'owner')
         ON CONFLICT (guild_id, discord_user_id) DO UPDATE SET tier = 'owner', updated_at = now()`,
        [guildId, FIXTURE_ACCOUNT]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end().catch(() => undefined);
  }
  return sessionId;
}
