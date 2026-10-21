/**
 * The welcome-image renderer.
 *
 * The dashboard's Image Builder stores a layer config (background, avatar,
 * username, custom texts); this module turns that config plus one member's
 * facts into a PNG/JPEG buffer the bot can attach. Nothing here imports
 * discord.js — the avatar arrives as a plain CDN URL and the buffer leaves as
 * bytes — so the drawing decisions are unit-testable without a client.
 *
 * The canvas engine is @napi-rs/canvas (Skia): Arabic text shapes correctly
 * out of the box, which is the whole reason a welcome card drawn here is
 * legible. Fonts resolve against the host's system families — the config's
 * family list is the dashboard's offer, and an unavailable family silently
 * falls back, exactly as a browser would.
 */
import { createCanvas, Image as CanvasImage, type SKRSContext2D, type Canvas } from "@napi-rs/canvas";
import {
  MAX_IMAGE_BYTES,
  renderWelcomeMessage,
  type WelcomeImageConfig,
  type WelcomeTemplateValues
} from "@al-ai/core";

export type WelcomeImageResult = {
  buffer: Buffer;
  /** "image/png" or "image/jpeg" — chosen by the background's alpha, not by taste. */
  contentType: "image/png" | "image/jpeg";
  extension: "png" | "jpg";
};

/**
 * The drawing plan: every shape the renderer will put on the canvas, resolved
 * against the member's values. Pure, so tests can assert "the username layer
 * carries the rendered name" without bitmap comparison.
 */
export type DrawOp =
  | { kind: "fill"; color: string; opacity?: number }
  | { kind: "gradient"; from: string; to: string; opacity?: number }
  | { kind: "image"; source: Buffer; x: number; y: number; width: number; height: number }
  | {
      kind: "avatar";
      source: Buffer;
      x: number;
      y: number;
      size: number;
      circular: boolean;
      strokeColor: string | null;
      strokeWidth: number;
      glowColor: string | null;
      glowSize: number;
    }
  | {
      kind: "text";
      text: string;
      x: number;
      y: number;
      fontFamily: string;
      fontSize: number;
      color: string;
      weight: "normal" | "bold";
      align: "start" | "center" | "end";
      strokeColor: string | null;
      strokeWidth: number;
      shadowColor: string | null;
      shadowSize: number;
    };

/**
 * Builds the op list from the config and one member's facts. A background
 * image that fails to decode is dropped here (the ops say so), not mid-draw:
 * a card with the configured colour fallback behind it is better than a join
 * message that never arrives.
 */
export async function planWelcomeImageDraw(
  config: WelcomeImageConfig,
  facts: { values: WelcomeTemplateValues; avatarBuffer: Buffer | null; backgroundBuffer: Buffer | null }
): Promise<DrawOp[]> {
  const ops: DrawOp[] = [];
  if (config.background.type === "color" && config.background.color) {
    ops.push({ kind: "fill", color: config.background.color, opacity: config.background.opacity ?? 1 });
  } else if (config.background.type === "gradient" && config.background.gradientFrom && config.background.gradientTo) {
    ops.push({
      kind: "gradient",
      from: config.background.gradientFrom,
      to: config.background.gradientTo,
      opacity: config.background.opacity ?? 1
    });
  } else if (config.background.type === "image" && facts.backgroundBuffer) {
    ops.push({
      kind: "image",
      source: facts.backgroundBuffer,
      x: 0,
      y: 0,
      width: config.width,
      height: config.height
    });
  }
  if (config.avatar.enabled && facts.avatarBuffer) {
    ops.push({
      kind: "avatar",
      source: facts.avatarBuffer,
      x: config.avatar.x,
      y: config.avatar.y,
      size: config.avatar.size,
      circular: config.avatar.circular,
      strokeColor: config.avatar.strokeColor,
      strokeWidth: config.avatar.strokeWidth,
      glowColor: config.avatar.glowColor ?? null,
      glowSize: config.avatar.glowSize ?? 0
    });
  }
  if (config.username.text.trim()) {
    ops.push({
      kind: "text",
      text: renderWelcomeMessage(config.username.text, facts.values),
      x: config.username.x,
      y: config.username.y,
      fontFamily: config.username.fontFamily,
      fontSize: config.username.fontSize,
      color: config.username.color,
      weight: config.username.weight,
      align: config.username.align,
      strokeColor: config.username.strokeColor ?? null,
      strokeWidth: config.username.strokeWidth ?? 0,
      shadowColor: config.username.shadowColor ?? null,
      shadowSize: config.username.shadowSize ?? 0
    });
  }
  for (const layer of config.customTexts) {
    if (!layer.text.trim()) continue;
    ops.push({
      kind: "text",
      text: renderWelcomeMessage(layer.text, facts.values),
      x: layer.x,
      y: layer.y,
      fontFamily: layer.fontFamily,
      fontSize: layer.fontSize,
      color: layer.color,
      weight: layer.weight,
      align: layer.align,
      strokeColor: layer.strokeColor ?? null,
      strokeWidth: layer.strokeWidth ?? 0,
      shadowColor: layer.shadowColor ?? null,
      shadowSize: layer.shadowSize ?? 0
    });
  }
  return ops;
}

/** Decodes a base64 data URL into bytes, or null. Bounded by the shared cap. */
export function dataUrlToBuffer(dataUrl: string | null, maxBytes = MAX_IMAGE_BYTES): Buffer | null {
  if (!dataUrl) return null;
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return null;
  const base64 = dataUrl.slice(comma + 1);
  if (base64.length * 0.75 > maxBytes) return null;
  // Buffer.from silently skips invalid characters, so a garbage payload would
  // decode into an empty buffer and read as "fine". The charset check is what
  // makes a malformed data URL a null instead.
  if (!/^[A-Za-z0-9+/=\s]+$/.test(base64) || base64.length === 0) return null;
  const bytes = Buffer.from(base64, "base64");
  return bytes.length > 0 ? bytes : null;
}

async function loadRemoteImage(url: string): Promise<Buffer | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!response.ok) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    return bytes.length <= 4_000_000 ? bytes : null;
  } catch {
    return null;
  }
}

/** Fetches the joiner's avatar bytes; a CDN hiccup degrades to a card without an avatar. */
export async function fetchImageBytes(url: string | null): Promise<Buffer | null> {
  if (!url) return null;
  return loadRemoteImage(url);
}

/** One canvas op, executed. Exported for the tests to drive directly. */
export function executeDrawOp(ctx: SKRSContext2D, canvas: Canvas, op: DrawOp, images: Map<Buffer, unknown>): void {
  if (op.kind === "fill") {
    ctx.save();
    ctx.globalAlpha = op.opacity ?? 1;
    ctx.fillStyle = op.color;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
    return;
  }
  if (op.kind === "gradient") {
    ctx.save();
    ctx.globalAlpha = op.opacity ?? 1;
    const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
    gradient.addColorStop(0, op.from);
    gradient.addColorStop(1, op.to);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
    return;
  }
  if (op.kind === "image" || op.kind === "avatar") {
    // The decoded image is cached per buffer, so an op replayed in a test does
    // not decode twice — and drawImage accepts the engine's own Image object.
    let image = images.get(op.source);
    if (!image) {
      const decoded = new CanvasImage();
      decoded.src = op.source;
      image = decoded;
      images.set(op.source, image);
    }
    if (op.kind === "image") {
      ctx.drawImage(image as never, op.x, op.y, op.width, op.height);
      return;
    }
    ctx.save();
    // The glow: a soft light around the avatar, drawn as the same picture with
    // a shadow and nothing else painted.
    if (op.glowColor && op.glowSize > 0) {
      ctx.shadowColor = op.glowColor;
      ctx.shadowBlur = op.glowSize;
    }
    if (op.circular) {
      ctx.beginPath();
      ctx.arc(op.x + op.size / 2, op.y + op.size / 2, op.size / 2, 0, Math.PI * 2);
      ctx.closePath();
      ctx.clip();
    }
    ctx.drawImage(image as never, op.x, op.y, op.size, op.size);
    ctx.restore();
    if (op.circular && op.strokeColor && op.strokeWidth > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(op.x + op.size / 2, op.y + op.size / 2, op.size / 2 - op.strokeWidth / 2, 0, Math.PI * 2);
      ctx.strokeStyle = op.strokeColor;
      ctx.lineWidth = op.strokeWidth;
      ctx.stroke();
      ctx.restore();
    }
    return;
  }
  // Text. `y` is the baseline the dashboard's editor shows as the layer's
  // anchor, matching how the canvas editor positions its boxes.
  ctx.save();
  ctx.fillStyle = op.color;
  ctx.font = `${op.weight === "bold" ? "bold " : ""}${op.fontSize}px "${op.fontFamily}"`;
  ctx.textAlign = op.align === "start" ? "left" : op.align;
  ctx.textBaseline = "alphabetic";
  if (op.shadowColor && op.shadowSize > 0) {
    ctx.shadowColor = op.shadowColor;
    ctx.shadowBlur = op.shadowSize;
  }
  // The outline is drawn first, under the fill: a stroke painted afterwards
  // would cover the glyphs.
  if (op.strokeColor && op.strokeWidth > 0) {
    ctx.strokeStyle = op.strokeColor;
    ctx.lineWidth = op.strokeWidth;
    ctx.lineJoin = "round";
    ctx.strokeText(op.text, op.x, op.y);
  }
  ctx.fillText(op.text, op.x, op.y);
  ctx.restore();
}

/**
 * Renders the card. Returns null when there is genuinely nothing to draw
 * (no ops at all) — the caller then sends the message without an image
 * instead of attaching a blank canvas.
 */
export async function renderWelcomeImage(
  config: WelcomeImageConfig,
  facts: { values: WelcomeTemplateValues; avatarBuffer: Buffer | null; backgroundBuffer: Buffer | null }
): Promise<WelcomeImageResult | null> {
  const canvas = createCanvas(config.width, config.height);
  const ctx = canvas.getContext("2d");
  const images = new Map<Buffer, unknown>();

  const ops = await planWelcomeImageDraw(config, facts);
  if (ops.length === 0) return null;
  for (const op of ops) executeDrawOp(ctx, canvas, op, images);

  // Alpha only survives in a PNG, so an opaque background may use the JPEG
  // quality setting — that is what the builder's quality control means.
  if (config.background.type !== "transparent") {
    return {
      buffer: canvas.toBuffer("image/jpeg", config.quality),
      contentType: "image/jpeg",
      extension: "jpg"
    };
  }
  return { buffer: canvas.toBuffer("image/png"), contentType: "image/png", extension: "png" };
}
