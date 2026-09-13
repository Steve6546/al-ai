/**
 * Guild access classification for the selector.
 *
 * GOVERNANCE: the browser never interprets a permission bitfield. The server
 * decides which section a guild belongs to and which actions it offers, so the
 * selector and the in-dashboard guild switcher cannot disagree about the same
 * guild — both read this one classification.
 *
 * The rules live here, apart from the route, because they are pure: they depend
 * only on the caller's bitfield and on what the bot can see. Keeping them out of
 * the Fastify handler is what makes them testable without a database.
 */

import type { Tier } from "@al-ai/core";
import { guildIconUrl, hasPermission, USER_PERMISSIONS, type DiscordUserGuild } from "./discord.js";

export type GuildSummary = {
  id: string;
  name: string;
  iconUrl: string | null;
  /** `null` means "not knowable", never zero. See the note in `describeGuildAccess`. */
  memberCount: number | null;
  tier: Tier | null;
  botPresent: boolean;
  canManage: boolean;
  canManageIdentity: boolean;
  canManageLogging: boolean;
  canManageCommands: boolean;
  canManageTiers: boolean;
  canInvite: boolean;
};

/**
 * Discord's own verdict on whether the caller may administer this guild.
 *
 * `hasPermission` treats Administrator as holding every bit, so an admin passes
 * without the check being written twice. `MANAGE_GUILD` is the floor: someone
 * who cannot manage the guild cannot be shown a dashboard that edits it.
 */
export function isAdministrable(permissions: bigint): boolean {
  return hasPermission(permissions, USER_PERMISSIONS.MANAGE_GUILD);
}

/**
 * Derives the flags for one guild.
 *
 * The caller resolves `tier` (it needs the bot's role list) and `memberCount`
 * (the bot is the only layer that can read it), then hands both in. Two
 * invariants are enforced here rather than trusted to the caller, because
 * getting either wrong produces a plausible-looking lie rather than an error:
 *
 * - A guild the bot has not joined reports `memberCount: null`. Reporting `0`
 *   would render as "no members" for a server that may have thousands.
 * - A guild the bot has not joined reports `tier: null`. Without a role list
 *   there is nothing to resolve against, so any tier would be invented.
 *
 * Every flag that depends on the tier therefore reads false for a guild the bot
 * is absent from — correctly, since there is nothing to manage there yet.
 */
export function describeGuildAccess(input: {
  guild: DiscordUserGuild;
  botPresent: boolean;
  memberCount: number | null;
  tier: Tier | null;
}): GuildSummary {
  const { guild, botPresent } = input;
  const tier = botPresent ? input.tier : null;

  return {
    id: guild.id,
    name: guild.name,
    iconUrl: guildIconUrl(guild.id, guild.icon),
    memberCount: botPresent ? input.memberCount : null,
    tier,
    botPresent,
    canManage: isAdministrable(guild.permissions),
    canManageIdentity: tier !== null,
    canManageLogging: tier !== null,
    canManageCommands: tier !== null,
    // Role mapping decides who can do everything else, so it needs the admin
    // tier or above — a moderator must not be able to widen their own access by
    // editing the list.
    canManageTiers: tier === "owner" || tier === "admin",
    canInvite: hasPermission(guild.permissions, USER_PERMISSIONS.MANAGE_GUILD)
  };
}
