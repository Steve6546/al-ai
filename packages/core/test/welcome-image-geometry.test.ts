import test from "node:test";
import assert from "node:assert/strict";
import {
  AVATAR_MAX_SIZE,
  AVATAR_MIN_SIZE,
  TEXT_MAX_FONT_SIZE,
  TEXT_MIN_FONT_SIZE,
  clampAnchor,
  clampBox,
  clampTextAnchor,
  maxFontSizeForWidth,
  sizeFromDrag,
  textAscentRatio,
  toCardPoint
} from "../src/welcome-image-geometry.js";

/**
 * The welcome card's geometry, in the units the exported image uses.
 *
 * These are the rules the designer and the renderer both obey, and each one
 * exists because of a way the editor used to disagree with the exported card:
 * a layer that could leave the card, a resize that ran away from the pointer,
 * and a text anchor a whole line-height apart from the one the canvas draws.
 */

const CARD = { width: 1024, height: 512 };

test("a box never leaves the card", () => {
  const inside = clampBox({ x: 10, y: 20, width: 100, height: 100 }, CARD);
  assert.deepEqual(inside, { x: 10, y: 20, width: 100, height: 100 });

  // Dragged past the right edge: the box slides back inside.
  const past = clampBox({ x: 1000, y: 0, width: 100, height: 100 }, CARD);
  assert.equal(past.x, CARD.width - 100);
  assert.equal(past.x + past.width, CARD.width);

  // Dragged past the bottom: the same.
  const below = clampBox({ x: 0, y: 500, width: 100, height: 100 }, CARD);
  assert.equal(below.y, CARD.height - 100);

  // A negative position is pulled back to the origin.
  const negative = clampBox({ x: -50, y: -50, width: 100, height: 100 }, CARD);
  assert.deepEqual(negative, { x: 0, y: 0, width: 100, height: 100 });
});

test("a box bigger than the card is cut to the card", () => {
  const huge = clampBox({ x: 0, y: 0, width: 4096, height: 4096 }, CARD);
  assert.deepEqual(huge, { x: 0, y: 0, width: CARD.width, height: CARD.height });
});

test("an anchor stays inside the card", () => {
  assert.deepEqual(clampAnchor({ x: -10, y: -10 }, CARD), { x: 0, y: 0 });
  assert.deepEqual(clampAnchor({ x: 5000, y: 5000 }, CARD), { x: CARD.width, y: CARD.height });
  assert.deepEqual(clampAnchor({ x: 100, y: 200 }, CARD), { x: 100, y: 200 });
});

test("a text anchor is clamped by the text's own width, not only by the card", () => {
  // A left-aligned text may not hang off the right edge: its anchor stops
  // where the text ends.
  const start = clampTextAnchor({ x: 1000, y: 200 }, CARD, { width: 300, ascent: 40, align: "start" });
  assert.equal(start.x, CARD.width - 300);
  assert.equal(start.x + 300, CARD.width);

  // A centred text is bounded by its own half-width on each side.
  const centre = clampTextAnchor({ x: 0, y: 200 }, CARD, { width: 300, ascent: 40, align: "center" });
  assert.equal(centre.x, 150);
  const centreRight = clampTextAnchor({ x: 5000, y: 200 }, CARD, { width: 300, ascent: 40, align: "center" });
  assert.equal(centreRight.x, CARD.width - 150);

  // An end-aligned text grows to the left, so its anchor has room on its right.
  const end = clampTextAnchor({ x: 5000, y: 200 }, CARD, { width: 300, ascent: 40, align: "end" });
  assert.equal(end.x, CARD.width);

  // The baseline cannot be above the card: the text would hang out of the top.
  const high = clampTextAnchor({ x: 100, y: 0 }, CARD, { width: 300, ascent: 40, align: "start" });
  assert.equal(high.y, 40);

  // A text wider than the card is pinned to its alignment's own position
  // rather than left out of the card.
  const wide = clampTextAnchor({ x: 0, y: 200 }, CARD, { width: 4000, ascent: 40, align: "start" });
  assert.equal(wide.x, 0);
  const wideCentre = clampTextAnchor({ x: 0, y: 200 }, CARD, { width: 4000, ascent: 40, align: "center" });
  assert.equal(wideCentre.x, CARD.width / 2);
});

test("the size is the size at the start of the drag plus the pointer's travel", () => {
  const bounds = { min: AVATAR_MIN_SIZE, max: AVATAR_MAX_SIZE };
  // The bug: the size used to be the distance from the box's origin corner to
  // the pointer, so grabbing the bottom-right handle inflated the box by 41%
  // before the mouse moved at all. Now the travel is measured from where the
  // drag began.
  const startPointer = { x: 200, y: 200 };
  const size = sizeFromDrag({ start: 100, startPointer, pointer: { x: 200, y: 200 }, ...bounds });
  assert.equal(size, 100, "an unmoved pointer keeps the size it had");

  // A diagonal drag of 60px grows the box by 60px: the handle stays under the
  // finger, and the box grows at the pointer's speed.
  const diagonal = sizeFromDrag({ start: 100, startPointer, pointer: { x: 260, y: 260 }, ...bounds });
  assert.equal(diagonal, 160);

  // Pulling back shrinks it again, symmetrically.
  const back = sizeFromDrag({ start: 100, startPointer, pointer: { x: 140, y: 140 }, ...bounds });
  assert.equal(back, 40);
});

test("a drag can never shrink a layer below its minimum or grow it past its maximum", () => {
  const bounds = { min: AVATAR_MIN_SIZE, max: AVATAR_MAX_SIZE };
  const startPointer = { x: 0, y: 0 };
  assert.equal(
    sizeFromDrag({ start: 100, startPointer, pointer: { x: -5000, y: -5000 }, ...bounds }),
    AVATAR_MIN_SIZE
  );
  assert.equal(
    sizeFromDrag({ start: 100, startPointer, pointer: { x: 5000, y: 5000 }, ...bounds }),
    AVATAR_MAX_SIZE
  );
  // A font has its own bounds.
  assert.equal(
    sizeFromDrag({
      start: 40,
      startPointer,
      pointer: { x: -500, y: -500 },
      min: TEXT_MIN_FONT_SIZE,
      max: TEXT_MAX_FONT_SIZE
    }),
    TEXT_MIN_FONT_SIZE
  );
  assert.equal(
    sizeFromDrag({
      start: 40,
      startPointer,
      pointer: { x: 9999, y: 9999 },
      min: TEXT_MIN_FONT_SIZE,
      max: TEXT_MAX_FONT_SIZE
    }),
    TEXT_MAX_FONT_SIZE
  );
});

test("the largest font that still fits the card is measured, not guessed", () => {
  // A 48px line that measures 600px on an 800px card: the font may grow to
  // 48 * (800 * 0.98) / 600 = 62 before the line leaves the card.
  const max = maxFontSizeForWidth(48, 600, 800);
  assert.equal(max, 62);
  // A line that already fills the card may not grow at all.
  assert.equal(maxFontSizeForWidth(48, 800, 800), 47);
  // A line that is not measured yet is left alone.
  assert.equal(maxFontSizeForWidth(48, 0, 800), 48);
  // And the answer is never below the smallest readable font.
  assert.equal(maxFontSizeForWidth(48, 100_000, 800), TEXT_MIN_FONT_SIZE);
});

test("a pointer is read against the canvas's real rendered box", () => {  // The card is 1024 wide and is displayed at 512: a move of 50 screen pixels
  // is 100 card pixels.
  const half = toCardPoint(
    { x: 150, y: 150 },
    { left: 100, top: 100, clientWidth: 512, clientHeight: 256 },
    CARD
  );
  assert.deepEqual(half, { x: 100, y: 100 });

  // The border is not part of the content box: the origin is its inner edge.
  const bordered = toCardPoint(
    { x: 101, y: 101 },
    { left: 100, top: 100, clientWidth: 512, clientHeight: 256, borderLeft: 1, borderTop: 1 },
    CARD
  );
  assert.deepEqual(bordered, { x: 0, y: 0 });

  // A canvas that has not been laid out yet must not divide by zero.
  const unlaid = toCardPoint({ x: 150, y: 150 }, { left: 0, top: 0, clientWidth: 0, clientHeight: 0 }, CARD);
  assert.deepEqual(unlaid, { x: 150, y: 150 });
});

test("the text ascent is a share of the font size", () => {
  assert.equal(textAscentRatio(100), 80);
  assert.equal(textAscentRatio(0), 0);
});
