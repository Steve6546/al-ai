import test from "node:test";
import assert from "node:assert/strict";
import { GifEncoder, createCanvas, loadImage } from "@napi-rs/canvas";
import type { WelcomeImageResult } from "../src/runtime/welcome-image.js";

/**
 * Whether a welcome card can ever animate.
 *
 * An operator can upload an animated GIF as the joiner's avatar and the whole
 * pipeline lets it through — the file picker accepts `image/gif`, the browser
 * sends it unmodified (`FileReader.readAsDataURL`, no re-encode), the link
 * importer accepts it, and the stored data URL allows it. The card is still
 * static, and this is the reason: `@napi-rs/canvas` decodes a GIF but exposes no
 * frame API, so `drawImage` paints the first frame and nothing else.
 *
 * Measured, not assumed — the fixture below is a real GIF89a with two frames,
 * built with the encoder this same library ships.
 */

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
 * Compile-time fence on the output contract.
 *
 * `renderWelcomeImage` answers `image/png | image/jpeg`. The tuple wrapper stops
 * the conditional from distributing, so widening that union to an animated type
 * makes `CardIsStill` false and this file stops typechecking — deliberately,
 * because every sender would then be shipping a still frame under an animated
 * name.
 */
type CardIsStill = [WelcomeImageResult["contentType"]] extends ["image/png" | "image/jpeg"] ? true : false;
const cardIsStill: CardIsStill = true;
void cardIsStill;

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
 * The whole question, end to end: an operator uploads an animated GIF, the bot
 * draws the card, and the file that lands in the channel is the **first frame**
 * of that GIF — as a still.
 *
 * Measured rather than assumed, because the alternative is a claim about what
 * members see. Frame 2 is pure green and frame 3 pure blue, so "it animated"
 * and "it picked a later frame" are both distinguishable from "it took frame 1".
 */
test("a card drawn from an animated GIF carries that GIF's first frame, as a still", async () => {
  const { renderWelcomeImage } = await import("../src/runtime/welcome-image.js");
  const { normaliseWelcomeImageConfig } = await import("@al-ai/core");
  const gif = buildFourFrameGif();
  assert.equal(gif.colors.length, 4);

  const card = await renderWelcomeImage(
    normaliseWelcomeImageConfig({
      width: 64,
      height: 64,
      background: { type: "transparent" },
      avatar: { enabled: true, x: 0, y: 0, size: 64, circular: false },
      username: { text: "", x: 0, y: 0, fontSize: 10 },
      customTexts: []
    }),
    {
      values: { userMention: "@x", username: "x", server: "s", memberCount: 1, inviterMention: "", joinDate: "today" },
      avatarBuffer: gif.bytes,
      backgroundBuffer: null
    }
  );
  assert.ok(card, "the card is drawn");

  const decoded = await loadImage(card.buffer);
  const probe = createCanvas(decoded.width, decoded.height);
  const ctx = probe.getContext("2d");
  ctx.drawImage(decoded, 0, 0);
  const [red, green, blue] = [...ctx.getImageData(32, 32, 1, 1).data];

  assert.ok(red > 200 && green < 60 && blue < 60, `expected frame one (red), got rgb ${[red, green, blue].join(",")}`);
  // An animated PNG would carry an `acTL` chunk; the card never does, because
  // the engine has no frame API to step through in the first place.
  assert.equal(card.buffer.includes(Buffer.from("acTL", "latin1")), false, "the exported card is not an animated PNG");
});
