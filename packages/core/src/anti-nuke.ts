import { isSnowflake } from "./snowflake.js";
import {
  DEFAULT_PROTECTION_SETTINGS,
  normaliseProtectionSettings,
  type ProtectionSettingsMap
} from "./anti-nuke-registry.js";

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

export type NukeAction =
  | "channel-delete"
  | "channel-create"
  | "channel-update"
  | "channel-permissions"
  | "ban"
  | "kick"
  | "timeout"
  | "role-change"
  | "role-update"
  | "webhook-create"
  | "webhook-update"
  | "message-bulk-delete";

export type AntiNukeLimits = {
  /** Channels one actor may delete inside the window. */
  channelDeletesPerMinute: number;
  /** Channels one actor may create inside the window. */
  channelCreatesPerMinute: number;
  /** Channels one actor may edit inside the window. */
  channelUpdatesPerMinute: number;
  /** Permission overwrites one actor may change inside the window. */
  channelOverwritesPerMinute: number;
  /** Members one actor may ban inside the window. */
  bansPerMinute: number;
  /** Members one actor may kick inside the window. */
  kicksPerMinute: number;
  /** Members one actor may time out inside the window. */
  timeoutsPerMinute: number;
  /** Roles one actor may create or delete inside the window, counted together. */
  roleChangesPerMinute: number;
  /**
   * Roles one actor may *edit* inside the window.
   *
   * Deliberately its own budget rather than a share of `roleChangesPerMinute`:
   * creating and deleting are one behaviour (a burst that reshapes the role
   * list), while raising a role's permissions is privilege escalation — the
   * quiet attack that needs no new role at all. Counting them together would
   * let an attacker who only edits roles stay under a budget set for churn.
   */
  roleUpdatesPerMinute: number;
  /**
   * Webhooks one actor may *create* inside the window.
   *
   * Split from editing on purpose: adding a webhook to a channel is how a
   * message stream is copied out of the server, while editing an existing one is
   * how the server's own alerts are silenced. They are different attacks by
   * different hands, and an operator who wants one limited has not thereby asked
   * for the other to be.
   */
  webhookCreatesPerMinute: number;
  /** Webhooks one actor may edit (or delete) inside the window. */
  webhookUpdatesPerMinute: number;
  /**
   * Bulk message deletes one actor may perform inside the window.
   *
   * Counts the purge, not each message: a single `/clear` of 200 messages is
   * one act by one person, and counting messages would make the limit fire on
   * the first legitimate cleanup. Single deletions are not counted at all —
   * Discord's audit log does not record them, so they cannot be attributed.
   */
  messageBulkDeletesPerMinute: number;
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
   * The operator's switch for each protection in the registry.
   *
   * Kept next to `limits` rather than replacing them: the limits are the engine's
   * budgets (three counters, shared on purpose), and these are which of the
   * listed actions feed those counters. Collapsing the two would make a
   * guild able to set a limit for an action nothing counts.
   */
  protections: ProtectionSettingsMap;
  /**
   * The role a quarantined member is reduced to. Null means no role is set yet,
   * in which case mitigation still notifies and logs but changes no roles.
   */
  quarantineRoleId: string | null;
};

export const ANTI_NUKE_WINDOW_MS = 60_000;

export const ANTI_NUKE_ACTIONS: readonly NukeAction[] = [
  "channel-delete",
  "channel-create",
  "channel-update",
  "channel-permissions",
  "ban",
  "kick",
  "timeout",
  "role-change",
  "role-update",
  "webhook-create",
  "webhook-update",
  "message-bulk-delete"
] as const;

/** Which limit governs which action. Kept explicit so a new action cannot be added without a limit. */
export const ANTI_NUKE_LIMIT_KEYS: Record<NukeAction, keyof AntiNukeLimits> = {
  "channel-delete": "channelDeletesPerMinute",
  "channel-create": "channelCreatesPerMinute",
  "channel-update": "channelUpdatesPerMinute",
  "channel-permissions": "channelOverwritesPerMinute",
  ban: "bansPerMinute",
  kick: "kicksPerMinute",
  timeout: "timeoutsPerMinute",
  "role-change": "roleChangesPerMinute",
  "role-update": "roleUpdatesPerMinute",
  "webhook-create": "webhookCreatesPerMinute",
  "webhook-update": "webhookUpdatesPerMinute",
  "message-bulk-delete": "messageBulkDeletesPerMinute"
};

/** Operator-facing names, in the language the dashboard is written in. */
export const ANTI_NUKE_ACTION_LABELS: Record<NukeAction, string> = {
  "channel-delete": "حذف القنوات",
  "channel-create": "إنشاء القنوات",
  "channel-update": "تعديل القنوات",
  "channel-permissions": "صلاحيات القنوات",
  ban: "حظر الأعضاء",
  kick: "طرد الأعضاء",
  timeout: "عزل الأعضاء",
  "role-change": "إنشاء الرتب وحذفها",
  "role-update": "تعديل صلاحيات الرتب",
  "webhook-create": "إنشاء الويبوكات",
  "webhook-update": "تعديل الويبوكات",
  "message-bulk-delete": "حذف الرسائل الجماعي"
};

export const DEFAULT_ANTI_NUKE_LIMITS: AntiNukeLimits = {
  channelDeletesPerMinute: 3,
  channelCreatesPerMinute: 5,
  channelUpdatesPerMinute: 5,
  channelOverwritesPerMinute: 5,
  bansPerMinute: 5,
  kicksPerMinute: 5,
  timeoutsPerMinute: 5,
  roleChangesPerMinute: 3,
  roleUpdatesPerMinute: 3,
  webhookCreatesPerMinute: 3,
  webhookUpdatesPerMinute: 3,
  messageBulkDeletesPerMinute: 5
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
  protections: DEFAULT_PROTECTION_SETTINGS,
  quarantineRoleId: null
};


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
  // The pre-split field. Kept as a plain read off the raw object: it is not part
  // of `AntiNukeLimits` any more, but every row written before the split has it.
  const legacyWebhookBudget = limits.webhookChangesPerMinute;

  return {
    enabled: normaliseEnabled(source.enabled),
    limits: {
      channelDeletesPerMinute: clampLimit(limits.channelDeletesPerMinute, DEFAULT_ANTI_NUKE_LIMITS.channelDeletesPerMinute),
      channelCreatesPerMinute: clampLimit(limits.channelCreatesPerMinute, DEFAULT_ANTI_NUKE_LIMITS.channelCreatesPerMinute),
      channelUpdatesPerMinute: clampLimit(limits.channelUpdatesPerMinute, DEFAULT_ANTI_NUKE_LIMITS.channelUpdatesPerMinute),
      channelOverwritesPerMinute: clampLimit(limits.channelOverwritesPerMinute, DEFAULT_ANTI_NUKE_LIMITS.channelOverwritesPerMinute),
      bansPerMinute: clampLimit(limits.bansPerMinute, DEFAULT_ANTI_NUKE_LIMITS.bansPerMinute),
      kicksPerMinute: clampLimit(limits.kicksPerMinute, DEFAULT_ANTI_NUKE_LIMITS.kicksPerMinute),
      timeoutsPerMinute: clampLimit(limits.timeoutsPerMinute, DEFAULT_ANTI_NUKE_LIMITS.timeoutsPerMinute),
      roleChangesPerMinute: clampLimit(limits.roleChangesPerMinute, DEFAULT_ANTI_NUKE_LIMITS.roleChangesPerMinute),
      roleUpdatesPerMinute: clampLimit(limits.roleUpdatesPerMinute, DEFAULT_ANTI_NUKE_LIMITS.roleUpdatesPerMinute),
      // A config saved before the split carries one budget for both actions;
      // it seeds both rather than being dropped, so an operator's chosen number
      // survives the upgrade. Read through the old name, which is no longer part
      // of the type but is still in every row written before this change.
      webhookCreatesPerMinute: clampLimit(
        limits.webhookCreatesPerMinute ?? legacyWebhookBudget,
        DEFAULT_ANTI_NUKE_LIMITS.webhookCreatesPerMinute
      ),
      webhookUpdatesPerMinute: clampLimit(
        limits.webhookUpdatesPerMinute ?? legacyWebhookBudget,
        DEFAULT_ANTI_NUKE_LIMITS.webhookUpdatesPerMinute
      ),
      messageBulkDeletesPerMinute: clampLimit(limits.messageBulkDeletesPerMinute, DEFAULT_ANTI_NUKE_LIMITS.messageBulkDeletesPerMinute)
    },
    protections: normaliseProtectionSettings(source.protections),
    // A malformed ID is dropped rather than stored: it would never match a role,
    // so mitigation would silently do nothing while claiming to be configured.
    quarantineRoleId: isSnowflake(quarantineRoleId) ? quarantineRoleId : null
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
