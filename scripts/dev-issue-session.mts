/**
 * Issues a dashboard session for a local probe.
 *
 * Why this exists: every per-guild route needs a session, and getting one
 * normally means a full Discord OAuth round-trip through a browser. That makes
 * the authenticated half of the API effectively untestable by hand, which is
 * how a route can ship returning the wrong shape for months.
 *
 * This mints a session directly through the same `issueSession` the OAuth
 * callback uses, so the cookie it prints is a real one — the route under test
 * performs its normal lookup and cannot tell the difference.
 *
 *   npx tsx --env-file=.env scripts/dev-issue-session.mts <discordUserId>
 *
 * It refuses to run against a production environment.
 *
 * NOTE: the extension must be `.mts`. The repo root has no `"type": "module"`,
 * so a bare `.ts` here is compiled as CommonJS and top-level `await` fails with
 * ERR_REQUIRE_ASYNC_MODULE.
 */
import { loadEnv } from "../apps/dashboard/server/env.js";
import { createDatabase, createPool } from "../apps/dashboard/server/db.js";
import { issueSession } from "../apps/dashboard/server/session.js";
import { SESSION_COOKIE_NAME } from "@al-ai/core";

const env = loadEnv();

if (env.isProduction) {
  console.error("Refusing to mint a development session against a production environment.");
  process.exit(1);
}

const discordUserId = process.argv[2];
if (!discordUserId) {
  console.error("usage: npx tsx --env-file=.env scripts/dev-issue-session.mts <discordUserId>");
  process.exit(2);
}

const pool = createPool(env.databaseUrl);
const db = createDatabase(pool);

const { id, expiresAt } = await issueSession(db, env, {
  discordUserId,
  discordUsername: `probe-${discordUserId}`,
  discordAvatar: null,
  accessToken: "probe-token",
  scopes: "identify guilds"
});

// Printed as the exact header value so it can be piped straight into curl.
console.log(`${SESSION_COOKIE_NAME}=${id}`);
console.error(`session ${id} expires ${expiresAt.toISOString()}`);

await pool.end();
