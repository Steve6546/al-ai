/**
 * Anti-nuke: rate limits on destructive actions, and what a breach means.
 *
 * A "nuke" is not a single dramatic act — it is a burst. One moderator deleting
 * one channel is routine; the same account deleting six in twenty seconds is an
 * attack, and by the time a human notices, the server is gone. The defence is
 * therefore a count inside a window, which is what this module decides.
 *
 * Everything here is pure. The bot supplies the counts and performs the
 * mitigation; this file only answers "has this crossed the line?".
 */

export type NukeAction = "channel-delete" | "ban" | "role-change";

export type AntiNukeLimits = {
  /** Channels one actor may delete inside the window. */
  channelDeletesPerMinute: number;
  /** Members one actor may ban inside the window. */
  bansPerMinute: number;
  /** Roles one actor may create or delete inside the window, counted together. */
  roleChangesPerMinute: number;
};

export type AntiNukeConfig = {
  /**
   * Armed unless the operator disarms it.
   *
   * This was the other way round while the engine was being built: mitigation
   * strips a moderator's roles, which is itself destructive, so it shipped
   * disarmed until the owner had decided. The owner has now decided, so a guild
   * is protected from the moment AL AI joins — the failure mode of a forgotten
   * setting is a wiped server, and that is not a coin worth flipping.
   *
   * Disarming is one switch in the security screen, and it is honoured.
   */
  enabled: boolean;
  limits: AntiNukeLimits;
  /**
   * The role a quarantined member is reduced to. Null means no role is set yet,
   * in which case mitigation still notifies and logs but changes no roles.
   */
  quarantineRoleId: string | null;
};

export const ANTI_NUKE_WINDOW_MS = 60_000;

export const ANTI_NUKE_ACTIONS: readonly NukeAction[] = ["channel-delete", "ban", "role-change"] as const;

/** Which limit governs which action. Kept explicit so a new action cannot be added without a limit. */
export const ANTI_NUKE_LIMIT_KEYS: Record<NukeAction, keyof AntiNukeLimits> = {
  "channel-delete": "channelDeletesPerMinute",
  ban: "bansPerMinute",
  "role-change": "roleChangesPerMinute"
};

/** Operator-facing names, in the language the dashboard is written in. */
export const ANTI_NUKE_ACTION_LABELS: Record<NukeAction, string> = {
  "channel-delete": "حذف القنوات",
  ban: "حظر الأعضاء",
  "role-change": "إنشاء الرتب وحذفها"
};

export const DEFAULT_ANTI_NUKE_LIMITS: AntiNukeLimits = {
  channelDeletesPerMinute: 3,
  bansPerMinute: 5,
  roleChangesPerMinute: 3
};

/**
 * Ceiling for any single limit.
 *
 * Without it, a mistyped `100000` silently disables the engine — the operator
 * would believe they are protected while nothing can ever trip.
 */
export const MAX_ANTI_NUKE_LIMIT = 100;

export const DEFAULT_ANTI_NUKE_CONFIG: AntiNukeConfig = {
  enabled: true,
  limits: DEFAULT_ANTI_NUKE_LIMITS,
  quarantineRoleId: null
};

const SNOWFLAKE = /^\d{17,20}$/;

/**
 * Coerces a stored or submitted value into a limit.
 *
 * The floor is 1, not 0: a limit of zero would trip on the very first action,
 * which reads as "the engine works" while actually blocking all moderation.
 */
function clampLimit(value: unknown, fallback: number): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(MAX_ANTI_NUKE_LIMIT, Math.max(1, Math.trunc(numeric)));
}

/**
 * Reads the armed flag.
 *
 * The failure modes stopped being symmetric when the engine started shipping
 * armed, so this is deliberately explicit rather than a truthiness test:
 *
 *   - An explicit `false` must survive in every shape it can arrive in — a JSON
 *     body, a boolean column, or the string a form would produce. Losing an
 *     opt-out would re-arm a protection the operator deliberately switched off.
 *   - Anything unrecognised falls back to the documented default instead of
 *     being read as consent. A stray `null` from an absent column must not be
 *     interpreted as a decision either way.
 */
function normaliseEnabled(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (value === "false" || value === "0" || value === 0) return false;
  if (value === "true" || value === "1" || value === 1) return true;
  return DEFAULT_ANTI_NUKE_CONFIG.enabled;
}

/** Coerces an untrusted value — a JSON body, or a row read back from the database. */
export function normaliseAntiNukeConfig(value: unknown): AntiNukeConfig {
  const source = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const limits = (source.limits && typeof source.limits === "object" ? source.limits : {}) as Record<string, unknown>;
  const quarantineRoleId = typeof source.quarantineRoleId === "string" ? source.quarantineRoleId.trim() : "";

  return {
    enabled: normaliseEnabled(source.enabled),
    limits: {
      channelDeletesPerMinute: clampLimit(limits.channelDeletesPerMinute, DEFAULT_ANTI_NUKE_LIMITS.channelDeletesPerMinute),
      bansPerMinute: clampLimit(limits.bansPerMinute, DEFAULT_ANTI_NUKE_LIMITS.bansPerMinute),
      roleChangesPerMinute: clampLimit(limits.roleChangesPerMinute, DEFAULT_ANTI_NUKE_LIMITS.roleChangesPerMinute)
    },
    // A malformed ID is dropped rather than stored: it would never match a role,
    // so mitigation would silently do nothing while claiming to be configured.
    quarantineRoleId: SNOWFLAKE.test(quarantineRoleId) ? quarantineRoleId : null
  };
}

export type NukeAssessment = {
  action: NukeAction;
  /** How many of this action the actor has performed inside the window. */
  count: number;
  limit: number;
  /** True when the count is past the limit and mitigation must run. */
  tripped: boolean;
};

/**
 * Compares a window count against the configured limit.
 *
 * The limit is inclusive: a limit of 3 permits three actions and trips on the
 * fourth. Tripping *at* the limit would punish an actor for the exact behaviour
 * the operator said was allowed.
 */
export function assessNukeAction(action: NukeAction, count: number, limits: AntiNukeLimits): NukeAssessment {
  const limit = limits[ANTI_NUKE_LIMIT_KEYS[action]];
  return { action, count, limit, tripped: count > limit };
}
