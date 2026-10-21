/**
 * The geometry of the welcome card, shared by the designer and the renderer.
 *
 * The editor (the dashboard) and the renderer (the bot) must agree on where
 * every layer sits, or the card the operator designs is not the card the
 * joiner receives. They disagreed in three ways before this module existed:
 *
 * - **The text anchor.** The renderer draws text with an *alphabetic
 *   baseline* at `y` (`fillText(text, x, y)` with `textBaseline: "alphabetic"`),
 *   while the editor placed the text's *top* at `y`. The two are a whole
 *   line-height apart, and the gap grows with the font size - which is why a
 *   large text sat lower in the editor than in the exported image.
 * - **The resize.** The editor measured the new size as the distance from the
 *   box's *origin corner* to the pointer. The handle sits at the bottom-right,
 *   so that distance is already `size x 1.41` before the operator moves the
 *   mouse at all: the element inflated by 41% on the first pixel of the drag,
 *   then grew 1.41 times faster than the pointer travelled - which is how a
 *   small movement filled the card. **The size is the size at the start of the
 *   drag plus the pointer's travel.** Nothing else.
 * - **The bounds.** A resize was not clamped at all, so a layer could grow
 *   out of the card, and a dragged text was clamped by its anchor only.
 *
 * So the rules live here, once, and both sides use them.
 */

/** The smallest and largest an avatar may be, in card pixels. */
export const AVATAR_MIN_SIZE = 16;
export const AVATAR_MAX_SIZE = 512;

/** The smallest and largest a text layer's font may be, in card pixels. */
export const TEXT_MIN_FONT_SIZE = 8;
export const TEXT_MAX_FONT_SIZE = 512;

/** The distance from a text layer's anchor to the top of its line box. */
export function textAscentRatio(fontSize: number): number {
  // The renderer's baseline is `alphabetic`, so the line box starts one
  // ascent above it. 0.8 is the ascent of a typical UI face at 1em; the
  // designer uses it to place the *same* anchor the renderer draws.
  return 0.8 * fontSize;
}

/** A point in card pixels. */
export type Point = { x: number; y: number };

/** Keeps a whole box inside the card. */
export function clampBox(
  box: { x: number; y: number; width: number; height: number },
  canvas: { width: number; height: number }
): { x: number; y: number; width: number; height: number } {
  const width = Math.min(Math.max(0, box.width), canvas.width);
  const height = Math.min(Math.max(0, box.height), canvas.height);
  return {
    x: Math.min(Math.max(0, box.x), Math.max(0, canvas.width - width)),
    y: Math.min(Math.max(0, box.y), Math.max(0, canvas.height - height)),
    width,
    height
  };
}

/**
 * Where a layer may sit: an anchor inside the card.
 *
 * A text layer's anchor is its baseline origin, and an avatar's is its
 * top-left corner - both are points, so the clamp is on the point.
 */
export function clampAnchor(point: Point, canvas: { width: number; height: number }): Point {
  return {
    x: Math.min(Math.max(0, point.x), canvas.width),
    y: Math.min(Math.max(0, point.y), canvas.height)
  };
}

/**
 * Where a text layer's anchor may sit, so the **whole text** stays in the card.
 *
 * The anchor alone is not enough: a left-aligned text at `x = card.width` sits
 * inside the card and hangs off its right edge. The box's width is what makes
 * the difference, and the alignment decides which side the text grows towards.
 */
export function clampTextAnchor(
  point: Point,
  canvas: { width: number; height: number },
  box: { width: number; ascent: number; align: "start" | "center" | "end" }
): Point {
  const half = Math.max(0, box.width) / 2;
  const left =
    box.align === "center" ? half : box.align === "end" ? Math.max(0, box.width) : 0;
  const right =
    box.align === "center"
      ? canvas.width - half
      : box.align === "end"
        ? canvas.width
        : canvas.width - Math.max(0, box.width);
  // A text wider than the card has no room: it is pinned to the position its
  // alignment asks for, and it overflows rather than being pulled inside.
  const inverted = left > right;
  const pinned =
    box.align === "center" ? canvas.width / 2 : box.align === "end" ? canvas.width : 0;
  const minX = inverted ? pinned : left;
  const maxX = inverted ? pinned : right;
  const ascent = Math.max(0, box.ascent);
  return {
    x: Math.min(Math.max(minX, point.x), maxX),
    // The baseline cannot be above the card's top: the text would hang out of
    // it. One ascent is the height of the line above the baseline.
    y: Math.min(Math.max(Math.min(ascent, canvas.height), point.y), canvas.height)
  };
}

/**
 * The size a drag asks for.
 *
 * **The size at the start of the drag, plus the pointer's travel.** The
 * pointer's travel is projected on the handle's diagonal - the average of the
 * two axes - so a diagonal drag (the natural one) grows the box by exactly
 * the distance the pointer moved, and the corner the operator holds stays
 * under their finger. The bounds are explicit: a layer never shrinks below
 * its minimum nor grows past its maximum, whatever the pointer does.
 */
export function sizeFromDrag(params: {
  /** The size when the drag began. */
  start: number;
  /** The pointer, in card pixels, when the drag began. */
  startPointer: Point;
  /** The pointer now, in card pixels. */
  pointer: Point;
  min: number;
  max: number;
}): number {
  const dx = params.pointer.x - params.startPointer.x;
  const dy = params.pointer.y - params.startPointer.y;
  const travelled = (dx + dy) / 2;
  const size = params.start + travelled;
  return Math.round(Math.min(Math.max(params.min, size), params.max));
}

/**
 * The largest font that still fits the card's width.
 *
 * The width of a line is not a number anybody can predict - the browser
 * measures it - so the rule takes a *measured* line and the font that drew
 * it, and says how big the font may grow before the line leaves the card.
 * The editor measures with the DOM, the renderer with `measureText`, and
 * both use this rule: **the line fits the card.**
 */
export function maxFontSizeForWidth(
  fontSize: number,
  measuredWidth: number,
  cardWidth: number
): number {
  if (measuredWidth <= 0 || cardWidth <= 0) return fontSize;
  return Math.max(
    TEXT_MIN_FONT_SIZE,
    Math.floor((fontSize * cardWidth * 0.98) / measuredWidth)
  );
}

/** The pointer's position in card pixels.
 *
 * The scale is read from the canvas's **real** rendered box - its client width
 * against the card's own width - so a card that is displayed at half size
 * turns a 10-pixel screen movement into 20 card pixels, whatever the frame
 * happens to measure. The border is excluded (`clientWidth` is the content
 * box), and the content box's origin is the border's inner edge, so the
 * pointer lands where it visually does.
 */
export function toCardPoint(
  screen: Point,
  box: {
    left: number;
    top: number;
    clientWidth: number;
    clientHeight: number;
    borderLeft?: number;
    borderTop?: number;
  },
  canvas: { width: number; height: number }
): Point {
  const scaleX = box.clientWidth > 0 ? box.clientWidth / canvas.width : 1;
  const scaleY = box.clientHeight > 0 ? box.clientHeight / canvas.height : 1;
  const originX = box.left + (box.borderLeft ?? 0);
  const originY = box.top + (box.borderTop ?? 0);
  return {
    x: (screen.x - originX) / scaleX,
    y: (screen.y - originY) / scaleY
  };
}
