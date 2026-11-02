import test from "node:test";
import assert from "node:assert/strict";
import { GifEncoder } from "@napi-rs/canvas";
import { decodeGifFrames, looksLikeAnimatedGif } from "../src/runtime/gif-frames.js";

/**
 * The GIF decoder that makes an animated welcome card possible.
 *
 * `@napi-rs/canvas` decodes a GIF to its first frame and nothing else, so the
 * card could never animate — this module exists to step through the frames.
 * Because it is a hand-written decoder, its tests are built with the engine's
 * own encoder: the fixture and the product are two different implementations of
 * the same format, which is the only arrangement where a test can actually fail.
 */

const SIZE = 8;

function gifOf(colors: number[][], delays: number[]): Buffer {
  const encoder = new GifEncoder(SIZE, SIZE, { repeat: 0 });
  colors.forEach((color, index) => {
    const rgba = new Uint8Array(SIZE * SIZE * 4);
    for (let pixel = 0; pixel < SIZE * SIZE; pixel += 1) {
      rgba[pixel * 4] = color[0]!;
      rgba[pixel * 4 + 1] = color[1]!;
      rgba[pixel * 4 + 2] = color[2]!;
      rgba[pixel * 4 + 3] = 255;
    }
    encoder.addFrame(rgba, SIZE, SIZE, { delay: delays[index] ?? 10 });
  });
  return Buffer.from(encoder.finish());
}

const FOUR = [
  [220, 30, 30],
  [30, 200, 60],
  [40, 80, 230],
  [240, 210, 40]
];

function centre(frame: { rgba: Uint8Array }) {
  const at = (4 * SIZE + 4) * 4;
  return [frame.rgba[at]!, frame.rgba[at + 1]!, frame.rgba[at + 2]!];
}

test("every frame of a real animated GIF is decoded, in order", () => {
  const bytes = gifOf(FOUR, [12, 25, 37, 50]);
  const decoded = decodeGifFrames(bytes);
  assert.ok(decoded, "the file decodes");
  assert.equal(decoded.width, SIZE);
  assert.equal(decoded.height, SIZE);
  assert.equal(decoded.frames.length, 4, "all four frames, not the first one");
  decoded.frames.forEach((frame, index) => {
    assert.deepEqual(centre(frame), FOUR[index], `frame ${index + 1} carries its own colour`);
  });
  assert.deepEqual(
    decoded.frames.map(frame => frame.delayCs),
    [1, 2, 3, 5],
    /*
     * The GIF file stores delay in hundredths of a second, and this engine's
     * `addFrame({delay})` takes **milliseconds** — the fixture asked for 12/25/
     * 37/50 ms and the file holds 1/2/3/5 cs. Reading the file's unit and
     * handing it to the encoder as if it were the same unit would run every
     * card ten times too fast, so the difference is pinned here rather than
     * remembered.
     */
    "the delays survive, converted to the file's own unit"
  );
});

test("the frame count is capped, because every frame is composited whole", () => {
  const many = Array.from({ length: 30 }, (_, i) => [(i * 7) % 256, 0, 0] as number[]);
  const decoded = decodeGifFrames(gifOf(many, many.map(() => 10)), 12);
  assert.equal(decoded?.frames.length, 12, "the budget is honoured instead of the file being rejected");
});

test("a static GIF decodes to one frame and is not treated as animated", () => {
  const bytes = gifOf([[10, 200, 30]], [0]);
  const decoded = decodeGifFrames(bytes);
  assert.equal(decoded?.frames.length, 1);
  assert.equal(looksLikeAnimatedGif(bytes), false, "the cheap pre-check keeps it on the still path");
  assert.equal(looksLikeAnimatedGif(gifOf(FOUR, [10, 10, 10, 10])), true);
});

test("bytes that are not a GIF answer null, so the caller keeps the still frame", () => {
  assert.equal(decodeGifFrames(Buffer.from("not a gif at all, really")), null);
  assert.equal(decodeGifFrames(Buffer.alloc(0)), null);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  assert.equal(decodeGifFrames(png), null);
});
