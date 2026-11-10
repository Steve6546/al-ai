import type { AntiNukeLimits, NukeAction } from "./anti-nuke.js";
import type { DiscordPermissionBit } from "./discord-permissions.js";
import { isSnowflake } from "./snowflake.js";

/**
 * What the anti-nuke engine could watch, in the order an operator thinks about it.
 *
 * `anti-nuke.ts` holds the three budgets the engine enforces *today*. This file
 * holds the wider set of destructive actions a burst can be made of — grouped the
 * way Discord's own role editor groups them, because that is the vocabulary the
 * operator already has. It is a registry, not a feature flag list: every entry
 * names the audit-log event that would prove the action happened and the native
 * permission bit that makes the action possible at all.
 *
 * Two rules keep it honest:
 *
 * - A protection with a `limitKey` is one the engine counts. One without it is
 *   declared but **not enforced**, and the dashboard must say so rather than
 *   render a control that changes nothing.
 * - The set of `limitKey`s must match `ANTI_NUKE_ACTIONS` exactly. That is
 *   asserted in `packages/core/test/anti-nuke-registry.test.ts`, because two
 *   tables describing one engine is how a screen ends up offering a limit that
 *   nothing reads.
 */

export type NukeFamily = "channels" | "roles" | "members" | "webhooks" | "content";

/**
 * Every protection, by key.
 *
 * A union rather than `string` because the operator's per-protection switches are
 * stored as a JSON object: an unlisted key must be rejected at the boundary, not
 * accepted and then read by nothing — a typo that persists is a setting that
 * silently does nothing forever.
 */
export type NukeProtectionKey =
  | "channel-delete"
  | "channel-create"
  | "channel-update"
  | "channel-permissions"
  | "role-create"
  | "role-delete"
  | "role-update"
  | "member-ban"
  | "member-kick"
  | "member-timeout"
  | "webhook-create"
  | "webhook-update"
  | "message-purge";

export type NukeProtection = {
  /** Stable identifier. Never shown to the operator, never renamed for cosmetics. */
  key: NukeProtectionKey;
  family: NukeFamily;
  label: string;
  /** One line in the operator's language: what stops when this protection fires. */
  description: string;
  /**
   * Discord's own audit-log events for this action, by their official names.
   *
   * Plural because one protection can cover a family of events — channel
   * permission edits arrive as three separate events, and an operator who
   * deletes an overwrite and a member who edits one are the same incident.
   */
  auditEvents: readonly string[];
  /** The bit a member needs to perform the action. `ADMINISTRATOR` implies all. */
  permission: DiscordPermissionBit;
  /**
   * The bounds of the per-minute limit.
   *
   * `min` is 1 everywhere: a limit of 0 would trip on the first action, which
   * reads as "protected" while actually forbidding all moderation. `max` is the
   * engine's own ceiling (`MAX_ANTI_NUKE_LIMIT`) so a mistyped huge number cannot
   * silently switch a protection off.
   */
  limit: { min: number; max: number; default: number };
  /** The limit this protection reads when the engine counts it. Absent = not enforced. */
  limitKey?: keyof AntiNukeLimits;
};

export const NUKE_FAMILY_LABELS: Record<NukeFamily, string> = {
  channels: "حماية الرومات / الشاتات",
  roles: "حماية الرتب",
  members: "حماية الأعضاء",
  webhooks: "حماية الويبوك",
  content: "حماية المحتوى"
};

export const NUKE_FAMILIES: readonly NukeFamily[] = ["channels", "roles", "members", "webhooks", "content"];

export const NUKE_PROTECTIONS: readonly NukeProtection[] = [
  /* ---------------- Channels ----------------
   * Deleting a channel is the classic nuke; creating one is how an attacker
   * stages a fake "announcement" channel; editing and overwriting are how they
   * make it visible or lock people out of the real one. */
  {
    key: "channel-delete",
    family: "channels",
    label: "مكافحة حذف القنوات",
    description: "منع حذف قنوات السيرفر بشكل جماعي.",
    auditEvents: ["ChannelDelete"],
    permission: "MANAGE_CHANNELS",
    limit: { min: 1, max: 100, default: 3 },
    limitKey: "channelDeletesPerMinute"
  },
  {
    key: "channel-create",
    family: "channels",
    label: "مكافحة إنشاء القنوات",
    description: "منع إنشاء قنوات جماعي لتمرير إعلانات مزوّرة.",
    auditEvents: ["ChannelCreate"],
    permission: "MANAGE_CHANNELS",
    limit: { min: 1, max: 100, default: 5 },
    limitKey: "channelCreatesPerMinute"
  },
  {
    key: "channel-update",
    family: "channels",
    label: "مكافحة تعديل القنوات",
    description: "منع تعديل أسماء القنوات وخصائصها بشكل جماعي.",
    auditEvents: ["ChannelUpdate"],
    permission: "MANAGE_CHANNELS",
    limit: { min: 1, max: 100, default: 5 },
    limitKey: "channelUpdatesPerMinute"
  },
  {
    key: "channel-permissions",
    family: "channels",
    label: "حماية صلاحيات القنوات",
    description: "منع تعديل أذونات القنوات (Allow/Deny/Overwrites) لعزل الأعضاء.",
    auditEvents: ["ChannelOverwriteCreate", "ChannelOverwriteUpdate", "ChannelOverwriteDelete"],
    permission: "MANAGE_CHANNELS",
    limit: { min: 1, max: 100, default: 5 },
    limitKey: "channelOverwritesPerMinute"
  },

  /* ---------------- Roles ----------------
   * Create and delete are one budget in the engine — a burst that makes ten roles
   * and one that removes ten are the same attack, counted together. That shared
   * budget is stated in the UI rather than hidden, because two rows reading one
   * number looks like a bug otherwise. */
  {
    key: "role-create",
    family: "roles",
    label: "مكافحة إنشاء الرتب",
    description: "منع إنشاء رتب جماعي لانتحال صلاحيات إشراف.",
    auditEvents: ["RoleCreate"],
    permission: "MANAGE_ROLES",
    limit: { min: 1, max: 100, default: 3 },
    limitKey: "roleChangesPerMinute"
  },
  {
    key: "role-delete",
    family: "roles",
    label: "مكافحة حذف الرتب",
    description: "منع حذف رتب الإشراف لإسقاط الصلاحيات.",
    auditEvents: ["RoleDelete"],
    permission: "MANAGE_ROLES",
    limit: { min: 1, max: 100, default: 3 },
    limitKey: "roleChangesPerMinute"
  },
  {
    key: "role-update",
    family: "roles",
    label: "مكافحة تعديل الرتب",
    description: "منع رفع صلاحيات رتبة قائمة إلى مستوى الإدارة.",
    auditEvents: ["RoleUpdate"],
    permission: "MANAGE_ROLES",
    limit: { min: 1, max: 100, default: 3 },
    limitKey: "roleUpdatesPerMinute"
  },

  /* ---------------- Members ----------------
   * The three ways to remove a person's access, each with its own budget. They
   * are not interchangeable: a ban is permanent, a kick is reversible, and a
   * timeout is temporary — an operator who tolerates a kick storm is not
   * thereby tolerating bans, so one number for all three would either punish
   * the mild case or wave through the severe one. */
  {
    key: "member-ban",
    family: "members",
    label: "مكافحة الحظر",
    description: "منع الحظر الجماعي للأعضاء.",
    auditEvents: ["MemberBanAdd"],
    permission: "BAN_MEMBERS",
    limit: { min: 1, max: 100, default: 5 },
    limitKey: "bansPerMinute"
  },
  {
    key: "member-kick",
    family: "members",
    label: "مكافحة الطرد",
    description: "منع الطرد الجماعي للأعضاء (المطرود يستطيع العودة، بعكس المحظور).",
    auditEvents: ["MemberKick"],
    permission: "KICK_MEMBERS",
    limit: { min: 1, max: 100, default: 5 },
    limitKey: "kicksPerMinute"
  },
  {
    key: "member-timeout",
    family: "members",
    label: "مكافحة العزل",
    description: "منع العزل الجماعي للأعضاء (timeout).",
    auditEvents: ["MemberUpdate"],
    permission: "MODERATE_MEMBERS",
    limit: { min: 1, max: 100, default: 5 },
    limitKey: "timeoutsPerMinute"
  },

  /* ---------------- Webhooks ----------------
   * Two protections, not one budget for three events.
   *
   * They answer different questions and are carried out by different hands:
   * *creating* a webhook is how a channel's message stream is copied out of the
   * server (a webhook posts as the server, so nobody sees a stranger), while
   * *editing or deleting* an existing one is how the server's own alerts are
   * silenced. Sharing a budget meant an operator could not limit the first
   * without also moving the second, and the event feed could not say which of
   * the two had fired. Deleting stays with editing: both are changes to a
   * webhook that already exists and both need the same permission.
   */
  {
    key: "webhook-create",
    family: "webhooks",
    label: "مكافحة إنشاء الويبوك",
    description: "منع إنشاء ويبوكات في القنوات — الطريق المعتاد لسرقة الرسائل وانتحال شخصية السيرفر.",
    auditEvents: ["WebhookCreate"],
    permission: "MANAGE_WEBHOOKS",
    limit: { min: 1, max: 100, default: 3 },
    limitKey: "webhookCreatesPerMinute"
  },
  {
    key: "webhook-update",
    family: "webhooks",
    label: "مكافحة تعديل الويبوك",
    description: "منع تعديل ويبوك قائم أو حذفه — تغيير وجهته يسرق الرسائل، وحذفه يعطّل التنبيهات.",
    auditEvents: ["WebhookUpdate", "WebhookDelete"],
    permission: "MANAGE_WEBHOOKS",
    limit: { min: 1, max: 100, default: 3 },
    limitKey: "webhookUpdatesPerMinute"
  },

  /* ---------------- Content ----------------
   * The wipe that does not touch structure: a bulk delete erases the channel's
   * history while every channel and role stays exactly where it was, so the three
   * structural budgets never notice it. */
  {
    key: "message-purge",
    family: "content",
    label: "مكافحة حذف الرسائل",
    description: "منع الحذف الجماعي للرسائل لإفراغ القنوات من محتواها.",
    auditEvents: ["MessageBulkDelete", "MessageDelete"],
    permission: "MANAGE_MESSAGES",
    limit: { min: 1, max: 100, default: 5 },
    limitKey: "messageBulkDeletesPerMinute"
  }
];

/**
 * The audit-log event names Discord defines, copied from the official payload
 * types (`discord-api-types/payloads/v10/auditLog.d.ts`, the enum the installed
 * discord.js 14.27 re-exports).
 *
 * This exists so the registry's `auditEvents` are checked rather than trusted:
 * a typo in an event name is a protection that silently never fires, and nothing
 * in TypeScript would notice, because they are strings here.
 */
export const DISCORD_AUDIT_EVENTS = [
  "ChannelCreate",
  "ChannelUpdate",
  "ChannelDelete",
  "ChannelOverwriteCreate",
  "ChannelOverwriteUpdate",
  "ChannelOverwriteDelete",
  "MemberKick",
  "MemberPrune",
  "MemberBanAdd",
  "MemberBanRemove",
  "MemberUpdate",
  "MemberRoleUpdate",
  "MemberMove",
  "MemberDisconnect",
  "RoleCreate",
  "RoleUpdate",
  "RoleDelete",
  "WebhookCreate",
  "WebhookUpdate",
  "WebhookDelete",
  "MessageDelete",
  "MessageBulkDelete",
  "MessagePin",
  "MessageUnpin"
] as const satisfies readonly string[];

/**
 * The operator's per-protection switch.
 *
 * One field today, and deliberately an object rather than a bare boolean map:
 * the limit, the punishment, the window and the member exceptions all land here
 * in the rounds after this one, and a JSON column shaped as
 * `{ "channel-delete": { ... } }` grows without a migration each time. A flat
 * `boolean` map would have to be rewritten the day the second field arrives.
 */
export type ProtectionPunishment = "ban" | "kick" | "timeout" | "remove-roles" | "warn";

export const PROTECTION_PUNISHMENTS: readonly ProtectionPunishment[] = ["ban", "kick", "timeout", "remove-roles", "warn"] as const;

export function isProtectionPunishment(value: unknown): value is ProtectionPunishment {
  return typeof value === "string" && (PROTECTION_PUNISHMENTS as readonly string[]).includes(value);
}

export type ProtectionSettings = {
  /**
   * Off means the engine does not count this action at all for this guild.
   *
   * Defaulted to on, because the registry lists protections the engine mostly
   * does *not* enforce yet — a default of off would make the badge read 0/13 for
   * a guild that has never opened the screen, which is the opposite of the truth.
   */
  enabled: boolean;
  /**
   * How many seconds the burst window covers for THIS protection.
   *
   * Per-protection rather than one engine-wide number: a channel delete storm is
   * fast and wants a tight window, while a slow role edit drip wants a long one.
   * Defaults to 600s. The tracker is handed this per call, so two protections on
   * the same action never share a window.
   */
  windowSeconds: number;
  /**
   * What happens to the actor when this protection trips. Independent per
   * protection — changing one must never move another.
   *
   * `remove-roles` is the historic behaviour (strip roles, then the quarantine
   * role); the rest are named Discord actions. Defaulted to `remove-roles` so an
   * existing row keeps the behaviour it had before this field existed.
   */
  punishment: ProtectionPunishment;
  /** Seconds for the `timeout` punishment. Ignored by every other punishment. */
  timeoutSeconds: number;
  /**
   * Members this protection never counts, as Discord user IDs.
   *
   * A person the operator trusts with a bulk job — the community manager moving
   * a category, a bot-adjacent account re-importing channels — performs exactly
   * the burst the engine is built to stop. Without this list the only ways out
   * were to disarm the protection for everybody or to punish an ally, so the
   * engine reads this before it counts anything.
   *
   * IDs only, never names: two members can share a display name, and a list that
   * matched on one would exempt the wrong person. Snowflakes are validated at
   * the boundary for the same reason `quarantineRoleId` is — a malformed entry
   * would be stored, shown to the operator, and match nobody.
   */
  exceptions: string[];
};

/**
 * How many members one protection may exempt.
 *
 * A cap rather than "as many as you like": this list is read on every event the
 * engine sees, and an unbounded array is a linear scan in the hottest path in
 * the bot. Fifty is far more than any real guild needs and still small enough
 * that the scan costs nothing.
 */
export const MAX_PROTECTION_EXCEPTIONS = 50;

/**
 * Seconds the window may cover: 5..600, defaulting to 600.
 *
 * Five seconds is the shortest window in which a burst is still a burst — below
 * it two clicks by one moderator in a row would trip the engine. Ten minutes is
 * the ceiling because the counters live in memory per guild: a longer window
 * would keep counting actions the operator can no longer see in the event feed,
 * and mitigation would fire long after the incident it belongs to.
 */
export const MIN_WINDOW_SECONDS = 5;
export const MAX_WINDOW_SECONDS = 600;

function clampWindowSeconds(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return MAX_WINDOW_SECONDS;
  return Math.min(MAX_WINDOW_SECONDS, Math.max(MIN_WINDOW_SECONDS, Math.trunc(numeric)));
}

/** A timeout length: 60s .. 28 days, defaulting to 600s (Discord's ceiling is 28d). */
function clampTimeoutSeconds(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return 600;
  return Math.min(2_419_200, Math.max(60, Math.trunc(numeric)));
}

/**
 * Coerces an untrusted exception list into IDs the engine can match.
 *
 * Anything that is not a snowflake is dropped rather than kept: a username, a
 * mention (`<@123…>`) or a typo would sit in the list looking like an exemption
 * while matching no event, which is worse than an empty list — the operator
 * would believe a person was exempt and find out only when the engine acted on
 * them. Duplicates collapse so the same person cannot occupy two slots, and the
 * result is capped so the hot-path scan stays bounded.
 */
function normaliseExceptions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const id = entry.trim();
    if (!isSnowflake(id)) continue;
    seen.add(id);
    if (seen.size >= MAX_PROTECTION_EXCEPTIONS) break;
  }
  return [...seen];
}

export type ProtectionSettingsMap = Record<NukeProtectionKey, ProtectionSettings>;

/**
 * Every protection, switched on, with the documented defaults.
 *
 * Built with a `reduce` over the registry rather than `Object.fromEntries`: the
 * registry is the single list of keys, so the map cannot be missing one, and
 * each value is checked against `ProtectionSettings` as it is written instead of
 * being asserted after the fact.
 */
export const DEFAULT_PROTECTION_SETTINGS: ProtectionSettingsMap = NUKE_PROTECTIONS.reduce(
  (map, protection) => {
    map[protection.key] = {
      enabled: true,
      windowSeconds: 600,
      punishment: "remove-roles",
      timeoutSeconds: 600,
      exceptions: []
    };
    return map;
  },
  {} as ProtectionSettingsMap
);

/**
 * Coerces an untrusted object — a JSON body or a JSONB column — into the full map.
 *
 * Unknown keys are dropped rather than stored: a typo would persist, be read by
 * nothing, and look like a setting the operator made. Missing keys fall back to
 * the default instead of being read as an opt-out, because silence is not consent
 * to switch a protection off.
 */
export function normaliseProtectionSettings(value: unknown): ProtectionSettingsMap {
  const source = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const result = { ...DEFAULT_PROTECTION_SETTINGS };
  // «webhook-churn» was one protection for create + edit + delete. A row written
  // before the split carries it, and dropping it would reset both new switches
  // to their defaults — an operator's opt-out would silently become an opt-in.
  const legacyWebhook = source["webhook-churn"];
  if (legacyWebhook && typeof legacyWebhook === "object") {
    for (const key of ["webhook-create", "webhook-update"] as const) {
      if (source[key] !== undefined) continue;
      const settings = legacyWebhook as Record<string, unknown>;
      result[key] = {
        enabled: settings.enabled !== false,
        windowSeconds: clampWindowSeconds(settings.windowSeconds),
        punishment: isProtectionPunishment(settings.punishment) ? settings.punishment : "remove-roles",
        timeoutSeconds: clampTimeoutSeconds(settings.timeoutSeconds),
        exceptions: normaliseExceptions(settings.exceptions)
      };
    }
  }
  for (const [key, raw] of Object.entries(source)) {
    if (!isNukeProtectionKey(key)) continue;
    const settings = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    result[key] = {
      enabled: settings.enabled !== false,
      windowSeconds: clampWindowSeconds(settings.windowSeconds),
      punishment: isProtectionPunishment(settings.punishment) ? settings.punishment : "remove-roles",
      timeoutSeconds: clampTimeoutSeconds(settings.timeoutSeconds),
      exceptions: normaliseExceptions(settings.exceptions)
    };
  }
  return result;
}

export function protectionEnabled(settings: ProtectionSettingsMap | undefined, key: NukeProtectionKey): boolean {
  return settings?.[key]?.enabled ?? true;
}

/**
 * The members one protection exempts.
 *
 * Read through this rather than `settings[key].exceptions` at each call site so
 * "no settings" and "no exceptions" answer the same thing. The engine asks this
 * on every event; a caller that had to guard for an absent map would eventually
 * forget once, and a forgotten guard here means acting on an exempt member.
 */
export function protectionExceptions(
  settings: Partial<ProtectionSettingsMap> | undefined,
  key: NukeProtectionKey
): readonly string[] {
  return settings?.[key]?.exceptions ?? [];
}

export function protectionsInFamily(family: NukeFamily): NukeProtection[] {
  return NUKE_PROTECTIONS.filter(protection => protection.family === family);
}

/** Every key, for the boundary that normalises stored settings. */
export const NUKE_PROTECTION_KEYS: readonly NukeProtectionKey[] = NUKE_PROTECTIONS.map(protection => protection.key);

export function isNukeProtectionKey(value: unknown): value is NukeProtectionKey {
  return typeof value === "string" && (NUKE_PROTECTION_KEYS as readonly string[]).includes(value);
}

export function findProtection(key: NukeProtectionKey): NukeProtection | undefined {
  return NUKE_PROTECTIONS.find(protection => protection.key === key);
}

/**
 * Which protections an engine action can switch off.
 *
 * `role-change` answers to two: the engine counts creating and deleting roles in
 * one budget, but an operator who turns off "creating roles" still expects
 * deleting them to be caught. So the gate asks about the *event's* protection,
 * while the counting stays shared — and the screen says so under the roles
 * family rather than letting two numbers look unrelated.
 */
export const PROTECTION_KEYS_BY_ACTION: Record<NukeAction, readonly NukeProtectionKey[]> = {
  "channel-delete": ["channel-delete"],
  "channel-create": ["channel-create"],
  "channel-update": ["channel-update"],
  "channel-permissions": ["channel-permissions"],
  ban: ["member-ban"],
  kick: ["member-kick"],
  timeout: ["member-timeout"],
  "role-change": ["role-create", "role-delete"],
  // An edit is its own protection and its own budget: raising a role's
  // permissions is privilege escalation, not churn, and an operator who turned
  // "create/delete" off has not thereby turned "raise to administrator" off.
  "role-update": ["role-update"],
  "webhook-create": ["webhook-create"],
  "webhook-update": ["webhook-update"],
  "message-bulk-delete": ["message-purge"]
};

/** The single protection an observed event belongs to, or null if the engine ignores it. */
export function protectionKeyForEvent(
  event:
    | "server.channel-delete"
    | "server.channel-create"
    | "server.channel-update"
    | "channel.permission-update"
    | "moderation.ban"
    | "moderation.kick"
    | "moderation.timeout"
    | "role.create"
    | "role.delete"
    | "role.update"
    | "webhook.create"
    | "webhook.update"
    | "webhook.delete"
    | "message.bulk-delete"
): NukeProtectionKey {
  switch (event) {
    case "server.channel-delete":
      return "channel-delete";
    case "server.channel-create":
      return "channel-create";
    case "server.channel-update":
      return "channel-update";
    case "channel.permission-update":
      return "channel-permissions";
    case "moderation.ban":
      return "member-ban";
    case "moderation.kick":
      return "member-kick";
    case "moderation.timeout":
      return "member-timeout";
    case "role.create":
      return "role-create";
    case "role.delete":
      return "role-delete";
    case "role.update":
      return "role-update";
    case "webhook.create":
      return "webhook-create";
    case "webhook.update":
    case "webhook.delete":
      return "webhook-update";
    case "message.bulk-delete":
      return "message-purge";
  }
}

/** Protections the engine actually counts — the ones a limit means anything for. */
export function enforcedProtections(): NukeProtection[] {
  return NUKE_PROTECTIONS.filter(protection => protection.limitKey !== undefined);
}

/**
 * How many protections are live for a guild.
 *
 * A protection counts when the engine is armed, the operator has not switched it
 * off, **and** the engine actually counts that action. All three, because the
 * badge is the one number on the screen that answers "am I protected?" — a count
 * of switches alone would read 12/12 for a guild whose engine enforces four
 * actions, which is the exact kind of comfort a UI must not sell.
 */
export function activeProtectionCount(enabled: boolean, settings?: Partial<ProtectionSettingsMap>): number {
  if (!enabled) return 0;
  return enforcedProtections().filter(protection => settings?.[protection.key]?.enabled !== false).length;
}
