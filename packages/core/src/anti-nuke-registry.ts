import type { AntiNukeLimits, NukeAction } from "./anti-nuke.js";
import type { DiscordPermissionBit } from "./discord-permissions.js";

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
  | "webhook-churn"
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
  channels: "حماية القنوات",
  roles: "حماية الرتب",
  members: "حماية الأعضاء",
  webhooks: "حماية الويبهوك",
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
    limit: { min: 1, max: 100, default: 5 }
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
    label: "مكافحة تعديل صلاحيات الرتب",
    description: "منع رفع صلاحيات رتب موجودة إلى مستوى الإدارة.",
    auditEvents: ["RoleUpdate"],
    permission: "MANAGE_ROLES",
    limit: { min: 1, max: 100, default: 3 }
  },

  /* ---------------- Members ----------------
   * The three ways to remove a person's access. Ban is counted today; kick and
   * timeout arrive as their own events and are declared here so the next round
   * does not have to invent the vocabulary again. */
  {
    key: "member-ban",
    family: "members",
    label: "مكافحة حظر الأعضاء",
    description: "منع حظر الأعضاء بشكل جماعي.",
    auditEvents: ["MemberBanAdd"],
    permission: "BAN_MEMBERS",
    limit: { min: 1, max: 100, default: 5 },
    limitKey: "bansPerMinute"
  },
  {
    key: "member-kick",
    family: "members",
    label: "مكافحة طرد الأعضاء",
    description: "منع طرد الأعضاء بشكل جماعي (العضو يستطيع العودة، بعكس الحظر).",
    auditEvents: ["MemberKick"],
    permission: "KICK_MEMBERS",
    limit: { min: 1, max: 100, default: 5 }
  },
  {
    key: "member-timeout",
    family: "members",
    label: "مكافحة عزل الأعضاء",
    description: "منع إسكات الأعضاء بشكل جماعي (timeout).",
    auditEvents: ["MemberUpdate"],
    permission: "MODERATE_MEMBERS",
    limit: { min: 1, max: 100, default: 5 }
  },

  /* ---------------- Webhooks ----------------
   * One entry, not three: a webhook attack is the same burst whether the attacker
   * creates it to exfiltrate messages or deletes the server's existing ones, and
   * splitting it would ask the operator to set one number three times. */
  {
    key: "webhook-churn",
    family: "webhooks",
    label: "مكافحة إنشاء وحذف الويبهوكات",
    description: "منع تغيير ويبهوكات القنوات لسرقة الرسائل أو تعطيل التنبيهات.",
    auditEvents: ["WebhookCreate", "WebhookUpdate", "WebhookDelete"],
    permission: "MANAGE_WEBHOOKS",
    limit: { min: 1, max: 100, default: 3 }
  },

  /* ---------------- Content ----------------
   * The wipe that does not touch structure: a bulk delete erases the channel's
   * history while every channel and role stays exactly where it was, so the three
   * structural budgets never notice it. */
  {
    key: "message-purge",
    family: "content",
    label: "مكافحة حذف رسائل القنوات",
    description: "منع حذف الرسائل الجماعي لإفراغ القنوات من محتواها.",
    auditEvents: ["MessageBulkDelete", "MessageDelete"],
    permission: "MANAGE_MESSAGES",
    limit: { min: 1, max: 100, default: 5 }
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
export type ProtectionSettings = {
  /**
   * Off means the engine does not count this action at all for this guild.
   *
   * Defaulted to on, because the registry lists protections the engine mostly
   * does *not* enforce yet — a default of off would make the badge read 0/12 for
   * a guild that has never opened the screen, which is the opposite of the truth.
   */
  enabled: boolean;
};

export type ProtectionSettingsMap = Record<NukeProtectionKey, ProtectionSettings>;

export const DEFAULT_PROTECTION_SETTINGS: ProtectionSettingsMap = Object.fromEntries(
  NUKE_PROTECTIONS.map(protection => [protection.key, { enabled: true }])
) as ProtectionSettingsMap;

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
  for (const [key, raw] of Object.entries(source)) {
    if (!isNukeProtectionKey(key)) continue;
    const settings = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    result[key] = { enabled: settings.enabled !== false };
  }
  return result;
}

export function protectionEnabled(settings: ProtectionSettingsMap | undefined, key: NukeProtectionKey): boolean {
  return settings?.[key]?.enabled ?? true;
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
  ban: ["member-ban"],
  "role-change": ["role-create", "role-delete"]
};

/** The single protection an observed event belongs to, or null if the engine ignores it. */
export function protectionKeyForEvent(
  event: "server.channel-delete" | "server.channel-create" | "server.channel-update" | "moderation.ban" | "role.create" | "role.delete"
): NukeProtectionKey {
  switch (event) {
    case "server.channel-delete":
      return "channel-delete";
    case "server.channel-create":
      return "channel-create";
    case "server.channel-update":
      return "channel-update";
    case "moderation.ban":
      return "member-ban";
    case "role.create":
      return "role-create";
    case "role.delete":
      return "role-delete";
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
