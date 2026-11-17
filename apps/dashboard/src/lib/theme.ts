/**
 * The appearance preferences: the theme mode and the accent colour.
 *
 * Three rules shape this module:
 *
 * 1. **The reader's choice, following the account.** The palette is stored on
 *    the account (`user_preferences.appearance`) so it is the same on every
 *    device, and mirrored into `localStorage` as a paint-time cache: `theme-boot.js`
 *    reads that cache before the first frame, then `main.tsx` reconciles with
 *    what the server says. Without the cache the page would paint in the default
 *    palette and repaint once the session loaded — the flash this module exists
 *    to prevent. The cache is never the source of truth; it is only the fastest
 *    available copy of it.
 *
 * 2. **Applied before the first paint.** `applyThemePrefs` is called from
 *    `main.tsx` before React renders, so the page never flashes the wrong
 *    palette on the way to the right one.
 *
 * 3. **The system is a mode, not a guess.** "system" means "follow the
 *    operating system *now*", and it keeps following it: a listener on the
 *    media query re-applies the palette when the OS flips at sunset.
 */
import { useCallback, useEffect, useState } from "react";

import {
  ACCENT_SWATCHES,
  APPEARANCE_PRESETS,
  DEFAULT_APPEARANCE,
  backgroundImage,
  normaliseAppearance,
  normaliseHex,
  readableOn,
  type AccentName,
  type Appearance
} from "@al-ai/core/browser";

export type ThemeMode = Appearance["mode"];
export type { AccentName };

/**
 * The stored preference is the shared appearance shape: one definition, used by
 * the server to validate, by the boot script to paint, and here to render.
 */
export type ThemePrefs = Appearance;

export const THEME_STORAGE_KEY = "al-ai.appearance";

export const ACCENTS: { name: AccentName; label: string; swatch: string }[] = (
  ["blue", "violet", "emerald", "amber", "rose"] as AccentName[]
).map(name => ({ name, label: name, swatch: ACCENT_SWATCHES[name] }));

export const DEFAULT_THEME_PREFS: ThemePrefs = DEFAULT_APPEARANCE;
export { APPEARANCE_PRESETS, backgroundImage, normaliseHex, readableOn };

/** The preferences as stored, or the defaults when nothing usable is stored. */
export function readThemePrefs(storage: Pick<Storage, "getItem"> | null = safeStorage()): ThemePrefs {
  if (!storage) return { ...DEFAULT_THEME_PREFS };
  try {
    const raw = storage.getItem(THEME_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_THEME_PREFS };
    // `normaliseAppearance` repairs whatever is there field by field, so a cache
    // written by an older build still paints with the parts that still make sense.
    return normaliseAppearance(JSON.parse(raw));
  } catch {
    // A corrupt or unreadable value must not break the app; the defaults are
    // always a working appearance.
    return { ...DEFAULT_THEME_PREFS };
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    // Storage can be blocked entirely (a private window, a locked-down
    // profile). The app still has to work.
    return null;
  }
}

/** What the palette should actually be, given the mode and the system. */
export function resolveTheme(mode: ThemeMode, systemPrefersDark: boolean): "light" | "dark" {
  if (mode === "system") return systemPrefersDark ? "dark" : "light";
  return mode;
}

/**
 * Puts the palette on the document.
 *
 * HeroUI reads `data-theme` *and* the `light`/`dark` class, and Tailwind's
 * `dark:` variant reads the class - so both are set, and the mode is written
 * back onto the element as `data-appearance` for the few places that need to
 * know what the reader actually chose (the appearance menu, for one).
 */
export function applyThemePrefs(prefs: ThemePrefs, root: HTMLElement | null = document?.documentElement ?? null): "light" | "dark" {
  if (!root) return "light";
  const systemPrefersDark =
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
      : false;
  const theme = resolveTheme(prefs.mode, systemPrefersDark);

  root.classList.toggle("dark", theme === "dark");
  root.classList.toggle("light", theme === "light");
  root.dataset.theme = theme;
  root.dataset.appearance = prefs.mode;
  root.dataset.accent = prefs.accent;

  /**
   * The accent and the backdrop, as variables rather than classes.
   *
   * A custom colour cannot be expressed as one of the five `data-accent` blocks
   * in the stylesheet, so the two properties the accent actually drives are set
   * inline and win over the block. The label colour is computed from the accent
   * itself (`readableOn`), which is what keeps button text legible when somebody
   * picks pale yellow — a fixed white label would vanish there.
   */
  const accentColor = normaliseHex(prefs.accentColor) ?? ACCENT_SWATCHES[prefs.accent] ?? ACCENT_SWATCHES.blue;
  root.style.setProperty("--primary", accentColor);
  root.style.setProperty("--primary-foreground", readableOn(accentColor));
  root.style.setProperty("--ring", accentColor);

  const image = backgroundImage(prefs.background);
  const solid = normaliseHex(prefs.background.from);
  if (image) {
    root.style.setProperty("--app-bg-image", image);
    root.style.removeProperty("--app-bg-color");
  } else {
    root.style.removeProperty("--app-bg-image");
    if (solid) root.style.setProperty("--app-bg-color", solid);
    else root.style.removeProperty("--app-bg-color");
  }
  return theme;
}

const THEME_CHANGE_EVENT = "al-ai:appearance-changed";

function writeThemePrefs(prefs: ThemePrefs, storage: Pick<Storage, "setItem"> | null = safeStorage()) {
  if (storage) {
    try {
      storage.setItem(THEME_STORAGE_KEY, JSON.stringify(prefs));
    } catch {
      // A full or blocked storage must not break the change: the palette is
      // already applied, it just will not survive a reload.
    }
  }
  // Every hook instance (the header menu, the sidebar menu and the settings
  // panel) reads its own state. The event keeps them in agreement without
  // turning a two-value preference into a provider.
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT));
}

/**
 * The appearance state, and the two setters that change it.
 *
 * The state lives in the hook rather than in a context: the only consumer is
 * the appearance menu, and a provider would mean threading the palette through
 * the tree for two buttons.
 */
export function useThemePrefs() {
  const [prefs, setPrefs] = useState<ThemePrefs>(() => readThemePrefs());

  const commit = useCallback((next: ThemePrefs) => {
    setPrefs(next);
    writeThemePrefs(next);
    applyThemePrefs(next);
  }, []);

  const setMode = useCallback((mode: ThemeMode) => commit({ ...prefs, mode }), [commit, prefs]);
  const setAccent = useCallback((accent: AccentName) => commit({ ...prefs, accent, accentColor: null }), [commit, prefs]);
  /** A custom accent; passing null returns to the named one. */
  const setAccentColor = useCallback(
    (accentColor: string | null) => commit({ ...prefs, accentColor: normaliseHex(accentColor) }),
    [commit, prefs]
  );
  const setBackground = useCallback(
    (background: Partial<ThemePrefs["background"]>) =>
      commit(normaliseAppearance({ ...prefs, background: { ...prefs.background, ...background } })),
    [commit, prefs]
  );
  /** A ready-made palette, applied whole (mode, accent and backdrop together). */
  const applyPreset = useCallback((appearance: ThemePrefs) => commit(normaliseAppearance(appearance)), [commit]);
  const resetTheme = useCallback(() => commit({ ...DEFAULT_THEME_PREFS }), [commit]);

  // "system" means "follow the system *now*": when the operating system flips
  // at sunset, the page follows it without a reload.
  useEffect(() => {
    if (prefs.mode !== "system") return;
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyThemePrefs(prefs);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [prefs]);

  // Another mounted menu or the settings panel may have written a new value.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const sync = () => setPrefs(readThemePrefs());
    window.addEventListener(THEME_CHANGE_EVENT, sync);
    return () => window.removeEventListener(THEME_CHANGE_EVENT, sync);
  }, []);

  return { prefs, setMode, setAccent, setAccentColor, setBackground, applyPreset, resetTheme };
}

/**
 * Applies the palette the account holds, and caches it for the next first paint.
 *
 * Called once per session, from the loader that already asked for the account's
 * preferences. It writes the same key `theme-boot.js` reads, so the next page
 * load paints the account's palette before React exists — the cache is a copy,
 * never a competing source of truth.
 */
export function applyAccountAppearance(appearance: unknown): ThemePrefs {
  const prefs = normaliseAppearance(appearance);
  writeThemePrefs(prefs);
  applyThemePrefs(prefs);
  return prefs;
}
