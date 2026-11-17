import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_APPEARANCE,
  backgroundImage,
  normaliseAppearance,
  normaliseHex,
  readableOn,
  relativeLuminance
} from "../src/appearance.js";

/**
 * The appearance rules both ends share.
 *
 * The server validates with these before writing and the client renders with
 * them, so a value the UI can produce must survive the round trip unchanged —
 * and a value an older row or a hand-edited request contains must come out
 * either repaired or replaced by a default, never stored as-is.
 */

test("a complete appearance survives normalisation unchanged", () => {
  const input = {
    mode: "dark",
    accent: "violet",
    accentColor: "#123456",
    background: { style: "split-h", from: "#000000", to: "#ffffff" }
  } as const;
  assert.deepEqual(normaliseAppearance(input), input);
});

test("shorthand hex is expanded and letter case is ignored", () => {
  assert.equal(normaliseHex("#ABC"), "#aabbcc");
  assert.equal(normaliseHex("  #AABBCC "), "#aabbcc");
  assert.equal(normaliseHex("aabbcc"), null);
  assert.equal(normaliseHex("#12345"), null);
  assert.equal(normaliseHex(42), null);
});

test("an unknown field falls back on its own, without resetting the rest", () => {
  const parsed = normaliseAppearance({
    mode: "sepia",
    accent: "emerald",
    accentColor: "not-a-colour",
    background: { style: "checkerboard", from: "#101010", to: "#202020" }
  });
  assert.equal(parsed.mode, DEFAULT_APPEARANCE.mode, "the bad mode is replaced");
  assert.equal(parsed.accent, "emerald", "the valid accent is kept");
  assert.equal(parsed.accentColor, null, "the bad colour is dropped, not kept");
  assert.equal(parsed.background.style, DEFAULT_APPEARANCE.background.style);
  assert.equal(parsed.background.from, "#101010", "the colour that was fine survives");
});

test("a solid backdrop has no second colour to strand a gradient on", () => {
  const parsed = normaliseAppearance({ background: { style: "solid", from: "#000000", to: "#ffffff" } });
  assert.equal(parsed.background.to, null);
  assert.equal(backgroundImage(parsed.background), null, "solid draws no image");
});

test("split draws a hard stop on the axis, gradient blends along it", () => {
  assert.equal(
    backgroundImage({ style: "split-v", from: "#000000", to: "#ffffff" }),
    "linear-gradient(to bottom, #000000 0 50%, #ffffff 50% 100%)"
  );
  assert.equal(
    backgroundImage({ style: "split-h", from: "#000000", to: "#ffffff" }),
    "linear-gradient(to right, #000000 0 50%, #ffffff 50% 100%)"
  );
  assert.equal(backgroundImage({ style: "gradient", from: "#000000", to: "#ffffff" }), "linear-gradient(to bottom, #000000, #ffffff)");
});

test("a split with one colour is a solid colour, not half a gradient", () => {
  assert.equal(backgroundImage({ style: "split-v", from: "#000000", to: null }), "linear-gradient(to bottom, #000000 0 50%, #000000 50% 100%)");
});

test("the label colour follows the accent's luminance, not a constant", () => {
  // Measured, not assumed: the accent ships at #3b82f6, whose luminance (0.2355)
  // is above the equality point, so black wins there — white on that blue is
  // 3.7:1 and black is 5.7:1. A fixed white label would have been the wrong
  // answer for four of the five shipped accents.
  assert.equal(readableOn("#3b82f6"), "#0b0b0b");
  assert.equal(readableOn("#f59e0b"), "#0b0b0b");
  assert.equal(readableOn("#10b981"), "#0b0b0b");
  assert.equal(readableOn("#ffffff"), "#0b0b0b");
  assert.equal(readableOn("#000000"), "#ffffff");
  // The flip sits exactly where white and black score the same (L = 0.1791),
  // so a hair either side of it must land on different colours.
  assert.equal(readableOn("#767575"), "#ffffff");
  assert.equal(readableOn("#767778"), "#0b0b0b");
  assert.ok(relativeLuminance("#767575") < 0.1791 && relativeLuminance("#767778") > 0.1791);
});
