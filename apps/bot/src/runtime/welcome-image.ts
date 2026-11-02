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
import { createCanvas, GifEncoder, ImageData, loadImage, type SKRSContext2D, type Canvas } from "@napi-rs/canvas";
import { decodeGifFrames, looksLikeAnimatedGif, type DecodedGif } from "./gif-frames.js";
import {
  MAX_IMAGE_BYTES,
  renderWelcomeMessage,
  type WelcomeImageConfig,
  type WelcomeTemplateValues
} from "@al-ai/core";

export type WelcomeImageResult = {
  buffer: Buffer;
  /**
   * "image/png" or "image/jpeg" for a still card — chosen by the background's
   * alpha, not by taste — and "image/gif" when the member's avatar was animated
   * and the card was composited frame by frame.
   */
  contentType: "image/png" | "image/jpeg" | "image/gif";
  extension: "png" | "jpg" | "gif";
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
      letterSpacing: number;
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
      shadowSize: config.username.shadowSize ?? 0,
      letterSpacing: config.username.letterSpacing ?? 0
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
      shadowSize: layer.shadowSize ?? 0,
      letterSpacing: layer.letterSpacing ?? 0
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

/**
 * The only hosts an avatar or embed image can come from.
 *
 * Today every caller passes a URL minted by discord.js, so this names what is
 * already true rather than restricting anyone. It is here because the card
 * renderer is the one place the bot fetches a URL at all: the day a stored
 * `imageUrl` or a background reaches this function, an unchecked `fetch` would
 * let the bot be pointed at a private address, and the dashboard's vetted
 * image layer (`server/appearance.ts`) does not cover this process.
 */
const ALLOWED_IMAGE_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);

/** Avatars are small; this is a runaway-response ceiling, not a quality budget. */
const MAX_REMOTE_IMAGE_BYTES = 4_000_000;

function isAllowedImageUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      !parsed.username &&
      !parsed.password &&
      ALLOWED_IMAGE_HOSTS.has(parsed.hostname)
    );
  } catch {
    return false;
  }
}

async function loadRemoteImage(url: string): Promise<Buffer | null> {
  if (!isAllowedImageUrl(url)) return null;
  try {
    // `redirect: "error"`: an allowed host that answers 302 to somewhere else
    // would otherwise be followed, which is exactly the hole the host list is
    // there to close.
    const response = await fetch(url, { signal: AbortSignal.timeout(8_000), redirect: "error" });
    if (!response.ok || !response.body) return null;
    // Read as it arrives. Buffering the whole body first means a server that
    // claims to send an image can make the bot hold as many bytes as it likes.
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      total += chunk.byteLength;
      if (total > MAX_REMOTE_IMAGE_BYTES) return null;
      chunks.push(Buffer.from(chunk));
    }
    return total > 0 ? Buffer.concat(chunks) : null;
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
export async function executeDrawOp(
  ctx: SKRSContext2D,
  canvas: Canvas,
  op: DrawOp,
  images: Map<Buffer, unknown>
): Promise<void> {
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
      // `loadImage`, never `new Image()` with `.src`. Measured on 1.0.11: the
      // constructed image reports the correct width, height and `complete`, and
      // then paints **nothing** — a 1×1 red PNG, a solid JPEG and an animated
      // GIF all came back `0,0,0,0` through that path, in both drawImage
      // overloads. `loadImage` decodes all three. The old path made every avatar
      // and every picture background on this card invisible.
      image = await loadImage(op.source);
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
  let fontSize = op.fontSize;
  const font = (size: number) => `${op.weight === "bold" ? "bold " : ""}${size}px "${op.fontFamily}"`;
  ctx.font = font(fontSize);
  // **The text must fit the card.** The renderer measures the line it is
  // about to draw and shrinks the font until it fits the card's width, so a
  // layer that was saved oversized is drawn whole instead of as a fragment.
  // The editor does the same measurement in the browser, and the two agree
  // on the rule: the line fits.
  const measured = ctx.measureText(op.text).width;
  if (measured > canvas.width && measured > 0) {
    fontSize = Math.max(8, Math.floor(fontSize * ((canvas.width * 0.98) / measured)));
    ctx.font = font(fontSize);
  }
  ctx.textAlign = op.align === "start" ? "left" : op.align;
  ctx.textBaseline = "alphabetic";
  // The letter spacing, the same property the SVG preview uses, so the two
  // agree on how wide the line is.
  ctx.letterSpacing = `${op.letterSpacing}px`;
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
 * The frame budget for an animated card.
 *
 * Every frame is a whole card composited in memory (`width × height × 4`
 * bytes), so the count is the bill rather than a taste. Twelve covers the short
 * loops animated avatars actually use; beyond that the GIF is sampled, and a
 * member whose avatar loops longer still gets a moving card.
 */
const MAX_ANIMATED_FRAMES = 12;

/** One decoded GIF frame as PNG bytes, so the existing draw ops can consume it. */
function frameToPng(gif: DecodedGif, rgba: Uint8Array): Buffer {
  const canvas = createCanvas(gif.width, gif.height);
  const ctx = canvas.getContext("2d");
  ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.length), gif.width, gif.height), 0, 0);
  return canvas.toBuffer("image/png");
}

/**
 * Renders the card. Returns null when there is genuinely nothing to draw
 * (no ops at all) — the caller then sends the message without an image
 * instead of attaching a blank canvas.
 *
 * An animated avatar makes the card an animated GIF: the plan is built once and
 * replayed per frame with only the avatar source swapped, so the background, the
 * glow, the outline and the Arabic text are identical in every frame — which is
 * the same drawing the still card already does, not a second renderer to keep in
 * step. Anything that goes wrong (no frames, a format the decoder refuses, a
 * single-frame file) falls through to the still card, because a greeting without
 * a picture is better than a greeting that never arrives.
 */
export async function renderWelcomeImage(
  config: WelcomeImageConfig,
  facts: { values: WelcomeTemplateValues; avatarBuffer: Buffer | null; backgroundBuffer: Buffer | null }
): Promise<WelcomeImageResult | null> {
  const ops = await planWelcomeImageDraw(config, facts);
  if (ops.length === 0) return null;

  const animated = facts.avatarBuffer && looksLikeAnimatedGif(facts.avatarBuffer)
    ? decodeGifFrames(facts.avatarBuffer, MAX_ANIMATED_FRAMES)
    : null;

  if (animated && animated.frames.length > 1) {
    const encoder = new GifEncoder(config.width, config.height, { repeat: 0 });
    for (const frame of animated.frames) {
      const source = frameToPng(animated, frame.rgba);
      const frameCanvas = createCanvas(config.width, config.height);
      const frameCtx = frameCanvas.getContext("2d");
      for (const op of ops) {
        await executeDrawOp(frameCtx, frameCanvas, op.kind === "avatar" ? { ...op, source } : op, new Map<Buffer, unknown>());
      }
      const { data } = frameCtx.getImageData(0, 0, config.width, config.height);
      // A copy, not a view. `getImageData` hands back a buffer the engine reuses
      // for the next call, and `addFrame` keeps what it is given until
      // `finish()` — so passing a view produced four identical frames, all of
      // them the last one. Measured, not guessed: the test decodes the card.
      const rgba = new Uint8Array(data.length);
      rgba.set(data);
      // The file stores hundredths of a second; this encoder takes milliseconds.
      encoder.addFrame(rgba, config.width, config.height, {
        delay: frame.delayCs > 0 ? frame.delayCs * 10 : 100
      });
    }
    return { buffer: Buffer.from(encoder.finish()), contentType: "image/gif", extension: "gif" };
  }

  const canvas = createCanvas(config.width, config.height);
  const ctx = canvas.getContext("2d");
  const images = new Map<Buffer, unknown>();
  for (const op of ops) await executeDrawOp(ctx, canvas, op, images);

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
