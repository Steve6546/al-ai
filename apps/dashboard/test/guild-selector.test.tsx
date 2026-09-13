import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { filterGuilds, GuildSelector, highestTier, splitGuilds } from "../src/components/guild-selector";
import { formatMemberCount } from "../src/lib/format";
import { guildPath, guildsPath, parsePath } from "../src/lib/router";
import type { Guild, SessionInfo } from "../src/types";

/**
 * The guild selector, and the pieces it is built from.
 *
 * The split, the search and the address parsing are pure functions, so they are
 * asserted directly rather than through the rendered markup. The render pass
 * exists for the other half of the problem: a screen that throws while rendering
 * shows the operator a blank page, and only executing it catches that.
 *
 * The member count gets its own attention because it is the one value here that
 * can be *unknown*. Rendering "0" for a guild the bot has not joined would state
 * something false in a way that looks completely normal.
 */

const base: Guild = {
  id: "1540515175826985080",
  name: "Alpha",
  iconUrl: null,
  memberCount: 271,
  tier: "owner",
  botPresent: true,
  canManage: true,
  canManageIdentity: true,
  canManageLogging: true,
  canManageCommands: true,
  canManageTiers: true,
  canInvite: true
};

const active: Guild = base;
const eligible: Guild = { ...base, id: "1540515175826985081", name: "Beta", botPresent: false, tier: null, memberCount: null };
const third: Guild = { ...base, id: "1540515175826985082", name: "Gamma", memberCount: 3 };

const user: SessionInfo["user"] = { id: "1", username: "naxhz", avatarUrl: null, expiresAt: new Date().toISOString() };

/* ------------------------------------------------------------------ *
 * The split
 * ------------------------------------------------------------------ */

test("guilds are split by whether the bot is already in them", () => {
  const { active: activeList, eligible: eligibleList } = splitGuilds([active, eligible, third]);

  assert.deepEqual(
    activeList.map(guild => guild.name),
    ["Alpha", "Gamma"]
  );
  assert.deepEqual(
    eligibleList.map(guild => guild.name),
    ["Beta"]
  );
});

test("an empty list produces two empty sections, not a missing one", () => {
  assert.deepEqual(splitGuilds([]), { active: [], eligible: [] });
});

/* ------------------------------------------------------------------ *
 * Search
 * ------------------------------------------------------------------ */

test("search matches a partial name, case-insensitively", () => {
  const list = [active, eligible, third];
  assert.deepEqual(
    filterGuilds(list, "al").map(guild => guild.name),
    ["Alpha"]
  );
  assert.deepEqual(
    filterGuilds(list, "BET").map(guild => guild.name),
    ["Beta"]
  );
});

test("search matches a pasted guild id", () => {
  // Pasting an id is how a guild is found when its name cannot be typed.
  assert.deepEqual(
    filterGuilds([active, eligible], "1540515175826985081").map(guild => guild.name),
    ["Beta"]
  );
});

test("a blank or whitespace-only query returns everything", () => {
  const list = [active, eligible];
  assert.equal(filterGuilds(list, "").length, 2);
  assert.equal(filterGuilds(list, "   ").length, 2);
});

test("a query with no match returns nothing rather than everything", () => {
  // The failure this guards: an empty filter falling through to "no filter",
  // which would silently show every guild when the operator searched for none.
  assert.deepEqual(filterGuilds([active, eligible], "zzz"), []);
});

/* ------------------------------------------------------------------ *
 * Welcome badge
 * ------------------------------------------------------------------ */

test("the welcome badge shows the most privileged tier held anywhere", () => {
  assert.equal(highestTier([{ ...base, tier: "moderator" }, { ...base, tier: "admin" }]), "admin");
  assert.equal(highestTier([{ ...base, tier: "moderator" }]), "moderator");
});

test("no tier anywhere yields no badge rather than a made-up one", () => {
  assert.equal(highestTier([{ ...base, tier: null }]), null);
  assert.equal(highestTier([]), null);
});

/* ------------------------------------------------------------------ *
 * Member count
 * ------------------------------------------------------------------ */

test("an unknown member count is never rendered as zero", () => {
  // The whole point: the bot is not in the guild, so nobody counted its members.
  assert.equal(formatMemberCount(null), "غير محدد");
  assert.equal(formatMemberCount(undefined), "غير محدد");
});

test("the member noun agrees with the number, as Arabic requires", () => {
  assert.equal(formatMemberCount(0), "لا أعضاء");
  assert.equal(formatMemberCount(1), "عضو واحد");
  assert.equal(formatMemberCount(2), "عضوان");
  assert.equal(formatMemberCount(5), "5 أعضاء");
  assert.equal(formatMemberCount(42), "42 عضواً");
  assert.equal(formatMemberCount(271), "271 عضو");
});

/* ------------------------------------------------------------------ *
 * Address parsing
 * ------------------------------------------------------------------ */

test("the root path is the selector", () => {
  assert.deepEqual(parsePath("/"), { kind: "guilds" });
});

test("a guild dashboard path carries the guild and its screen", () => {
  assert.deepEqual(parsePath("/dashboard/1540515175826985080"), {
    kind: "guild",
    guildId: "1540515175826985080",
    view: null
  });
  assert.deepEqual(parsePath("/dashboard/1540515175826985080/security"), {
    kind: "guild",
    guildId: "1540515175826985080",
    view: "security"
  });
});

test("a malformed guild id is not treated as a guild", () => {
  // `/dashboard/abc` is a broken link. Passing "abc" on as a guild id would earn
  // a confusing 404 from Discord instead of a clean return to the selector.
  assert.equal(parsePath("/dashboard/abc").kind, "unknown");
  assert.equal(parsePath("/dashboard").kind, "unknown");
  assert.equal(parsePath("/nonsense").kind, "unknown");
});

test("path building round-trips through parsing", () => {
  const path = guildPath("1540515175826985080", "audit");
  assert.equal(path, "/dashboard/1540515175826985080/audit");
  assert.deepEqual(parsePath(path), { kind: "guild", guildId: "1540515175826985080", view: "audit" });
  assert.equal(guildsPath(), "/");
});

/* ------------------------------------------------------------------ *
 * Render
 * ------------------------------------------------------------------ */

const render = (guilds: Guild[]) =>
  renderToString(
    createElement(GuildSelector, {
      user,
      guilds,
      health: null,
      notice: null,
      error: null,
      refreshing: false,
      onRefresh: () => {},
      onSelect: () => {},
      onLogout: () => {}
    })
  );

test("the selector renders the welcome line and the operator's name", () => {
  const html = render([active, eligible]);
  assert.match(html, /مرحباً/, "the welcome greeting is present");
  assert.match(html, /naxhz/, "the signed-in username is shown");
  assert.match(html, /اختر سيرفراً لإدارة إعدادات البوت/, "the subtitle is present");
});

test("the selector renders both sections with their actions", () => {
  const html = render([active, eligible]);
  assert.match(html, /السيرفرات النشطة/, "the active section is titled");
  assert.match(html, /سيرفرات أخرى مؤهلة/, "the eligible section is titled");
  assert.match(html, /نشط/, "an active guild is badged as active");
  assert.match(html, /غير مضاف/, "an eligible guild is badged as not added");
  assert.match(html, /إدارة/, "the active action is offered");
  assert.match(html, /إضافة البوت/, "the invite action is offered");
});

test("an eligible guild links to the invite endpoint scoped to that guild", () => {
  // The guild id in the link is what stops Discord's server picker from letting
  // the bot be added somewhere the operator did not choose.
  const html = render([eligible]);
  assert.match(html, new RegExp(`/api/guilds/${eligible.id}/invite`));
});

test("the selector shows the real member count for a guild the bot is in", () => {
  assert.match(render([active]), /271 عضو/);
});

test("the selector never renders a zero for a guild the bot is not in", () => {
  const html = render([eligible]);
  assert.match(html, /غير محدد/, "the unknown count is stated as unknown");
  assert.doesNotMatch(html, /لا أعضاء/, "and is not reported as an empty server");
});

test("an operator with no eligible guilds is told why, not left with a blank page", () => {
  const html = render([]);
  assert.match(html, /لا توجد سيرفرات مؤهلة/);
  assert.match(html, /إدارة السيرفر/, "the rule that decides the list is explained");
});

test("a notice is rendered when the operator arrives from a refused link", () => {
  const html = renderToString(
    createElement(GuildSelector, {
      user,
      guilds: [],
      health: null,
      notice: "لا تملك صلاحية الوصول إلى هذا السيرفر. اختر سيرفراً من القائمة.",
      error: null,
      refreshing: false,
      onRefresh: () => {},
      onSelect: () => {},
      onLogout: () => {}
    })
  );
  assert.match(html, /لا تملك صلاحية الوصول/);
});
