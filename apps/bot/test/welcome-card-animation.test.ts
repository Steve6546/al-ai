import test from "node:test";
import assert from "node:assert/strict";
import { GifEncoder, createCanvas, loadImage } from "@napi-rs/canvas";
import type { WelcomeImageResult } from "../src/runtime/welcome-image.js";
import { decodeGifFrames } from "../src/runtime/gif-frames.js";

/**
 * Whether a welcome card can animate, and what that costs.
 *
 * `@napi-rs/canvas` decodes a GIF to its **first frame** and exposes no frame
 * API — `pages`, `frames`, `numFrames` are all `undefined` — so a card
 * composited from an animated avatar used to be a still of frame one. That is
 * what the first three tests here measure, on a real two-frame GIF89a built with
 * the encoder this same library ships.
 *
 * The rest of the file is the consequence: the bot now decodes the avatar itself
 * (`gif-frames.ts`) and replays the draw plan per frame, so an animated avatar
 * produces an animated card. Both halves are asserted — the limitation that made
 * the decoder necessary, and the behaviour that replaced it.
 */

const VALUES = {
  userMention: "<@111>",
  username: "naxhz",
  server: "Baran",
  memberCount: 80,
  inviterMention: "<@222>",
  joinDate: "10 أكتوبر 2026"
};

/** The output type still has to name the format it returned. */
type CardFormats = WelcomeImageResult["contentType"];
const formatsCovered: CardFormats[] = ["image/png", "image/jpeg", "image/gif"];
void formatsCovered;

/** A 2×2 GIF89a: frame one red, frame two green, both marked as a graphic control block. */
function buildTwoFrameGif(): Buffer {
  const encoder = new GifEncoder(2, 2, { repeat: 0 });
  for (const [red, green] of [[255, 0], [0, 255]] as const) {
    const rgba = new Uint8Array(2 * 2 * 4);
    for (let pixel = 0; pixel < 4; pixel += 1) {
      rgba[pixel * 4] = red;
      rgba[pixel * 4 + 1] = green;
      rgba[pixel * 4 + 3] = 255;
    }
    encoder.addFrame(rgba, 2, 2, { delay: 100 });
  }
  return Buffer.from(encoder.finish());
}

test("the fixture really is an animated GIF", () => {
  const gif = buildTwoFrameGif();
  assert.equal(gif.subarray(0, 6).toString(), "GIF89a");
  // One graphic-control extension per frame: two frames, two blocks. If this ever
  // reads 1, the rest of the file proves nothing.
  assert.equal(gif.toString("binary").split("\x00\x21\xf9").length - 1, 2, "the file carries two frames");
});

test("the canvas decodes a GIF but exposes no frames", async () => {
  const image = await loadImage(buildTwoFrameGif());
  assert.deepEqual({ width: image.width, height: image.height }, { width: 2, height: 2 });

  const frameAccess = image as unknown as Record<string, unknown>;
  for (const name of ["pages", "frames", "numFrames", "frameCount"]) {
    assert.equal(frameAccess[name], undefined, `no ${name} accessor — the renderer cannot step frames`);
  }
});

test("drawing an animated GIF paints the first frame only", async () => {
  const image = await loadImage(buildTwoFrameGif());
  const canvas = createCanvas(2, 2);
  const ctx = canvas.getContext("2d");

  ctx.drawImage(image, 0, 0);
  const [red, green] = ctx.getImageData(0, 0, 1, 1).data;

  // Frame one is red, frame two is green. Green here would mean the library can
  // reach later frames, and the card could be animated after all.
  assert.ok(red > green, `expected frame one (red), got rgba ${[...ctx.getImageData(0, 0, 1, 1).data].join(",")}`);
});

/**
 * The output contract, stated instead of fenced.
 *
 * This file used to carry a compile-time fence asserting the card could only
 * ever be PNG or JPEG. The card can now be an animated GIF, so the fence is
 * gone and the rule is asserted where it belongs: a still source still yields a
 * still file, and only an animated avatar yields a moving one.
 */
test("a still avatar still produces a still card", async () => {
  const { renderWelcomeImage } = await import("../src/runtime/welcome-image.js");
  const { normaliseWelcomeImageConfig } = await import("@al-ai/core");
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64"
  );
  const card = await renderWelcomeImage(
    normaliseWelcomeImageConfig({
      width: 32,
      height: 32,
      background: { type: "transparent" },
      avatar: { enabled: true, x: 0, y: 0, size: 32, circular: false },
      username: { text: "", x: 0, y: 0, fontSize: 10 },
      customTexts: []
    }),
    { values: VALUES, avatarBuffer: png, backgroundBuffer: null }
  );
  assert.ok(card);
  assert.equal(card.contentType, "image/png", "a static avatar is not promoted to a GIF");
  assert.equal(card.extension, "png");
});

/**
 * The animated case, end to end: a four-frame GIF avatar in, a moving card out.
 *
 * Asserted by decoding the *output* with the same decoder the pipeline uses, so
 * the test proves the frames survived the compositing — not merely that the
 * renderer claimed to write a GIF.
 */
test("an animated avatar makes the card an animated GIF", async () => {
  const { renderWelcomeImage } = await import("../src/runtime/welcome-image.js");
  const { normaliseWelcomeImageConfig } = await import("@al-ai/core");
  const gif = buildFourFrameGif();

  const card = await renderWelcomeImage(
    normaliseWelcomeImageConfig({
      width: 64,
      height: 64,
      background: { type: "transparent" },
      avatar: { enabled: true, x: 0, y: 0, size: 64, circular: false },
      username: { text: "", x: 0, y: 0, fontSize: 10 },
      customTexts: []
    }),
    { values: VALUES, avatarBuffer: gif.bytes, backgroundBuffer: null }
  );
  assert.ok(card, "the card is drawn");
  assert.equal(card.contentType, "image/gif");
  assert.equal(card.extension, "gif", "the attachment is named for the format it actually is");
  assert.equal(card.buffer.subarray(0, 6).toString(), "GIF89a");

  const decoded = decodeGifFrames(card.buffer, 20);
  assert.ok(decoded, "the card decodes");
  assert.equal(decoded.frames.length, gif.colors.length, "every frame of the avatar is in the card");
  const centre = (index: number) => {
    const rgba = decoded.frames[index]!.rgba;
    const at = (32 * decoded.width + 32) * 4;
    return [rgba[at]!, rgba[at + 1]!, rgba[at + 2]!];
  };
  const first = centre(0);
  const second = centre(1);
  assert.ok(
    first.every((value, i) => Math.abs(value - gif.colors[0]![i]!) <= 12),
    `frame one carries the avatar's first frame, got ${first.join(",")}`
  );
  assert.ok(
    Math.abs(second[0] - first[0]) > 40 || Math.abs(second[1] - first[1]) > 40,
    `frame two must differ from frame one, or nothing animates: ${first.join(",")} vs ${second.join(",")}`
  );
});

/**
 * Four frames, four colours, 64×64 — far enough apart that a later frame cannot
 * be mistaken for the first by rounding.
 */
function buildFourFrameGif(): { bytes: Buffer; colors: number[][] } {
  const size = 64;
  const colors = [
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
    [255, 255, 0]
  ];
  const encoder = new GifEncoder(size, size, { repeat: 0 });
  for (const [r, g, b] of colors) {
    const rgba = new Uint8Array(size * size * 4);
    for (let i = 0; i < size * size; i += 1) {
      rgba[i * 4] = r;
      rgba[i * 4 + 1] = g;
      rgba[i * 4 + 2] = b;
      rgba[i * 4 + 3] = 255;
    }
    encoder.addFrame(rgba, size, size, { delay: 200 });
  }
  return { bytes: Buffer.from(encoder.finish()), colors };
}

/**
 * The speed survives the round trip.
 *
 * A card that animates at the wrong rate is a defect nobody can name — it just
 * feels wrong — so the delay is asserted per frame. The avatar's file stores
 * hundredths of a second, this engine's encoder takes milliseconds, and the
 * renderer converts between them: 200 ms in, 20 cs out.
 */
test("the card keeps the avatar's frame delays", async () => {
  const { renderWelcomeImage } = await import("../src/runtime/welcome-image.js");
  const { normaliseWelcomeImageConfig } = await import("@al-ai/core");
  const gif = buildFourFrameGif();
  const card = await renderWelcomeImage(
    normaliseWelcomeImageConfig({
      width: 64,
      height: 64,
      background: { type: "transparent" },
      avatar: { enabled: true, x: 0, y: 0, size: 64, circular: false },
      username: { text: "", x: 0, y: 0, fontSize: 10 },
      customTexts: []
    }),
    { values: VALUES, avatarBuffer: gif.bytes, backgroundBuffer: null }
  );
  assert.ok(card);
  const decoded = decodeGifFrames(card.buffer, 20);
  assert.ok(decoded, "the card decodes");
  assert.deepEqual(
    decoded.frames.map(frame => frame.delayCs),
    decoded.frames.map(() => 20),
    "every frame holds the avatar's 200 ms, converted to the file's unit"
  );
});
