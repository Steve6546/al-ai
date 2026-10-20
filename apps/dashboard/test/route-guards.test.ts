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

/**
 * Route declarations, matched whatever their indentation or line breaks.
 *
 * The pattern used to be anchored with `^app\.`, which only sees a declaration
 * starting at column 0 on a line whose path string opens on the same line. That
 * is true of every route today, but it is a *silent* blind spot: indenting the
 * table into a plugin, or breaking a long path across two lines, would drop the
 * route out of the scan while the count assertions above only fail if the whole
 * table disappears. A route that falls out of the scan is a route with no guard,
 * which is the exact hole this file exists to close — so the scanner is widened
 * here and the count test still acts as the tripwire for a wholesale change.
 */
const routeStart = /app\.(get|put|post|delete|patch)\(\s*["`]([^"`]+)/g;
const pathContinued = /^\s*["`]([^"`]+)/;

const routes: Route[] = [];
lines.forEach((line, index) => {
  routeStart.lastIndex = 0;
  const match = routeStart.exec(line);
  if (match) {
    // A path may be opened on one line and closed on the next; take the join so
    // `:guildId` is seen wherever it sits.
    const next = lines[index + 1] ?? "";
    const continued = line.includes(match[2]) && !/["`]\s*[,)]/.test(line) ? pathContinued.exec(next) : null;
    routes.push({
      method: match[1].toUpperCase(),
      path: continued ? `${match[2]}${continued[1]}` : match[2],
      line: index + 1,
      body: ""
    });
  }
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
 *
 * The call goes through `fetchUserGuildsCached` so the same list is not pulled
 * from Discord once per guarded route — but the cached wrapper must still be
 * reached only from here, or the first failure mode returns along with the
 * second. Both spellings are matched, because the invariant is "one guarded call
 * site", not "one particular identifier".
 */
test("the caller's guild list is read only through loadUserGuilds", () => {
  const callSites = lines
    .map((line, index) => ({ number: index + 1, text: line }))
    .filter(entry => /fetchUserGuilds(Cached)?\(/.test(entry.text));

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
 * The bot's presence route
 *
 * It is the one account-wide route that carries no `:guildId` in its path — the
 * guild arrives in the body, because a status belongs to the bot and not to a
 * guild. That makes it invisible to the scanner above, so it is asserted here
 * explicitly rather than left relying on a convention it does not follow.
 * ------------------------------------------------------------------ */

const presenceRoute = routes.find(route => route.path === "/api/bot/presence" && route.method === "PUT");
const presenceRead = routes.find(route => route.path === "/api/bot/presence" && route.method === "GET");

test("the presence write route exists and is scanned", () => {
  assert.ok(presenceRoute, "PUT /api/bot/presence is declared");
});

test("the presence write is gated to the platform owner on the server", () => {
  const body = presenceRoute!.body;

  // The value being edited is the bot's: one status on one gateway connection,
  // identical in every guild. Standing in any single guild is therefore the
  // wrong currency — and handing this to a guild admin would give them a switch
  // that changes every other server, which is precisely the cross-server reach
  // the identity screen was stripped of. The guildId stays mandatory as the
  // *location* the audit trail names and the place the caller's tier is
  // resolved.
  assert.match(body, /requirePlatformOwner\(/, "the write goes through the platform-owner gate");
  assert.match(body, /normaliseSnowflake\(body\?\.guildId\)/, "the guild id is validated before it is used");
  assert.doesNotMatch(body, /requireTierForGuild\(/, "a guild tier does not authorise an account-wide write");
});

test("the presence read carries the same gate as the write", () => {
  assert.ok(presenceRead, "GET /api/bot/presence is declared");
  assert.match(presenceRead!.body, /requirePlatformOwner\(/, "the read goes through the platform-owner gate");
  assert.doesNotMatch(presenceRead!.body, /requireTierForGuild\(/, "a guild tier does not widen the read");
});

test("the presence write refuses a body with no guild to authorise against", () => {
  // Without a guild there is nowhere to resolve standing, and the honest answer
  // is a 400 — not a default that silently grants or denies.
  assert.match(presenceRoute!.body, /GUILD_ID_REQUIRED/, "a missing guild id is refused with a reason");
});

test("the presence write makes no Discord call, because there is none to make", () => {
  // A status lives on the gateway connection and the *bot* applies it; the
  // dashboard can only store the choice. A route that ran the appearance writer
  // here, or that answered with an `applied` list, would be reporting a write
  // that never happened — the "محفوظ ≠ منفّذ" defect arriving from the other
  // direction.
  const body = presenceRoute!.body;
  assert.doesNotMatch(body, /applyAppearance\(/, "the presence is not written through the appearance writer");
  assert.doesNotMatch(body, /applied:/, "and no field outcome is invented for it");
});

/* ------------------------------------------------------------------ *
 * The identity screen's write is a guild admin's
 *
 * The screen is 100% server-scoped now, and this is the other half of that
 * claim: every field on it must be editable by whoever may administer the
 * server, with no platform-owner gate and no per-field restriction. The
 * `:guildId` scanner above already proves it goes through the admin tier; this
 * pins that nothing owner-only was left on it by accident.
 * ------------------------------------------------------------------ */

const customizationWrite = routes.find(route => route.path === "/api/guilds/:guildId/customization" && route.method === "PUT");

test("every identity field is writable by a guild admin, with no owner gate", () => {
  assert.ok(customizationWrite, "PUT /api/guilds/:guildId/customization is declared");
  const body = customizationWrite!.body;

  assert.match(body, /requireTierForGuild\(/, "the write resolves the caller's tier in this guild");
  assert.doesNotMatch(body, /requirePlatformOwner\(/, "and nothing on it is reserved for the platform owner");
  assert.doesNotMatch(body, /GLOBAL_APPEARANCE_FIELDS/, "there is no separate set of account-wide fields to gate");
});

test("the identity write accepts the four member fields the screen offers", () => {
  // Nickname, avatar, banner and bio travel in one Modify Current Member call.
  // A route that silently ignored one of them would leave a control that saves
  // and changes nothing.
  const body = customizationWrite!.body;
  for (const field of ["nickname", "avatarDataUrl", "bannerDataUrl", "bio"]) {
    assert.match(body, new RegExp(field), `${field} is handled by the route`);
  }
});

/* ------------------------------------------------------------------ *
 * The overview metrics route
 *
 * The bot status card is the whole point of the overview, and it has exactly
 * one input: `guild_health`. `deriveBotStatus` cannot separate "no row" from
 * "the read threw", because both reach it as `null` — and `null` is what the
 * screen renders as «لم يُشغّل بعد», "start the bot and reload". A read failure
 * would therefore be presented as a dead bot and send the operator to restart
 * a process that is healthy, while the real fault is the dashboard's own
 * database. The route must fail the request instead of guessing.
 * ------------------------------------------------------------------ */

const metricsRoute = routes.find(route => route.path === "/api/guilds/:guildId/metrics" && route.method === "GET");

test("the overview metrics route is scanned", () => {
  assert.ok(metricsRoute, "GET /api/guilds/:guildId/metrics is declared");
});

test("the overview metrics route does not swallow a heartbeat read failure as «never started»", () => {
  const body = metricsRoute!.body;

  // The four supporting reads stay best-effort: an empty activity feed and an
  // unknown member count degrade honestly. The heartbeat read cannot, because
  // its failure mode is a false diagnosis rather than missing data.
  assert.doesNotMatch(
    body,
    /getGuildHealth\([^)]*\)\s*\.catch\(\(\)\s*=>\s*null\)/,
    "a failed heartbeat read must not become the «bot was never started» state"
  );
  assert.match(body, /METRICS_UNAVAILABLE/, "a failed heartbeat read answers with a named error");
});
