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
