/**
 * Dashboard-facing types.
 *
 * Any shape that crosses the wire is declared once in `@al-ai/core` and merely
 * re-exported here, so the browser, the BFF and the bot cannot drift apart.
 * Only shapes that exist purely inside the UI are declared in this file.
 *
 * The rule that matters: if the server sends it or the bot reads it, it lives in
 * core. A type declared in two places is a type that will eventually disagree
 * with itself.
 */
import {
  eventsByCategory,
  logDestinations,
  type AntiNukeConfig,
  type LogDestination,
  type NukeAction,
  type Tier,
  type TierRoles
} from "@al-ai/core/browser";

export type { Tier } from "@al-ai/core/browser";
export { tierOrder } from "@al-ai/core/browser";

/* ------------------------------------------------------------------ *
 * Shared with the BFF and the bot — declared in core, re-exported here
 * ------------------------------------------------------------------ */
export type {
  ActivityEntry,
  ActivityType,
  AntiNukeConfig,
  AntiNukeLimits,
  AppearanceFailure,
  AppearanceFieldName,
  AppearanceSaveResult,
  BotIdentitySettings,
  BotStatus,
  BotStatusDuration,
  ChannelOption,
  CommandCategory,
  CommandConfig,
  CommandDuration,
  CommandFlag,
  CommandTarget,
  CustomizationSettings,
  DurationOption,
  GuildMetrics,
  HealthSnapshot,
  LogDestination,
  LoggingSettings,
  NukeAction,
  PermissionStatus,
  PresetReason,
  PunishmentCounts,
  RoleHierarchyVerdict,
  RoleIconGate,
  TierRoles
} from "@al-ai/core/browser";

/* ------------------------------------------------------------------ *
 * Dashboard-only shapes
 * ------------------------------------------------------------------ */

/**
 * The bot's *resolved* global profile, for the live preview.
 *
 * Declared here rather than in core because it is a view, not a stored shape:
 * `BotIdentitySettings` holds what the operator chose (which may be a data URL
 * they just cropped), while this holds what Discord currently serves — the CDN
 * URL, the account name. The preview needs both so it can show the last applied
 * value before the operator touches anything.
 */
export type BotIdentitySnapshot = {
  username: string;
  avatarUrl: string | null;
  bannerUrl: string | null;
  bio: string;
};

export type Guild = {
  id: string;
  name: string;
  /** Resolved on the server: the browser never builds a Discord CDN URL itself. */
  iconUrl: string | null;
  /**
   * Real member count, or `null` when it is not knowable.
   *
   * Only the bot can count members, so a guild it has not joined has no count —
   * and showing `0` there would be a number the dashboard invented. The selector
   * renders `null` as "غير محدد" rather than as a server with nobody in it.
   */
  memberCount: number | null;
  tier: Tier | null;
  botPresent: boolean;
  /** The caller holds ADMINISTRATOR or MANAGE_GUILD in Discord. */
  canManage: boolean;
  canManageIdentity: boolean;
  canManageLogging: boolean;
  canManageCommands: boolean;
  /** Owner-only: binding tiers decides who can do everything else. */
  canManageTiers: boolean;
  canInvite: boolean;
};

export type AuditEntry = {
  id: string;
  severity: "info" | "warning" | "critical";
  eventId: string;
  correlationId: string;
  actorHash: string;
  sourceLayer: string;
  createdAt: string;
  payload: Record<string, unknown> | null;
};

export type SecurityEvent = {
  id: string;
  eventId: string;
  correlationId: string;
  sourceLayer: string;
  createdAt: string;
  payload: Record<string, unknown> | null;
};

export type DiscordRole = {
  id: string;
  name: string;
  position: number;
  managed: boolean;
  isDefault: boolean;
  /** Discord's packed RGB integer. 0 means "no colour" (the default grey). */
  color: number;
};

export type TierConfig = {
  roles: DiscordRole[];
  /** Null until the guild saves a mapping. Not a lockout — `owner` is automatic. */
  configured: TierRoles | null;
  botHighestRolePosition: number | null;
  /** Role IDs the bot cannot assign because they sit at or above its own role. */
  unassignable?: string[];
  warning?: string;
};

/**
 * One row of the anti-nuke limits form.
 *
 * The label is resolved on the server from the shared registry, so the dashboard
 * cannot offer an action the engine does not actually watch.
 */
export type AntiNukeActionLimit = {
  action: NukeAction;
  label: string;
  limit: number;
};

export type AntiNukeSettings = {
  config: AntiNukeConfig;
  /** Roles the quarantine role may be chosen from. */
  roles: DiscordRole[];
  actions: AntiNukeActionLimit[];
};

export type SessionInfo = {
  authenticated: boolean;
  user: { id: string; username: string; avatarUrl: string | null; expiresAt: string } | null;
};

/* ------------------------------------------------------------------ *
 * Display copy
 * ------------------------------------------------------------------ */

export const tierDescriptions: Record<Tier, string> = {
  owner: "تحكم كامل. تلقائي: مالك السيرفر وأي عضو يملك صلاحية Administrator في Discord.",
  admin: "إعدادات اللوحة وكافة الأوامر الإشرافية.",
  moderator: "العقوبات اليومية فقط: إسكات مؤقت، تحذير، طرد."
};

export const tierLabels: Record<Tier, string> = {
  owner: "المالك",
  admin: "مدير",
  moderator: "مشرف"
};

/**
 * Arabic copy for the destinations an operator configures.
 *
 * `bot-log` is deliberately absent: it is an internal destination delivered to
 * the developer webhook, so it is never offered as a channel choice. It still
 * exists in the schema — the operator simply cannot mute it.
 */
const categoryCopy: Record<string, { label: string; description: string }> = {
  "member-log": { label: "الأعضاء", description: "الدخول والخروج والاسم والرتب" },
  "moderation-log": { label: "الإشراف", description: "العقوبات والتغييرات الحساسة" },
  "voice-log": { label: "الصوت", description: "حركة الغرف والمستضيف الصوتي" },
  "message-log": { label: "الرسائل", description: "حذف وتعديل الرسائل" },
  "server-log": { label: "السيرفر", description: "القنوات والدعوات والتعبيرات والرتب" }
};

/** Arabic copy for every event inside those destinations. */
const eventCopy: Record<string, string> = {
  "member.join": "انضمام عضو",
  "member.leave": "خروج عضو",
  "member.nickname-change": "تغيير الاسم",
  "member.role-add": "إسناد رتبة",
  "member.role-remove": "سحب رتبة",
  "moderation.ban": "حظر",
  "moderation.unban": "رفع حظر",
  "moderation.kick": "طرد",
  "moderation.timeout": "إسكات مؤقت",
  "moderation.warn": "تحذير",
  "voice.join": "دخول غرفة صوتية",
  "voice.leave": "خروج من غرفة صوتية",
  "voice.move": "انتقال بين غرفتين",
  "voice.state-change": "كتم/صمّ/بث",
  "message.delete": "حذف رسالة",
  "message.edit": "تعديل رسالة",
  "message.bulk-delete": "حذف جماعي",
  "server.channel-create": "إنشاء قناة",
  "server.channel-update": "تعديل قناة",
  "server.channel-delete": "حذف قناة",
  "server.invite-create": "إنشاء دعوة",
  "server.expression-create": "إضافة إيموجي/ستيكر",
  "server.expression-delete": "حذف إيموجي/ستيكر",
  "role.create": "إنشاء رتبة",
  "role.update": "تعديل رتبة",
  "role.delete": "حذف رتبة"
};

export type LogCategory = {
  id: LogDestination;
  label: string;
  description: string;
  /** The sub-toggles shown under the destination switch, straight from the schema. */
  events: { id: string; label: string }[];
};

/**
 * The five destinations, described in the operator's language.
 *
 * The event lists are derived from the compiled schema rather than retyped, so
 * the dashboard can never offer a toggle for an event the bot does not emit.
 * The ids are the same `LogDestination` values the bot routes on.
 */
export const logCategories: LogCategory[] = logDestinations.map(id => ({
  id,
  label: categoryCopy[id]?.label ?? id,
  description: categoryCopy[id]?.description ?? "",
  events: eventsByCategory(id).map(eventId => ({ id: eventId, label: eventCopy[eventId] ?? eventId }))
}));
