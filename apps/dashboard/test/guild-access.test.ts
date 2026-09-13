import test from "node:test";
import assert from "node:assert/strict";
import { describeGuildAccess, isAdministrable } from "../server/guild-access.js";
import { USER_PERMISSIONS, type DiscordUserGuild } from "../server/discord.js";

/* ------------------------------------------------------------------ *
 * The selector's data contract.
 *
 * The browser never reads a permission bitfield, so the two things worth
 * pinning down are: who is allowed into the list at all, and what the selector
 * is told about a guild the bot has not joined. The second is where a wrong
 * answer is dangerous rather than merely wrong — a fabricated member count
 * renders as real data.
 * ------------------------------------------------------------------ */

const GUILD_ID = "1540515175826985080";

function guild(overrides: Partial<DiscordUserGuild> = {}): DiscordUserGuild {
  return {
    id: GUILD_ID,
    name: "سيرفر الاختبار",
    icon: null,
    owner: false,
    permissions: USER_PERMISSIONS.MANAGE_GUILD,
    ...overrides
  };
}

test("MANAGE_GUILD is enough to appear in the selector", () => {
  assert.equal(isAdministrable(USER_PERMISSIONS.MANAGE_GUILD), true);
});

test("Administrator is enough, because Discord grants it every bit", () => {
  assert.equal(isAdministrable(USER_PERMISSIONS.ADMINISTRATOR), true);
});

test("a guild the caller cannot manage is dropped, not listed and then refused", () => {
  assert.equal(isAdministrable(0n), false);
  // A bitfield of unrelated permissions must not be mistaken for standing.
  assert.equal(isAdministrable(USER_PERMISSIONS.MANAGE_NICKNAMES | USER_PERMISSIONS.CHANGE_NICKNAME), false);
});

test("an administrable guild with the bot is fully manageable", () => {
  const summary = describeGuildAccess({
    guild: guild(),
    botPresent: true,
    memberCount: 271,
    tier: "owner"
  });

  assert.equal(summary.botPresent, true);
  assert.equal(summary.canManage, true);
  assert.equal(summary.canInvite, true);
  assert.equal(summary.memberCount, 271);
  assert.equal(summary.tier, "owner");
  assert.equal(summary.canManageIdentity, true);
  assert.equal(summary.canManageLogging, true);
  assert.equal(summary.canManageCommands, true);
  assert.equal(summary.canManageTiers, true);
});

test("an administrable guild without the bot keeps its real name and offers the invite", () => {
  const summary = describeGuildAccess({
    guild: guild({ name: "سيرفر آخر" }),
    botPresent: false,
    memberCount: null,
    tier: null
  });

  assert.equal(summary.name, "سيرفر آخر");
  assert.equal(summary.botPresent, false);
  assert.equal(summary.canManage, true, "the caller can still add the bot");
  assert.equal(summary.canInvite, true);
  assert.equal(summary.tier, null);
});

test("a guild without the bot never reports a member count, even if one is passed in", () => {
  // The invariant is enforced in the classifier, not trusted to the caller:
  // `0` would render as an empty server rather than an unknown one.
  const summary = describeGuildAccess({
    guild: guild(),
    botPresent: false,
    memberCount: 271,
    tier: "owner"
  });

  assert.equal(summary.memberCount, null, "a stale count must not leak through");
  assert.equal(summary.tier, null, "a tier cannot be resolved without the bot's role list");
});

test("a guild without the bot exposes no management flags", () => {
  const summary = describeGuildAccess({
    guild: guild(),
    botPresent: false,
    memberCount: null,
    tier: null
  });

  assert.equal(summary.canManageIdentity, false);
  assert.equal(summary.canManageLogging, false);
  assert.equal(summary.canManageCommands, false);
  assert.equal(summary.canManageTiers, false);
});

test("a moderator tier may manage settings but not the role mapping", () => {
  const summary = describeGuildAccess({
    guild: guild(),
    botPresent: true,
    memberCount: 12,
    tier: "moderator"
  });

  assert.equal(summary.canManageIdentity, true);
  assert.equal(summary.canManageLogging, true);
  assert.equal(summary.canManageCommands, true);
  assert.equal(summary.canManageTiers, false, "a moderator must not widen their own access");
});

test("the admin tier may edit the role mapping", () => {
  const summary = describeGuildAccess({ guild: guild(), botPresent: true, memberCount: 12, tier: "admin" });
  assert.equal(summary.canManageTiers, true);
});

test("a guild the caller does not administer carries no flags even if asked for", () => {
  // Defence in depth: the route filters first, but the classifier must not
  // describe a guild the caller has no standing in as manageable.
  const summary = describeGuildAccess({
    guild: guild({ permissions: 0n }),
    botPresent: true,
    memberCount: 5,
    tier: "owner"
  });

  assert.equal(summary.canManage, false);
  assert.equal(summary.canInvite, false);
});

test("a guild with no icon reports null rather than an invented URL", () => {
  const summary = describeGuildAccess({ guild: guild({ icon: null }), botPresent: true, memberCount: 3, tier: "owner" });
  assert.equal(summary.iconUrl, null);
});

test("a guild with an icon gets a real CDN URL built from its hash", () => {
  const summary = describeGuildAccess({
    guild: guild({ icon: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6" }),
    botPresent: true,
    memberCount: 3,
    tier: "owner"
  });

  assert.match(summary.iconUrl ?? "", /^https:\/\/cdn\.discordapp\.com\/icons\/\d+\//);
  assert.ok(summary.iconUrl?.includes("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"));
});

test("the guild id survives as a string and is never coerced to a number", () => {
  // Snowflake IDs exceed Number.MAX_SAFE_INTEGER; a numeric round-trip would
  // silently corrupt the last digits and point the dashboard at a dead guild.
  const summary = describeGuildAccess({
    guild: guild({ id: "999999999999999999" }),
    botPresent: true,
    memberCount: 1,
    tier: "owner"
  });

  assert.equal(typeof summary.id, "string");
  assert.equal(summary.id, "999999999999999999");
});
