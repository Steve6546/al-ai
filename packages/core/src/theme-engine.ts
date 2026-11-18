/**
 * The theme engine: five chosen colours in, a whole interface out.
 *
 * The old appearance system painted the backdrop and then left the cards, the
 * sidebar, the borders and the buttons at the built-in palette's own colours —
 * so a purple theme was a purple page with grey cards on top, and the seams
 * showed in every direction. This module closes that seam: it takes the theme's
 * colours, the gradient angle and an intensity, and derives **every** surface
 * and text colour from them, so a theme is a theme rather than a tinted
 * background.
 *
 * Three decisions are load-bearing:
 *
 * 1. **OKLCH, not HSL.** HSL's "lightness" is not perceptual: at the same L, a
 *    yellow and a blue differ in brightness by a factor of several, so a ramp
 *    built in HSL gives surfaces that are visibly uneven from hue to hue. OKLCH
 *    is close enough to uniform for a lightness ramp to hold its shape across
 *    hues, which is exactly what deriving eight surfaces from one colour needs.
 *    Its hue also stays put when lightness changes, so a theme keeps its identity
 *    in both modes.
 *
 * 2. **Lightness comes from the mode, hue and chroma from the theme.** A theme
 *    stores colours, not lightness stops. In dark mode the canvas sits at L≈0.16
 *    and cards at L≈0.22; in light mode the same hue sits at L≈0.99 and L≈1.0.
 *    That is what makes one palette work in both modes without a second palette
 *    per theme — and it is why the engine never stores a "dark canvas" and a
 *    "light canvas" separately.
 *
 * 3. **Contrast is computed, not hoped for.** Every text colour is chosen
 *    against the surface it will actually sit on and then nudged in lightness
 *    until WCAG AA (4.5:1) holds. A pale theme with white text is the failure
 *    this prevents, and it cannot be a fixed token: pale amber and deep violet
 *    need opposite answers.
 *
 * Everything here is pure: hex and OKLCH in, CSS custom properties out. No DOM,
 * no storage, so the same code decides what the browser paints and what the tests
 * assert.
 */

/* ------------------------------------------------------------------ *
 * Colour space
 * ------------------------------------------------------------------ */

export type Oklch = { l: number; c: number; h: number };
export type Rgb = { r: number; g: number; b: number };

const HEX = /^#[0-9a-f]{6}$/i;

export function isHex(value: unknown): value is string {
  return typeof value === "string" && HEX.test(value);
}

/** `#abc` and `#AABBCC` in, `#aabbcc` out; anything else is null. */
export function normaliseHex(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (/^#[0-9a-f]{3}$/i.test(trimmed)) {
    const [r, g, b] = trimmed.slice(1);
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return HEX.test(trimmed) ? trimmed.toLowerCase() : null;
}

export function hexToRgb(hex: string): Rgb {
  const value = normaliseHex(hex) ?? "#000000";
  return {
    r: Number.parseInt(value.slice(1, 3), 16) / 255,
    g: Number.parseInt(value.slice(3, 5), 16) / 255,
    b: Number.parseInt(value.slice(5, 7), 16) / 255
  };
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

export function rgbToHex({ r, g, b }: Rgb): string {
  const channel = (value: number) =>
    Math.round(clamp01(value) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

/** sRGB transfer function, inverted — the encoding OKLab expects. */
function toLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function fromLinear(channel: number): number {
  return channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055;
}

/** Linear sRGB → OKLab (Björn Ottosson's matrices). */
function linearToOklab({ r, g, b }: Rgb): { L: number; a: number; b: number } {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  };
}

function oklabToLinear({ L, a, b }: { L: number; a: number; b: number }): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return {
    r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    b: -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
  };
}

export function hexToOklch(hex: string): Oklch {
  const rgb = hexToRgb(hex);
  const lab = linearToOklab({ r: toLinear(rgb.r), g: toLinear(rgb.g), b: toLinear(rgb.b) });
  const c = Math.sqrt(lab.a * lab.a + lab.b * lab.b);
  let h = (Math.atan2(lab.b, lab.a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return { l: lab.L, c, h: c < 1e-4 ? 0 : h };
}

/**
 * OKLCH → hex, with chroma reduced until the colour fits sRGB.
 *
 * Clamping the channels instead would shift the hue and the lightness (a clipped
 * blue becomes violet-ish at the edge), so out-of-gamut colours are pulled back
 * along the chroma axis: same hue, same lightness, the most saturated colour that
 * can actually be painted. Binary search because the gamut boundary has no
 * closed form.
 */
export function oklchToHex(colour: Oklch): string {
  const l = clamp01(colour.l);
  const h = ((colour.h % 360) + 360) % 360;
  const toHex = (c: number) => {
    const radians = (h * Math.PI) / 180;
    const lab = { L: l, a: Math.cos(radians) * c, b: Math.sin(radians) * c };
    const linear = oklabToLinear(lab);
    return rgbToHex({ r: fromLinear(linear.r), g: fromLinear(linear.g), b: fromLinear(linear.b) });
  };
  const inGamut = (c: number) => {
    const radians = (h * Math.PI) / 180;
    const linear = oklabToLinear({ L: l, a: Math.cos(radians) * c, b: Math.sin(radians) * c });
    return [linear.r, linear.g, linear.b].every(channel => channel >= -0.0001 && channel <= 1.0001);
  };
  if (inGamut(colour.c)) return toHex(colour.c);
  let low = 0;
  let high = colour.c;
  for (let i = 0; i < 24; i++) {
    const mid = (low + high) / 2;
    if (inGamut(mid)) low = mid;
    else high = mid;
  }
  return toHex(low);
}

/** WCAG 2.1 relative luminance of an sRGB colour. */
export function relativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** WCAG contrast ratio between two opaque colours, 1…21. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/* ------------------------------------------------------------------ *
 * Readability
 * ------------------------------------------------------------------ */

/** The two directions a text colour can go, in OKLCH. */
const NEAR_WHITE: Oklch = { l: 0.98, c: 0, h: 0 };
const NEAR_BLACK: Oklch = { l: 0.14, c: 0, h: 0 };

export const AA_TEXT = 4.5;
export const AA_LARGE = 3;

/**
 * A text colour that reaches `min` contrast on `background`.
 *
 * The candidate closest to the background wins when both already pass — a theme
 * with a very light canvas gets near-black text, not white-at-4.6:1, because the
 * highest ratio is not the same thing as the most comfortable page. When neither
 * passes, lightness is walked away from the background until it does, which is
 * what keeps a mid-grey theme readable instead of merely "chosen".
 */
export function readableText(background: string, { min = AA_TEXT, dark = NEAR_BLACK, light = NEAR_WHITE } = {}): string {
  const backgroundL = hexToOklch(background).l;
  const candidates = [oklchToHex({ ...dark }), oklchToHex({ ...light })];
  const passing = candidates.filter(candidate => contrastRatio(candidate, background) >= min);
  if (passing.length > 0) {
    return passing.sort(
      (a, b) => Math.abs(hexToOklch(a).l - backgroundL) - Math.abs(hexToOklch(b).l - backgroundL)
    )[0]!;
  }
  // Neighbouring lightnesses, in order of distance from the background, until one
  // clears the bar. 24 steps of 0.03 covers the whole axis.
  const away = (target: Oklch) => {
    for (let step = 1; step <= 24; step++) {
      const l = target.l > backgroundL ? Math.min(1, backgroundL + step * 0.03) : Math.max(0, backgroundL - step * 0.03);
      const colour = oklchToHex({ l, c: Math.min(target.c, 0.02), h: target.h });
      if (contrastRatio(colour, background) >= min) return colour;
    }
    return oklchToHex(target.l > backgroundL ? { l: 1, c: 0, h: 0 } : { l: 0, c: 0, h: 0 });
  };
  const towardsWhite = contrastRatio("#ffffff", background) >= contrastRatio("#000000", background);
  return away(towardsWhite ? NEAR_WHITE : NEAR_BLACK);
}

/* ------------------------------------------------------------------ *
 * Harmony
 * ------------------------------------------------------------------ */

export type HarmonyKind = "analogous" | "complementary" | "triadic" | "split" | "monochrome";

export const HARMONY_KINDS: readonly HarmonyKind[] = ["analogous", "complementary", "triadic", "split", "monochrome"];

/**
 * The hue offsets each harmony uses, in degrees.
 *
 * These are the classical relationships, expressed once so "surprise me" and the
 * preset generator cannot disagree about what a triadic palette is.
 */
const HARMONY_OFFSETS: Record<HarmonyKind, number[]> = {
  analogous: [0, 22, -22, 44, -44],
  complementary: [0, 180, 12, 192, 0],
  triadic: [0, 120, 240, 12, 132],
  split: [0, 150, 210, 15, 195],
  monochrome: [0, 0, 0, 0, 0]
};

/**
 * A palette from one seed colour, in the chosen relationship.
 *
 * The stops differ in lightness as well as hue, because a gradient between two
 * colours of equal lightness reads as a flat band with a seam. Monochrome is the
 * exception by design: it varies lightness only, which is the theme people pick
 * when they want their accent to be the only colour on the page.
 */
export function harmonise(seed: string, kind: HarmonyKind, count = 3): string[] {
  const base = hexToOklch(seed);
  const offsets = HARMONY_OFFSETS[kind];
  const stops = Math.min(5, Math.max(1, Math.round(count)));
  const lightnessSteps = [0, -0.12, 0.1, -0.2, 0.16];
  const chromaSteps = [0, 0.02, -0.03, 0.04, -0.05];
  return Array.from({ length: stops }, (_, index) => {
    const offset = offsets[index % offsets.length]!;
    const hue = index === 0 ? base.h : base.h + offset;
    const l = Math.min(0.88, Math.max(0.16, base.l + (kind === "monochrome" ? lightnessSteps[index]! * 1.6 : lightnessSteps[index]!)));
    const c = Math.min(0.36, Math.max(0, base.c + (kind === "monochrome" ? 0 : chromaSteps[index]!)));
    return oklchToHex({ l, c, h: hue });
  });
}

/* ------------------------------------------------------------------ *
 * The theme shape
 * ------------------------------------------------------------------ */

export type ThemeMode = "light" | "dark" | "system";

/** At most five gradient stops; more than that is a photograph, not a theme. */
export const MAX_THEME_COLORS = 5;

/**
 * How the chosen colours reach the surfaces.
 *
 * `canvas` paints the gradient on the page only; `tinted` also tints the cards,
 * the sidebar, the borders and the buttons — the mode the request is about, and
 * therefore the default. Kept as a field so a theme can be loud on the page and
 * quiet on the panels, which is what a "wallpaper" theme wants.
 */
export type ThemeScope = "canvas" | "tinted";

export type Appearance = {
  /** Bumped when the stored shape changes; older rows are migrated on read. */
  version: 2;
  mode: ThemeMode;
  /** 1…5 stops, in gradient order. */
  colors: string[];
  /** Gradient angle in degrees, 0…360. 0 points up, like CSS's `0deg`. */
  angle: number;
  /** 0…100: how much of the theme's chroma reaches the surfaces. */
  intensity: number;
  scope: ThemeScope;
  /**
   * A colour for the buttons and the focus ring, or null to derive it.
   *
   * Null is the interesting case and the default: the accent is then the most
   * saturated stop of the theme, so a palette is complete when its colours are
   * chosen. A non-null value is for the theme where the controls should contrast
   * with the backdrop rather than match it — and it is what the old accent
   * control migrates into.
   */
  accent: string | null;
};

export const DEFAULT_APPEARANCE: Appearance = {
  version: 2,
  mode: "system",
  // The shipped canvas, one stop: a neutral that reads correctly in both modes
  // because the mode decides its lightness. A fresh account therefore looks like
  // it always did until somebody opens the appearance screen.
  colors: ["#4f6bed"],
  angle: 135,
  intensity: 55,
  scope: "tinted",
  accent: null
};

/* ------------------------------------------------------------------ *
 * Tokens
 * ------------------------------------------------------------------ */

export type ThemeTokens = Record<string, string>;

/**
 * A text colour readable on all of `surfaces`, falling back to `fallback` for the
 * measurement when a surface cannot carry usable text at all.
 *
 * Gradients are the reason this exists: one label sits on several colours at
 * once, so the answer has to satisfy every one of them.
 */
export function readableOnEvery(surfaces: readonly string[], fallback: string): string {
  const candidates = [NEAR_WHITE, NEAR_BLACK].map(colour => colour);
  const judge = (colour: Oklch) => {
    const hex = oklchToHex(colour);
    const worst = Math.min(...surfaces.map(surface => contrastRatio(hex, surface)));
    return { hex, worst };
  };
  const scored = candidates.map(judge).sort((a, b) => b.worst - a.worst);
  if (scored[0]!.worst >= AA_TEXT) return scored[0]!.hex;
  // Nothing fixed passes every stop, so walk lightness away from the hardest
  // surface until it does. A gradient between a bright and a dark colour cannot
  // hold AA on both with any single colour, and this returns the best available
  // rather than pretending otherwise.
  const target = scored[0]!.hex;
  const towards = contrastRatio("#ffffff", fallback) >= contrastRatio("#000000", fallback) ? 1 : -1;
  const start = hexToOklch(target).l;
  for (let step = 1; step <= 24; step++) {
    const l = Math.min(1, Math.max(0, start + towards * step * 0.03));
    const hex = oklchToHex({ l, c: 0, h: 0 });
    if (surfaces.every(surface => contrastRatio(hex, surface) >= AA_TEXT)) return hex;
  }
  return target;
}

export type BuildOptions = {
  /** Whether the browser can interpolate a gradient in OKLCH. */
  oklchGradients?: boolean;
};

/**
 * The gradient the canvas paints.
 *
 * One stop is a solid colour, not a gradient that happens to have two identical
 * ends — a `linear-gradient` with one stop is invalid CSS, and the two-stop
 * version would still pay for a gradient layer on every paint.
 */
export function canvasBackground(appearance: Appearance, { oklchGradients = true }: BuildOptions = {}): string | null {
  const stops = paintedStops(appearance);
  if (stops.length === 0) return null;
  if (stops.length === 1) return stops[0]!;
  const direction = `${Math.round(appearance.angle)}deg`;
  const interpolation = oklchGradients ? " in oklch" : "";
  return `linear-gradient(${direction}${interpolation}, ${stops.join(", ")})`;
}

/**
 * The colours actually painted, as opposed to the colours chosen.
 *
 * A theme stores hues, not lightnesses. The stops are re-lit for the mode — dark
 * mode lays them between L 0.13 and L 0.27, light mode between L 0.99 and L 0.90 —
 * and their chroma is scaled by the intensity, so one palette reads correctly in
 * both modes and `intensity: 0` is a genuinely neutral page.
 *
 * Keeping the preset's own lightness instead was the first implementation, and it
 * produced the failure this fixes: a dark preset viewed in light mode painted a
 * near-black page while every derived token said "light", so the page and the
 * panels disagreed about which theme was in force.
 */
export function paintedStops(appearance: Appearance): string[] {
  const colors = appearance.colors.filter(isHex);
  if (colors.length === 0) return [];
  const intensity = Math.min(100, Math.max(0, appearance.intensity)) / 100;
  const dark = appearance.mode !== "light";
  const count = colors.length;
  return colors.map((color, index) => {
    const stop = hexToOklch(color);
    const position = count === 1 ? 0 : index / (count - 1);
    // Light mode starts near-white and steps *down* to a genuinely tinted pale
    // wash. It used to sit at L 0.99, which is white to the eye: the page looked
    // unthemed while the panels looked tinted, the inverse of the bug this
    // system exists to fix. The start also follows the intensity, because
    // "intensity 0" has to mean the plain page — a grey-white 0.99 is a
    // different colour from the white an unpainted theme uses.
    const start = dark ? 0.13 : 0.99 - 0.025 * intensity;
    const l = dark ? start + 0.14 * position : start - 0.085 * position;
    // Dark surfaces hold far less chroma before they clip; light ones hold less
    // again before they look like highlighter.
    const ceiling = dark ? 0.085 : 0.07;
    // Pure scaling, no floor: `intensity: 0` has to mean "no colour anywhere",
    // which is what the OLED preset is, and a 15% floor would quietly keep a
    // tint the slider says is gone.
    const c = Math.min(ceiling, stop.c) * intensity;
    return oklchToHex({ l, c, h: stop.h });
  });
}

/**
 * All twelve surfaces and their text colours, derived from the theme.
 *
 * The lightness ladder below is the whole design: in dark mode the canvas is the
 * darkest thing on the page and each panel is a step lighter (so a shadow reads
 * as depth, as it does in Discord's client); in light mode the canvas is the
 * lightest and panels step *down* towards the cards. Text is then chosen per
 * surface, so an intermediate contrast level never has to be guessed.
 */
export function buildThemeTokens(appearance: Appearance, options: BuildOptions = {}): ThemeTokens {
  const intensity = Math.min(100, Math.max(0, appearance.intensity)) / 100;
  const colors = appearance.colors.filter(isHex);
  const anchor = colors.length > 0 ? hexToOklch(colors[0]!) : hexToOklch("#4f6bed");
  const mode = appearance.mode === "light" ? "light" : appearance.mode === "dark" ? "dark" : "dark";

  // The hue of each stop, averaged as a unit vector so red-at-350° and
  // red-at-10° average to 0° instead of 180°.
  const stops = colors.length > 0 ? colors.map(hexToOklch) : [anchor];
  let sx = 0;
  let sy = 0;
  for (const stop of stops) {
    sx += Math.cos((stop.h * Math.PI) / 180);
    sy += Math.sin((stop.h * Math.PI) / 180);
  }
  const hue = (Math.atan2(sy, sx) * 180) / Math.PI;
  const chroma = Math.min(0.055, Math.max(...stops.map(stop => stop.c)));
  const tinted = appearance.scope === "tinted";

  // How far the theme's colour reaches: zero intensity leaves the panels neutral
  // (chroma 0), which is how "no tint" is expressed without a second palette.
  const tint = (factor: number) => (tinted ? chroma * intensity * factor : 0);

  const surface = (l: number, factor: number) =>
    oklchToHex({ l, c: tint(factor), h: hue });

  const tokens: ThemeTokens = {};

  /**
   * The canvas, and the text that will sit on it.
   *
   * The canvas is a *ladder* position, not the picked colour: in dark mode the
   * page is the darkest surface and in light mode the lightest, and the picked
   * colours contribute their hue and chroma there through `tint()`. Using the
   * colour's own lightness instead looked reasonable and was wrong — a mid-blue
   * `#3b82f6` (L≈0.62) became a canvas *lighter* than the sidebar above it, which
   * is the "cards float above a brighter page" look no theme wants.
   *
   * When there is more than one stop the gradient covers the page, so the text
   * colour is chosen against the worst stop rather than against the token: a
   * white label that passes on the dark end of a sunset gradient and fails on its
   * orange end is exactly the bug this avoids.
   */
  const painted = paintedStops(appearance);
  const canvas = colors.length > 0 && painted.length > 0 ? painted[0]! : surface(mode === "dark" ? 0.16 : 0.985, 0.5);
  const canvasL = hexToOklch(canvas).l;
  const gradient = canvasBackground(appearance, options);
  // Text on the page sits on every stop of the gradient at once, so it is chosen
  // against all of them and the token behind it is the first stop.
  const onCanvas = painted.length > 1 ? readableOnEvery(painted, canvas) : readableText(canvas);

  tokens["--background"] = canvas;
  tokens["--foreground"] = onCanvas;

  /**
   * The lightness of each surface, per mode. Panels step *up* from a dark canvas
   * and *down* from a light one, so a shadow reads as depth in both modes — the
   * relationship Discord's client uses and the one the eye expects.
   */
  const ladder =
    mode === "dark"
      ? { canvas: canvasL, sidebar: canvasL + 0.045, card: canvasL + 0.08, popover: canvasL + 0.09, muted: canvasL + 0.13, input: canvasL + 0.15 }
      : { canvas: canvasL, sidebar: canvasL - 0.022, card: Math.min(0.995, canvasL + 0.02), popover: Math.min(0.995, canvasL + 0.02), muted: canvasL - 0.04, input: canvasL - 0.05 };
  tokens["--card"] = surface(ladder.card, 0.7);
  tokens["--card-foreground"] = readableText(tokens["--card"]!);
  tokens["--popover"] = surface(ladder.popover, 0.7);
  tokens["--popover-foreground"] = readableText(tokens["--popover"]!);
  tokens["--sidebar"] = surface(ladder.sidebar, 0.8);
  tokens["--sidebar-foreground"] = readableText(tokens["--sidebar"]!);
  tokens["--muted"] = surface(ladder.muted, 0.55);
  tokens["--muted-foreground"] = readableText(tokens["--muted"]!, { min: 4.6 });
  tokens["--secondary"] = surface(ladder.muted, 0.7);
  tokens["--secondary-foreground"] = readableText(tokens["--secondary"]!);
  tokens["--input"] = surface(ladder.input, 0.5);

  /**
   * The accent: the most saturated stop, lifted or dropped until it reads as a
   * button on the card and its own label reaches AA.
   *
   * A picked colour is often either too dark to be a button on a dark card or too
   * pale to carry white text; both are fixed here rather than by asking the
   * operator to pick a different colour.
   */
  const vivid = appearance.accent && isHex(appearance.accent) ? hexToOklch(appearance.accent) : [...stops].sort((a, b) => b.c - a.c)[0]!;
  const primaryL = mode === "dark" ? Math.min(0.78, Math.max(0.55, vivid.l)) : Math.min(0.62, Math.max(0.42, vivid.l));
  const primary = oklchToHex({ l: primaryL, c: Math.max(vivid.c, 0.1), h: vivid.h });
  tokens["--primary"] = primary;
  tokens["--primary-foreground"] = readableText(primary);
  tokens["--ring"] = oklchToHex({ l: mode === "dark" ? Math.min(0.85, primaryL + 0.1) : Math.max(0.4, primaryL - 0.08), c: Math.max(vivid.c, 0.1), h: vivid.h });
  tokens["--accent"] = surface(ladder.muted, 0.9);
  tokens["--accent-foreground"] = readableText(tokens["--accent"]!);

  tokens["--sidebar-primary"] = primary;
  tokens["--sidebar-primary-foreground"] = tokens["--primary-foreground"]!;
  tokens["--sidebar-accent"] = surface(ladder.muted, 0.8);
  tokens["--sidebar-accent-foreground"] = readableText(tokens["--sidebar-accent"]!);
  tokens["--sidebar-ring"] = tokens["--ring"]!;

  // Borders carry a trace of the theme's hue, so they belong to the palette
  // instead of being a neutral hairline laid over it.
  const borderBase = hexToRgb(surface(ladder.card, 0.7));
  const borderAlpha = mode === "dark" ? 0.14 : 0.16;
  const line = (alpha: number) =>
    `rgba(${Math.round(borderBase.r * 255)}, ${Math.round(borderBase.g * 255)}, ${Math.round(borderBase.b * 255)}, ${alpha})`;
  tokens["--border"] = mode === "dark" ? line(borderAlpha) : "rgba(0, 0, 0, 0.12)";
  tokens["--sidebar-border"] = mode === "dark" ? line(borderAlpha - 0.03) : "rgba(0, 0, 0, 0.1)";

  if (gradient) {
    if (colors.length > 1) {
      tokens["--app-bg-image"] = gradient;
      tokens["--app-bg-color"] = canvas;
    } else {
      // A single stop is a solid page colour: `--app-bg-image` is cleared so a
      // previous gradient cannot survive the switch.
      tokens["--app-bg-color"] = gradient;
      tokens["--app-bg-image"] = "";
    }
  }
  return tokens;
}

/** The tokens that carry a colour, for the tests and the cache writer. */
export const THEME_TOKEN_NAMES = [
  "--background",
  "--foreground",
  "--card",
  "--card-foreground",
  "--popover",
  "--popover-foreground",
  "--sidebar",
  "--sidebar-foreground",
  "--muted",
  "--muted-foreground",
  "--secondary",
  "--secondary-foreground",
  "--input",
  "--primary",
  "--primary-foreground",
  "--ring",
  "--accent",
  "--accent-foreground",
  "--sidebar-primary",
  "--sidebar-primary-foreground",
  "--sidebar-accent",
  "--sidebar-accent-foreground",
  "--sidebar-ring",
  "--border",
  "--sidebar-border",
  "--app-bg-image",
  "--app-bg-color"
] as const;
