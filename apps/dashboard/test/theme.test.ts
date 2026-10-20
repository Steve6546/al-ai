/**
 * The appearance preferences.
 *
 * Three behaviours are pinned here, because each of them is a way the palette
 * could go wrong without anybody noticing:
 *
 * 1. The stored preference is read defensively - a corrupt or hand-edited
 *    value must not break the app, and an unknown mode or accent falls back to
 *    the default rather than to "nothing".
 * 2. "system" resolves to what the operating system says *now*, and an
 *    explicit choice overrides it.
 * 3. Applying the preference puts the palette on the document the way HeroUI
 *    and Tailwind both read it: the `light`/`dark` class *and* `data-theme`,
 *    plus the chosen accent.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  applyThemePrefs,
  DEFAULT_THEME_PREFS,
  readThemePrefs,
  resolveTheme,
  THEME_STORAGE_KEY,
  type ThemePrefs
} from "../src/lib/theme";

/** A minimal `Storage`, so the tests need no browser. */
function fakeStorage(value: string | null): Pick<Storage, "getItem"> {
  return { getItem: () => value };
}

test("nothing stored means the defaults", () => {
  assert.deepEqual(readThemePrefs(fakeStorage(null)), DEFAULT_THEME_PREFS);
  assert.equal(DEFAULT_THEME_PREFS.mode, "system");
  assert.equal(DEFAULT_THEME_PREFS.accent, "blue");
});

test("a stored preference is read back", () => {
  const stored = JSON.stringify({ mode: "light", accent: "emerald" });
  assert.deepEqual(readThemePrefs(fakeStorage(stored)), { mode: "light", accent: "emerald" });
});

test("a corrupt or unknown value falls back to the defaults", () => {
  assert.deepEqual(readThemePrefs(fakeStorage("not json")), DEFAULT_THEME_PREFS);
  assert.deepEqual(readThemePrefs(fakeStorage(JSON.stringify({ mode: "neon", accent: "chartreuse" }))), DEFAULT_THEME_PREFS);
  assert.deepEqual(readThemePrefs(fakeStorage(JSON.stringify({ mode: "dark" }))), { mode: "dark", accent: "blue" });
});

test("the mode resolves against the system, and an explicit choice wins", () => {
  assert.equal(resolveTheme("system", true), "dark");
  assert.equal(resolveTheme("system", false), "light");
  assert.equal(resolveTheme("dark", false), "dark");
  assert.equal(resolveTheme("light", true), "light");
});

test("applying a preference sets the class, the theme and the accent", () => {
  // A stand-in for <html>: the same three attributes the real element takes.
  const classes = new Set<string>();
  const dataset: Record<string, string> = {};
  const root = {
    classList: {
      toggle: (name: string, on: boolean) => {
        if (on) classes.add(name);
        else classes.delete(name);
      }
    },
    dataset
  } as unknown as HTMLElement;

  const theme = applyThemePrefs({ mode: "dark", accent: "rose" }, root);

  assert.equal(theme, "dark");
  assert.ok(classes.has("dark"));
  assert.ok(!classes.has("light"));
  assert.equal(dataset.theme, "dark");
  assert.equal(dataset.appearance, "dark");
  assert.equal(dataset.accent, "rose");
});

test("the system mode follows the system when it is applied", () => {
  const classes = new Set<string>();
  const dataset: Record<string, string> = {};
  const root = {
    classList: {
      toggle: (name: string, on: boolean) => {
        if (on) classes.add(name);
        else classes.delete(name);
      }
    },
    dataset
  } as unknown as HTMLElement;

  // The engine reads the system's preference from `window.matchMedia`, which
  // does not exist in the test environment, so the fallback is the light
  // palette - the point of the assertion is that "system" never leaves the
  // document without a palette.
  const theme = applyThemePrefs({ mode: "system", accent: "blue" }, root);
  assert.ok(theme === "light" || theme === "dark");
  assert.equal(dataset.theme, theme);
  assert.ok(classes.has(theme));
});

test("the storage key is stable, so a reload keeps the choice", () => {
  assert.equal(THEME_STORAGE_KEY, "al-ai.appearance");
});

test("a preference round-trips through storage", () => {
  const prefs: ThemePrefs = { mode: "dark", accent: "amber" };
  const stored = JSON.stringify(prefs);
  assert.deepEqual(readThemePrefs(fakeStorage(stored)), prefs);
});
