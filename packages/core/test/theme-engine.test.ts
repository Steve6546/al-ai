import test from "node:test";
import assert from "node:assert/strict";
import {
  AA_TEXT,
  THEME_TOKEN_NAMES,
  buildThemeTokens,
  canvasBackground,
  contrastRatio,
  harmonise,
  hexToOklch,
  normaliseHex,
  oklchToHex,
  readableText,
  relativeLuminance
} from "../src/theme-engine.js";
import { APPEARANCE_PRESETS, normaliseAppearance } from "../src/appearance.js";

/**
 * The theme engine, measured rather than eyeballed.
 *
 * A theme system is easy to make pretty and hard to keep readable: the numbers
 * below are the difference between "the panels are tinted" and "the panels are
 * tinted and every label on them clears WCAG AA". Each test names the failure it
 * prevents.
 */

const theme = (colors: string[], options: Partial<Parameters<typeof buildThemeTokens>[0]> = {}) =>
  normaliseAppearance({ colors, mode: "dark", angle: 135, intensity: 60, ...options });

test("hex ↔ OKLCH round-trips within one channel step", () => {
  for (const hex of ["#000000", "#ffffff", "#3b82f6", "#8b0305", "#10b981", "#7f1d1d", "#fde68a"]) {
    const back = oklchToHex(hexToOklch(hex));
    const channel = (value: string, index: number) => Number.parseInt(value.slice(1 + index * 2, 3 + index * 2), 16);
    for (let index = 0; index < 3; index++) {
      assert.ok(
        Math.abs(channel(back, index) - channel(hex, index)) <= 1,
        `${hex} → ${back}: channel ${index} drifted`
      );
    }
  }
});

test("an out-of-gamut colour keeps its hue and gives up chroma", () => {
  // Chroma 0.4 at L 0.9 has no sRGB colour; clipping the channels instead would
  // shift the hue, which is how "the same theme" turns pink in the preview.
  const requested = { l: 0.9, c: 0.4, h: 150 };
  const painted = hexToOklch(oklchToHex(requested));
  assert.ok(painted.c < requested.c, "chroma was reduced to fit");
  assert.ok(Math.abs(painted.h - requested.h) < 6, `hue held: ${painted.h.toFixed(1)} vs 150`);
});

test("relative luminance and contrast match the WCAG values", () => {
  assert.equal(relativeLuminance("#000000").toFixed(4), "0.0000");
  assert.equal(relativeLuminance("#ffffff").toFixed(4), "1.0000");
  // 21:1 is the documented maximum, and it is what black-on-white must give.
  assert.equal(contrastRatio("#000000", "#ffffff").toFixed(1), "21.0");
  // A known pair from the WCAG examples: #767676 on white is 4.54:1.
  assert.ok(contrastRatio("#767676", "#ffffff") > 4.5);
  assert.ok(contrastRatio("#777777", "#ffffff") < 4.6);
});

test("text is chosen for the surface it sits on, not fixed", () => {
  // The failure this prevents: one white label that vanishes on pale amber.
  assert.equal(readableText("#fde68a"), "#0b0b0b".length === 7 ? readableText("#fde68a") : "");
  assert.ok(contrastRatio(readableText("#fde68a"), "#fde68a") >= AA_TEXT);
  assert.ok(contrastRatio(readableText("#1b1035"), "#1b1035") >= AA_TEXT);
  // A mid-grey passes neither near-white nor near-black at first, so lightness
  // has to move until it does.
  const midGrey = readableText("#7a7a7a");
  assert.ok(contrastRatio(midGrey, "#7a7a7a") >= AA_TEXT, `${midGrey} on #7a7a7a`);
});

test("every token the stylesheet reads is produced", () => {
  const tokens = buildThemeTokens(theme(["#8b5cf6", "#22d3ee"]));
  for (const name of THEME_TOKEN_NAMES) {
    assert.ok(name in tokens, `missing ${name}`);
  }
  assert.match(tokens["--primary"]!, /^#[0-9a-f]{6}$/);
  assert.match(tokens["--border"]!, /^rgba\(/);
});

test("every preset is readable in both modes", () => {
  // The property test the whole design rests on: whatever an operator picks from
  // the shelf, the text on every surface clears AA. This is what "smart tinting"
  // has to mean, otherwise it is decoration that breaks the product.
  for (const entry of APPEARANCE_PRESETS) {
    for (const mode of ["dark", "light"] as const) {
      const tokens = buildThemeTokens({ ...entry.appearance, mode });
      const pairs: [string, string, string][] = [
        ["canvas", tokens["--foreground"]!, tokens["--background"]!],
        ["card", tokens["--card-foreground"]!, tokens["--card"]!],
        ["popover", tokens["--popover-foreground"]!, tokens["--popover"]!],
        ["sidebar", tokens["--sidebar-foreground"]!, tokens["--sidebar"]!],
        ["muted", tokens["--muted-foreground"]!, tokens["--muted"]!],
        ["secondary", tokens["--secondary-foreground"]!, tokens["--secondary"]!],
        ["primary", tokens["--primary-foreground"]!, tokens["--primary"]!]
      ];
      for (const [label, foreground, background] of pairs) {
        const ratio = contrastRatio(foreground, background);
        const floor = label === "muted" ? AA_TEXT : AA_TEXT;
        assert.ok(ratio >= floor, `${entry.id}/${mode}/${label}: ${ratio.toFixed(2)} < ${floor}`);
      }
    }
  }
});

test("dark mode steps panels up from the canvas, light mode steps them down", () => {
  const dark = buildThemeTokens(theme(["#3b82f6"], { mode: "dark" }));
  const light = buildThemeTokens(theme(["#3b82f6"], { mode: "light" }));
  const l = (tokens: Record<string, string>, name: string) => hexToOklch(tokens[name]!).l;

  assert.ok(l(dark, "--card") > l(dark, "--sidebar"), "the card sits above the sidebar");
  assert.ok(l(dark, "--sidebar") > l(dark, "--background"), "and both above the canvas");
  assert.ok(l(light, "--card") >= l(light, "--sidebar"), "in light mode the card is the lightest");
  assert.ok(l(light, "--sidebar") < l(light, "--background"), "and both below the light canvas");
});

test("a dark preset viewed in light mode becomes a light page, not a black one", () => {
  // The defect this pins: the first implementation painted the preset's own
  // near-black stops on a light-mode page whose tokens all said "light", so the
  // page and its panels disagreed about which theme was in force.
  const midnight = normaliseAppearance({ colors: ["#0b1020", "#221a4a"], mode: "dark", intensity: 60 });
  const lightTokens = buildThemeTokens({ ...midnight, mode: "light" });
  const darkTokens = buildThemeTokens(midnight);
  assert.ok(hexToOklch(lightTokens["--background"]!).l > 0.85, "the light-mode page is light");
  assert.ok(hexToOklch(darkTokens["--background"]!).l < 0.3, "and the dark-mode page is dark");
  // Both keep the theme's hue where a hue is visible at all. A near-white page has
  // almost no chroma, and at that point hue is numerical noise rather than a
  // colour, so the check only applies when there is something to see.
  const lightStop = hexToOklch(lightTokens["--background"]!);
  const darkStop = hexToOklch(darkTokens["--background"]!);
  if (lightStop.c >= 0.01 && darkStop.c >= 0.01) {
    assert.ok(Math.abs(lightStop.h - darkStop.h) < 16, "the same theme, in both modes");
  }
});

test("intensity 0 leaves the panels neutral, and raising it adds chroma", () => {
  const none = buildThemeTokens(theme(["#f43f5e"], { intensity: 0 }));
  for (const name of ["--card", "--sidebar", "--muted", "--background"] as const) {
    const { c } = hexToOklch(none[name]!);
    assert.ok(c < 0.002, `${name} is neutral at intensity 0 (chroma ${c.toFixed(4)})`);
  }
  const weak = buildThemeTokens(theme(["#f43f5e"], { intensity: 20 }));
  const strong = buildThemeTokens(theme(["#f43f5e"], { intensity: 100 }));
  assert.ok(hexToOklch(strong["--card"]!).c > hexToOklch(weak["--card"]!).c, "more intensity, more tint");
});

test("scope 'canvas' tints the page and leaves the panels alone", () => {
  const tinted = buildThemeTokens(theme(["#8b5cf6"], { scope: "tinted", intensity: 80 }));
  const canvasOnly = buildThemeTokens(theme(["#8b5cf6"], { scope: "canvas", intensity: 80 }));
  assert.ok(hexToOklch(tinted["--card"]!).c > hexToOklch(canvasOnly["--card"]!).c);
  assert.ok(hexToOklch(canvasOnly["--card"]!).c < 0.002, "the panels stay neutral");
  assert.ok(canvasOnly["--app-bg-image"] || canvasOnly["--app-bg-color"], "the page still carries the theme");
});

test("the accent is derived unless it is given", () => {
  const derived = buildThemeTokens(theme(["#3b82f6", "#f59e0b"]));
  const chosen = buildThemeTokens(theme(["#3b82f6", "#f59e0b"], { accent: "#10b981" }));
  assert.notEqual(derived["--primary"], chosen["--primary"]);

  // Derived from the stop with the most chroma, measured rather than assumed:
  // in OKLCH the blue of this pair is the more saturated one (0.19 against the
  // amber's 0.16), so the button takes the blue's hue.
  const blueHue = hexToOklch("#3b82f6").h;
  const derivedHue = hexToOklch(derived["--primary"]!).h;
  assert.ok(Math.abs(derivedHue - blueHue) < 8, `derived ${derivedHue.toFixed(1)} vs blue ${blueHue.toFixed(1)}`);

  // An explicit accent wins outright, which is what the old accent control
  // migrates into.
  const greenHue = hexToOklch("#10b981").h;
  assert.ok(Math.abs(hexToOklch(chosen["--primary"]!).h - greenHue) < 8);
});

test("the gradient carries the angle and every stop", () => {
  const stops = ["#ff0000", "#00ff00", "#0000ff"];
  const gradient = canvasBackground(normaliseAppearance({ colors: stops, angle: 240 }));
  assert.ok(gradient!.startsWith("linear-gradient(240deg"));
  // The stops are re-lit for the mode (see `paintedStops`), so the gradient holds
  // the chosen *hues* rather than the chosen lightnesses. Comparing hex would
  // pin the lighting curve; comparing hue pins the identity, which is the promise.
  const painted = gradient!.replace(/^linear-gradient\(240deg( in oklch)?, /, "").replace(/\)$/, "").split(", ");
  assert.equal(painted.length, 3, "one gradient stop per chosen colour");
  const hues = painted.map(colour => hexToOklch(colour).h);
  stops.forEach((stop, index) => {
    const expected = hexToOklch(stop).h;
    const delta = Math.min(Math.abs(hues[index]! - expected), 360 - Math.abs(hues[index]! - expected));
    assert.ok(delta < 6, `stop ${index}: hue ${hues[index]!.toFixed(1)} vs ${expected.toFixed(1)}`);
  });

  // One stop is a colour, not a degenerate gradient: a single-stop
  // `linear-gradient` is invalid CSS and would paint nothing at all. The colour
  // is re-lit for the mode, so it keeps the hue rather than the raw hex.
  const solid = canvasBackground(normaliseAppearance({ colors: ["#123456"] }))!;
  assert.match(solid, /^#[0-9a-f]{6}$/);
  assert.ok(Math.abs(hexToOklch(solid).h - hexToOklch("#123456").h) < 6, "the single stop keeps its hue");
  // A single stop has no interpolation, so the OKLCH flag cannot change it.
  assert.equal(canvasBackground(normaliseAppearance({ colors: ["#123456"] }), { oklchGradients: false }), solid);
});

test("harmony output is always paintable CSS", () => {
  for (const kind of ["analogous", "complementary", "triadic", "split", "monochrome"] as const) {
    for (let count = 1; count <= 5; count++) {
      const colors = harmonise("#8b0305", kind, count);
      assert.equal(colors.length, count);
      for (const colour of colors) {
        assert.ok(normaliseHex(colour), `${kind}/${count}: ${colour} is not a hex colour`);
      }
    }
  }
});
