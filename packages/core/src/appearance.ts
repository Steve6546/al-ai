/**
 * The appearance a person chooses: the shape, its migration, and the presets.
 *
 * Round four replaced this module's first version, which had grown a shape per
 * feature — a named accent plus a custom accent plus a background object with a
 * style, a start and an end. That shape could describe four backdrops and five
 * accents, and nothing else: it had no way to say "three colours at 40°", which
 * is what a Discord-style customizer produces.
 *
 * The v2 shape is the one the engine needs: up to five colours, an angle, an
 * intensity, and an optional accent override. `version: 2` is written explicitly
 * so a row can be read without guessing, and `normaliseAppearance` migrates a v1
 * row into it rather than dropping somebody's palette on upgrade.
 *
 * Everything here is pure: no DOM, no storage. The colour maths lives beside it
 * in `theme-engine.ts`; this file is only the shape, the migration and the shelf
 * of ready-made themes.
 */
import { harmonise, normaliseHex, type Appearance, type ThemeMode, type ThemeScope } from "./theme-engine.js";

export {
  AA_LARGE,
  AA_TEXT,
  DEFAULT_APPEARANCE,
  HARMONY_KINDS,
  MAX_THEME_COLORS,
  THEME_TOKEN_NAMES,
  buildThemeTokens,
  canvasBackground,
  contrastRatio,
  harmonise,
  hexToOklch,
  hexToRgb,
  isHex,
  normaliseHex,
  oklchToHex,
  readableText,
  relativeLuminance,
  rgbToHex,
  type Appearance,
  type HarmonyKind,
  type Oklch,
  type ThemeMode,
  type ThemeScope,
  type ThemeTokens
} from "./theme-engine.js";

export const APPEARANCE_VERSION = 2;
export const MAX_COLORS = 5;
export const THEME_MODES: readonly ThemeMode[] = ["light", "dark", "system"];
export const THEME_SCOPES: readonly ThemeScope[] = ["canvas", "tinted"];

/** The named accents the design ships with, kept for the quick swatches. */
export type AccentName = "blue" | "violet" | "emerald" | "amber" | "rose";
export const NAMED_ACCENTS: readonly AccentName[] = ["blue", "violet", "emerald", "amber", "rose"];
export const ACCENT_SWATCHES: Record<AccentName, string> = {
  blue: "#3b82f6",
  violet: "#8b5cf6",
  emerald: "#10b981",
  amber: "#f59e0b",
  rose: "#f43f5e"
};

/**
 * Whether a colour is readable on another.
 *
 * Kept as the name the rest of the app already imports; the implementation is
 * the engine's `readableText`, so there is one contrast rule in the product.
 */
export { readableText as readableOn } from "./theme-engine.js";

/** The quick colours offered beside the picker: six hues plus two neutrals. */
export const QUICK_SWATCHES: readonly string[] = [
  "#f43f5e",
  "#f97316",
  "#f59e0b",
  "#10b981",
  "#06b6d4",
  "#3b82f6",
  "#8b5cf6",
  "#64748b"
];

/* ------------------------------------------------------------------ *
 * Presets
 * ------------------------------------------------------------------ */

/**
 * The shelf of ready-made themes.
 *
 * Each one is a complete appearance, not a patch: applying a preset that only
 * changed the colours would leave a custom accent behind, which is how
 * one-click themes end up looking like neither theme. `preview` is derived from
 * the same colours by the same engine, so the tile cannot promise a gradient the
 * page will not paint.
 */
export type AppearancePreset = {
  id: string;
  appearance: Appearance;
};

const preset = (
  id: string,
  colors: string[],
  options: Partial<Omit<Appearance, "version" | "colors">> = {}
): AppearancePreset => ({
  id,
  appearance: {
    version: 2,
    mode: options.mode ?? "dark",
    colors,
    angle: options.angle ?? 135,
    intensity: options.intensity ?? 55,
    scope: options.scope ?? "tinted",
    accent: options.accent ?? null
  }
});

export const APPEARANCE_PRESETS: readonly AppearancePreset[] = [
  // The default: one hue, so the panels are a whisper of it rather than a wash.
  preset("default", ["#4f6bed"], { mode: "system", intensity: 45 }),
  // OLED black: no tint at all, for people who want the pixels off.
  preset("oled", ["#000000"], { intensity: 0 }),
  preset("midnight", ["#0b1020", "#221a4a"], { angle: 160, intensity: 60 }),
  preset("nebula", ["#2b1055", "#7597de"], { angle: 145, intensity: 65 }),
  preset("ocean", ["#04222b", "#071626"], { angle: 120, intensity: 58 }),
  preset("forest", ["#0f2a1d", "#1d4b2f"], { angle: 135, intensity: 52 }),
  preset("sunset", ["#f97316", "#db2777"], { angle: 30, intensity: 62 }),
  preset("cottonCandy", ["#c084fc", "#f9a8d4", "#fde68a"], { angle: 45, intensity: 48 }),
  preset("ember", ["#7f1d1d", "#f59e0b"], { angle: 20, intensity: 55 }),
  preset("steel", ["#1e293b", "#475569"], { angle: 200, intensity: 40 }),
  preset("daylight", ["#ffffff"], { mode: "light", intensity: 0 }),
  preset("porcelain", ["#eef2ff", "#e0e7ff"], { mode: "light", angle: 150, intensity: 45 }),
  preset("mint", ["#ecfdf5", "#d1fae5"], { mode: "light", angle: 140, intensity: 50 }),
  preset("sand", ["#fdf6e3", "#f5e6c8"], { mode: "light", angle: 160, intensity: 42 })
];

/* ------------------------------------------------------------------ *
 * Validation and migration
 * ------------------------------------------------------------------ */

/**
 * Anything the client or an older row may send, turned into a valid appearance.
 *
 * Field by field: a corrupt angle must not wipe somebody's colours, and an
 * unknown mode must not reset the palette. A v1 row (the accent + background
 * shape) is migrated rather than dropped — those rows exist in
 * `user_preferences.appearance` right now, and an upgrade that silently reset
 * every account's theme would be a regression dressed as a feature.
 */
export function normaliseAppearance(input: unknown): Appearance {
  const source = (input ?? {}) as Record<string, unknown>;
  const mode = normaliseMode(source.mode);
  const colors = normaliseColors(source);
  const intensity = clampNumber(source.intensity, 0, 100, 55);
  // Angles wrap rather than clamp: a stored 900° means "the same direction as
  // 180°", and clamping it to 360° (then to 0°) would turn it into the opposite
  // direction. Only a non-number falls back.
  const angle = wrapAngle(source.angle);
  const scope: ThemeScope = source.scope === "canvas" ? "canvas" : "tinted";
  const accent = normaliseHex(source.accent) ?? legacyAccent(source);
  return { version: APPEARANCE_VERSION, mode, colors, angle, intensity, scope, accent };
}

function normaliseMode(value: unknown): ThemeMode {
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

function wrapAngle(value: unknown): number {
  const number = typeof value === "string" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isFinite(number)) return 135;
  return Math.round(((number % 360) + 360) % 360);
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const number = typeof value === "string" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

/**
 * The colour list, from either shape.
 *
 * v1 stored a {@link BackgroundStyle} and two colours; the intent behind a
 * "split" backdrop is two stops with a hard edge, which the engine paints as a
 * gradient with two stops the operator can now drag, so the migration keeps the
 * colours and drops the style. A v1 `gradient` becomes the same two stops.
 */
function normaliseColors(source: Record<string, unknown>): string[] {
  const raw = Array.isArray(source.colors) ? source.colors : null;
  if (raw) {
    const colors = raw.map(value => normaliseHex(value)).filter((value): value is string => value !== null);
    if (colors.length > 0) return colors.slice(0, MAX_COLORS);
  }
  const background = source.background as { from?: unknown; to?: unknown } | undefined;
  const legacy = [normaliseHex(background?.from), normaliseHex(background?.to)].filter(
    (value): value is string => value !== null
  );
  if (legacy.length > 0) return legacy.slice(0, MAX_COLORS);
  return [...DEFAULT_COLORS];
}

function legacyAccent(source: Record<string, unknown>): string | null {
  const custom = normaliseHex(source.accentColor);
  if (custom) return custom;
  const named = source.accent;
  if (typeof named === "string" && named in ACCENT_SWATCHES) {
    return ACCENT_SWATCHES[named as AccentName];
  }
  return null;
}

const DEFAULT_COLORS = ["#4f6bed"];

/** Whether two appearances are the same choice, for the unsaved-changes bar. */
export function appearanceEquals(a: Appearance, b: Appearance): boolean {
  return (
    a.mode === b.mode &&
    a.angle === b.angle &&
    a.intensity === b.intensity &&
    a.scope === b.scope &&
    (a.accent ?? "") === (b.accent ?? "") &&
    a.colors.length === b.colors.length &&
    a.colors.every((color, index) => color === b.colors[index])
  );
}

/**
 * A theme from a seed, for the «فاجئني» button.
 *
 * The harmonies rotate through the classical relationships so two presses give
 * two different answers, and the mode is left alone: the operator asked for a
 * palette, not for their light/dark choice to change under them.
 */
export function surpriseAppearance(
  current: Appearance,
  random: () => number = Math.random
): Appearance {
  const kinds = ["analogous", "complementary", "triadic", "split", "monochrome"] as const;
  const kind = kinds[Math.floor(random() * kinds.length) % kinds.length]!;
  const hue = Math.floor(random() * 360);
  const seed = `#${[0, 1, 2]
    .map(() => Math.floor(random() * 256).toString(16).padStart(2, "0"))
    .join("")}`;
  const colors = harmonise(seed, kind, 2 + Math.floor(random() * 2));
  return {
    ...current,
    version: APPEARANCE_VERSION,
    colors: colors.length > 0 ? colors : [`#${hue.toString(16).padStart(2, "0")}6bed`],
    angle: Math.round(random() * 360),
    intensity: 35 + Math.round(random() * 50)
  };
}
