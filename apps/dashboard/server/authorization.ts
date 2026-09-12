import { requireTier, type PermissionStatus, type Tier } from "@al-ai/core";
import type { Database } from "./db.js";
import { fetchMemberRoleIds, fetchBotPermissions, hasPermission, USER_PERMISSIONS } from "./discord.js";

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
}): Promise<Tier | null> {
  if (input.userIsGuildOwner) return "owner";
  if (!input.botToken) return null;

  const tiers = await input.db.getTierRoles(input.guildId);
  if (!tiers) return null;

  let roleIds: Set<string>;
  try {
    roleIds = await fetchMemberRoleIds(input.botToken, input.guildId, input.discordUserId);
  } catch {
    return null; // Not a member, or the bot lost access: deny by default.
  }

  const order: Tier[] = ["owner", "head_admin", "admin", "moderator"];
  return order.find(tier => roleIds.has(tiers[tier])) ?? null;
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
 */
export async function botIdentityPermissionStatus(botToken: string, guildId: string): Promise<PermissionStatus[]> {
  let bits: bigint;
  try {
    bits = await fetchBotPermissions(botToken, guildId);
  } catch {
    return [
      { key: "change_nickname", label: "تغيير الاسم المستعار", granted: false },
      { key: "manage_guild", label: "إدارة السيرفر", granted: false }
    ];
  }
  return [
    {
      key: "change_nickname",
      label: "تغيير الاسم المستعار",
      granted: hasPermission(bits, USER_PERMISSIONS.CHANGE_NICKNAME) || hasPermission(bits, USER_PERMISSIONS.MANAGE_NICKNAMES)
    },
    { key: "manage_guild", label: "إدارة السيرفر", granted: hasPermission(bits, USER_PERMISSIONS.MANAGE_GUILD) }
  ];
}
