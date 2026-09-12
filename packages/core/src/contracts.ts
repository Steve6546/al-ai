import type { LogDestination } from "./event-schema.js";

/** A channel the operator can choose as a log destination. */
export type ChannelOption = { id: string; name: string; type: "text" | "voice" | "category" };

/** One Discord permission the bot needs, and whether it currently holds it. */
export type PermissionStatus = {
  key: string;
  label: string;
  granted: boolean;
};

/* ------------------------------------------------------------------ *
 * Bot appearance
 *
 * Discord gives an application ONE global avatar and banner, so a per-guild
 * image cannot be a real feature. What *is* per-guild is the bot's nickname and
 * the colour and icon of its own role. This contract therefore describes exactly
 * three things, and every layer — the dashboard form, the BFF validator and the
 * bot's sync — reads its defaults and its normalisation rules from here.
 *
 * The previous shape carried `avatarUrl`/`bannerUrl`, which the dashboard saved
 * and the bot never read: the operator changed them and nothing happened. Those
 * fields are gone rather than merely ignored, so that mistake cannot recur.
 * ------------------------------------------------------------------ */

/** The name AL AI shows in a guild until the operator renames it. */
export const DEFAULT_BOT_NICKNAME = "AL AI";

/** Longest nickname Discord accepts. Validated here so the UI and the BFF agree. */
export const MAX_NICKNAME_LENGTH = 32;

export type CustomizationSettings = {
  /** Empty string means "use the application's own name" and is sent as null. */
  nickname: string;
  /** "#rrggbb" for the AL AI role, or null to leave Discord's default. */
  roleColor: string | null;
  /** Icon for the AL AI role, or null. Discord requires an https URL. */
  roleIconUrl: string | null;
};

/** What a guild looks like before the operator changes anything. */
export const DEFAULT_CUSTOMIZATION: CustomizationSettings = {
  nickname: DEFAULT_BOT_NICKNAME,
  roleColor: null,
  roleIconUrl: null
};

/**
 * Trims a nickname and enforces Discord's length limit.
 * Whitespace-only input collapses to "" so "cleared" has exactly one spelling.
 */
export function normaliseNickname(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, MAX_NICKNAME_LENGTH);
}

/** Accepts "#rgb"/"#rrggbb" and returns lowercase "#rrggbb", or null. */
export function normaliseHexColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim().toLowerCase();
  const short = /^#([0-9a-f]{3})$/.exec(raw);
  if (short) return `#${short[1].split("").map(char => char + char).join("")}`;
  return /^#[0-9a-f]{6}$/.test(raw) ? raw : null;
}

/**
 * Accepts only an absolute https image URL.
 * Discord rejects http and relative values, so they are refused at the edge
 * instead of being stored and failing silently inside the bot.
 */
export function normaliseIconUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Normalises a whole appearance. Used by the BFF before a write and by the bot
 * after a read, so a value can never mean two different things on the two sides.
 */
export function normaliseCustomization(input: Partial<CustomizationSettings> | null | undefined): CustomizationSettings {
  return {
    nickname: normaliseNickname(input?.nickname),
    roleColor: normaliseHexColor(input?.roleColor),
    roleIconUrl: normaliseIconUrl(input?.roleIconUrl)
  };
}

export type LoggingSettings = {
  enabled: boolean;
  globalChannelId: string | null;
  ignoredChannelIds: string[];
  embedColor: string;
  eventFlags: Record<string, boolean>;
  categoryChannels: Partial<Record<LogDestination, string>>;
};

export type HealthSnapshot = {
  status: "healthy" | "degraded";
  dashboard: "online";
  bot: "connected" | "configured" | "awaiting_secret";
  database: "reachable" | "unreachable";
  gateway: { eventsLastMinute: number; ceiling: number };
  verification: {
    guildCount: number;
    uniqueUsers: number;
    reviewRequired: boolean;
    warning: string | null;
  };
};
