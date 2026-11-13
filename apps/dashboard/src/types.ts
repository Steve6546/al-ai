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
  type LevelRewardKind,
  type LogDestination,
  type NukeAction,
  type RemoteAccessMode,
  type TierRoles
} from "@al-ai/core/browser";

export { tierOrder } from "@al-ai/core/browser";

/* ------------------------------------------------------------------ *
 * Shared with the BFF and the bot — declared in core, re-exported here
 * ------------------------------------------------------------------ */
export type {
  ActivityType,
  AntiNukeConfig,
  AppearanceSaveResult,
  BotPresenceSettings,
  BotStatus,
  BotStatusDuration,
  ChannelOption,
  CommandCategory,
  CommandConfig,
  CommandDuration,
  CommandFlag,
  CustomizationSettings,
  GuildMetrics,
  HealthSnapshot,
  InviteMilestone,
  InviteSettings,
  WelcomeEmbedField,
  WelcomeMessageSettings,
  WelcomeTextLayer,
  LevelNotifyMode,
  LevelRewardKind,
  LevelRoleReward,
  LevelSettings,
  LogDestination,
  LoggingSettings,
  WelcomeSettings,
  NukeAction,
  PermissionStatus,
  PresetReason,
  RemoteAccessMode,
  RoleHierarchyVerdict,
  RoleIconGate,
  TierRoles
} from "@al-ai/core/browser";

/* ------------------------------------------------------------------ *
 * Levels system — UI-only shapes
 * ------------------------------------------------------------------ */

export type { LevelConfigProblem } from "@al-ai/core/browser";

/** One persistent sync job, mirroring the BFF's `LevelSyncJob`. */
export type LevelSyncJob = {
  id: string;
  guildId: string;
  status: "pending" | "running" | "completed" | "failed";
  cursor: string | null;
  total: number | null;
  processed: number;
  granted: number;
  removed: number;
  skipped: number;
  failed: number;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

/** Real engine status: every value read from server state, nothing invented. */
export type LevelsStatus = {
  enabled: boolean;
  lastXpWriteAt: string | null;
  lastVoiceTickAt: string | null;
  voiceSessions: number | null;
  sync: LevelSyncJob | null;
};

/** What an operator types into a reward modal, before it has a row id. */
export type LevelRewardInput = {
  kind: LevelRewardKind;
  level: number;
  /** Required voice level; only meaningful for "dual" rules. */
  voiceLevel: number | null;
  roleId: string;
  /** Keep this role even without the guild-wide stacking switch. */
  alwaysKeep?: boolean;
};

/** One leaderboard row, with the avatar URL the BFF already resolved. */
export type LeaderboardEntry = {
  userId: string;
  displayName: string | null;
  avatarHash: string | null;
  avatarUrl: string | null;
  xp: number;
  /** Hidden members keep earning; the board only dims and un-ranks them. */
  hidden: boolean;
};

export type LeaderboardPage = {
  entries: LeaderboardEntry[];
  total: number;
  stats: { highestLevel: number; totalXp: number; rankedMembers: number };
};

/* ------------------------------------------------------------------ *
 * Dashboard-only shapes
 * ------------------------------------------------------------------ */

/**
 * What Discord currently serves for the bot *inside one guild*, for the preview.
 *
 * Declared here rather than in core because it is a view, not a stored shape:
 * `CustomizationSettings` holds what the operator chose (which may be a data URL
 * they just cropped), while this holds what Discord actually returns — the CDN
 * URLs, the account name. The preview needs both so it can show the last applied
 * value before the operator touches anything.
 *
 * Guild-scoped, and every field is the *member's* value rather than the
 * account's: `avatarUrl` is built from the guild-avatar hash and `bannerUrl`
 * from the guild-banner hash, so the preview draws the face members of THIS
 * server see. There is no `bio`: Discord validates a member bio on write and
 * never returns it on read, so the stored row is the only source for it.
 */
export type GuildProfileSnapshot = {
  username: string;
  /** The member's nickname in this guild, or null when they have none. */
  nickname: string | null;
  /** This guild's avatar and banner, or null when there is no override. */
  avatarUrl: string | null;
  bannerUrl: string | null;
  /**
   * What the bot falls back to where this guild has no override — the account's
   * own picture. Present so the preview draws the face members really see
   * instead of the initials, and never as a control: nothing on this screen can
   * write it.
   */
  accountAvatarUrl: string | null;
  accountBannerUrl: string | null;
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
  /** `isPlatformOwner` is the server's verdict on OWNER_ID, never the value itself. */
  user: {
    id: string;
    /** The display name Discord shows. */
    username: string;
    /** The @handle, when the session carries one. */
    handle?: string | null;
    avatarUrl: string | null;
    expiresAt: string;
    isPlatformOwner?: boolean;
  } | null;
  /**
   * Present when `GET /api/session` reports a pending admin login: OAuth has
   * identified the operator but no session cookie has been issued yet, so the
   * second factor must be cleared first. `required === true` is the gate the
   * SPA uses to show the 2FA screen instead of the login screen; `enrolled`
   * decides whether that screen must also set up an authenticator, and
   * `expiresAt` bounds the short-lived pending login.
   */
  secondFactor?: {
    required: boolean;
    enrolled: boolean;
    expiresAt: string;
  };
};

/**
 * The one-time enrolment payload for `GET /api/2fa/enrollment`.
 *
 * When `enrolled === false`, `secret` is the base32 TOTP key and `otpauthUri`
 * the `otpauth://` URI the admin adds to their authenticator app by hand, and
 * `recoveryCodes` holds ten single-use codes shown exactly once. When
 * `enrolled === true` the secret and URI are null and the codes are empty, but
 * `expiresAt` is always present so the pending login can be counted down in
 * both states.
 */
export type TwoFactorEnrollment = {
  enrolled: boolean;
  secret: string | null;
  otpauthUri: string | null;
  recoveryCodes: string[];
  expiresAt: string;
};

/** The interface language. Arabic is the default; English is the alternative. */
export type Language = "ar" | "en" | "de";

export type UserPreferences = { language: Language };

/**
 * A new authenticator's one-time material, from `POST /api/me/2fa/setup`.
 * Like the login payload it is shown exactly once: confirming or cancelling
 * deletes the server-side copy.
 */
export type TwoFactorSetup = {
  secret: string;
  otpauthUri: string;
  recoveryCodes: string[];
  expiresAt: string;
  replacing: boolean;
};

/** One live sign-in for the account, as the security screen lists it. */
export type SecuritySession = {
  current: boolean;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
};

export type SecurityOverview = {
  twoFactor: {
    enrolled: boolean;
    confirmedAt: string | null;
    recoveryCodesRemaining: number;
  };
  sessions: SecuritySession[];
  platformOwner: boolean;
};

/** What `GET /api/network` answers with — the deployment's current reach. */
export type NetworkSnapshot = {
  mode: RemoteAccessMode;
  tunnelProvider: "ngrok";
  tunnelUrl: string | null;
  /** The configured ngrok hostname, when one is set. */
  tunnelDomain: string | null;
  /** True when the live URL is the configured domain, not a random one. */
  tunnelStable: boolean;
  tunnelStatus: "off" | "starting" | "running" | "error";
  tunnelError: string | null;
  /** The machine's own non-loopback addresses, each with the interface it belongs to. */
  machineHosts: { host: string; label: string }[];
  port: number;
  /** Whether a sign-in has completed through the tunnel address, proving its
   * redirect URI is registered in Discord — see `markOriginVerified` server-side. */
  tunnelCallbackVerified: boolean;
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
  "invites.member-join": "انضمام عبر دعوة (إحالة)",
  "invites.member-leave": "مغادرة مُحال وخصم",
  "invites.milestone": "رتبة إنجاز إحالات",
  "invites.admin-adjust": "تعديل يدوي للإحالات",
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
