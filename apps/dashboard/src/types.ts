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
  type DiscordRoleWire,
  type GuildSummary,
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
  WelcomeSettings,
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

/**
 * The guild list the BFF serves at `GET /api/guilds`.
 *
 * Declared in core and aliased here so the SPA keeps its own word for it while
 * the shape itself can only ever change in one place.
 */
export type Guild = GuildSummary;

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

/** A Discord role as the tier and command-scope pickers render it. */
export type DiscordRole = DiscordRoleWire;

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
  "member-log": { label: "الأعضاء", description: "انضمام الأعضاء وخروجهم وتغييراتهم، والعقوبات التي تقع عليهم" },
  "role-log": { label: "الرتب", description: "إنشاء الرتب وتعديلها وحذفها، وإسنادها للأعضاء" },
  "channel-log": { label: "القنوات", description: "إنشاء القنوات والخيوط وتعديلها وحذفها وصلاحياتها" },
  "message-log": { label: "الرسائل", description: "حذف الرسائل وتعديلها وتثبيتها والتفاعلات معها" },
  "voice-log": { label: "الصوت", description: "دخول الغرف الصوتية وخروجها، والكتم والصمم" },
  "moderation-log": { label: "الإشراف", description: "قرارات المشرفين: التحذيرات والقوائم والعقوبات المعتمدة على الحالة" },
  "server-log": { label: "السيرفر", description: "تغييرات اسم السيرفر وأيقونته وإعداداته" },
  "invite-log": { label: "الدعوات", description: "إنشاء الدعوات وحذفها وانتهاء صلاحيتها" },
  "expression-log": { label: "الإيموجي والاستيكرز", description: "إضافة الإيموجي والاستيكرز وتعديلها وحذفها" },
  "event-log": { label: "الأحداث", description: "الأحداث المجدولة ومراحلها والمشاركون فيها" },
  "integration-log": { label: "التكاملات", description: "انضمام البوتات والويبهوكات والتكاملات" },
  "automod-log": { label: "الأوتو مود", description: "قواعد التلقين التلقائي والإجراءات التي تتخذها" },
  "platform-log": { label: "المنصة", description: "قنوات Stage المباشرة والمتحدثون فيها" }
};

/**
 * Arabic copy for every event inside those destinations.
 *
 * Kept complete by `log-labels.test.ts`: a missing entry falls back to the raw
 * id, which renders and toggles correctly while reading as an identifier in a
 * list of Arabic labels — a gap nothing else in the build would surface.
 */
const eventCopy: Record<string, string> = {
  /* member-log */
  "member.join": "دخول عضو",
  "member.leave": "خروج عضو",
  "member.nickname-change": "تغيير الاسم المستعار",
  "member.username-change": "تغيير اسم المستخدم",
  "member.avatar-change": "تغيير الصورة",
  "member.boost-add": "بوست السيرفر",
  "member.boost-remove": "إزالة البوست",
  "member.suspicious-account": "حساب مشبوه",
  "moderation.ban": "حظر عضو",
  "moderation.unban": "فك حظر عضو",
  "moderation.kick": "طرد عضو",
  "moderation.timeout": "عزل عضو",
  "moderation.untimeout": "إزالة العزل",
  "moderation.mute": "إسكات كتابي",
  "moderation.unmute": "إلغاء إسكات كتابي",
  "moderation.prison": "سجن عضو",
  "moderation.unprison": "إخراج من السجن",
  "moderation.remove": "حذف عقوبة من السجل",

  /* role-log */
  "role.create": "إنشاء رتبة",
  "role.update": "تعديل رتبة",
  "role.delete": "حذف رتبة",
  "role.managed-change": "رتبة خاصة",
  "member.role-add": "إضافة رتبة لعضو",
  "member.role-remove": "إزالة رتبة من عضو",

  /* channel-log */
  "server.channel-create": "إنشاء قناة",
  "server.channel-update": "تعديل قناة",
  "server.channel-delete": "حذف قناة",
  "channel.permission-update": "تعديل صلاحيات قناة",
  "thread.create": "إنشاء ثريد",
  "thread.update": "تعديل ثريد",
  "thread.delete": "حذف ثريد",

  /* message-log */
  "message.delete": "حذف رسالة",
  "message.edit": "تعديل رسالة",
  "message.bulk-delete": "حذف رسائل جماعي",
  "message.delete-attachment": "حذف صورة",
  "message.pin": "تثبيت رسالة",
  "message.unpin": "إلغاء تثبيت رسالة",
  "message.reaction-add": "إضافة تفاعل",
  "message.reaction-remove": "إزالة تفاعل",
  "message.reaction-clear": "مسح جميع التفاعلات",

  /* voice-log */
  "voice.join": "دخول روم صوتي",
  "voice.leave": "خروج من روم صوتي",
  "voice.move": "نقل بين الرومات",
  "voice.self-move": "تبديل الرومات",
  "voice.disconnect": "فصل من الصوتية",
  "voice.server-mute": "كتم عضو",
  "voice.server-unmute": "إلغاء كتم عضو",
  "voice.server-deafen": "إصمات عضو",
  "voice.server-undeafen": "إلغاء إصمات عضو",
  "voice.self-mute": "سيلف ميوت",
  "voice.self-unmute": "إلغاء السيلف ميوت",
  "voice.self-deafen": "سيلف ديفن",
  "voice.self-undeafen": "إلغاء السيلف ديفن",
  "voice.stream-start": "بدء بث",
  "voice.stream-end": "إنهاء بث",
  "voice.camera-on": "تشغيل الكاميرا",
  "voice.camera-off": "إيقاف الكاميرا",

  /* moderation-log */
  "moderation.warn": "إعطاء تحذير",
  "moderation.delwarn": "إزالة تحذير",
  "moderation.clearwarns": "مسح التحذيرات",
  "moderation.block": "إعطاء بلوك",
  "moderation.blacklist": "إضافة بلاك لست",
  "moderation.unblacklist": "إزالة بلاك لست",
  /* Still emitted, still audited — but internal now, so these labels serve the
   * audit trail's event column rather than the logs panel. */
  "moderation.unblock": "فك المنع من رتبة",
  "moderation.down": "سحب الرتب الإدارية",
  "moderation.undown": "استعادة الرتب الإدارية",
  "moderation.down-expired": "انتهاء مدة سحب الرتب الإدارية",
  "moderation.clearallwarns": "مسح كل التحذيرات",
  "moderation.clearallpunishments": "تصفير سجل العقوبات",
  "server.afk-change": "تغيير إعدادات الخمول",
  "server.system-channel-change": "تغيير قناة النظام",

  /* server-log */
  "server.settings-change": "تعديل السيرفر",
  "server.name-change": "تغيير اسم السيرفر",
  "server.icon-change": "تغيير أيقونة السيرفر",
  "server.banner-change": "تغيير بانر السيرفر",
  "server.vanity-url-change": "تغيير رابط الفانيتي",
  "server.boost-tier-up": "رفع مستوى البوست",
  "server.boost-tier-down": "انخفاض مستوى البوست",

  /* invite-log */
  "server.invite-create": "إنشاء دعوة",
  "invite.delete": "حذف دعوة",
  "invite.use": "استخدام دعوة",

  /* expression-log */
  "server.expression-create": "إضافة إيموجي",
  "server.expression-delete": "حذف إيموجي",
  "emoji.update": "تعديل إيموجي",
  "sticker.create": "إضافة ستيكر",
  "sticker.delete": "حذف ستيكر",
  "sticker.update": "تعديل ستيكر",

  /* event-log */
  "scheduled-event.create": "إنشاء حدث",
  "scheduled-event.delete": "حذف حدث",
  "scheduled-event.update": "تعديل حدث",
  "scheduled-event.start": "بدء حدث",
  "scheduled-event.complete": "انتهاء حدث",
  "scheduled-event.user-add": "اشتراك في حدث",
  "scheduled-event.user-remove": "إلغاء اشتراك",

  /* integration-log */
  "integration.update": "تعديل تكامل",
  "webhook.create": "إنشاء ويب هوك",
  "webhook.delete": "حذف ويب هوك",
  "webhook.update": "تعديل ويب هوك",
  "bot.join": "إضافة بوت للسيرفر",
  "bot.leave": "إزالة بوت من السيرفر",
  "bot.role-create": "إنشاء رتبة بوت",
  "bot.role-remove": "حذف رتبة بوت",

  /* automod-log */
  "automod.rule-create": "إنشاء قاعدة أوتو مود",
  "automod.rule-delete": "حذف قاعدة أوتو مود",
  "automod.rule-update": "تعديل قاعدة أوتو مود",
  "automod.alert": "إجراء أوتو مود",
  "automod.block-message": "حجب محتوى تلقائياً",
  "automod.timeout": "عزل تلقائي",
  "automod.member-block": "حجب عضو تلقائياً",

  /* platform-log */
  "stage.create": "إنشاء منصة صوتية",
  "stage.delete": "حذف منصة",
  "stage.update": "تعديل منصة",
  "stage.speaker": "إضافة متحدث",
  "stage.suppress": "إزالة متحدث",
  "stage.request-speak": "طلب التحدث"
};

export type LogCategory = {
  id: LogDestination;
  label: string;
  description: string;
  /** The sub-toggles shown under the destination switch, straight from the schema. */
  events: { id: string; label: string }[];
};

/**
 * The thirteen destinations, described in the operator's language.
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
