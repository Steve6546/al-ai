/**
 * Discord's own permission bits, as values the whole monorepo can share.
 *
 * GOVERNANCE rule 25 — Discord's constants come from Discord's own enums. This
 * module is the single permitted restatement, and the test named below is what
 * makes the exception safe rather than merely convenient.
 *
 * The dashboard has to authorise against Discord's permission bitfield, but it
 * cannot import discord.js: `apps/dashboard/server` is a BFF that must not drag
 * a gateway library into its process, and GOVERNANCE rule 2 keeps discord.js in
 * one module of the bot. The values are therefore restated here.
 *
 * **discord.js remains the source of truth.** `apps/bot/test/discord-standards.test.ts`
 * asserts every value below equals its counterpart in `PermissionFlagsBits`, so
 * a restated number cannot drift from the official enum — the test fails instead.
 *
 * That test is the point of this module. These four numbers were previously
 * written out by hand inside `apps/dashboard/server/discord.ts`, where a wrong
 * bit had already caused a real defect once (the invite requested
 * MODERATE_MEMBERS where ADMINISTRATOR was meant, and the bot silently could not
 * run most of its own commands).
 *
 * This module is deliberately **not** exported from `browser.ts`: the values are
 * `bigint`, which is a server-side concern, and the dashboard UI has no use for
 * a raw bitfield.
 */

export const DISCORD_PERMISSION_BITS = {
  /**
   * Administrator. Discord treats a holder as holding *every* permission, so it
   * must be tested first: a naive bitwise test reports the other bits as absent.
   */
  ADMINISTRATOR: 0x8n,
  MANAGE_GUILD: 0x20n,
  MANAGE_NICKNAMES: 0x8000000n,
  CHANGE_NICKNAME: 0x4000000n
} as const;

export type DiscordPermissionBit = keyof typeof DISCORD_PERMISSION_BITS;

/**
 * The decimal string Discord's OAuth invite expects in `permissions`.
 *
 * Administrator alone is what the invite asks for, and it is derived from the
 * bit above rather than written as a second literal — one number, one place.
 */
export const BOT_INVITE_PERMISSIONS = String(DISCORD_PERMISSION_BITS.ADMINISTRATOR);
