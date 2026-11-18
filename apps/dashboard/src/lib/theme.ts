/**
 * The appearance, applied to the document.
 *
 * The engine (`@al-ai/core`) decides *what* the tokens are; this module decides
 * *when* they reach the DOM, and it never lets two things disagree about the
 * answer:
 *
 * 1. **One write per frame.** Dragging a 360° angle slider fires `input` events
 *    far faster than the screen refreshes, and each one used to mean a fresh
 *    `setProperty` for every token — 27 style writes per event, from JavaScript,
 *    on a thread that also has to lay out the page. The changes are therefore
 *    coalesced: `scheduleApply` keeps the latest appearance and paints it once per
 *    `requestAnimationFrame`, so the sliders run at the compositor's rate instead
 *    of at the pointer's rate.
 *
 * 2. **The derived tokens are cached, not just the choice.** `theme-boot.js` runs
 *    before any module loads, and it cannot import the colour engine — so the
 *    tokens are written to `localStorage` alongside the preference, and the boot
 *    script only has to put them back. That is what keeps a themed page from
 *    flashing the default palette for a frame: no maths in the boot path, just
 *    27 property writes it already knows the value of.
 *
 * 3. **The cache is a copy.** `applyAccountAppearance` recomputes from the
 *    account's stored preference on every session load and rewrites both keys, so
 *    a stale cache (an older build's tokens, a theme changed on another device)
 *    is corrected before the person sees it.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import {
  DEFAULT_APPEARANCE,
  MAX_THEME_COLORS,
  THEME_TOKEN_NAMES,
  appearanceEquals,
  buildThemeTokens,
  normaliseAppearance,
  type Appearance,
  type ThemeMode
} from "@al-ai/core/browser";

export type ThemePrefs = Appearance;
export type { ThemeMode };

export const THEME_STORAGE_KEY = "al-ai.appearance";
/**
 * The derived tokens, as last painted.
 *
 * Stored separately from the preference so a cache written by an older build is
 * recognisable: the boot script only trusts it when the two shapes agree.
 */
export const THEME_TOKENS_STORAGE_KEY = "al-ai.appearance.tokens";
/** Bumped when the token set changes; a mismatch makes the boot script ignore the cache. */
export const THEME_TOKENS_VERSION = 2;

export const DEFAULT_THEME_PREFS: ThemePrefs = DEFAULT_APPEARANCE;

/** Whether this browser can interpolate a gradient in OKLCH. */
export function supportsOklchGradients(): boolean {
  try {
    return typeof CSS !== "undefined" && typeof CSS.supports === "function"
      ? CSS.supports("background-image", "linear-gradient(0deg in oklch, red, blue)")
      : false;
  } catch {
    return false;
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    // Storage can be blocked entirely (a private window, a locked-down profile).
    // The app still has to work; it just cannot pre-paint the next load.
    return null;
  }
}

/** The preferences as stored, or the defaults when nothing usable is stored. */
export function readThemePrefs(storage: Pick<Storage, "getItem"> | null = safeStorage()): ThemePrefs {
  if (!storage) return { ...DEFAULT_THEME_PREFS };
  try {
    const raw = storage.getItem(THEME_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_THEME_PREFS };
    // `normaliseAppearance` repairs whatever is there field by field — including
    // a v1 row, which it migrates — so a cache written by an older build still
    // paints with the parts that still make sense.
    return normaliseAppearance(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_THEME_PREFS };
  }
}

/** The cached tokens, when they were written for this exact preference and shape. */
export function readCachedTokens(
  prefs: ThemePrefs,
  storage: Pick<Storage, "getItem"> | null = safeStorage()
): Record<string, string> | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(THEME_TOKENS_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { version?: unknown; for?: unknown; tokens?: unknown };
    if (parsed.version !== THEME_TOKENS_VERSION) return null;
    if (typeof parsed.for !== "string" || parsed.for !== fingerprint(prefs)) return null;
    if (!parsed.tokens || typeof parsed.tokens !== "object") return null;
    return parsed.tokens as Record<string, string>;
  } catch {
    return null;
  }
}

/** A stable description of a choice, used to tie a token cache to it. */
export function fingerprint(prefs: ThemePrefs): string {
  return [prefs.mode, prefs.angle, prefs.intensity, prefs.scope, prefs.accent ?? "-", prefs.colors.join(",")].join("|");
}

function writeThemePrefs(
  prefs: ThemePrefs,
  tokens: Record<string, string>,
  theme: "light" | "dark",
  storage: Pick<Storage, "setItem"> | null = safeStorage()
) {
  if (storage) {
    try {
      storage.setItem(THEME_STORAGE_KEY, JSON.stringify(prefs));
      storage.setItem(
        THEME_TOKENS_STORAGE_KEY,
        // `dark` is stored because `mode: "system"` resolves differently depending
        // on the OS at load time: a cache built for the light side of that
        // decision must not be painted on the dark side.
        JSON.stringify({ version: THEME_TOKENS_VERSION, for: fingerprint(prefs), dark: theme === "dark", tokens })
      );
    } catch {
      // A full or blocked storage must not break the change: the palette is
      // already applied, it just will not survive a reload.
    }
  }
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT));
}

/** What the palette should actually be, given the mode and the system. */
export function resolveTheme(mode: ThemeMode, systemPrefersDark: boolean): "light" | "dark" {
  if (mode === "system") return systemPrefersDark ? "dark" : "light";
  return mode;
}

function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)").matches
    : false;
}

/**
 * Puts the derived tokens on the document.
 *
 * `data-theme` and the `light`/`dark` class both change, because HeroUI reads the
 * attribute and Tailwind's `dark:` variant reads the class. The tokens go on as
 * custom properties, which is what makes the CSS follow without a class per
 * theme: every utility in the product is built from these names.
 */
export function applyAppearance(
  prefs: ThemePrefs,
  root: HTMLElement | null = typeof document === "undefined" ? null : document.documentElement
): { theme: "light" | "dark"; tokens: Record<string, string> } {
  const tokens = buildThemeTokens(prefs, { oklchGradients: supportsOklchGradients() });
  if (!root) return { theme: "dark", tokens };

  const theme = resolveTheme(prefs.mode, systemPrefersDark());
  // The mode decides the ladder, so a `system` theme has to resolve before the
  // tokens are built — otherwise the engine would derive dark surfaces for a
  // light OS preference.
  const resolved = theme === prefs.mode ? prefs : { ...prefs, mode: theme as ThemeMode };
  const resolvedTokens = theme === prefs.mode ? tokens : buildThemeTokens(resolved, { oklchGradients: supportsOklchGradients() });

  root.classList.toggle("dark", theme === "dark");
  root.classList.toggle("light", theme === "light");
  root.dataset.theme = theme;
  root.dataset.appearance = prefs.mode;
  root.dataset.themeScope = prefs.scope;

  for (const name of THEME_TOKEN_NAMES) {
    const value = resolvedTokens[name];
    if (value === undefined) continue;
    // An empty string is a deliberate "clear this one": a theme that switches
    // from a gradient to a solid must not leave the old image set on the page.
    if (value === "") root.style.removeProperty(name);
    else root.style.setProperty(name, value);
  }
  return { theme, tokens: resolvedTokens };
}

const THEME_CHANGE_EVENT = "al-ai:appearance-changed";

/**
 * Coalesces applications into one per animation frame.
 *
 * A pointer drag on the angle slider produces ~120 events a second; the screen
 * shows 60. Without this, 60 of those events cost a full token rebuild plus 27
 * style writes that are never painted — and the writes are synchronous style
 * invalidation, so the drag itself gets slower the faster the operator moves.
 */
export function createAppearanceScheduler(root: HTMLElement | null = typeof document === "undefined" ? null : document.documentElement) {
  let frame = 0;
  let pending: ThemePrefs | null = null;
  let last = { theme: "dark" as "light" | "dark", tokens: {} as Record<string, string> };

  const paint = () => {
    frame = 0;
    if (!pending) return;
    const next = pending;
    pending = null;
    last = applyAppearance(next, root);
    writeThemePrefs(next, last.tokens, last.theme);
  };

  return {
    /** Queue an appearance; it is painted on the next frame. */
    schedule(prefs: ThemePrefs) {
      pending = prefs;
      if (frame) return;
      if (typeof requestAnimationFrame === "function") frame = requestAnimationFrame(paint);
      else paint();
    },
    /** Paint now — used for the first application and for a discrete change. */
    flush(prefs: ThemePrefs) {
      pending = prefs;
      if (frame && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
      paint();
    },
    get last() {
      return last;
    }
  };
}

/** Kept for the call sites that only need "apply this, now". */
export function applyThemePrefs(prefs: ThemePrefs, root?: HTMLElement | null) {
  const { theme } = applyAppearance(prefs, root ?? (typeof document === "undefined" ? null : document.documentElement));
  return theme;
}

/**
 * The appearance state, and the setters that change it.
 *
 * Every setter normalises through `normaliseAppearance`, so the shape the UI can
 * produce is exactly the shape the server accepts — a five-colour ceiling or a
 * wrapped angle cannot be committed from here even by a bug in a control.
 */
export function useThemePrefs() {
  const [prefs, setPrefs] = useState<ThemePrefs>(() => readThemePrefs());
  const scheduler = useRef<ReturnType<typeof createAppearanceScheduler> | null>(null);

  const getScheduler = useCallback(() => {
    if (!scheduler.current) {
      scheduler.current = createAppearanceScheduler();
    }
    return scheduler.current;
  }, []);

  /**
   * Commits a change.
   *
   * `live` means "a control is being dragged": the palette is queued for the next
   * frame and the preference is not written until it lands. Both paths write the
   * cache in the same place, so a reload mid-drag paints the last frame that was
   * actually shown.
   *
   * The next value may be an update function, and the setters below always pass
   * one. That is not a stylistic choice: React batches the events of one task, so
   * a preset press followed by a slider move in that same task used to compose
   * the slider's change onto the *pre-preset* palette (`{ ...prefs, angle }`,
   * where `prefs` is the closure of the last render) and silently undo the
   * preset. Reading the latest choice from a ref makes the setters compose, which
   * is what a control that only changes one field has to do.
   */
  const latest = useRef(prefs);
  latest.current = prefs;
  const commit = useCallback(
    (next: ThemePrefs | ((current: ThemePrefs) => ThemePrefs), { live = false }: { live?: boolean } = {}) => {
      const normalised = normaliseAppearance(typeof next === "function" ? next(latest.current) : next);
      latest.current = normalised;
      setPrefs(normalised);
      const painter = getScheduler();
      if (live) painter.schedule(normalised);
      else painter.flush(normalised);
      return normalised;
    },
    [getScheduler]
  );

  const setMode = useCallback((mode: ThemeMode) => commit(current => ({ ...current, mode })), [commit]);
  const setColors = useCallback(
    (colors: string[], options?: { live?: boolean }) =>
      commit(current => ({ ...current, colors: colors.slice(0, MAX_THEME_COLORS) }), options),
    [commit]
  );
  /**
   * The palette, derived from the palette itself.
   *
   * Adding, deleting and reordering a stop are all "look at the current list and
   * produce the next one", so they take the updater form: two such edits in one
   * task would otherwise both start from the list of the last render and the
   * second would drop the first.
   */
  const updateColors = useCallback(
    (update: (colors: string[]) => string[], options?: { live?: boolean }) =>
      commit(current => ({ ...current, colors: update(current.colors).slice(0, MAX_THEME_COLORS) }), options),
    [commit]
  );
  const setAngle = useCallback(
    (angle: number, options?: { live?: boolean }) => commit(current => ({ ...current, angle }), options),
    [commit]
  );
  const setIntensity = useCallback(
    (intensity: number, options?: { live?: boolean }) => commit(current => ({ ...current, intensity }), options),
    [commit]
  );
  const setScope = useCallback((scope: ThemePrefs["scope"]) => commit(current => ({ ...current, scope })), [commit]);
  const setAccent = useCallback((accent: string | null) => commit(current => ({ ...current, accent })), [commit]);
  const applyPreset = useCallback((appearance: ThemePrefs) => commit(normaliseAppearance(appearance)), [commit]);
  const resetTheme = useCallback(() => commit(() => ({ ...DEFAULT_THEME_PREFS })), [commit]);

  // "system" means "follow the system *now*": when the operating system flips at
  // sunset, the page follows it without a reload.
  useEffect(() => {
    if (prefs.mode !== "system") return;
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => getScheduler().flush(prefs);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [prefs, getScheduler]);

  // Another mounted surface (the settings panel, a second tab) may have written
  // a new value; the event keeps every instance in agreement.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const sync = () => setPrefs(readThemePrefs());
    window.addEventListener(THEME_CHANGE_EVENT, sync);
    return () => window.removeEventListener(THEME_CHANGE_EVENT, sync);
  }, []);

  return {
    prefs,
    commit,
    setMode,
    setColors,
    updateColors,
    setAngle,
    setIntensity,
    setScope,
    setAccent,
    applyPreset,
    resetTheme,
    isDefault: appearanceEquals(prefs, DEFAULT_THEME_PREFS)
  };
}

/**
 * Applies the palette the account holds, and caches it for the next first paint.
 *
 * Called once per session, from the loader that already asked for the account's
 * preferences. It writes the same two keys `theme-boot.js` reads, so the next page
 * load paints the account's palette before React exists — the cache is a copy,
 * never a competing source of truth.
 */
export function applyAccountAppearance(appearance: unknown): ThemePrefs {
  const prefs = normaliseAppearance(appearance);
  const { tokens, theme } = applyAppearance(prefs);
  writeThemePrefs(prefs, tokens, theme);
  return prefs;
}
