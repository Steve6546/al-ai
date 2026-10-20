import test from "node:test";
import assert from "node:assert/strict";
import {
  AVATAR_MAX_SIZE,
  AVATAR_MIN_SIZE,
  TEXT_MAX_FONT_SIZE,
  TEXT_MIN_FONT_SIZE,
  clampAnchor,
  clampBox,
  fontSizeFromHandle,
  sizeFromHandle,
  textAscentRatio,
  toCardSpace
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

test("a corner handle sizes the box by the distance to the pointer, not by one axis", () => {
  // The scenario from the bug report: a small element is scaled up, and the
  // handle must follow the pointer instead of running away from it.
  const origin = { x: 100, y: 100 };
  const pointer = { x: 200, y: 200 };
  const size = sizeFromHandle(origin, pointer, { min: AVATAR_MIN_SIZE, max: AVATAR_MAX_SIZE });
  // The pointer is 100px away on each axis, so the diagonal distance is ~141.
  assert.equal(size, 141);
  // The horizontal movement alone would have given 100 - a different answer,
  // and the one that made the box grow away from the pointer.
  assert.notEqual(size, 100);

  // Straight up: the distance is the movement.
  assert.equal(sizeFromHandle(origin, { x: 100, y: 180 }, { min: 16, max: 512 }), 80);
});

test("a size is never zero, negative or above the ceiling", () => {
  const bounds = { min: AVATAR_MIN_SIZE, max: AVATAR_MAX_SIZE };
  assert.equal(sizeFromHandle({ x: 50, y: 50 }, { x: 50, y: 50 }, bounds), AVATAR_MIN_SIZE);
  assert.equal(sizeFromHandle({ x: 0, y: 0 }, { x: 5000, y: 5000 }, bounds), AVATAR_MAX_SIZE);
  assert.ok(sizeFromHandle({ x: 0, y: 0 }, { x: -100, y: -100 }, bounds) >= AVATAR_MIN_SIZE);
});

test("a text handle sizes the font by the distance from the anchor", () => {
  const bounds = { min: TEXT_MIN_FONT_SIZE, max: TEXT_MAX_FONT_SIZE };
  assert.equal(fontSizeFromHandle({ x: 100, y: 100 }, { x: 100, y: 140 }, bounds), 40);
  assert.equal(fontSizeFromHandle({ x: 100, y: 100 }, { x: 100, y: 100 }, bounds), TEXT_MIN_FONT_SIZE);
  assert.equal(fontSizeFromHandle({ x: 0, y: 0 }, { x: 9999, y: 9999 }, bounds), TEXT_MAX_FONT_SIZE);
});

test("a pointer is converted into card pixels", () => {
  // The card is drawn at half size on the screen: a move of 50 screen pixels
  // is 100 card pixels.
  const card = toCardSpace({ x: 150, y: 150 }, { x: 100, y: 100 }, 0.5);
  assert.deepEqual(card, { x: 200, y: 200 });

  // A scale of zero would divide by zero; the conversion must survive it.
  const safe = toCardSpace({ x: 150, y: 150 }, { x: 100, y: 100 }, 0);
  assert.deepEqual(safe, { x: 150, y: 150 });
});

test("the text ascent is a share of the font size", () => {
  assert.equal(textAscentRatio(100), 80);
  assert.equal(textAscentRatio(0), 0);
});
