import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { isPlatformOwner } from "../server/authorization.js";
import { AppShell } from "../src/components/app-shell";
import type { Guild, HealthSnapshot } from "../src/types";

/**
 * The platform-owner gate: the pure verdict, plus a source-level drift guard
 * that every owner-gated route actually goes through `requirePlatformOwner`.
 *
 * The verdict is where the security lives — the middleware is a thin wrapper
 * around it — so the rules are asserted directly: unset OWNER_ID denies
 * everyone, only the matching authenticated id passes, and no guild id or
 * claimed identity in a request can influence the answer.
 */

const OWNER = "1111111111111111111";
const OTHER = "2222222222222222222";

test("the configured owner's authenticated id passes", () => {
  assert.equal(isPlatformOwner(OWNER, OWNER), true);
});

test("any other authenticated id is refused — a guild admin included", () => {
  assert.equal(isPlatformOwner(OWNER, OTHER), false);
});

test("an unset OWNER_ID denies everyone, the deployment owner included", () => {
  assert.equal(isPlatformOwner(null, OWNER), false);
  assert.equal(isPlatformOwner(null, ""), false);
});

test("the verdict cannot be influenced by a request-supplied identity", () => {
  // The function takes exactly two arguments; there is no guild or body input
  // to bias it. This pins the signature: widening it later to accept a claim
  // from the request would fail here.
  assert.equal(isPlatformOwner.length, 2);
});

test("every owner-gated route is wired through requirePlatformOwner", () => {
  // A drift guard, not a substitute for the gate: each instance-wide surface —
  // the network reach in both directions and the bot's presence in both
  // directions — must call the platform-owner gate inside its own handler body.
  // A route added later that checks a guild tier instead of the owner would
  // fail here, the same way the routing test catches un-logged events.
  //
  // The presence is on this list, and that is not a leftover from the identity
  // screen: a status really is one value for every server the bot is in, so it
  // is the one appearance setting a guild admin must not be able to move.
  const source = readFileSync(resolve(import.meta.dirname, "../server/index.ts"), "utf8");
  const routes = [
    'app.get("/api/network"',
    'app.put("/api/network"',
    'app.get("/api/bot/presence"',
    'app.put("/api/bot/presence"'
  ];
  for (const route of routes) {
    const at = source.indexOf(route);
    assert.ok(at > 0, `${route} exists`);
    const body = source.slice(at, at + 1_500);
    assert.ok(
      body.includes("requirePlatformOwner"),
      `${route} routes through requirePlatformOwner`
    );
  }
});

test("the sidebar hides the platform-owner surfaces from a non-owner and shows them to the owner", () => {
  // The frontend half of the gate: a non-owner never sees the «النظام» section
  // in the nav — including the empty heading — while the owner does. The
  // server-side route gate above is the authority; this only pins what the
  // sidebar advertises.
  const guild: Guild = {
    id: "1540515175826985080",
    name: "سيرفر الاختبار",
    iconUrl: null,
    memberCount: 42,
    tier: "owner",
    botPresent: true,
    canManage: true,
    canManageIdentity: true,
    canManageLogging: true,
    canManageCommands: true,
    canManageTiers: true,
    canInvite: true,
    canAdminInstance: true
  };
  const health = { status: "healthy" } as HealthSnapshot;
  const shell = (isOwner: boolean) =>
    renderToString(
      createElement(AppShell, {
        guilds: [guild],
        guild,
        selectedGuildId: guild.id,
        onSelectGuild: () => {},
        onBrowseAll: () => {},
        view: "dashboard",
        onView: () => {},
        health,
        user: { id: OWNER, username: "owner", avatarUrl: null, expiresAt: new Date().toISOString(), isPlatformOwner: isOwner },
        refreshing: false,
        onRefresh: () => {},
        onLogout: () => {},
        children: null
      })
    );

  const nonOwner = shell(false);
  assert.ok(!nonOwner.includes("الوصول للشبكة"), "a non-owner never sees the network nav");
  assert.ok(!nonOwner.includes("النظام"), "the empty owner section does not even render its heading");

  const owner = shell(true);
  assert.ok(owner.includes("الوصول للشبكة"), "the owner sees the network nav");
});
