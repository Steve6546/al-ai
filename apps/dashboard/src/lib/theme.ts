/**
 * The appearance preferences: the theme mode and the accent colour.
 *
 * Three rules shape this module:
 *
 * 1. **The reader's own choice, on their own machine.** The preferences live
 *    in `localStorage`, not in the account and not in a setting the server
 *    holds - the dashboard is a tool one person uses on their own machine, and
 *    a theme is not something that should be pushed to anybody else. It also
 *    means no API, no table and no migration for a purely visual choice.
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

export type ThemeMode = "light" | "dark" | "system";
export type AccentName = "blue" | "violet" | "emerald" | "amber" | "rose";

export type ThemePrefs = {
  mode: ThemeMode;
  accent: AccentName;
};

export const THEME_STORAGE_KEY = "al-ai.appearance";

export const ACCENTS: { name: AccentName; label: string; swatch: string }[] = [
  { name: "blue", label: "أزرق", swatch: "oklch(0.55 0.19 262)" },
  { name: "violet", label: "بنفسجي", swatch: "oklch(0.55 0.17 292)" },
  { name: "emerald", label: "زمردي", swatch: "oklch(0.55 0.14 158)" },
  { name: "amber", label: "كهرماني", swatch: "oklch(0.68 0.15 72)" },
  { name: "rose", label: "وردي", swatch: "oklch(0.55 0.18 18)" }
];

const MODES: readonly ThemeMode[] = ["light", "dark", "system"];
const ACCENT_NAMES: readonly AccentName[] = ACCENTS.map(accent => accent.name);

export const DEFAULT_THEME_PREFS: ThemePrefs = { mode: "system", accent: "blue" };

function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === "string" && (MODES as readonly string[]).includes(value);
}

function isAccentName(value: unknown): value is AccentName {
  return typeof value === "string" && (ACCENT_NAMES as readonly string[]).includes(value);
}

/** The preferences as stored, or the defaults when nothing usable is stored. */
export function readThemePrefs(storage: Pick<Storage, "getItem"> | null = safeStorage()): ThemePrefs {
  if (!storage) return { ...DEFAULT_THEME_PREFS };
  try {
    const raw = storage.getItem(THEME_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_THEME_PREFS };
    const parsed = JSON.parse(raw) as Partial<ThemePrefs>;
    return {
      mode: isThemeMode(parsed.mode) ? parsed.mode : DEFAULT_THEME_PREFS.mode,
      accent: isAccentName(parsed.accent) ? parsed.accent : DEFAULT_THEME_PREFS.accent
    };
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
  return theme;
}

function writeThemePrefs(prefs: ThemePrefs, storage: Pick<Storage, "setItem"> | null = safeStorage()) {
  if (!storage) return;
  try {
    storage.setItem(THEME_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // A full or blocked storage must not break the change: the palette is
    // already applied, it just will not survive a reload.
  }
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
  const setAccent = useCallback((accent: AccentName) => commit({ ...prefs, accent }), [commit, prefs]);

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

  return { prefs, setMode, setAccent };
}
