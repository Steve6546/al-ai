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
 * Discord splits a bot's identity across two scopes, and the contract keeps that
 * split visible instead of pretending it is uniform:
 *
 *   per guild  — the nickname, and the colour and icon of the AL AI role
 *   global     — the account's avatar and banner, the application's description
 *                (what Discord shows as the bot's "About me"), and the gateway
 *                presence (status + activity)
 *
 * Every field below is applied by exactly one writer. The dashboard performs the
 * REST writes, because it can report the real per-field outcome straight back to
 * the operator; the bot performs the presence write, because only a live gateway
 * connection can set a status. A field with no writer is the defect this project
 * treats as a bug, so there are none.
 *
 * The two scopes are two types and two tables — `guild_customization` for the
 * per-guild half and `bot_identity` for the global half. One table would force a
 * per-guild row to carry a global value, which is how N rows come to hold the
 * same setting and quietly disagree.
 *
 * A previous design carried per-guild `avatarUrl`/`bannerUrl` that the dashboard
 * saved and nothing ever read. Those names are still absent: an avatar cannot be
 * per-guild, and the fields that exist now are global and actually applied.
 * ------------------------------------------------------------------ */

/** The name AL AI shows in a guild until the operator renames it. */
export const DEFAULT_BOT_NICKNAME = "AL AI";

/** Longest nickname Discord accepts. Validated here so the UI and the BFF agree. */
export const MAX_NICKNAME_LENGTH = 32;

/**
 * The role AL AI creates for itself on join.
 *
 * Declared in core because two processes need the same string: the bot creates
 * and assigns the role, and the dashboard finds it by name to colour it. Two
 * copies of this literal would drift and the colour would land on nothing.
 */
export const BOT_ROLE_NAME = "AL AI";

/** Discord's four presence states. */
export type BotStatus = "online" | "idle" | "dnd" | "invisible";

export const botStatuses = ["online", "idle", "dnd", "invisible"] as const;

export const botStatusLabels: Record<BotStatus, string> = {
  online: "متصل",
  idle: "خامل",
  dnd: "لا تُزعجني",
  invisible: "غير ظاهر"
};

export const DEFAULT_BOT_STATUS: BotStatus = "online";

/**
 * The three statuses Discord lets you hold for a fixed window.
 *
 * `online` is excluded because Discord offers no sub-menu for it — picking
 * "online for 15 minutes" is not a thing the real client can do, so offering it
 * here would be a control Discord itself refuses.
 */
export const timedBotStatuses = ["idle", "dnd", "invisible"] as const;

export type TimedBotStatus = (typeof timedBotStatuses)[number];

export function isTimedBotStatus(value: unknown): value is TimedBotStatus {
  return typeof value === "string" && (timedBotStatuses as readonly string[]).includes(value);
}

/**
 * The durations Discord's duration sub-menu offers, in the order it shows them.
 *
 * The minutes are the source of truth and the label is derived, so a test can
 * assert the arithmetic once instead of asserting six string constants that
 * could each drift from the number beside them.
 */
export const botStatusDurations = [
  { id: "15m", minutes: 15, label: "لمدة 15 دقيقة" },
  { id: "1h", minutes: 60, label: "لمدة ساعة" },
  { id: "8h", minutes: 480, label: "لمدة 8 ساعات" },
  { id: "24h", minutes: 1440, label: "لمدة 24 ساعة" },
  { id: "3d", minutes: 4320, label: "لمدة 3 أيام" },
  { id: "forever", minutes: null, label: "دائم (Forever)" }
] as const;

export type BotStatusDuration = (typeof botStatusDurations)[number]["id"];

export function isBotStatusDuration(value: unknown): value is BotStatusDuration {
  return typeof value === "string" && botStatusDurations.some(duration => duration.id === value);
}

/**
 * How long a duration lasts from now, in milliseconds, or null for "forever".
 *
 * `null` rather than `0` for the open-ended choice, because `0` is a length of
 * time that has already passed — the two would be indistinguishable at every
 * call site, and "expired immediately" is the exact opposite of "never expires".
 */
export function durationToMs(duration: BotStatusDuration | null): number | null {
  if (duration === null) return null;
  const found = botStatusDurations.find(candidate => candidate.id === duration);
  return found?.minutes === null || found === undefined ? null : found.minutes * 60_000;
}

/**
 * The activity kinds the operator may choose, limited to the four the directive
 * names. `streaming` (1) is deliberately absent: Discord only renders it as a
 * live stream when a Twitch or YouTube URL accompanies it, so offering it
 * without a URL would be a control that cannot show what it promises.
 */
export type ActivityType = "playing" | "listening" | "watching" | "competing";

export const activityTypes = ["playing", "listening", "watching", "competing"] as const;

export const activityTypeLabels: Record<ActivityType, string> = {
  playing: "يلعب",
  listening: "يستمع إلى",
  watching: "يشاهد",
  competing: "يتنافس في"
};

/** Discord's own numbers for the activity kinds. */
export const activityTypeNumbers: Record<ActivityType, number> = {
  playing: 0,
  listening: 2,
  watching: 3,
  competing: 5
};

export const DEFAULT_ACTIVITY_TYPE: ActivityType = "playing";

/** Discord rejects a longer activity name. */
export const MAX_ACTIVITY_TEXT_LENGTH = 128;

/** Discord's limit for an application description, which is the bot's "About me". */
export const MAX_BIO_LENGTH = 400;

/**
 * Largest base64 data URL accepted for an avatar, a banner or a role icon.
 *
 * The images are cropped in the browser before they arrive, so this is a ceiling
 * on something already small — its job is to stop a hand-crafted request from
 * writing megabytes into a text column.
 */
export const MAX_IMAGE_DATA_URL_LENGTH = 500_000;

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
 *
 * Kept for values that genuinely arrive as links. The role icon no longer has
 * to: it is uploaded through the cropper as a base64 data URL, because a link
 * was the wrong shape for a field the operator fills from their own machine —
 * it saved successfully and then broke whenever the host went away, with
 * nothing on the screen to say so.
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
 * An image the bot will draw: either an uploaded data URL or an https link.
 *
 * Order matters conceptually as well as practically — the data URL form is
 * checked first because that is what the cropper produces, and an https link
 * remains supported so a value stored by an older build keeps working instead
 * of being silently cleared on the next save.
 *
 * Returns null for anything unusable, and callers must distinguish "absent"
 * from "rejected": storing null for a value that failed would wipe the picture
 * the operator meant to replace.
 */
export function normaliseImageValue(value: unknown): string | null {
  return normaliseImageDataUrl(value) ?? normaliseIconUrl(value);
}

/**
 * Only a base64 image data URL, within the size ceiling.
 *
 * The type list is closed on purpose: Discord accepts PNG, JPEG, WEBP and GIF,
 * and a `data:text/html` or `data:image/svg+xml` value is either useless there or
 * an injection waiting to happen if it is ever rendered back.
 *
 * Returns null for anything unusable. Callers must distinguish "absent" from
 * "rejected" — silently storing null would wipe an image the operator meant to
 * replace, so the write path refuses the request instead.
 */
export function normaliseImageDataUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;
  if (raw.length > MAX_IMAGE_DATA_URL_LENGTH) return null;
  return /^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(raw) ? raw : null;
}

/** Why an image was refused, for the operator-facing message. */
export function imageRejectionReason(value: unknown): "TOO_LARGE" | "NOT_AN_IMAGE" | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;
  if (normaliseImageDataUrl(raw)) return null;
  return raw.length > MAX_IMAGE_DATA_URL_LENGTH ? "TOO_LARGE" : "NOT_AN_IMAGE";
}

export function normaliseBio(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, MAX_BIO_LENGTH);
}

export function normaliseActivityText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, MAX_ACTIVITY_TEXT_LENGTH);
}

export function isBotStatus(value: unknown): value is BotStatus {
  return typeof value === "string" && (botStatuses as readonly string[]).includes(value);
}

export function isActivityType(value: unknown): value is ActivityType {
  return typeof value === "string" && (activityTypes as readonly string[]).includes(value);
}

export function normaliseBotStatus(value: unknown): BotStatus {
  return isBotStatus(value) ? value : DEFAULT_BOT_STATUS;
}

export function normaliseActivityType(value: unknown): ActivityType {
  return isActivityType(value) ? value : DEFAULT_ACTIVITY_TYPE;
}

/**
 * Normalises a whole appearance. Used by the BFF before a write and by the bot
 * after a read, so a value can never mean two different things on the two sides.
 */
export function normaliseCustomization(input: Partial<CustomizationSettings> | null | undefined): CustomizationSettings {
  return {
    nickname: normaliseNickname(input?.nickname),
    roleColor: normaliseHexColor(input?.roleColor),
    // A data URL from the cropper or an https link from a value stored earlier.
    roleIconUrl: normaliseImageValue(input?.roleIconUrl)
  };
}

/* ------------------------------------------------------------------ *
 * Global bot identity
 *
 * The counterpart to the per-guild settings above, and a separate type because
 * it is a separate scope: Discord gives the application ONE avatar and ONE
 * banner, and one presence shared by every guild it is in. Storing these per
 * guild would mean N rows holding the same value, where the last writer wins and
 * the others silently disagree — so they live in their own single-row table and
 * this contract says so.
 * ------------------------------------------------------------------ */

export type BotIdentitySettings = {
  /** Global account avatar as a base64 data URL, or null for Discord's default. */
  avatarDataUrl: string | null;
  /** Global account banner as a base64 data URL, or null. */
  bannerDataUrl: string | null;
  /** The application description Discord shows as the bot's "About me". */
  bio: string;
  status: BotStatus;
  activityType: ActivityType;
  /** Empty means "show no activity" rather than an activity with a blank name. */
  activityText: string;
  /**
   * The status durations Discord offers when you click one of the three
   * timed states, or null for "until I change it".
   *
   * Discord's own client lets you hold `idle`, `dnd` or `invisible` for a fixed
   * window — 15 minutes, an hour, and so on — and then clears it. Storing the
   * choice is what makes the sub-menu honest: a duration the operator picks and
   * the dashboard throws away would be a control that saves but never applies.
   *
   * Not every state accepts a duration. Discord only offers the sub-menu for
   * those three; `online` has no duration and normalisation clears any value
   * paired with it, so a stale clock can never linger behind a state that has no
   * concept of running out.
   */
  statusDuration: BotStatusDuration | null;
  /**
   * When the timed status lapses, as an ISO-8601 instant, or null for "never".
   *
   * Derived from `statusDuration` when the status is written, not sent by the
   * client: the client picks a duration, and the server owns what that means in
   * wall-clock terms. It exists so the reader can tell a window that has passed
   * from one still running, which is the difference between showing the operator
   * `dnd` and showing them `online` with an explanation.
   */
  statusExpiresAt: string | null;
};

export const DEFAULT_BOT_IDENTITY: BotIdentitySettings = {
  avatarDataUrl: null,
  bannerDataUrl: null,
  bio: "",
  status: DEFAULT_BOT_STATUS,
  activityType: DEFAULT_ACTIVITY_TYPE,
  activityText: "",
  statusDuration: null,
  statusExpiresAt: null
};

/**
 * A stored identity as it comes *out* of the database, before validation.
 *
 * The distinction from `BotIdentitySettings` is the whole point of this type.
 * `normaliseBotIdentity` exists to turn unvalidated input into a valid identity,
 * so typing its parameter as `Partial<BotIdentitySettings>` was a contradiction:
 * it demanded a `BotStatus` and then spent its body checking whether the value
 * was one. That mismatch is what made both database readers — the bot's and the
 * dashboard's — fail to compile over a string that the function is designed to
 * accept.
 *
 * `unknown` on the narrowed fields is deliberate rather than `string`: the point
 * is that the caller has not validated them, and the function is what decides.
 * Widening the parameter does not weaken the result — the return type is still
 * a fully-validated `BotIdentitySettings`.
 */
export type RawBotIdentity = Partial<{
  avatarDataUrl: unknown;
  bannerDataUrl: unknown;
  bio: unknown;
  status: unknown;
  activityType: unknown;
  activityText: unknown;
  statusDuration: unknown;
  statusExpiresAt: unknown;
}>;

/**
 * Resolve the timed-status pair from raw input.
 *
 * Both fields are decided here rather than in the route, so the bot and the
 * dashboard cannot disagree about when a window closes. The rules:
 *
 * - A duration on a status Discord offers no sub-menu for is dropped, along with
 *   its expiry. Keeping the expiry would leave a stale clock counting down
 *   behind `online`, which has no concept of running out.
 * - `forever` stores a duration with a null expiry: the operator made a real
 *   choice and the sub-menu must still show it when they reopen the popover.
 * - A missing duration stores null, which reads as "no window" — the state a
 *   fresh install is in.
 *
 * An unparseable `statusExpiresAt` becomes null rather than Invalid Date: a
 * corrupt clock must not make the status look permanently expired.
 */
function normaliseStatusWindow(
  status: BotStatus,
  duration: unknown,
  expiresAt: unknown
): Pick<BotIdentitySettings, "statusDuration" | "statusExpiresAt"> {
  if (!isTimedBotStatus(status) || !isBotStatusDuration(duration)) {
    return { statusDuration: null, statusExpiresAt: null };
  }

  const ms = durationToMs(duration);
  if (ms === null) return { statusDuration: duration, statusExpiresAt: null };

  const parsed = typeof expiresAt === "string" ? Date.parse(expiresAt) : Number.NaN;
  return {
    statusDuration: duration,
    statusExpiresAt: Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
  };
}

export function normaliseBotIdentity(input: RawBotIdentity | null | undefined): BotIdentitySettings {
  const status = normaliseBotStatus(input?.status);
  return {
    avatarDataUrl: normaliseImageDataUrl(input?.avatarDataUrl),
    bannerDataUrl: normaliseImageDataUrl(input?.bannerDataUrl),
    bio: normaliseBio(input?.bio),
    status,
    activityType: normaliseActivityType(input?.activityType),
    activityText: normaliseActivityText(input?.activityText),
    ...normaliseStatusWindow(status, input?.statusDuration, input?.statusExpiresAt)
  };
}

/**
 * Whether a stored status window has already closed.
 *
 * The reader asks this rather than comparing timestamps itself, so the two sides
 * cannot disagree about the boundary. A missing expiry means the window is open
 * — either it is `forever`, or there is no window at all — and a status with no
 * duration is never expired.
 */
export function isStatusWindowExpired(
  identity: Pick<BotIdentitySettings, "statusDuration" | "statusExpiresAt">,
  now: number
): boolean {
  if (identity.statusDuration === null || identity.statusExpiresAt === null) return false;
  const expires = Date.parse(identity.statusExpiresAt);
  return Number.isFinite(expires) && expires <= now;
}

/**
 * The status to actually show, once an elapsed window is taken into account.
 *
 * A timed `dnd` whose window closed falls back to `online`, which is what
 * Discord does when the clock runs out. The stored row is deliberately *not*
 * rewritten on read: a read must not mutate, and the operator's chosen state is
 * worth keeping until they change it.
 */
export function effectiveBotStatus(identity: BotIdentitySettings, now: number): BotStatus {
  return isStatusWindowExpired(identity, now) ? DEFAULT_BOT_STATUS : identity.status;
}

/**
 * The fields the dashboard can only apply over REST, in the order the form shows
 * them. Named here so the write path and its tests cannot disagree about which
 * fields exist.
 */
export const BOT_IDENTITY_IMAGE_FIELDS = ["avatarDataUrl", "bannerDataUrl"] as const;

/* ------------------------------------------------------------------ *
 * Appearance save results
 *
 * An appearance save is not all-or-nothing: Discord applies each field on its
 * own, and one refusal (a nickname the bot may not change, a rate limit on
 * profile edits) must not discard the other five. These types are the shape
 * both scopes answer with, declared once in core so the BFF, the two screens
 * and their tests cannot disagree about what "saved" means.
 *
 * `applied` and `failed` are both reported, never inferred from one another:
 * an empty `failed` means every attempted field landed, and an empty `applied`
 * with a non-empty `failed` means nothing did and the save is an error.
 * ------------------------------------------------------------------ */

/** Arabic labels for the fields an operator can change, for messages. */
export const APPEARANCE_FIELD_LABELS_AR = {
  nickname: "الاسم المستعار",
  avatarDataUrl: "الصورة الرمزية",
  bannerDataUrl: "البانر",
  bio: "النبذة التعريفية",
  roleColor: "لون الرتبة",
  roleIconUrl: "أيقونة الرتبة"
} as const;

export type AppearanceFieldName = keyof typeof APPEARANCE_FIELD_LABELS_AR;

/** One field Discord refused, with something the operator can act on. */
export type AppearanceFailure = {
  field: AppearanceFieldName;
  code: string;
  message: string;
};

/** What a save actually did, as the toast reads it. */
export type AppearanceSaveResult = {
  savedAt: string;
  /** Fields Discord accepted. The rest of the form is untouched. */
  applied: AppearanceFieldName[];
  /** Empty on a clean save. Never empty on a partial one. */
  failed: AppearanceFailure[];
};

/**
 * The sentence a toast shows after a save.
 *
 * Extracted so the two scopes say the same thing, and so "some fields were
 * skipped" can never be presented as a plain success — the operator would walk
 * away believing the whole form took effect.
 */
export function describeAppearanceResult(result: AppearanceSaveResult): { ok: boolean; message: string } {
  const failedFields = result.failed.map(entry => APPEARANCE_FIELD_LABELS_AR[entry.field] ?? entry.field);

  if (result.failed.length === 0) {
    return { ok: true, message: result.applied.length === 0 ? "لا توجد تغييرات لتطبيقها." : "تم حفظ التغييرات وتطبيقها." };
  }

  if (result.applied.length === 0) {
    return { ok: false, message: result.failed.map(entry => entry.message).join(" ") };
  }

  return {
    ok: false,
    message: `تم تطبيق بعض التغييرات، وتعذّر تطبيق: ${failedFields.join("، ")}. ${result.failed
      .map(entry => entry.message)
      .join(" ")}`
  };
}

/** Where the bot's profile picture is expected to be square and its banner wide. */
export const IMAGE_ASPECT_RATIOS = { avatar: 1, banner: 600 / 240, roleIcon: 1 } as const;

/** The size each upload is cropped to before it is sent to Discord. */
export const IMAGE_TARGET_SIZES = {
  avatar: { width: 256, height: 256 },
  banner: { width: 600, height: 240 },
  roleIcon: { width: 128, height: 128 }
} as const;

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
