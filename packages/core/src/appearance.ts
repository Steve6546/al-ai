/**
 * The appearance a person chooses, and the rules for storing it.
 *
 * The dashboard used to keep this in `localStorage` alone, which is right for a
 * colour and wrong for a preference: the choice disappeared on the next device
 * and came back only for whoever used the same browser. It now travels with the
 * account, and this module is the single definition both ends share — the server
 * validates with it before writing, the client imports it to render, and a value
 * the server would reject can therefore never be produced by the UI.
 *
 * Everything here is pure: no DOM, no storage, no hex parsing library.
 */

/** How the backdrop is painted. */
export type BackgroundStyle = "solid" | "split-v" | "split-h" | "gradient";

/** The named accents the design ships with. */
export type AccentName = "blue" | "violet" | "emerald" | "amber" | "rose";

export type Appearance = {
  mode: "light" | "dark" | "system";
  /** A named accent, used unless `accentColor` is set. */
  accent: AccentName;
  /**
   * A custom accent as `#rrggbb`, or null for the named one.
   *
   * A custom colour wins over `accent` so switching back to a named accent is a
   * single action, not "clear the picker first".
   */
  accentColor: string | null;
  /** The backdrop: one colour, two halves, or a smooth blend. */
  background: {
    style: BackgroundStyle;
    /** Top / start colour. */
    from: string | null;
    /** Bottom / end colour. Null makes a solid backdrop out of `from`. */
    to: string | null;
  };
};

export const NAMED_ACCENTS: readonly AccentName[] = ["blue", "violet", "emerald", "amber", "rose"];
export const BACKGROUND_STYLES: readonly BackgroundStyle[] = ["solid", "split-v", "split-h", "gradient"];

/** The colours the named accents stand for, kept beside their names. */
export const ACCENT_SWATCHES: Record<AccentName, string> = {
  blue: "#3b82f6",
  violet: "#8b5cf6",
  emerald: "#10b981",
  amber: "#f59e0b",
  rose: "#f43f5e"
};

export const DEFAULT_APPEARANCE: Appearance = {
  mode: "system",
  accent: "blue",
  accentColor: null,
  background: { style: "solid", from: null, to: null }
};

/**
 * The ready-made palettes, each a complete appearance rather than a patch.
 *
 * A preset that only changed the background would leave a custom accent behind,
 * which is how "one-click themes" end up looking like neither theme.
 */
export const APPEARANCE_PRESETS: { id: string; appearance: Appearance }[] = [
  {
    id: "oled",
    appearance: { mode: "dark", accent: "blue", accentColor: null, background: { style: "solid", from: "#000000", to: null } }
  },
  {
    id: "midnight",
    appearance: { mode: "dark", accent: "violet", accentColor: null, background: { style: "gradient", from: "#0b1020", to: "#131a2e" } }
  },
  {
    id: "ocean",
    appearance: { mode: "dark", accent: "emerald", accentColor: null, background: { style: "split-v", from: "#04222b", to: "#071626" } }
  },
  {
    id: "daylight",
    appearance: { mode: "light", accent: "blue", accentColor: null, background: { style: "solid", from: null, to: null } }
  }
];

const HEX = /^#[0-9a-f]{6}$/i;

export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && HEX.test(value);
}

/**
 * `#abc` and `#AABBCC` in, `#aabbcc` out; anything else is null.
 *
 * `<input type="color">` always reports six lowercase digits, but a stored value
 * may come from an older row or from a person editing JSON, so it is normalised
 * rather than trusted.
 */
export function normaliseHex(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (/^#[0-9a-f]{3}$/i.test(trimmed)) {
    const [r, g, b] = trimmed.slice(1);
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return HEX.test(trimmed) ? trimmed.toLowerCase() : null;
}

/** Relative luminance, WCAG 2.1 — the number the contrast choice needs. */
export function relativeLuminance(hex: string): number {
  const value = normaliseHex(hex);
  if (!value) return 0;
  const channel = (offset: number) => {
    const srgb = Number.parseInt(value.slice(offset, offset + 2), 16) / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/**
 * The text colour that stays readable on a filled accent.
 *
 * The button and the badge take the accent as their background, so the label has
 * to be chosen from the accent — not fixed at white, which disappears on a pale
 * amber, and not fixed at black, which disappears on a deep violet. WCAG's
 * threshold for the two sides of `#767676` is what `0.179` encodes: above it the
 * accent is light enough for near-black text, below it white is the readable one.
 */
export function readableOn(hex: string): "#ffffff" | "#0b0b0b" {
  return relativeLuminance(hex) > 0.179 ? "#0b0b0b" : "#ffffff";
}

/**
 * The accent as a CSS gradient for the split backdrop.
 *
 * Split is drawn as a hard-stop gradient rather than two elements: one paint,
 * no extra nodes, and the boundary lands exactly on the axis the operator chose
 * (`to bottom` / `to right`). `from` alone is a solid colour.
 */
export function backgroundImage(background: Appearance["background"]): string | null {
  const from = normaliseHex(background.from);
  const to = normaliseHex(background.to) ?? from;
  if (!from) return null;
  if (background.style === "solid") return null;
  const direction = background.style === "split-h" ? "to right" : "to bottom";
  if (background.style === "gradient") return `linear-gradient(${direction}, ${from}, ${to})`;
  return `linear-gradient(${direction}, ${from} 0 50%, ${to} 50% 100%)`;
}

/**
 * Anything the client or an older row may send, turned into a valid appearance.
 *
 * Unknown fields are dropped rather than stored, and every failure falls back to
 * the shipped default for that field alone — a corrupt background must not reset
 * somebody's accent.
 */
export function normaliseAppearance(input: unknown): Appearance {
  const source = (input ?? {}) as Partial<Appearance> & { background?: Partial<Appearance["background"]> };
  const mode = source.mode === "light" || source.mode === "dark" ? source.mode : source.mode === "system" ? "system" : DEFAULT_APPEARANCE.mode;
  const accent = NAMED_ACCENTS.includes(source.accent as AccentName) ? (source.accent as AccentName) : DEFAULT_APPEARANCE.accent;
  const accentColor = normaliseHex(source.accentColor);
  const style = BACKGROUND_STYLES.includes(source.background?.style as BackgroundStyle)
    ? (source.background?.style as BackgroundStyle)
    : DEFAULT_APPEARANCE.background.style;
  const from = normaliseHex(source.background?.from);
  const to = normaliseHex(source.background?.to);
  return {
    mode,
    accent,
    accentColor,
    background: { style, from, to: style === "solid" ? null : to }
  };
}

/** Whether two appearances are the same choice, for the unsaved-changes bar. */
export function appearanceEquals(a: Appearance, b: Appearance): boolean {
  return (
    a.mode === b.mode &&
    a.accent === b.accent &&
    a.accentColor === b.accentColor &&
    a.background.style === b.background.style &&
    a.background.from === b.background.from &&
    a.background.to === b.background.to
  );
}
