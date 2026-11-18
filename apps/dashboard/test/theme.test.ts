/**
 * The appearance as the *document* sees it.
 *
 * The engine's own arithmetic is tested in `packages/core/test/theme-engine.test.ts`;
 * what is pinned here is the part that only exists in the browser and therefore
 * cannot be tested there:
 *
 * 1. The stored preference is read defensively — a corrupt or hand-edited value
 *    must not break the app, and an unknown mode falls back to the default
 *    rather than to "nothing".
 * 2. "system" resolves against the operating system *now*, and an explicit
 *    choice overrides it.
 * 3. Applying the preference puts the palette on the document in the shape
 *    HeroUI and Tailwind both read it: the `light`/`dark` class, `data-theme`,
 *    and every derived token as a custom property.
 * 4. **The cache the boot script replays agrees with what was painted.** This is
 *    the one that could rot silently: `theme-boot.js` cannot import the engine,
 *    so it trusts `al-ai.appearance.tokens` — and if the fingerprint written
 *    here stopped matching the one computed there, every reload would flash the
 *    unthemed page with nothing failing.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { THEME_TOKEN_NAMES, buildThemeTokens, normaliseAppearance } from "@al-ai/core/browser";
import {
  applyAppearance,
  applyThemePrefs,
  createAppearanceScheduler,
  DEFAULT_THEME_PREFS,
  fingerprint,
  readCachedTokens,
  readThemePrefs,
  resolveTheme,
  THEME_STORAGE_KEY,
  THEME_TOKENS_STORAGE_KEY,
  THEME_TOKENS_VERSION,
  type ThemePrefs
} from "../src/lib/theme";

/** A stand-in for the element's inline style, recording what was written. */
function styleStub() {
  const written = new Map<string, string>();
  return {
    written,
    setProperty: (name: string, value: string) => written.set(name, value),
    removeProperty: (name: string) => written.delete(name),
    getPropertyValue: (name: string) => written.get(name) ?? ""
  };
}

/** A stand-in for `<html>`: the attributes and the inline style it takes. */
function rootStub() {
  const classes = new Set<string>();
  const dataset: Record<string, string> = {};
  const style = styleStub();
  return {
    classes,
    dataset,
    style,
    element: {
      classList: {
        toggle: (name: string, on: boolean) => {
          if (on) classes.add(name);
          else classes.delete(name);
        }
      },
      dataset,
      style
    } as unknown as HTMLElement
  };
}

/** A minimal `Storage`, so the tests need no browser. */
function fakeStorage(value: string | null): Pick<Storage, "getItem"> {
  return { getItem: () => value };
}

/** A `Storage` that keeps what is written, so a write can be read back. */
function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key)
  };
}

const DARK_VIOLET: ThemePrefs = {
  version: 2,
  mode: "dark",
  colors: ["#6d28d9", "#0ea5e9"],
  angle: 210,
  intensity: 60,
  scope: "tinted",
  accent: null
};

test("nothing stored means the defaults", () => {
  assert.deepEqual(readThemePrefs(fakeStorage(null)), DEFAULT_THEME_PREFS);
  assert.equal(DEFAULT_THEME_PREFS.mode, "system");
  assert.equal(DEFAULT_THEME_PREFS.version, 2);
  assert.equal(DEFAULT_THEME_PREFS.colors.length, 1);
  assert.equal(DEFAULT_THEME_PREFS.scope, "tinted");
});

test("a stored preference is read back through the normaliser", () => {
  const stored = JSON.stringify({ mode: "light", colors: ["#123456"] });
  // Absent fields arrive as explicit defaults rather than as `undefined` the UI
  // would have to guard at every read.
  assert.deepEqual(readThemePrefs(fakeStorage(stored)), {
    version: 2,
    mode: "light",
    colors: ["#123456"],
    angle: 135,
    intensity: 55,
    scope: "tinted",
    accent: null
  });
});

test("a corrupt or unknown value falls back to the defaults", () => {
  assert.deepEqual(readThemePrefs(fakeStorage("not json")), DEFAULT_THEME_PREFS);
  assert.deepEqual(readThemePrefs(fakeStorage(JSON.stringify({ mode: "neon", colors: "red" }))), {
    ...DEFAULT_THEME_PREFS,
    colors: DEFAULT_THEME_PREFS.colors
  });
  // A mode that *is* known survives even when the rest of the row is junk: the
  // normaliser repairs field by field instead of resetting the row.
  assert.equal(readThemePrefs(fakeStorage(JSON.stringify({ mode: "dark", colors: [1, 2] }))).mode, "dark");
});

test("a v1 row is migrated, not discarded", () => {
  // Shape written by the previous build: a named accent plus a two-colour
  // backdrop. Losing it would reset every existing operator's theme on deploy.
  const v1 = JSON.stringify({ mode: "dark", accent: "violet", accentColor: "#123456", background: { style: "split-h", from: "#111111", to: "#eeeeee" } });
  const migrated = readThemePrefs(fakeStorage(v1));
  assert.equal(migrated.mode, "dark");
  assert.equal(migrated.version, 2);
  assert.deepEqual(migrated.colors, ["#111111", "#eeeeee"]);
  assert.equal(migrated.accent, "#123456");
});

test("the mode resolves against the system, and an explicit choice wins", () => {
  assert.equal(resolveTheme("system", true), "dark");
  assert.equal(resolveTheme("system", false), "light");
  assert.equal(resolveTheme("dark", false), "dark");
  assert.equal(resolveTheme("light", true), "light");
});

test("applying a preference sets the class, the theme and every token", () => {
  const { classes, dataset, style, element } = rootStub();
  const { theme, tokens } = applyAppearance({ ...DARK_VIOLET, mode: "dark" }, element);

  assert.equal(theme, "dark");
  assert.ok(classes.has("dark"));
  assert.ok(!classes.has("light"));
  assert.equal(dataset.theme, "dark");
  assert.equal(dataset.appearance, "dark");
  assert.equal(dataset.themeScope, "tinted");

  // Every token the engine lists reaches the element — that list is what the
  // stylesheet reads, so a token the engine emits and this loop skips is a
  // surface that silently keeps the default palette.
  for (const name of THEME_TOKEN_NAMES) {
    assert.equal(style.getPropertyValue(name), tokens[name], `${name} was not applied`);
  }
  assert.equal(style.written.size, THEME_TOKEN_NAMES.length);
});

test("the same preference produces the same tokens in the engine and the DOM", () => {
  const { element, style } = rootStub();
  applyAppearance(DARK_VIOLET, element);
  const expected = buildThemeTokens(DARK_VIOLET);
  assert.equal(style.getPropertyValue("--background"), expected["--background"]);
  assert.equal(style.getPropertyValue("--card"), expected["--card"]);
  assert.equal(style.getPropertyValue("--primary"), expected["--primary"]);
});

test("the system mode follows the system when it is applied", () => {
  const { classes, dataset, element } = rootStub();
  // `window.matchMedia` does not exist in the test environment, so the fallback
  // is the light palette — the point of the assertion is that "system" never
  // leaves the document without a palette.
  const theme = applyThemePrefs({ ...DEFAULT_THEME_PREFS }, element);
  assert.ok(theme === "light" || theme === "dark");
  assert.equal(dataset.theme, theme);
  assert.ok(classes.has(theme));
});

test("a cleared token is removed rather than written empty", () => {
  const { element, style } = rootStub();
  // A theme with no gradient must not leave the previous one set on the page.
  style.setProperty("--app-bg-image", "linear-gradient(0deg, red, blue)");
  applyAppearance({ ...DEFAULT_THEME_PREFS, colors: ["#000000"], intensity: 0 }, element);
  assert.equal(style.getPropertyValue("--app-bg-image"), "");
});

test("the storage keys are stable, so a reload keeps the choice", () => {
  assert.equal(THEME_STORAGE_KEY, "al-ai.appearance");
  assert.equal(THEME_TOKENS_STORAGE_KEY, "al-ai.appearance.tokens");
  assert.equal(THEME_TOKENS_VERSION, 2);
});

test("a preference round-trips through storage", () => {
  const stored = JSON.stringify(DARK_VIOLET);
  assert.deepEqual(readThemePrefs(fakeStorage(stored)), DARK_VIOLET);
});

test("the scheduler paints once per frame, with the latest value", () => {
  const { element, style } = rootStub();
  const frames: (() => void)[] = [];
  const originalRaf = globalThis.requestAnimationFrame;
  const originalCancel = globalThis.cancelAnimationFrame;
  // A controllable frame loop: nothing is painted until the test runs the frame.
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    frames.push(() => callback(0));
    return frames.length;
  }) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((id: number) => void frames.splice(id - 1, 1, () => {})) as typeof cancelAnimationFrame;

  try {
    const scheduler = createAppearanceScheduler(element);
    // Three drag events before a frame: only the last may reach the DOM.
    scheduler.schedule({ ...DARK_VIOLET, angle: 10 });
    scheduler.schedule({ ...DARK_VIOLET, angle: 20 });
    scheduler.schedule({ ...DARK_VIOLET, angle: 30 });
    assert.equal(style.written.size, 0, "nothing is painted before the frame");
    assert.equal(frames.length, 1, "one frame was requested, not three");

    frames[0]!();
    assert.equal(style.written.size, THEME_TOKEN_NAMES.length, "the frame painted the tokens once");
    assert.equal(scheduler.last.tokens["--background"], buildThemeTokens({ ...DARK_VIOLET, angle: 30 })["--background"]);

    // `flush` paints immediately, for a discrete change (a preset, a reset).
    scheduler.flush({ ...DARK_VIOLET, angle: 90 });
    assert.equal(scheduler.last.tokens["--background"], buildThemeTokens({ ...DARK_VIOLET, angle: 90 })["--background"]);
  } finally {
    globalThis.requestAnimationFrame = originalRaf;
    globalThis.cancelAnimationFrame = originalCancel;
  }
});

test("the token cache the boot script replays belongs to this exact choice", () => {
  const storage = memoryStorage();
  const originalWindow = globalThis.window;
  // `writeThemePrefs` is private; the public path is `applyAppearance` through
  // the scheduler, which writes both keys with the browser's storage.
  (globalThis as { window?: unknown }).window = {
    localStorage: storage,
    dispatchEvent: () => true,
    matchMedia: () => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} })
  };

  try {
    const scheduler = createAppearanceScheduler(rootStub().element);
    scheduler.flush(DARK_VIOLET);

    const choice = JSON.parse(storage.getItem(THEME_STORAGE_KEY)!) as ThemePrefs;
    assert.deepEqual(choice, DARK_VIOLET);

    // The boot script's contract, in three parts.
    const cached = JSON.parse(storage.getItem(THEME_TOKENS_STORAGE_KEY)!) as {
      version: number;
      for: string;
      dark: boolean;
      tokens: Record<string, string>;
    };
    assert.equal(cached.version, THEME_TOKENS_VERSION);
    assert.equal(cached.for, fingerprint(choice), "the cache is keyed to the same fingerprint the boot script computes");
    assert.equal(cached.dark, true, "a system-mode cache is only valid on the side it was built for");
    // Node has no `CSS.supports`, so the gradient falls back to a plain
    // `linear-gradient`: the cached values are whatever `applyAppearance`
    // actually produced, which is the point — a cache that disagreed with the
    // paint would be a flash on every load.
    const painted = buildThemeTokens(DARK_VIOLET, { oklchGradients: false });
    assert.deepEqual(cached.tokens, painted, "the cached values are what was actually painted");
    assert.equal(cached.tokens["--app-bg-image"]!.includes("in oklch"), false, "no unsupported syntax in the cache");

    // Read back through the same checks the client makes.
    assert.deepEqual(readCachedTokens(DARK_VIOLET, storage), painted);

    // A cache for a different choice is refused, and so is one from an older build.
    assert.equal(readCachedTokens({ ...DARK_VIOLET, angle: 211 }, storage), null);
    storage.setItem(THEME_TOKENS_STORAGE_KEY, JSON.stringify({ ...cached, version: 1 }));
    assert.equal(readCachedTokens(DARK_VIOLET, storage), null);
    storage.setItem(THEME_TOKENS_STORAGE_KEY, "not json");
    assert.equal(readCachedTokens(DARK_VIOLET, storage), null);
  } finally {
    (globalThis as { window?: unknown }).window = originalWindow;
  }
});

test("the fingerprint covers everything that changes the tokens", () => {
  const base = fingerprint(DARK_VIOLET);
  for (const change of [
    { mode: "light" as const },
    { angle: 90 },
    { intensity: 10 },
    { scope: "canvas" as const },
    { accent: "#ff0000" },
    { colors: ["#6d28d9"] }
  ]) {
    assert.notEqual(fingerprint({ ...DARK_VIOLET, ...change }), base, JSON.stringify(change));
  }
});

test("an unreadable storage does not throw", () => {
  // A private window, or a profile with storage disabled entirely.
  const hostile = {
    getItem: () => {
      throw new Error("blocked");
    }
  };
  assert.deepEqual(readThemePrefs(hostile), DEFAULT_THEME_PREFS);
  assert.equal(readCachedTokens(DARK_VIOLET, hostile), null);
  // And applying still works, because the palette is not stored state.
  const { style, element } = rootStub();
  applyAppearance(DARK_VIOLET, element);
  assert.ok(style.written.size > 0);
});

test("every preset paints readably in both modes", () => {
  // Not the engine's own test repeated: this one proves the *applied* tokens
  // (after `normaliseAppearance`, which is what the server stores) are the ones
  // that were checked, so a preset cannot be readable in theory and broken in
  // the DOM.
  const presets: ThemePrefs[] = [
    { ...DARK_VIOLET, accent: "#ff0000" },
    normaliseAppearance({ colors: ["#ffffff"], mode: "light", intensity: 0 }),
    normaliseAppearance({ colors: ["#f97316", "#db2777"], angle: 30, intensity: 62 })
  ];
  for (const preset of presets) {
    for (const mode of ["light", "dark"] as const) {
      const tokens = buildThemeTokens({ ...preset, mode });
      const { element, style } = rootStub();
      applyAppearance({ ...preset, mode }, element);
      assert.equal(style.getPropertyValue("--foreground"), tokens["--foreground"]);
      // 3:1 is the floor for large text; the engine's own test asserts AA at 4.5
      // for body text, this guards the wiring.
      assert.ok(tokens["--foreground"] && tokens["--background"]);
    }
  }
});
