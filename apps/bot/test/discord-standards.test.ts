import test from "node:test";
import assert from "node:assert/strict";
import { ActivityType, PermissionFlagsBits } from "discord.js";
import { activityTypeNumbers, BOT_INVITE_PERMISSIONS, DISCORD_PERMISSION_BITS } from "@al-ai/core";

/**
 * discord.js is the source of truth for Discord's own constants.
 *
 * The dashboard cannot import discord.js (GOVERNANCE rule 2 keeps it in one
 * module of the bot, and the BFF must not carry a gateway library), so the few
 * values it needs are restated in `packages/core`. A restated number is a second
 * copy, and a second copy is a second chance for the two to disagree.
 *
 * These tests close that gap: they import *both* sides and assert they are equal,
 * so a value that drifts from the official enum fails the build instead of
 * silently authorising the wrong thing. The check runs here rather than in core
 * because core is the browser-safe package and must not depend on discord.js.
 *
 * This is not hypothetical. The invite once requested MODERATE_MEMBERS where
 * ADMINISTRATOR was meant, and the bot silently could not run most of its own
 * commands — a wrong bit that no test could see.
 */

test("every shared permission bit matches discord.js PermissionFlagsBits", () => {
  const official: Record<keyof typeof DISCORD_PERMISSION_BITS, bigint> = {
    ADMINISTRATOR: PermissionFlagsBits.Administrator,
    MANAGE_GUILD: PermissionFlagsBits.ManageGuild,
    MANAGE_NICKNAMES: PermissionFlagsBits.ManageNicknames,
    CHANGE_NICKNAME: PermissionFlagsBits.ChangeNickname
  };

  for (const [name, expected] of Object.entries(official)) {
    assert.equal(
      DISCORD_PERMISSION_BITS[name as keyof typeof DISCORD_PERMISSION_BITS],
      expected,
      `${name} must equal PermissionFlagsBits.${name}`
    );
  }
});

test("the invite's permissions string is Administrator, as Discord spells it", () => {
  // Discord's OAuth endpoint takes the bitfield as a decimal string.
  assert.equal(BOT_INVITE_PERMISSIONS, String(PermissionFlagsBits.Administrator));
  assert.equal(BOT_INVITE_PERMISSIONS, "8");
});

test("Administrator is a single bit, so testing it first is meaningful", () => {
  // `hasPermission` tests Administrator before anything else because Discord
  // treats a holder as holding every permission. If Administrator ever became a
  // composite value that short-circuit would stop being correct.
  const admin = DISCORD_PERMISSION_BITS.ADMINISTRATOR;
  assert.equal(admin & (admin - 1n), 0n, "Administrator is a power of two");
});

test("every shared activity-type number matches discord.js ActivityType", () => {
  const official: Record<keyof typeof activityTypeNumbers, number> = {
    playing: ActivityType.Playing,
    listening: ActivityType.Listening,
    watching: ActivityType.Watching,
    competing: ActivityType.Competing
  };

  for (const [name, expected] of Object.entries(official)) {
    assert.equal(
      activityTypeNumbers[name as keyof typeof activityTypeNumbers],
      expected,
      `${name} must equal ActivityType.${name}`
    );
  }
});

test("no activity type is mapped to a number Discord does not define", () => {
  const known = new Set(Object.values(ActivityType).filter(value => typeof value === "number"));
  for (const [name, value] of Object.entries(activityTypeNumbers)) {
    assert.ok(known.has(value), `${name} (${value}) is not an ActivityType Discord defines`);
  }
});
