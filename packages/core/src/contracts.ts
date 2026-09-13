import type { LogDestination, Severity } from "./event-schema.js";

/** A channel the operator can choose as a log destination. */
export type ChannelOption = { id: string; name: string; type: "text" | "voice" | "category" };

/**
 * One Discord permission the bot needs, and whether it currently holds it.
 *
 * `granted` is three-valued on purpose. `false` means the bot's permissions were
 * read successfully and the bit is absent — the only case where the UI may tell
 * the operator something is missing. `null` means the read itself failed, which
 * is not evidence of anything: reporting it as `false` would disable a control
 * (or refuse a save) over a permission the bot may well hold.
 */
export type PermissionStatus = {
  key: string;
  label: string;
  granted: boolean | null;
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

/**
 * How the operator wants the rooms laid out.
 *
 * `single` sends everything to one channel; `granular` gives each destination
 * its own. The mode is explicit rather than inferred from which fields happen to
 * be filled, because an operator switching to `single` should not silently lose
 * the per-category channels they configured earlier — those stay stored and come
 * back when they switch to `granular` again.
 */
export type LoggingMode = "single" | "granular";

export const DEFAULT_LOGGING_MODE: LoggingMode = "single";

export function isLoggingMode(value: unknown): value is LoggingMode {
  return value === "single" || value === "granular";
}

export type LoggingSettings = {
  enabled: boolean;
  mode: LoggingMode;
  globalChannelId: string | null;
  ignoredChannelIds: string[];
  /** Members holding any of these roles are left out of the logs entirely. */
  ignoredRoleIds: string[];
  embedColor: string;
  /** Keyed by destination *or* by individual event ID; the event ID wins. */
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

/* ------------------------------------------------------------------ *
 * Dashboard metrics
 *
 * What the operator sees on the overview screen. Everything here is either a
 * real Discord value or a real row from the audit trail — the previous version
 * of this screen showed the dashboard's own gateway counters, which told an
 * operator nothing about their server.
 * ------------------------------------------------------------------ */

/** The four events that count as a punishment. An unban is a release, not one. */
export const PUNISHMENT_EVENT_IDS = ["moderation.ban", "moderation.kick", "moderation.timeout", "moderation.warn"] as const;

export type PunishmentKind = "ban" | "kick" | "timeout" | "warn";

export type PunishmentCounts = Record<PunishmentKind, number> & { total: number };

/** Maps an audit event ID onto its counter, or null when it is not a punishment. */
export function punishmentKindOf(eventId: string): PunishmentKind | null {
  switch (eventId) {
    case "moderation.ban":
      return "ban";
    case "moderation.kick":
      return "kick";
    case "moderation.timeout":
      return "timeout";
    case "moderation.warn":
      return "warn";
    default:
      return null;
  }
}

export const EMPTY_PUNISHMENT_COUNTS: PunishmentCounts = { total: 0, ban: 0, kick: 0, timeout: 0, warn: 0 };

/** One row of the activity feed, already decrypted and flattened for display. */
export type ActivityEntry = {
  id: string;
  eventId: string;
  severity: Severity;
  /** The moderator, or null when Discord's audit log did not name one. */
  actorId: string | null;
  targetId: string | null;
  reason: string | null;
  createdAt: string;
};

export type GuildMetrics = {
  bot: {
    online: boolean;
    /**
     * Discord's own gateway heartbeat, reported by the bot. Null until the bot
     * has checked in — never a fabricated zero, which would read as "0 ms".
     */
    pingMs: number | null;
    /** When the bot last reported. Lets the screen say "stale" rather than lie. */
    lastSeenAt: string | null;
  };
  members: {
    total: number;
    /**
     * Aggregate presence published by Discord's guild widget. Null when the
     * operator has not enabled the widget.
     *
     * GOVERNANCE rule 8 forbids the GUILD_PRESENCES intent, so AL AI never
     * tracks a member's own online state. This is a single number Discord
     * publishes itself, not per-member tracking.
     */
    online: number | null;
    /** Why `online` is null, in the operator's language. Null when it is present. */
    onlineNote: string | null;
  };
  punishments24h: PunishmentCounts;
  recentActivity: ActivityEntry[];
};

/** A ping slower than this is worth flagging to the operator. */
export const PING_WARN_MS = 300;

/** How stale a bot heartbeat may be before the screen stops calling it live. */
export const BOT_HEARTBEAT_STALE_MS = 3 * 60 * 1000;

/** A raw `audit_trail` tally: an event ID and how many times it occurred. */
export type EventTally = { eventId: string; count: number };

/**
 * Turns raw audit tallies into the four counters the overview shows.
 *
 * Events that are not punishments are ignored rather than folded into an
 * "other" bucket — an unban or a settings change must never inflate a number
 * an operator reads as "how many people did we punish today".
 */
export function summarisePunishments(tallies: EventTally[]): PunishmentCounts {
  const counts: PunishmentCounts = { ...EMPTY_PUNISHMENT_COUNTS };
  for (const tally of tallies) {
    const kind = punishmentKindOf(tally.eventId);
    if (kind) counts[kind] += tally.count;
  }
  counts.total = counts.ban + counts.kick + counts.timeout + counts.warn;
  return counts;
}

/** The stored heartbeat, as the dashboard reads it out of `guild_health`. */
export type BotHeartbeat = {
  botPresent: boolean;
  pingMs: number | null;
  /** ISO timestamp, or null when the bot has never checked in. */
  checkedAt: string | null;
};

/**
 * Decides whether the bot is live, and whether its ping is still meaningful.
 *
 * A heartbeat row outlives the process that wrote it. Reporting "online", or a
 * ping, from a row older than the staleness window would describe a bot that is
 * no longer running — so both collapse to offline and null once it goes stale.
 * `now` is passed in rather than read here so the caller's clock is the only
 * clock, and so this stays testable without mocking time.
 */
export function deriveBotStatus(heartbeat: BotHeartbeat | null, now: number): GuildMetrics["bot"] {
  const lastSeenAt = heartbeat?.checkedAt ?? null;
  const fresh = lastSeenAt !== null && now - Date.parse(lastSeenAt) < BOT_HEARTBEAT_STALE_MS;
  return {
    online: Boolean(heartbeat?.botPresent) && fresh,
    pingMs: fresh ? (heartbeat?.pingMs ?? null) : null,
    lastSeenAt
  };
}

/** What Discord's widget endpoint reported, including why it reported nothing. */
export type WidgetPresenceResult = {
  online: number | null;
  reason?: "widget-disabled" | "unavailable";
};

/**
 * Explains a missing live-member count in the operator's own language.
 *
 * Returning null when the count exists keeps the screen from printing a note
 * beside a number that needs no explanation.
 */
export function widgetOnlineNote(widget: WidgetPresenceResult): string | null {
  if (widget.online !== null) return null;
  return widget.reason === "widget-disabled"
    ? "فعّل «Server Widget» في إعدادات السيرفر لعرض عدد المتصلين."
    : "تعذّر قراءة عدد المتصلين من Discord.";
}
