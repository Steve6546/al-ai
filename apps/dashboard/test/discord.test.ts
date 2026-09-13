import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  fetchBotHighestRolePosition,
  fetchBotPermissions,
  fetchGuildHierarchy,
  resetBotUserIdCache
} from "../server/discord.js";
import { botIdentityPermissionStatus } from "../server/authorization.js";

/**
 * Regression tests for the bot's own member lookup.
 *
 * Three shipped features depended on reading the bot's own member object, and
 * all three read it through an endpoint a bot token cannot use:
 *
 *   - `GET /guilds/{id}/members/@me`       → 400 NUMBER_TYPE_COERCE
 *   - `GET /users/@me/guilds/{id}/member`  → 403 "Bots cannot use this endpoint"
 *
 * Both errors were swallowed by a `.catch(() => null)`, so nothing crashed and
 * nothing was logged — the features simply reported nothing, forever. The
 * hierarchy warning never appeared, the tier screen never flagged an
 * unassignable role, and the customization form disabled Save in every guild.
 *
 * These tests pin the request shape, because the failure mode of a wrong URL
 * here is silence rather than an exception, and they pin the "unknown is not
 * false" rule, because a failed read must not become a claim about the bot.
 */

const GUILD_ID = "900000000000000001";
const BOT_USER_ID = "999000000000000001";
const ADMIN_ROLE_ID = "900000000000000010";

type Call = { url: string; authorization: string };
let calls: Call[] = [];
let routes: { match: string; respond: () => Response }[] = [];

const json = (body: unknown) => () => Response.json(body);
const failure = (status: number, message: string) => () => new Response(message, { status });

const realFetch = globalThis.fetch;

globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
  const url = String(input);
  const headers = (init?.headers ?? {}) as Record<string, string>;
  calls.push({ url, authorization: headers.Authorization ?? "" });
  for (const route of routes) {
    if (url.includes(route.match)) return route.respond();
  }
  return new Response("no route", { status: 404 });
}) as typeof fetch;

after(() => {
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  calls = [];
  routes = [];
  resetBotUserIdCache();
});

/** The happy path: the bot resolves its own ID and holds one role. */
function happyRoutes(rolePosition: number, rolePermissions: string) {
  return [
    { match: "/users/@me", respond: json({ id: BOT_USER_ID }) },
    {
      match: `/guilds/${GUILD_ID}/members/${BOT_USER_ID}`,
      respond: json({ roles: [ADMIN_ROLE_ID], permissions: "0" })
    },
    {
      match: `/guilds/${GUILD_ID}/roles`,
      respond: json([{ id: ADMIN_ROLE_ID, position: rolePosition, permissions: rolePermissions }])
    }
  ];
}

test("the bot's member object is read by snowflake, never through an @me route", async () => {
  routes = happyRoutes(7, "8");

  await fetchGuildHierarchy("token", GUILD_ID);

  const memberCalls = calls.filter(call => call.url.includes("/members/"));
  assert.equal(memberCalls.length, 1, "expected exactly one member lookup");
  assert.ok(
    memberCalls[0]!.url.endsWith(`/guilds/${GUILD_ID}/members/${BOT_USER_ID}`),
    `member lookup used the wrong route: ${memberCalls[0]!.url}`
  );
  assert.ok(
    !calls.some(call => call.url.includes("@me/guilds")),
    "used the OAuth2-only /users/@me/guilds/{id}/member route, which answers a bot with 403"
  );
  assert.equal(memberCalls[0]!.authorization, "Bot token");
});

test("the bot's own ID is resolved once and reused across guilds", async () => {
  routes = happyRoutes(7, "8");

  await fetchGuildHierarchy("token", GUILD_ID);
  await fetchBotHighestRolePosition("token", "900000000000000002");

  const identityCalls = calls.filter(call => call.url.endsWith("/users/@me"));
  assert.equal(identityCalls.length, 1, "the bot's identity should be memoised, not re-fetched per guild");
});

test("the hierarchy verdict uses the bot's highest held role", async () => {
  routes = happyRoutes(7, "8");

  const hierarchy = await fetchGuildHierarchy("token", GUILD_ID);

  assert.equal(hierarchy?.botPosition, 7);
  assert.equal(hierarchy?.rolePositions.get(ADMIN_ROLE_ID), 7);
});

test("an unreadable member object yields null, not a guessed position", async () => {
  routes = [
    { match: "/users/@me", respond: json({ id: BOT_USER_ID }) },
    { match: "/members/", respond: failure(403, "Missing Access") },
    { match: `/guilds/${GUILD_ID}/roles`, respond: json([]) }
  ];

  assert.equal(await fetchGuildHierarchy("token", GUILD_ID), null);
  assert.equal(await fetchBotHighestRolePosition("token", GUILD_ID), null);
});

test("an unreadable permission bitfield is null, which is not the same as 0n", async () => {
  routes = [
    { match: "/users/@me", respond: json({ id: BOT_USER_ID }) },
    { match: "/members/", respond: failure(403, "Missing Access") }
  ];

  const bits = await fetchBotPermissions("token", GUILD_ID);

  assert.equal(bits, null, "a failed read must be null so callers can say 'unknown'");
  assert.notEqual(bits, 0n, "0n would claim the bot holds no permissions, which was never established");
});

test("a failed permission read reports 'unknown', never a false 'missing'", async () => {
  routes = [
    { match: "/users/@me", respond: json({ id: BOT_USER_ID }) },
    { match: "/members/", respond: failure(403, "Missing Access") }
  ];

  const statuses = await botIdentityPermissionStatus("token", GUILD_ID);
  const nickname = statuses.find(status => status.key === "change_nickname");

  assert.equal(nickname?.granted, null);
  assert.notEqual(nickname?.granted, false, "reporting 'missing' here blocks a save the bot can perform");
});

test("a permission that is genuinely absent is reported as missing", async () => {
  // 0n: read successfully, holds nothing.
  routes = happyRoutes(7, "0");

  const statuses = await botIdentityPermissionStatus("token", GUILD_ID);
  const nickname = statuses.find(status => status.key === "change_nickname");

  assert.equal(nickname?.granted, false);
});

test("MANAGE_NICKNAMES also satisfies the nickname requirement", async () => {
  // 1 << 27 = 0x8000000, MANAGE_NICKNAMES, without CHANGE_NICKNAME.
  routes = happyRoutes(7, String(0x8000000n));

  const statuses = await botIdentityPermissionStatus("token", GUILD_ID);
  const nickname = statuses.find(status => status.key === "change_nickname");

  assert.equal(nickname?.granted, true);
});

test("Administrator satisfies every permission, as Discord grants the whole set", async () => {
  // 0x8 alone. This is the real shape of the AL AI role: bit 3 and nothing else,
  // because Discord does not expand Administrator into the bits it implies.
  routes = happyRoutes(7, "8");

  const statuses = await botIdentityPermissionStatus("token", GUILD_ID);

  assert.deepEqual(
    statuses.map(status => status.granted),
    [true, true],
    "an Administrator bot must not be reported as missing permissions"
  );
});

test("base permissions come from the member's roles, not the member's own field", async () => {
  // The member object claims `permissions: "0"` (what Discord actually returns);
  // the real grant lives on the role.
  routes = happyRoutes(7, "8");

  const bits = await fetchBotPermissions("token", GUILD_ID);

  assert.equal(bits, 8n, "the role's permissions must be unioned in");
});

test("base permissions include @everyone and ignore roles the bot does not hold", async () => {
  routes = [
    { match: "/users/@me", respond: json({ id: BOT_USER_ID }) },
    {
      match: `/guilds/${GUILD_ID}/members/${BOT_USER_ID}`,
      respond: json({ roles: [ADMIN_ROLE_ID], permissions: "0" })
    },
    {
      match: `/guilds/${GUILD_ID}/roles`,
      respond: json([
        { id: GUILD_ID, position: 0, permissions: "64" },
        { id: ADMIN_ROLE_ID, position: 7, permissions: "8" },
        { id: "900000000000000099", position: 9, permissions: "32" }
      ])
    }
  ];

  // 64 (@everyone's ADD_REACTIONS) | 8 (the held role) — the unheld role's 32 is out.
  assert.equal(await fetchBotPermissions("token", GUILD_ID), 72n);
});
