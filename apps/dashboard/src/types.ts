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
import type { LogDestination, Tier } from "@al-ai/core/browser";

export type { Tier } from "@al-ai/core/browser";
export { tierOrder } from "@al-ai/core/browser";

/* ------------------------------------------------------------------ *
 * Shared with the BFF and the bot — declared in core, re-exported here
 * ------------------------------------------------------------------ */
export type {
  ChannelOption,
  CustomizationSettings,
  HealthSnapshot,
  LogDestination,
  LoggingSettings,
  PermissionStatus
} from "@al-ai/core/browser";

/* ------------------------------------------------------------------ *
 * Dashboard-only shapes
 * ------------------------------------------------------------------ */

export type Guild = {
  id: string;
  name: string;
  /** Resolved on the server: the browser never builds a Discord CDN URL itself. */
  iconUrl: string | null;
  memberCount: number;
  tier: Tier | null;
  botPresent: boolean;
  canManageIdentity: boolean;
  canManageLogging: boolean;
  canManageCommands: boolean;
  /** Owner-only: binding tiers decides who can do everything else. */
  canManageTiers: boolean;
  canInvite?: boolean;
};

export type CommandFlag = {
  name: string;
  module: string;
  description: string;
  minimumTier: Tier;
  enabled: boolean;
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

export type TokenRecord = {
  id: string;
  label: string;
  masked: string;
  guildIds: string[];
  createdAt: string;
};

export type DiscordRole = { id: string; name: string; position: number; managed: boolean; isDefault: boolean };

export type TierRoles = Record<Tier, string | null>;

export type TierConfig = {
  roles: DiscordRole[];
  configured: TierRoles | null;
  botHighestRolePosition: number | null;
  /** Role IDs the bot cannot assign because they sit at or above its own role. */
  unassignable?: string[];
  warning?: string;
};

export type SessionInfo = {
  authenticated: boolean;
  user: { id: string; username: string; avatarUrl: string | null; expiresAt: string } | null;
};

/* ------------------------------------------------------------------ *
 * Display copy
 * ------------------------------------------------------------------ */

export const tierDescriptions: Record<Tier, string> = {
  owner: "تحكم كامل بكل الوحدات وإعدادات الأمان",
  head_admin: "كل الإدارة عدا تغيير رتب المستويات",
  admin: "الحظر والطرد وإعدادات السجلات",
  moderator: "التحذير والكتم والإسكات المؤقت"
};

export const tierLabels: Record<Tier, string> = {
  owner: "المالك",
  head_admin: "رئيس الإدارة",
  admin: "مدير",
  moderator: "مشرف"
};

/**
 * The seven destinations, described in the operator's language.
 * The ids are the same `LogDestination` values the bot routes on, so a label can
 * be reworded here without touching the pipeline.
 */
export const logCategories: { id: LogDestination; label: string; description: string }[] = [
  { id: "member-log", label: "الأعضاء", description: "الدخول، الخروج، الاسم والرتب" },
  { id: "moderation-log", label: "الإشراف", description: "العقوبات والتغييرات الحساسة" },
  { id: "voice-log", label: "الصوت", description: "حركة الغرف والمستضيف الصوتي" },
  { id: "role-log", label: "الرتب", description: "إنشاء وتعديل وإسناد الرتب" },
  { id: "message-log", label: "الرسائل", description: "حذف وتعديل الرسائل" },
  { id: "server-log", label: "السيرفر", description: "القنوات والدعوات وEmoji/Sticker" },
  { id: "bot-log", label: "البوت", description: "الصحة والأخطاء والأمان" }
];
