export type Tier = "owner" | "head_admin" | "admin" | "moderator";
const weight: Record<Tier, number> = { owner: 4, head_admin: 3, admin: 2, moderator: 1 };
export function canManage(actor: Tier, target: Tier) { return weight[actor] > weight[target]; }
export function requireTier(actor: Tier | null, needed: Tier) { if (!actor || weight[actor] < weight[needed]) throw new Error("UNAUTHORIZED"); }

/**
 * Tiers from highest to lowest. This is the only ordering in the codebase: the
 * dashboard renders in this order, the server validates against it, and the bot
 * resolves the effective minimum tier from it.
 */
export const tierOrder: readonly Tier[] = ["owner", "head_admin", "admin", "moderator"] as const;

/** Narrows an untrusted value (request body, database text) to a Tier. */
export function isTier(value: unknown): value is Tier {
  return typeof value === "string" && (tierOrder as readonly string[]).includes(value);
}
