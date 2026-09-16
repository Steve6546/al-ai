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
  CHANGE_NICKNAME: 0x4000000n,

  /* The moderation and channel bits a command declares as its own requirement.
   *
   * These exist so the dashboard can tell the operator, in Discord's own terms,
   * what a command asks of the person running it. They are deliberately the
   * *native* bits rather than a re-description of AL AI's tiers: the operator
   * already grants these in Discord's role editor, so naming them is the one
   * explanation that does not have to be learned twice. */
  KICK_MEMBERS: 0x2n,
  BAN_MEMBERS: 0x4n,
  MANAGE_CHANNELS: 0x10n,
  MANAGE_MESSAGES: 0x2000n,
  MANAGE_ROLES: 0x10000000n,
  MODERATE_MEMBERS: 0x10000000000n
} as const;

export type DiscordPermissionBit = keyof typeof DISCORD_PERMISSION_BITS;

/**
 * Arabic names for those bits, as Discord's own client renders them.
 *
 * Declared here rather than in the dashboard so the label travels with the bit:
 * a permission named in two places is a permission that will eventually be
 * called two different things, which is exactly how `STATUS_LABELS` drifted out
 * of core once already.
 *
 * `ADMINISTRATOR` now has an entry, which reverses what this comment used to say.
 * Two commands genuinely need it: `/clearallwarns` and `/clearallpunishments`
 * wipe a server-wide record with no undo, and no narrower bit expresses "may
 * destroy every punishment this server has ever recorded" — `MANAGE_GUILD`
 * covers renaming a channel as well, so it would be the wider grant of the two,
 * not the narrower. Every other command still asks for the narrowest bit that
 * works. `CHANGE_NICKNAME` has no entry because nothing declares it.
 *
 * The test named above asserts every bit a command *does* declare has a name
 * here, so this map cannot fall behind the registry.
 */
export const discordPermissionLabels: Partial<Record<DiscordPermissionBit, string>> = {
  ADMINISTRATOR: "المشرف العام",
  KICK_MEMBERS: "طرد الأعضاء",
  BAN_MEMBERS: "حظر الأعضاء",
  MANAGE_CHANNELS: "إدارة القنوات",
  MANAGE_MESSAGES: "إدارة الرسائل",
  MANAGE_GUILD: "إدارة السيرفر",
  MANAGE_NICKNAMES: "إدارة الأسماء المستعارة",
  MANAGE_ROLES: "إدارة الرتب",
  MODERATE_MEMBERS: "إسكات الأعضاء"
};

/**
 * The decimal string Discord's OAuth invite expects in `permissions`.
 *
 * Administrator alone is what the invite asks for, and it is derived from the
 * bit above rather than written as a second literal — one number, one place.
 */
export const BOT_INVITE_PERMISSIONS = String(DISCORD_PERMISSION_BITS.ADMINISTRATOR);
