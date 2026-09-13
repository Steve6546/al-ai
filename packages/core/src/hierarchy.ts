/**
 * Role-hierarchy and boost-level rules.
 *
 * Two Discord restrictions cause the same failure mode: the operator fills in a
 * field, presses save, and gets an opaque error. Both are knowable in advance,
 * so both are decided here and surfaced as a locked field or an advisory.
 *
 * These functions are pure on purpose. The dashboard feeds them values it read
 * from Discord, and the tests feed them values by hand — no network, no clock.
 */

/**
 * The boost level at which Discord unlocks role icons.
 *
 * Below this, `PATCH /guilds/{id}/roles/{roleId}` with an icon answers
 * `400 Bad Request`. Discord documents no friendlier code, so the guard has to
 * happen before the request rather than after it.
 */
export const ROLE_ICON_MIN_PREMIUM_TIER = 2;

export type RoleIconGate = {
  /** True when Discord would reject an icon for this guild right now. */
  locked: boolean;
  /** Why it is locked, in the operator's language. Null when it is not locked. */
  reason: string | null;
  /**
   * True when the boost level could not be read at all.
   *
   * The field stays unlocked in this case: refusing to accept input because our
   * own read failed would punish the operator for our outage, and the bot
   * validates again before it writes.
   */
  unknown: boolean;
};

/**
 * Decides whether the role-icon field may be used.
 *
 * `premiumTier` is null when the guild record could not be read.
 */
export function assessRoleIconGate(premiumTier: number | null): RoleIconGate {
  if (premiumTier === null) return { locked: false, reason: null, unknown: true };
  if (premiumTier >= ROLE_ICON_MIN_PREMIUM_TIER) return { locked: false, reason: null, unknown: false };
  return {
    locked: true,
    reason:
      `أيقونة الرتبة تتطلب مستوى تعزيز السيرفر ${ROLE_ICON_MIN_PREMIUM_TIER} على الأقل. ` +
      `سيرفرك حالياً في المستوى ${premiumTier}، وسيرفض Discord الحفظ بخطأ 400.`,
    unknown: false
  };
}

export type RoleHierarchyVerdict = {
  /** Position of the bot's own highest role. */
  botPosition: number;
  /** Highest position among the roles the bot is asked to manage, or null. */
  highestManagedPosition: number | null;
  /**
   * True when at least one managed role sits at or above the bot's own.
   *
   * Discord compares positions, not permissions: a role at the *same* position
   * is already out of reach, which is why this is `>=` and not `>`.
   */
  blocked: boolean;
  /** What to tell the operator. Null when nothing is wrong. */
  message: string | null;
};

/**
 * Compares the bot's standing against the roles it is expected to act on.
 *
 * `managedPositions` is every admin and moderator role position the operator
 * configured. An empty list means nothing is configured yet, which is not a
 * problem to report — the bot simply has nothing it must outrank.
 */
export function assessRoleHierarchy(botPosition: number, managedPositions: number[]): RoleHierarchyVerdict {
  if (managedPositions.length === 0) {
    return { botPosition, highestManagedPosition: null, blocked: false, message: null };
  }

  const highestManagedPosition = Math.max(...managedPositions);
  const blocked = highestManagedPosition >= botPosition;

  return {
    botPosition,
    highestManagedPosition,
    blocked,
    message: blocked
      ? `رتبة AL AI في المرتبة ${botPosition}، وأعلى رتبة إدارية في المرتبة ${highestManagedPosition}. ` +
        "Discord لا يسمح للبوت بتعديل رتبة مساوية لرتبته أو أعلى منها، فارفع رتبة AL AI فوق الرتب الإدارية."
      : null
  };
}
