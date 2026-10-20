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
 * - **The resize.** The editor changed the size by the *horizontal* movement
 *   of a corner handle while the box grew from its top-left, so the handle
 *   ran away from the pointer and the element appeared to jump.
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
 * The size a corner handle asks for.
 *
 * The handle sits at the bottom-right, so the size is the distance from the
 * box's *fixed* corner to the pointer - not the horizontal movement alone.
 * That is what makes the handle follow the pointer: the box grows away from
 * the corner that does not move, and the corner the operator holds stays
 * under their finger.
 */
export function sizeFromHandle(
  origin: Point,
  pointer: Point,
  bounds: { min: number; max: number }
): number {
  const distance = Math.hypot(pointer.x - origin.x, pointer.y - origin.y);
  return Math.round(Math.min(Math.max(bounds.min, distance), bounds.max));
}

/**
 * The size a text handle asks for.
 *
 * A text layer has no box to grow: it grows around its anchor, so the size
 * follows the pointer's distance from that anchor.
 */
export function fontSizeFromHandle(
  anchor: Point,
  pointer: Point,
  bounds: { min: number; max: number }
): number {
  const distance = Math.hypot(pointer.x - anchor.x, pointer.y - anchor.y);
  return Math.round(Math.min(Math.max(bounds.min, distance), bounds.max));
}

/** The pointer's position in card pixels, given the canvas's scale. */
export function toCardSpace(
  pointer: Point,
  origin: Point,
  scale: number
): Point {
  const safeScale = scale > 0 ? scale : 1;
  return {
    x: origin.x + (pointer.x - origin.x) / safeScale,
    y: origin.y + (pointer.y - origin.y) / safeScale
  };
}
