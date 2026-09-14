import { DISCORD_PERMISSION_BITS, EMPTY_TIER_ROLES, requireTier, resolveTier, type PermissionStatus, type Tier } from "@al-ai/core";
import type { Database } from "./db.js";
import { fetchMemberRoleIds, fetchBotPermissions, hasPermission } from "./discord.js";

export class AuthorizationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "AuthorizationError";
  }
}

/**
 * Resolves the caller's AL AI tier inside one guild.
 *
 * This runs on the server for every write. The browser can never assert its own
 * tier, and a stale client state cannot authorize anything.
 */
export async function resolveActorTier(input: {
  db: Database;
  botToken: string | null;
  guildId: string;
  discordUserId: string;
  userIsGuildOwner: boolean;
  /** Discord's own verdict: this member holds Administrator in the guild. */
  userIsAdministrator: boolean;
}): Promise<Tier | null> {
  // Zero-config access: Discord already knows who owns a guild and whom it
  // trusts with Administrator, so those members hold the top tier immediately.
  // Re-declaring that in a second place only created a way for the two answers
  // to disagree, and left a fresh guild locked out of its own dashboard.
  if (input.userIsGuildOwner || input.userIsAdministrator) return "owner";
  if (!input.botToken) return null;

  // A guild with no saved mapping is not a lockout — it simply has no extra
  // admin or moderator roles beyond Discord's own.
  const roles = (await input.db.getTierRoles(input.guildId)) ?? EMPTY_TIER_ROLES;

  let roleIds: Set<string>;
  try {
    roleIds = await fetchMemberRoleIds(input.botToken, input.guildId, input.discordUserId);
  } catch {
    return null; // Not a member, or the bot lost access: deny by default.
  }

  return resolveTier({ roleIds }, roles);
}

/** Throws unless the actor's tier strictly outranks the required tier. */
export function assertTier(actor: Tier | null, required: Tier) {
  try {
    requireTier(actor, required);
  } catch {
    throw new AuthorizationError("FORBIDDEN", "صلاحيتك لا تسمح بهذا الإجراء.");
  }
}

/**
 * Reports the bot's own Discord permissions for the actions the dashboard
 * offers, so the UI can disable an action instead of letting it fail.
 *
 * A failed read yields `granted: null` ("unknown"), never `false`. The two are
 * not interchangeable: `false` is a claim about the bot, and callers act on it
 * by blocking writes. Turning an outage into `false` would refuse a save the bot
 * is perfectly able to perform, and would do so with a message naming a missing
 * permission that is in fact present.
 */
export async function botIdentityPermissionStatus(botToken: string, guildId: string): Promise<PermissionStatus[]> {
  const bits = await fetchBotPermissions(botToken, guildId);
  return [
    {
      key: "change_nickname",
      label: "تغيير الاسم المستعار",
      granted: bits === null
        ? null
        : hasPermission(bits, DISCORD_PERMISSION_BITS.CHANGE_NICKNAME) || hasPermission(bits, DISCORD_PERMISSION_BITS.MANAGE_NICKNAMES)
    },
    {
      key: "manage_guild",
      label: "إدارة السيرفر",
      granted: bits === null ? null : hasPermission(bits, DISCORD_PERMISSION_BITS.MANAGE_GUILD)
    }
  ];
}
