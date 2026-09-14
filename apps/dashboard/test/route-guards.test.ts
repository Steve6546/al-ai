import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Every guild-scoped route must say who may reach the guild.
 *
 * This is a source-level check on purpose. The hole it guards against is not a
 * wrong answer from one function — it is a *missing* call, which no unit test of
 * the guards themselves can catch. A new route added with only `requireSession`
 * compiles, passes every other test, and leaks one guild's data to any signed-in
 * account, because a guild id is not a secret: it is in every invite link.
 *
 * Reads and writes are held to different bars:
 * - a read needs access to the guild (`requireGuildAccess`);
 * - a write needs the admin tier (`requireTierForGuild`), because disarming the
 *   anti-nuke engine is exactly what a compromised moderator account would try.
 */

const source = readFileSync(fileURLToPath(new URL("../server/index.ts", import.meta.url)), "utf8");
const lines = source.split(/\r?\n/);

type Route = { method: string; path: string; line: number; body: string };

const routeStart = /^app\.(get|put|post|delete|patch)\(\s*["`]([^"`]+)/;

const routes: Route[] = [];
lines.forEach((line, index) => {
  const match = routeStart.exec(line);
  if (match) routes.push({ method: match[1].toUpperCase(), path: match[2], line: index + 1, body: "" });
});

// Each route owns the source up to the next route declaration.
routes.forEach((route, index) => {
  const end = index + 1 < routes.length ? routes[index + 1].line - 1 : lines.length;
  route.body = lines.slice(route.line - 1, end).join("\n");
});

const guildScoped = routes.filter(route => route.path.includes(":guildId"));
const writes = guildScoped.filter(route => route.method !== "GET");

test("the route scanner actually found the routes", () => {
  // Guards the guard: if the declaration style changes, the assertions below
  // would pass vacuously over an empty list.
  assert.ok(routes.length >= 20, `expected the full route table, found ${routes.length}`);
  assert.ok(guildScoped.length >= 14, `expected the guild-scoped routes, found ${guildScoped.length}`);
  assert.ok(writes.length >= 5, `expected the write routes, found ${writes.length}`);
});

test("every guild-scoped route verifies access to that guild", () => {
  for (const route of guildScoped) {
    assert.match(
      route.body,
      /requireGuildAccess\(|requireTierForGuild\(/,
      `${route.method} ${route.path} (line ${route.line}) must guard the guild, not just the session`
    );
  }
});

test("no guild-scoped route is satisfied by a bare session check", () => {
  for (const route of guildScoped) {
    assert.doesNotMatch(
      route.body,
      /const\s+\w+\s*=\s*await requireSession\(/,
      `${route.method} ${route.path} (line ${route.line}) checks only that someone is signed in`
    );
  }
});

test("every guild-scoped write requires the admin tier, not merely access", () => {
  for (const route of writes) {
    assert.match(
      route.body,
      /requireTierForGuild\(/,
      `${route.method} ${route.path} (line ${route.line}) must re-resolve the tier on the server`
    );
  }
});

/**
 * A rejected Discord user token is an expired session, not a server fault.
 *
 * `fetchUserGuilds` throws when Discord refuses the stored token — it expired,
 * or the operator revoked the app's access. A route that lets that escape
 * answers 500 and, worse, leaves the session alive. The selector refetches this
 * list on every load, so the operator would sit on "unexpected error" forever
 * with no way back to the sign-in screen; `/api/guilds` did exactly that, while
 * the per-guild guards handled the same failure correctly.
 *
 * So the read has exactly one call site, inside `loadUserGuilds`, which clears
 * the dead session and answers 401. A second call site is a route that will
 * answer 500 on a dead token.
 */
test("the caller's guild list is read only through loadUserGuilds", () => {
  const callSites = lines
    .map((line, index) => ({ number: index + 1, text: line }))
    .filter(entry => /fetchUserGuilds\(/.test(entry.text));

  assert.equal(
    callSites.length,
    1,
    `expected exactly one fetchUserGuilds call site, found ${callSites.length} (lines ${callSites.map(s => s.number).join(", ")})`
  );

  const owner = lines.findIndex(line => /function loadUserGuilds\b/.test(line)) + 1;
  assert.ok(owner > 0, "loadUserGuilds is defined");
  assert.ok(
    callSites[0]!.number > owner,
    `the only fetchUserGuilds call (line ${callSites[0]!.number}) must live inside loadUserGuilds (line ${owner}), which maps a rejected token to 401 rather than a 500`
  );
});

/* ------------------------------------------------------------------ *
 * The global bot identity route
 *
 * It is the one guild-sensitive route that carries no `:guildId` in its path —
 * the guild arrives in the body, because the identity itself belongs to no
 * guild. That makes it invisible to the scanner above, so it is asserted here
 * explicitly rather than left relying on a convention it does not follow.
 * ------------------------------------------------------------------ */

const identityRoute = routes.find(route => route.path === "/api/bot/identity" && route.method === "PUT");
const identityRead = routes.find(route => route.path === "/api/bot/identity" && route.method === "GET");

test("the global identity write route exists and is scanned", () => {
  assert.ok(identityRoute, "PUT /api/bot/identity is declared");
});

test("the global identity write resolves the caller's tier in a guild from the body", () => {
  const body = identityRoute!.body;

  // The guild is a *location to check*, never a claim. The tier must be resolved
  // server-side from it, which is what `requireTierForGuild` does — it re-reads
  // the caller's roles from Discord rather than trusting anything sent up.
  assert.match(body, /requireTierForGuild\(/, "the write re-resolves the tier on the server");
  assert.match(body, /normaliseSnowflake\(body\??\.guildId\)/, "the guild id is validated before it is used");

  // A route that checked only for a session would let any signed-in account
  // rewrite the bot's profile across every guild.
  assert.doesNotMatch(body, /const\s+\w+\s*=\s*await requireSession\(/, "a bare session check is not enough");
});

test("the global identity read requires a session", () => {
  assert.ok(identityRead, "GET /api/bot/identity is declared");
  assert.match(identityRead!.body, /readSession\(/, "the read is not public");
});

test("the global identity write refuses a body with no guild to authorise against", () => {
  // Without a guild there is nowhere to resolve standing, and the honest answer
  // is a 400 — not a default that silently grants or denies.
  assert.match(identityRoute!.body, /GUILD_ID_REQUIRED/, "a missing guild id is refused with a reason");
});
