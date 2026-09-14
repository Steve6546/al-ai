/**
 * The AL AI access model.
 *
 * Three tiers, and only two of them are configurable. `owner` is automatic:
 * Discord itself already knows who owns a guild and who it grants Administrator,
 * so asking the operator to re-declare that in a second place would only create
 * a way for the two answers to disagree — and a guild where nobody had
 * configured anything yet was locked out entirely.
 *
 * GOVERNANCE rule 3 still holds: the configurable tiers bind to *Role IDs*,
 * never to User IDs, and no role ID is ever hard-coded. The automatic owner tier
 * is derived from Discord's own permission bitfield, which is not a stored
 * identifier at all.
 */

export type Tier = "owner" | "admin" | "moderator";

const weight: Record<Tier, number> = { owner: 3, admin: 2, moderator: 1 };

export function canManage(actor: Tier, target: Tier) {
  return weight[actor] > weight[target];
}

export function requireTier(actor: Tier | null, needed: Tier) {
  if (!actor || weight[actor] < weight[needed]) throw new Error("UNAUTHORIZED");
}

/**
 * Tiers from highest to lowest. This is the only ordering in the codebase: the
 * dashboard renders in this order, the server validates against it, and the bot
 * resolves the effective minimum tier from it.
 */
export const tierOrder: readonly Tier[] = ["owner", "admin", "moderator"] as const;

/** Narrows an untrusted value (request body, database text) to a Tier. */
export function isTier(value: unknown): value is Tier {
  return typeof value === "string" && (tierOrder as readonly string[]).includes(value);
}

/* ------------------------------------------------------------------ *
 * Per-guild role mapping
 *
 * Two lists, both of Role IDs. `owner` has no list on purpose — see above.
 * ------------------------------------------------------------------ */

export type TierRoles = {
  /** Holds full access to the dashboard and every command. */
  adminRoleIds: readonly string[];
  /** Holds day-to-day moderation only (timeout, warn, kick). */
  moderatorRoleIds: readonly string[];
};

export const EMPTY_TIER_ROLES: TierRoles = { adminRoleIds: [], moderatorRoleIds: [] };

/** What the resolver needs to know about one member. */
export type TierHolder = {
  roleIds: ReadonlySet<string>;
  /** True when Discord reports this member as the guild's owner. */
  isGuildOwner?: boolean;
  /** True when Discord grants this member the Administrator permission. */
  isAdministrator?: boolean;
};

/**
 * Resolves a member's tier, highest first.
 *
 * The automatic owner check comes first so a guild with no mapping saved still
 * works for the people Discord already trusts.
 */
export function resolveTier(holder: TierHolder, roles: TierRoles): Tier | null {
  if (holder.isGuildOwner || holder.isAdministrator) return "owner";
  if (roles.adminRoleIds.some(id => holder.roleIds.has(id))) return "admin";
  if (roles.moderatorRoleIds.some(id => holder.roleIds.has(id))) return "moderator";
  return null;
}

/**
 * Discord snowflakes are 17-20 digits. Anything else is not a role ID.
 *
 * GOVERNANCE rule 26 — a snowflake is a string, never a number. The pattern
 * exists so an ID can be validated without ever being parsed as one: a number
 * loses precision above 2^53 and Discord's IDs sit well past it.
 */
const SNOWFLAKE = /^\d{17,20}$/;

/**
 * Narrows an untrusted value into a clean role-ID list: non-strings dropped,
 * duplicates collapsed, order preserved. Used on both sides of the database so
 * a stored list cannot mean two different things.
 */
export function normaliseRoleIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!SNOWFLAKE.test(trimmed) || seen.has(trimmed)) continue;
    seen.add(trimmed);
  }
  return [...seen];
}

export function normaliseTierRoles(value: unknown): TierRoles {
  const source = (value ?? {}) as Partial<TierRoles>;
  return {
    adminRoleIds: normaliseRoleIds(source.adminRoleIds),
    moderatorRoleIds: normaliseRoleIds(source.moderatorRoleIds)
  };
}

/**
 * A role in both lists would resolve to `admin` and the moderator entry would be
 * dead configuration the operator cannot see. Rejected on write instead of
 * silently resolved on read.
 */
export function assertDisjointTierRoles(roles: TierRoles): void {
  const admins = new Set(roles.adminRoleIds);
  const overlap = roles.moderatorRoleIds.filter(id => admins.has(id));
  if (overlap.length) {
    throw new Error(`Role ${overlap[0]} cannot be both an admin role and a moderator role.`);
  }
}
