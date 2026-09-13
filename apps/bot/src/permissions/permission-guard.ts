import { requireTier, resolveTier as resolveTierFromRoles, type Tier, type TierHolder, type TierRoles } from "@al-ai/core";

// GOVERNANCE rule 3: all authorization decisions route through this guard.
// It never imports discord.js and never hard-codes a user or role ID — tiers are
// resolved from configurable Role IDs supplied by the caller, plus the automatic
// owner tier that Discord's own permission bitfield already expresses.

export type RoleCarrier = TierHolder;

/**
 * Builds the member shape the guard needs.
 *
 * `isGuildOwner` and `isAdministrator` are optional so a caller that only has
 * role IDs still works — but passing them is what makes the automatic owner tier
 * function, so the event path supplies both whenever Discord gave them to it.
 */
export function roleCarrierOf(
  roleIds: Iterable<string>,
  flags: { isGuildOwner?: boolean; isAdministrator?: boolean } = {}
): RoleCarrier {
  return { roleIds: new Set(roleIds), ...flags };
}

export function resolveTier(member: RoleCarrier, roles: TierRoles): Tier | null {
  return resolveTierFromRoles(member, roles);
}

export function authorize(member: RoleCarrier, roles: TierRoles, required: Tier) {
  const actor = resolveTier(member, roles);
  requireTier(actor, required);
  return actor;
}

export type GuardOutcome = { allowed: true; tier: Tier } | { allowed: false; reason: "NO_TIER" | "TIER_TOO_LOW" };

/** Non-throwing variant used on the event path. */
export function check(member: RoleCarrier, roles: TierRoles, required: Tier): GuardOutcome {
  const actor = resolveTier(member, roles);
  if (!actor) return { allowed: false, reason: "NO_TIER" };
  try {
    requireTier(actor, required);
  } catch {
    return { allowed: false, reason: "TIER_TOO_LOW" };
  }
  return { allowed: true, tier: actor };
}

/* ------------------------------------------------------------------ *
 * Role hierarchy
 *
 * A tier is not enough on its own: Discord also refuses an action when the
 * actor, or the bot itself, sits at or below the target's highest role. This
 * mirrors Discord's own rules so the bot rejects up front instead of letting
 * the API call fail after the fact.
 * ------------------------------------------------------------------ */

export type HierarchyInput = {
  actorId: string;
  targetId: string;
  actorHighestPosition: number;
  targetHighestPosition: number;
  botHighestPosition: number;
  actorIsGuildOwner: boolean;
  targetIsGuildOwner: boolean;
};

export type HierarchyOutcome = { allowed: true } | { allowed: false; reason: HierarchyReason };

export type HierarchyReason = "SELF_TARGET" | "TARGET_IS_OWNER" | "ACTOR_NOT_ABOVE_TARGET" | "BOT_NOT_ABOVE_TARGET";

export function checkHierarchy(input: HierarchyInput): HierarchyOutcome {
  if (input.actorId === input.targetId) return { allowed: false, reason: "SELF_TARGET" };
  if (input.targetIsGuildOwner) return { allowed: false, reason: "TARGET_IS_OWNER" };

  // The guild owner outranks everyone, so hierarchy does not restrict them —
  // only Discord's own owner protections above still apply.
  if (!input.actorIsGuildOwner && input.actorHighestPosition <= input.targetHighestPosition) {
    return { allowed: false, reason: "ACTOR_NOT_ABOVE_TARGET" };
  }
  // Discord requires the bot's own role to sit above the target's, regardless
  // of who the actor is. There is no matching rule for the actor.
  if (input.botHighestPosition <= input.targetHighestPosition) {
    return { allowed: false, reason: "BOT_NOT_ABOVE_TARGET" };
  }
  return { allowed: true };
}

/** Operator-facing wording. The detail stays internal (GOVERNANCE rule 7). */
export const hierarchyMessages: Record<HierarchyReason, string> = {
  SELF_TARGET: "لا يمكن تنفيذ الإجراء على نفسك.",
  TARGET_IS_OWNER: "لا يمكن تنفيذ الإجراء على مالك السيرفر.",
  ACTOR_NOT_ABOVE_TARGET: "رتبتك ليست أعلى من رتبة الهدف.",
  BOT_NOT_ABOVE_TARGET: "رتبة البوت ليست أعلى من رتبة الهدف."
};
