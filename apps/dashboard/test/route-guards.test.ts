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
