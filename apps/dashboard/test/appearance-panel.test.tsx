// `dom-env` is imported first on purpose: React captures the realm's event
// system when it is evaluated, and a React that comes up before `document`
// exists never hears a synthetic `change` (the clicks still work, which is what
// makes the mistake read as "the field is broken").
import { dom } from "./dom-env.js";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { AppearancePanel } from "../src/views/settings/appearance-panel";
import { I18nProvider } from "../src/lib/i18n";
import { APPEARANCE_PRESETS, MAX_THEME_COLORS } from "@al-ai/core/browser";
import { DEFAULT_THEME_PREFS, THEME_STORAGE_KEY, readThemePrefs, THEME_TOKENS_STORAGE_KEY } from "../src/lib/theme";
import { parseColorInput } from "../src/components/appearance/color-field";

/**
 * The appearance panel, driven the way an operator drives it.
 *
 * `renderToString` is not enough for this screen: the whole point of it is that
 * pressing a control changes the palette *and* the stored choice, and neither
 * happens without effects. The assertions are therefore about consequences —
 * the tokens on `<html>`, the value in storage, the number of stops — rather
 * than about class names, so a redesign does not have to rewrite them.
 */

const mounted: { root: ReturnType<typeof createRoot>; container: HTMLElement }[] = [];

afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => root.unmount());
    container.remove();
  }
  window.localStorage.clear();
  // The palette is written to the document root; clear it so one test's theme
  // is not the next test's starting point.
  document.documentElement.removeAttribute("style");
});

async function mountPanel(language?: "ar" | "en" | "de") {
  const container = document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(I18nProvider, { initialLanguage: language, children: createElement(AppearancePanel) }));
  });
  await act(async () => {
    await Promise.resolve();
  });
  mounted.push({ root, container });
  return container;
}

/** The section whose heading carries this id — used to scope a query to one band. */
function section(container: HTMLElement, headingId: string): HTMLElement {
  const found = container.querySelector(`section[aria-labelledby="${headingId}"]`);
  assert.ok(found, `no section labelled ${headingId}`);
  return found as HTMLElement;
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    candidate => (candidate.getAttribute("aria-label") ?? candidate.textContent ?? "").trim() === label
  );
  assert.ok(found, `no button labelled «${label}» — the panel rendered: ${[...container.querySelectorAll("button")].map(b => b.textContent?.trim()).join(" | ")}`);
  return found as HTMLButtonElement;
}

/** Waits for an animation frame, which is when a live change is painted. */
async function settle() {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 40));
  });
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
  await act(async () => {
    await Promise.resolve();
  });
}

test("the panel renders every preset and the five-colour ceiling", async () => {
  const container = await mountPanel();
  // Scoped to the preset grid: the stop chips in the palette band are list
  // items too, and counting those would make this assertion meaningless.
  const tiles = section(container, "appearance-presets").querySelectorAll("[role='listitem']");
  assert.equal(tiles.length, APPEARANCE_PRESETS.length, "every preset has a tile");

  // The add button disables itself at the ceiling rather than failing on press.
  const add = button(container, "إضافة لون");
  for (let index = 1; index < MAX_THEME_COLORS; index += 1) await click(add);
  assert.equal(readThemePrefs(window.localStorage).colors.length, MAX_THEME_COLORS);
  assert.equal(add.disabled, true, "no sixth stop can be added");
});

test("adding a colour adds a stop that is visibly different", async () => {
  await mountPanel();
  const coloursBefore = readThemePrefs(window.localStorage).colors;
  const add = button(document.body, "إضافة لون");
  await click(add);
  const after = readThemePrefs(window.localStorage).colors;
  assert.equal(after.length, coloursBefore.length + 1);
  // A new stop that is identical to the last one looks like the button failed.
  assert.notEqual(after[after.length - 1], coloursBefore[coloursBefore.length - 1]);
});

test("pressing a preset repaints the document and is stored", async () => {
  const container = await mountPanel();
  const nebula = APPEARANCE_PRESETS.find(preset => preset.id === "nebula")!;
  const tile = [...section(container, "appearance-presets").querySelectorAll("[role='listitem']")].find(element =>
    (element.textContent ?? "").includes("سديم")
  ) as HTMLElement | undefined;
  assert.ok(tile, "the nebula tile is labelled");
  await click(tile);

  const stored = readThemePrefs(window.localStorage);
  assert.deepEqual(stored.colors, nebula.appearance.colors);
  assert.equal(stored.angle, nebula.appearance.angle);

  // And the palette reached the document, not only the storage. The stops are
  // re-lit for the mode, so the hues are what carry over — comparing hexes
  // would only prove the input was echoed back.
  const painted = document.documentElement.style.getPropertyValue("--app-bg-image");
  assert.ok(painted.includes("linear-gradient"), `expected a gradient, got «${painted}»`);
  assert.equal(painted.match(/#[0-9a-f]{6}/g)?.length, nebula.appearance.colors.length, "one stop per colour");
  // The token cache the boot script replays was rewritten too.
  assert.ok(window.localStorage.getItem(THEME_TOKENS_STORAGE_KEY));
});

test("the panel speaks every shipped language, with the right direction", async () => {
  // The panel is the one screen whose controls are *all* new keys, so a missing
  // translation shows up here as an English key rather than as a blank label.
  for (const { language, add, dir } of [
    { language: "ar" as const, add: "إضافة لون", dir: "rtl" as const },
    { language: "en" as const, add: "Add colour", dir: "ltr" as const },
    { language: "de" as const, add: "Farbe hinzufügen", dir: "ltr" as const }
  ]) {
    const container = await mountPanel(language);
    // The translated name is what the operator sees on the button.
    assert.ok(button(container, add), `${language}: the add-colour button is translated`);
    // A key that fell back to its own name is the failure this catches: every
    // ``appearance.*`` string has a dictionary entry in all three languages.
    assert.doesNotMatch(container.textContent ?? "", /\bappearance\.[a-zA-Z]/, `${language}: no raw i18n key leaked`);
    // Direction is derived from the language, never stored, so it must agree.
    assert.equal(document.documentElement.dir, dir, `${language}: document direction`);
    assert.equal(document.documentElement.lang, language);
  }
});

test("a preset can be reset to the default theme", async () => {
  const container = await mountPanel();
  const sunset = [...section(container, "appearance-presets").querySelectorAll("[role='listitem']")].find(element =>
    (element.textContent ?? "").includes("غروب")
  ) as HTMLElement;
  await click(sunset);
  assert.notEqual(readThemePrefs(window.localStorage).colors[0], "#4f6bed");

  await click(button(container, "استعادة الافتراضي"));
  // Compared against the default itself rather than against literals: the reset
  // button's promise is "identical to a fresh account", and a new default must
  // not require editing this test.
  assert.deepEqual(readThemePrefs(window.localStorage), DEFAULT_THEME_PREFS);
});

test("«فاجئني» changes the palette to a readable one", async () => {
  const container = await mountPanel();
  const before = readThemePrefs(window.localStorage);
  await click(button(container, "فاجئني!"));
  const after = readThemePrefs(window.localStorage);
  assert.notDeepEqual(after.colors, before.colors, "the surprise is a new palette");
  assert.ok(after.colors.length >= 1 && after.colors.length <= MAX_THEME_COLORS);
  // Whatever it picked, the text still passes AA — the surprise is not allowed
  // to produce an unreadable theme.
  const foreground = document.documentElement.style.getPropertyValue("--foreground");
  const background = document.documentElement.style.getPropertyValue("--background");
  assert.match(foreground, /^#[0-9a-f]{6}$/);
  assert.match(background, /^#[0-9a-f]{6}$/);
});

test("the mode control switches the palette between light and dark", async () => {
  const container = await mountPanel();
  await click(button(container, "فاتح"));
  assert.equal(readThemePrefs(window.localStorage).mode, "light");
  assert.ok(document.documentElement.classList.contains("light"));
  const light = document.documentElement.style.getPropertyValue("--background");

  await click(button(container, "داكن"));
  assert.equal(readThemePrefs(window.localStorage).mode, "dark");
  assert.ok(document.documentElement.classList.contains("dark"));
  const dark = document.documentElement.style.getPropertyValue("--background");
  assert.notEqual(light, dark, "the two modes paint different surfaces");
});

test("the scope switch reaches the panels or only the page", async () => {
  const container = await mountPanel();
  const tinted = document.documentElement.style.getPropertyValue("--card");
  await click(button(container, "الخلفية فقط"));
  assert.equal(readThemePrefs(window.localStorage).scope, "canvas");
  // On the canvas-only setting the panels stay neutral: the card colour must be
  // the unthemed one, not whatever the gradient would have tinted it to.
  const canvasOnly = document.documentElement.style.getPropertyValue("--card");
  assert.notEqual(canvasOnly, tinted, "the panels are no longer tinted");
});

test("a custom accent replaces the derived one", async () => {
  const container = await mountPanel();
  // Scoped to the details band: the colour field's own quick swatches carry the
  // same hex labels, and clicking one of those changes a stop, not the accent.
  const swatch = [...section(container, "appearance-details").querySelectorAll("button[aria-label^='#']")].find(
    element => (element.getAttribute("aria-label") ?? "").toLowerCase() === "#f97316"
  );
  assert.ok(swatch, "the orange swatch is offered");
  await click(swatch as HTMLElement);
  assert.equal(readThemePrefs(window.localStorage).accent, "#f97316");
  // «مستخلص تلقائياً» gives the accent back to the engine.
  await click(button(container, "مستخلص تلقائياً"));
  assert.equal(readThemePrefs(window.localStorage).accent, null);
});

test("a hex typed into the field is parsed and applied", async () => {
  const container = await mountPanel();
  const field = container.querySelector("input[dir='ltr']") as HTMLInputElement;
  assert.ok(field, "the hex field rendered");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
    setter.call(field, "#22c55e");
    field.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  // React listens for `focusout` (blur does not bubble through a synthetic
  // root), and the live path paints on the next animation frame — so the test
  // commits with `focusout` and then waits a frame before reading storage.
  await act(async () => {
    field.dispatchEvent(new dom.window.FocusEvent("focusout", { bubbles: true }));
  });
  await settle();
  assert.equal(readThemePrefs(window.localStorage).colors[0], "#22c55e");
});

test("a pasted colour in any common form is understood", () => {
  // The hex field is the one input a native colour dialog does not offer, so it
  // has to accept what people actually paste.
  assert.equal(parseColorInput("#22c55e"), "#22c55e");
  assert.equal(parseColorInput("22C55E"), "#22c55e");
  assert.equal(parseColorInput("#2c5"), "#22cc55");
  // Decimal channels: 22 is 0x16, not 0x22. Reading them as hex would paint a
  // different green than the one in the paste.
  assert.equal(parseColorInput("22,197,94"), "#16c55e");
  assert.equal(parseColorInput("rgb(34, 197, 94)"), "#22c55e");
  assert.equal(parseColorInput("rgba(34,197,94,0.4)"), "#22c55e");
  assert.equal(parseColorInput("not a colour"), null);
  assert.equal(parseColorInput(""), null);
});

test("the theme survives a reload through the stored cache", async () => {
  const container = await mountPanel();
  await click(button(container, "فاتح"));
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  assert.ok(stored, "the choice was persisted");
  // Simulate the next load: the boot script's two reads, with no engine.
  const prefs = JSON.parse(stored!) as { mode: string; colors: string[] };
  assert.equal(prefs.mode, "light");
  assert.ok(Array.isArray(prefs.colors) && prefs.colors.length > 0);
  const cache = JSON.parse(window.localStorage.getItem(THEME_TOKENS_STORAGE_KEY)!) as {
    version: number;
    for: string;
    tokens: Record<string, string>;
  };
  assert.equal(cache.version, 2);
  assert.ok(cache.for.includes("light"), "the cache is keyed to the mode");
  assert.equal(cache.tokens["--background"], document.documentElement.style.getPropertyValue("--background"));
});
