import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  buildBotInviteUrl,
  DiscordApiError,
  fetchBotGuildIds,
  guildIconUrl,
  invalidateBotGuildCache,
  isAuthFailure,
  isRateLimited,
  userAvatarUrl
} from "../server/discord.js";

/**
 * Regression tests for the three ways the selector's guild read used to fail
 * the operator, all of which shared one root cause: Discord's status code was
 * thrown away.
 *
 *  1. A 429 (rate limit) arrived as a bare `Error`, so it was handled as an
 *     expired session — pressing refresh too fast signed the operator out.
 *  2. The same failure inside `Promise.all` rejected the route *after* a reply
 *     had been sent, turning a "slow down" into a 500 and a
 *     `FST_ERR_REP_ALREADY_SENT` stacked on top of it.
 *  3. Two Discord calls per load, on a screen that refetches on every visit,
 *     is what tripped the limit in the first place.
 *
 * Plus the animated-avatar rule: an `a_` hash asked for as `.png` is a valid
 * request that returns a still frame, so the bug is invisible.
 */

const BOT_TOKEN = "test-bot-token";

type Call = { url: string; authorization: string };
let calls: Call[] = [];
let routes: { match: string; respond: () => Response }[] = [];

const json = (body: unknown) => () => Response.json(body);
const failure = (status: number, body = "") => () => new Response(body, { status });

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

const realNow = Date.now;

after(() => {
  globalThis.fetch = realFetch;
  Date.now = realNow;
});

beforeEach(() => {
  calls = [];
  routes = [];
  invalidateBotGuildCache();
  Date.now = realNow;
});

/* ------------------------------------------------------------------ *
 * Discord's status code must survive to the caller
 * ------------------------------------------------------------------ */

test("a 401 from Discord is an auth failure", () => {
  const error = new DiscordApiError(401, "/users/@me/guilds", "Unauthorized");
  assert.equal(isAuthFailure(error), true);
  assert.equal(isRateLimited(error), false);
});

test("a 429 from Discord is a rate limit, not an auth failure", () => {
  const error = new DiscordApiError(429, "/users/@me/guilds", "rate limited", 0.35);
  assert.equal(isRateLimited(error), true);
  assert.equal(isAuthFailure(error), false, "a rate limit must never sign the operator out");
});

test("a 403 is not treated as an auth failure", () => {
  // 403 on these endpoints means "this token may not call this route", which a
  // new sign-in cannot fix. Destroying the session over it would be wrong.
  const error = new DiscordApiError(403, "/guilds/1/members/2", "Missing Permissions");
  assert.equal(isAuthFailure(error), false);
  assert.equal(isRateLimited(error), false);
});

test("a plain Error is neither an auth failure nor a rate limit", () => {
  assert.equal(isAuthFailure(new Error("socket hang up")), false);
  assert.equal(isRateLimited(new Error("socket hang up")), false);
});

test("the rate limit carries the wait Discord asked for", () => {
  const error = new DiscordApiError(429, "/users/@me/guilds", "rate limited", 0.35);
  assert.equal(error.retryAfterSeconds, 0.35);
  assert.equal(new DiscordApiError(429, "/x", "", null).retryAfterSeconds, null);
});

/* ------------------------------------------------------------------ *
 * The bot's guild list is memoised
 * ------------------------------------------------------------------ */

test("repeated reads of the bot guild list cost one Discord call", async () => {
  routes = [{ match: "/users/@me/guilds", respond: json([{ id: "1" }, { id: "2" }]) }];

  const first = await fetchBotGuildIds(BOT_TOKEN);
  const second = await fetchBotGuildIds(BOT_TOKEN);

  assert.equal(calls.length, 1, "the second read is served from the cache");
  assert.deepEqual([...first], ["1", "2"]);
  assert.deepEqual([...second], ["1", "2"]);
});

test("concurrent reads share one in-flight request", async () => {
  routes = [{ match: "/users/@me/guilds", respond: json([{ id: "7" }]) }];

  const [a, b, c] = await Promise.all([
    fetchBotGuildIds(BOT_TOKEN),
    fetchBotGuildIds(BOT_TOKEN),
    fetchBotGuildIds(BOT_TOKEN)
  ]);

  assert.equal(calls.length, 1, "three tabs opening at once are one Discord call");
  assert.deepEqual([...a], ["7"]);
  assert.deepEqual([...b], ["7"]);
  assert.deepEqual([...c], ["7"]);
});

test("invalidating the cache forces a fresh read", async () => {
  routes = [{ match: "/users/@me/guilds", respond: json([{ id: "1" }]) }];
  await fetchBotGuildIds(BOT_TOKEN);

  invalidateBotGuildCache();
  await fetchBotGuildIds(BOT_TOKEN);

  assert.equal(calls.length, 2);
});

test("the cache expires so a newly invited bot is noticed", async () => {
  routes = [{ match: "/users/@me/guilds", respond: json([{ id: "1" }]) }];
  await fetchBotGuildIds(BOT_TOKEN);

  // Past the TTL: the next read must go to Discord again rather than keep
  // answering "the bot is not in your new guild".
  Date.now = () => realNow() + 60_000;
  await fetchBotGuildIds(BOT_TOKEN);

  assert.equal(calls.length, 2);
});

test("a stale reading beats failing the whole screen", async () => {
  routes = [{ match: "/users/@me/guilds", respond: json([{ id: "1" }, { id: "2" }]) }];
  await fetchBotGuildIds(BOT_TOKEN);

  // Discord now fails, but guild membership is stable — an old answer is still
  // a true one, and the alternative is a 503 for a screen that could be shown.
  Date.now = () => realNow() + 60_000;
  routes = [{ match: "/users/@me/guilds", respond: failure(500, "boom") }];

  const ids = await fetchBotGuildIds(BOT_TOKEN);
  assert.deepEqual([...ids], ["1", "2"]);
});

test("with no cached reading, a failure still propagates", async () => {
  routes = [{ match: "/users/@me/guilds", respond: failure(500, "boom") }];

  await assert.rejects(() => fetchBotGuildIds(BOT_TOKEN), (error: unknown) => {
    assert.ok(error instanceof DiscordApiError);
    assert.equal(error.status, 500);
    return true;
  });
});

test("the bot guild read uses the Bot scheme", async () => {
  routes = [{ match: "/users/@me/guilds", respond: json([]) }];
  await fetchBotGuildIds(BOT_TOKEN);

  assert.equal(calls[0]?.authorization, `Bot ${BOT_TOKEN}`);
});

/* ------------------------------------------------------------------ *
 * Animated assets
 * ------------------------------------------------------------------ */

test("an animated avatar is requested as a gif", () => {
  const url = userAvatarUrl("123", "a_animatedhash");
  assert.match(url, /\/avatars\/123\/a_animatedhash\.gif\?size=/);
  assert.doesNotMatch(url, /\.png/, "a .png request would silently return a still frame");
});

test("a still avatar is still requested as a png", () => {
  assert.match(userAvatarUrl("123", "statichash"), /\/avatars\/123\/statichash\.png\?size=/);
});

test("an animated guild icon is requested as a gif", () => {
  assert.match(guildIconUrl("456", "a_iconhash")!, /\/icons\/456\/a_iconhash\.gif\?size=/);
  assert.match(guildIconUrl("456", "iconhash")!, /\/icons\/456\/iconhash\.png\?size=/);
});

test("a guild without an icon has no URL rather than a broken one", () => {
  assert.equal(guildIconUrl("456", null), null);
});

test("an account without an avatar falls back to Discord's defaults", () => {
  // The default images are fixed PNGs chosen by (id >> 22) % 6.
  assert.match(userAvatarUrl("0", null), /\/embed\/avatars\/0\.png$/);
  assert.match(userAvatarUrl("not-a-snowflake", null), /\/embed\/avatars\/0\.png$/, "a bad id does not throw");
});

test("avatars are fetched large enough for a HiDPI screen", () => {
  // Drawn at up to 56 CSS px, so 64 arrived visibly soft on a 2x display.
  assert.match(userAvatarUrl("123", "hash"), /size=128/);
});

/* ------------------------------------------------------------------ *
 * The invite's return leg
 * ------------------------------------------------------------------ */

test("the invite asks Discord to hand the browser back to the dashboard", () => {
  const url = buildBotInviteUrl("client", "guild", { redirectUri: "https://al.example/auth/discord/callback", state: "abc" });
  const params = new URL(url).searchParams;

  assert.equal(params.get("redirect_uri"), "https://al.example/auth/discord/callback");
  assert.equal(params.get("state"), "abc");
  assert.equal(params.get("response_type"), "code", "without this Discord never returns");
  assert.equal(params.get("guild_id"), "guild");
  assert.equal(params.get("disable_guild_select"), "true");
});

test("the invite keeps Administrator and pins the guild", () => {
  const params = new URL(buildBotInviteUrl("client", "guild", { redirectUri: "https://x/y", state: "s" })).searchParams;
  assert.equal(params.get("permissions"), "8");
  assert.equal(params.get("scope"), "bot applications.commands");
});

test("an invite without a return leg stays a plain link", () => {
  // The state cookie is only set when we ask for the return leg, so sending
  // Discord a `redirect_uri` we are not prepared to verify would be worse than
  // not sending one.
  const params = new URL(buildBotInviteUrl("client", "guild")).searchParams;
  assert.equal(params.get("redirect_uri"), null);
  assert.equal(params.get("state"), null);
  assert.equal(params.get("guild_id"), "guild");
});
