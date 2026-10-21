import { normaliseSnowflake } from "./snowflake.js";

/* ------------------------------------------------------------------ *
 * Welcome messages (رسائل الترحيب) — settings
 *
 * One settings row per guild. The module sends a message — plain text or a
 * rich embed, optionally carrying a generated image — to a channel when a
 * member joins. Distinct from the auto-role welcome (`guild_welcome`): that
 * one grants a role, this one speaks.
 * ------------------------------------------------------------------ */

/** Where the generated image goes, relative to the message. */
export type WelcomeImageMode = "with_message" | "before_message" | "separate_channel";

/** Plain text, or a Discord embed. */
export type WelcomeMessageMode = "text" | "embed";

/** How the embed's thumbnail is sourced. */
export type WelcomeEmbedThumbnailMode = "none" | "member_avatar" | "custom";

/** How the embed's large image is sourced. */
export type WelcomeEmbedImageMode = "none" | "upload" | "url";

export type WelcomeEmbedField = { id: string; name: string; value: string; inline: boolean };

export type WelcomeEmbed = {
  /** Optional plain text sent above the embed. Empty sends the embed alone. */
  content: string;
  title: string;
  /** Makes the title a hyperlink — an https URL, or null for plain text. */
  titleUrl: string | null;
  description: string;
  /** "#rrggbb" embed side-bar colour, or null for Discord's default. */
  color: string | null;
  thumbnailMode: WelcomeEmbedThumbnailMode;
  /** Only meaningful for thumbnailMode "custom". */
  thumbnailUrl: string | null;
  imageMode: WelcomeEmbedImageMode;
  /** The uploaded attachment as a base64 data URL, capped like every image. */
  imageDataUrl: string | null;
  /** Or a remote image URL. */
  imageUrl: string | null;
  footer: string;
  /** Small icon beside the footer text — an https URL, or null. */
  footerIconUrl: string | null;
  /** Append Discord's relative timestamp to the footer. */
  timestamp: boolean;
  fields: WelcomeEmbedField[];
};

/** Background behind the generated welcome image. */
export type WelcomeImageBackground = {
  type: "transparent" | "color" | "image" | "gradient";
  /** For "color". */
  color: string | null;
  /** For "gradient": the first stop, top-left to bottom-right. */
  gradientFrom?: string | null;
  /** For "gradient": the second stop. */
  gradientTo?: string | null;
  /** 0-1: how strongly the background is painted over the card. */
  opacity?: number;
  /** For "image", as a base64 data URL, capped like every image. */
  imageDataUrl: string | null;
};

/** The joiner's avatar, drawn at a position with optional circular crop. */
export type WelcomeImageAvatarLayer = {
  enabled: boolean;
  x: number;
  y: number;
  size: number;
  circular: boolean;
  /** Ring colour, or null for no ring. */
  strokeColor: string | null;
  strokeWidth: number;
  /** A soft light around the avatar, as a colour and a radius in pixels. */
  glowColor?: string | null;
  glowSize?: number;
};

export type WelcomeTextLayer = {
  id: string;
  /** The literal text; may carry the same tokens as the message. */
  text: string;
  x: number;
  y: number;
  fontFamily: string;
  fontSize: number;
  color: string;
  weight: "normal" | "bold";
  align: "start" | "center" | "end";
  /** A line around the glyphs, as a colour and a width in pixels. */
  strokeColor?: string | null;
  strokeWidth?: number;
  /** A soft shadow under the text, as a colour and a radius in pixels. */
  shadowColor?: string | null;
  shadowSize?: number;
};

/** The whole canvas the bot renders per join. */
export type WelcomeImageConfig = {
  width: number;
  height: number;
  /**
   * JPEG quality (0.5–1) used when the background is opaque; a transparent
   * background forces PNG regardless, because JPEG has no alpha.
   */
  quality: number;
  background: WelcomeImageBackground;
  avatar: WelcomeImageAvatarLayer;
  /** The joiner's name, as one named text layer. */
  username: WelcomeTextLayer;
  customTexts: WelcomeTextLayer[];
};

export type WelcomeMessageSettings = {
  enabled: boolean;
  imageEnabled: boolean;
  imageMode: WelcomeImageMode;
  /** Only meaningful when imageMode is "separate_channel". */
  imageChannelId: string | null;
  /** Where the message itself goes. Null means unset — the module stays quiet. */
  channelId: string | null;
  mode: WelcomeMessageMode;
  /** The plain-text message, also the embed's content source in embed mode? No: `embed.content` owns that. */
  text: string;
  embed: WelcomeEmbed;
  image: WelcomeImageConfig;
};

/* ---------------- tokens ---------------- */

/** The variables every welcome text may carry — message, embed, and canvas alike. */
export const WELCOME_MESSAGE_TOKENS = ["{user}", "{username}", "{server}", "{memberCount}", "{inviter}", "{joinDate}"] as const;

export const WELCOME_TOKEN_LABELS_AR: Record<(typeof WELCOME_MESSAGE_TOKENS)[number], string> = {
  "{user}": "منشن العضو",
  "{username}": "اسم المستخدم",
  "{server}": "اسم السيرفر",
  "{memberCount}": "عدد الأعضاء",
  "{inviter}": "منشن الداعي",
  "{joinDate}": "تاريخ الانضمام"
};

/** The values a template's tokens fill, as the bot resolves them at join time. */
export type WelcomeTemplateValues = {
  userMention: string;
  username: string;
  server: string;
  memberCount: number;
  inviterMention: string;
  joinDate: string;
};

/**
 * Fills a welcome template's tokens. An unknown token is left as the operator
 * typed it — a template is prose. A missing inviter renders the token as
 * "غير معروف" rather than an empty slot.
 */
export function renderWelcomeMessage(template: string, values: WelcomeTemplateValues): string {
  return template
    .replaceAll("{user}", values.userMention)
    .replaceAll("{username}", values.username)
    .replaceAll("{server}", values.server)
    .replaceAll("{memberCount}", String(values.memberCount))
    .replaceAll("{inviter}", values.inviterMention || "غير معروف")
    .replaceAll("{joinDate}", values.joinDate);
}

/* ---------------- limits ---------------- */

export const MAX_WELCOME_EMBED_FIELDS = 10;
export const MAX_WELCOME_TEXT_LENGTH = 2_000;
export const MAX_WELCOME_EMBED_DESCRIPTION = 4_000;
export const MAX_WELCOME_EMBED_TITLE = 256;
export const MAX_WELCOME_EMBED_FOOTER = 2_048;
export const MAX_WELCOME_CANVAS_EDGE = 2_048;
export const MIN_WELCOME_CANVAS_EDGE = 128;
export const MAX_WELCOME_CUSTOM_TEXTS = 8;

/** Arabic-capable font families the canvas offers, mapped to real font stacks. */
export const WELCOME_FONT_FAMILIES = ["IBM Plex Sans Arabic", "Segoe UI", "Tahoma", "Arial", "Impact", "Georgia"] as const;

/* ---------------- normalisation ---------------- */

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.round(numeric)));
}

function clampString(value: unknown, max: number, fallback = ""): string {
  if (typeof value !== "string") return fallback;
  return value.slice(0, max);
}

/** A [0, 1] fraction - the background's opacity, kept as a real fraction. */
function clampFraction(value: unknown, fallback: number): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(1, Math.max(0, numeric));
}

function normaliseHexColorField(value: unknown, fallback: string | null): string | null {
  if (value === null) return null;
  if (typeof value !== "string") return fallback;
  const short = /^#([0-9a-fA-F]{3})$/.exec(value.trim());
  if (short) return `#${short[1].split("").map(char => char + char).join("").toLowerCase()}`;
  const full = /^#([0-9a-fA-F]{6})$/.exec(value.trim());
  return full ? `#${full[1].toLowerCase()}` : fallback;
}

const IMAGE_DATA_URL_PATTERN = /^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/;

/** Accepts a well-formed image data URL, or null. The caller enforces the size cap. */
export function normaliseWelcomeImageDataUrl(value: unknown, maxBytes: number): string | null {
  if (typeof value !== "string" || !IMAGE_DATA_URL_PATTERN.test(value)) return null;
  return value.length <= maxBytes ? value : null;
}

const EMBED_FIELD_ID = (index: number) => `field-${index + 1}`;

function normaliseEmbedFields(value: unknown): WelcomeEmbedField[] {
  if (!Array.isArray(value)) return [];
  const fields: WelcomeEmbedField[] = [];
  for (const entry of value) {
    const source = (entry ?? {}) as Partial<WelcomeEmbedField>;
    const name = clampString(source.name, MAX_WELCOME_EMBED_TITLE).trim();
    const fieldValue = clampString(source.value, MAX_WELCOME_EMBED_DESCRIPTION).trim();
    // An empty half-field is inert repetition, not content.
    if (!name || !fieldValue) continue;
    fields.push({
      id: typeof source.id === "string" && source.id ? source.id.slice(0, 64) : EMBED_FIELD_ID(fields.length),
      name,
      value: fieldValue,
      inline: source.inline === true
    });
    if (fields.length >= MAX_WELCOME_EMBED_FIELDS) break;
  }
  return fields;
}

const THUMBNAIL_MODES: readonly WelcomeEmbedThumbnailMode[] = ["none", "member_avatar", "custom"];
const IMAGE_MODES: readonly WelcomeEmbedImageMode[] = ["none", "upload", "url"];
const IMAGE_SEND_MODES: readonly WelcomeImageMode[] = ["with_message", "before_message", "separate_channel"];

function normaliseTextLayer(value: unknown, fallback: WelcomeTextLayer): WelcomeTextLayer {
  const source = (value ?? {}) as Partial<WelcomeTextLayer>;
  const family = WELCOME_FONT_FAMILIES.includes(source.fontFamily as (typeof WELCOME_FONT_FAMILIES)[number])
    ? (source.fontFamily as string)
    : fallback.fontFamily;
  const weight = source.weight === "bold" ? "bold" : "normal";
  const align = source.align === "center" || source.align === "end" ? source.align : "start";
  return {
    id: typeof source.id === "string" && source.id ? source.id.slice(0, 64) : fallback.id,
    text: clampString(source.text, MAX_WELCOME_TEXT_LENGTH, fallback.text),
    // The layer bounds come from the caller's canvas — normaliseTextLayer
    // receives them through the fallback's coordinates, so the clamp here
    // stays the global ceiling and the config-level pass trims to the edges.
    x: clampInt(source.x, 0, MAX_WELCOME_CANVAS_EDGE, fallback.x),
    y: clampInt(source.y, 0, MAX_WELCOME_CANVAS_EDGE, fallback.y),
    fontFamily: family,
    fontSize: clampInt(source.fontSize, 8, 512, fallback.fontSize),
    color: normaliseHexColorField(source.color, fallback.color) ?? fallback.color,
    weight,
    align,
    strokeColor: normaliseHexColorField(source.strokeColor, null),
    strokeWidth: clampInt(source.strokeWidth, 0, 16, 0),
    shadowColor: normaliseHexColorField(source.shadowColor, null),
    shadowSize: clampInt(source.shadowSize, 0, 64, 0)
  };
}

/** A real [0.5, 1] clamp — the quality is a fraction, never an integer. */
function clampQuality(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return 0.9;
  return Math.min(1, Math.max(0.5, numeric));
}

export function normaliseWelcomeImageConfig(value: unknown): WelcomeImageConfig {
  const source = (value ?? {}) as Partial<WelcomeImageConfig>;
  const backgroundSource = (source.background ?? {}) as Partial<WelcomeImageBackground>;
  const bgType =
    backgroundSource.type === "color" || backgroundSource.type === "image" || backgroundSource.type === "gradient" ? backgroundSource.type : "transparent";
  const width = clampInt(source.width, MIN_WELCOME_CANVAS_EDGE, MAX_WELCOME_CANVAS_EDGE, 800);
  const height = clampInt(source.height, MIN_WELCOME_CANVAS_EDGE, MAX_WELCOME_CANVAS_EDGE, 400);
  const avatarSource = (source.avatar ?? {}) as Partial<WelcomeImageAvatarLayer>;
  const maxAvatarSize = Math.min(512, width, height);
  const fallbackAvatar: WelcomeImageAvatarLayer = {
    enabled: true,
    x: Math.round(width / 2 - 64),
    y: 40,
    size: 128,
    circular: true,
    strokeColor: "#3b82f6",
    strokeWidth: 4
  };
  const base: WelcomeImageConfig = {
    width,
    height,
    quality: clampQuality(source.quality),
    background: {
      type: bgType,
      color: bgType === "color" ? normaliseHexColorField(backgroundSource.color, "#0b1020") : null,
      gradientFrom: bgType === "gradient" ? normaliseHexColorField(backgroundSource.gradientFrom, "#1d4ed8") : null,
      gradientTo: bgType === "gradient" ? normaliseHexColorField(backgroundSource.gradientTo, "#7c3aed") : null,
      opacity: clampFraction(backgroundSource.opacity, 1),
      imageDataUrl: bgType === "image" ? normaliseWelcomeImageDataUrl(backgroundSource.imageDataUrl, MAX_IMAGE_BYTES) : null
    },
    avatar: {
      enabled: avatarSource.enabled !== false,
      x: clampInt(avatarSource.x, 0, Math.max(0, width - Math.min(clampInt(avatarSource.size, 16, 512, fallbackAvatar.size), maxAvatarSize)), fallbackAvatar.x),
      y: clampInt(avatarSource.y, 0, Math.max(0, height - Math.min(clampInt(avatarSource.size, 16, 512, fallbackAvatar.size), maxAvatarSize)), fallbackAvatar.y),
      size: Math.min(clampInt(avatarSource.size, 16, 512, fallbackAvatar.size), maxAvatarSize),
      circular: avatarSource.circular !== false,
      strokeColor: normaliseHexColorField(avatarSource.strokeColor, null),
      strokeWidth: clampInt(avatarSource.strokeWidth, 0, 32, fallbackAvatar.strokeWidth),
      glowColor: normaliseHexColorField(avatarSource.glowColor, null),
      glowSize: clampInt(avatarSource.glowSize, 0, 128, 0)
    },
    username: normaliseTextLayer(source.username, {
      id: "username",
      text: "{username}",
      x: Math.round(width / 2),
      y: Math.round(height - 60),
      fontFamily: "IBM Plex Sans Arabic",
      fontSize: 36,
      color: "#ffffff",
      weight: "bold",
      align: "center"
    }),
    customTexts: Array.isArray(source.customTexts)
      ? source.customTexts.slice(0, MAX_WELCOME_CUSTOM_TEXTS).map((entry, index) =>
          normaliseTextLayer(entry, {
            id: `text-${index + 1}`,
            text: "نص",
            x: Math.round(width / 2),
            y: 120 + index * 48,
            fontFamily: "IBM Plex Sans Arabic",
            fontSize: 24,
            color: "#ffffff",
            weight: "normal",
            align: "center"
          })
        )
      : []
  };
  return clampWelcomeImageConfig(base);
}

export const MAX_IMAGE_BYTES = 500_000;

const DEFAULT_EMBED: WelcomeEmbed = {
  content: "",
  title: "مرحباً بك في {server} 🎉",
  titleUrl: null,
  description: "أهلاً {user}، نتمنى لك وقتاً ممتعاً معنا!",
  color: "#3b82f6",
  thumbnailMode: "member_avatar",
  thumbnailUrl: null,
  imageMode: "none",
  imageDataUrl: null,
  imageUrl: null,
  footer: "",
  footerIconUrl: null,
  timestamp: true,
  fields: []
};

export const DEFAULT_WELCOME_MESSAGE_SETTINGS: WelcomeMessageSettings = {
  enabled: false,
  imageEnabled: false,
  imageMode: "with_message",
  imageChannelId: null,
  channelId: null,
  mode: "embed",
  text: "أهلاً وسهلاً {user} في {server}! 🎉",
  embed: DEFAULT_EMBED,
  image: normaliseWelcomeImageConfig(null)
};

export function normaliseWelcomeEmbed(value: unknown): WelcomeEmbed {
  const source = (value ?? {}) as Partial<WelcomeEmbed>;
  const thumbnailMode = THUMBNAIL_MODES.includes(source.thumbnailMode as WelcomeEmbedThumbnailMode)
    ? (source.thumbnailMode as WelcomeEmbedThumbnailMode)
    : DEFAULT_EMBED.thumbnailMode;
  const imageMode = IMAGE_MODES.includes(source.imageMode as WelcomeEmbedImageMode)
    ? (source.imageMode as WelcomeEmbedImageMode)
    : DEFAULT_EMBED.imageMode;
  const content = clampString(source.content, MAX_WELCOME_TEXT_LENGTH);
  const title = clampString(source.title, MAX_WELCOME_EMBED_TITLE);
  const description = clampString(source.description, MAX_WELCOME_EMBED_DESCRIPTION);
  const imageDataUrl = imageMode === "upload" ? normaliseWelcomeImageDataUrl(source.imageDataUrl, MAX_IMAGE_BYTES) : null;
  const imageUrl = imageMode === "url" && typeof source.imageUrl === "string" && /^https:\/\//.test(source.imageUrl)
    ? source.imageUrl.slice(0, 512)
    : null;
  // An embed whose every visible slot is empty renders as a thin coloured bar
  // — legal for Discord, useless for a greeting. It stays storable; the
  // readiness badge on the screen is what flags it.
  const httpsOr = (value: unknown): string | null =>
    typeof value === "string" && /^https:\/\//.test(value) ? value.slice(0, 512) : null;
  return {
    content,
    title,
    titleUrl: httpsOr(source.titleUrl),
    description,
    color: normaliseHexColorField(source.color, DEFAULT_EMBED.color),
    thumbnailMode,
    thumbnailUrl:
      thumbnailMode === "custom" && typeof source.thumbnailUrl === "string" && /^https:\/\//.test(source.thumbnailUrl)
        ? source.thumbnailUrl.slice(0, 512)
        : null,
    imageMode,
    imageDataUrl,
    imageUrl,
    footer: clampString(source.footer, MAX_WELCOME_EMBED_FOOTER),
    footerIconUrl: httpsOr(source.footerIconUrl),
    timestamp: source.timestamp !== false,
    fields: normaliseEmbedFields(source.fields)
  };
}

/**
 * Keeps every layer inside the canvas. The avatar's size is bounded by the
 * canvas itself — a 512px avatar on a 400px card is not a design, it is an
 * escapee — and every position is clamped so a slider shrinking the canvas
 * cannot leave a layer parked outside it. Exported because the dashboard's
 * drag editor and its dimension sliders apply the same rule live, between
 * saves.
 */
export function clampWelcomeImageConfig(config: WelcomeImageConfig): WelcomeImageConfig {
  const maxAvatarSize = Math.min(512, config.width, config.height);
  const size = Math.min(config.avatar.size, maxAvatarSize);
  const avatar = {
    ...config.avatar,
    size,
    x: Math.min(config.avatar.x, Math.max(0, config.width - size)),
    y: Math.min(config.avatar.y, Math.max(0, config.height - size))
  };
  const clampText = (layer: WelcomeTextLayer): WelcomeTextLayer => ({
    ...layer,
    x: Math.min(layer.x, config.width),
    y: Math.min(layer.y, config.height)
  });
  return {
    ...config,
    avatar,
    username: clampText(config.username),
    customTexts: config.customTexts.map(clampText)
  };
}

/**
 * Normalised, not trusted — the same helper the BFF writes through and the bot
 * reads through, so a hand-crafted PUT cannot store a value the bot would
 * behave differently on.
 */
export function normaliseWelcomeMessageSettings(value: unknown): WelcomeMessageSettings {
  const source = (value ?? {}) as Partial<WelcomeMessageSettings>;
  const imageMode = IMAGE_SEND_MODES.includes(source.imageMode as WelcomeImageMode)
    ? (source.imageMode as WelcomeImageMode)
    : DEFAULT_WELCOME_MESSAGE_SETTINGS.imageMode;
  const mode = source.mode === "text" || source.mode === "embed" ? source.mode : DEFAULT_WELCOME_MESSAGE_SETTINGS.mode;
  return {
    enabled: source.enabled === true,
    imageEnabled: source.imageEnabled === true,
    imageMode,
    // A separate-channel image without a channel would silently drop the
    // image; the route validates existence, and a non-snowflake here is unset.
    imageChannelId: imageMode === "separate_channel" ? normaliseSnowflake(source.imageChannelId) : null,
    channelId: normaliseSnowflake(source.channelId),
    mode,
    text: clampString(source.text, MAX_WELCOME_TEXT_LENGTH, DEFAULT_WELCOME_MESSAGE_SETTINGS.text),
    embed: normaliseWelcomeEmbed(source.embed),
    image: normaliseWelcomeImageConfig(source.image)
  };
}

/**
 * Whether the embed half carries enough to be worth sending — the readiness
 * badge on the screen derives from the same fields.
 */
export function welcomeEmbedReady(embed: WelcomeEmbed): boolean {
  return Boolean(embed.title.trim() || embed.description.trim() || embed.fields.length > 0);
}
