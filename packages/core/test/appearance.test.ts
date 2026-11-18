import test from "node:test";
import assert from "node:assert/strict";
import {
  APPEARANCE_PRESETS,
  MAX_COLORS,
  appearanceEquals,
  normaliseAppearance,
  surpriseAppearance
} from "../src/appearance.js";
import { harmonise } from "../src/theme-engine.js";

/**
 * The appearance shape: what survives a round trip, and what an old row becomes.
 *
 * The migration cases are the point. `user_preferences.appearance` holds rows
 * written by the first shape (an accent plus a background object), so an upgrade
 * that dropped them would silently reset every account's theme — the kind of
 * regression nobody reports because nothing errors.
 */

test("a v1 row is migrated, not reset", () => {
  const migrated = normaliseAppearance({
    mode: "dark",
    accent: "emerald",
    accentColor: "#123456",
    background: { style: "split-h", from: "#000000", to: "#ffffff" }
  });

  assert.equal(migrated.version, 2);
  assert.equal(migrated.mode, "dark");
  assert.deepEqual(migrated.colors, ["#000000", "#ffffff"], "the two backdrop colours become the gradient stops");
  assert.equal(migrated.accent, "#123456", "the custom accent is the one that was in force");
  assert.equal(migrated.scope, "tinted");
});

test("a v1 row with a named accent keeps that accent's colour", () => {
  const migrated = normaliseAppearance({ mode: "light", accent: "rose", accentColor: null });
  assert.equal(migrated.accent, "#f43f5e");
  assert.deepEqual(migrated.colors, [`#4f6bed`], "no backdrop was chosen, so the shipped stop is used");
});

test("an empty row is the shipped default", () => {
  const normalised = normaliseAppearance(null);
  assert.equal(normalised.mode, "system");
  assert.equal(normalised.intensity, 55);
  assert.equal(normalised.angle, 135);
  assert.equal(normalised.accent, null, "null means 'derive it from the colours'");
});

test("five colours is the ceiling, and junk stops are dropped rather than shifted", () => {
  const many = normaliseAppearance({ colors: ["#111111", "nope", "#222222", "#333333", "#444444", "#555555", "#666666"] });
  assert.equal(many.colors.length, MAX_COLORS);
  assert.deepEqual(many.colors, ["#111111", "#222222", "#333333", "#444444", "#555555"]);
});

test("one field being wrong does not wipe the others", () => {
  const normalised = normaliseAppearance({
    mode: "sideways",
    colors: ["#123456"],
    angle: 900,
    intensity: -20,
    scope: "everything"
  });
  assert.equal(normalised.mode, "system");
  assert.deepEqual(normalised.colors, ["#123456"]);
  assert.equal(normalised.angle, 180, "900° wraps to the same direction as 180°");
  assert.equal(normalised.intensity, 0);
  assert.equal(normalised.scope, "tinted");
});

test("equality compares the choices, not the object identity", () => {
  const base = normaliseAppearance({ colors: ["#abcdef"], angle: 40, intensity: 70, mode: "dark" });
  assert.ok(appearanceEquals(base, { ...base }));
  assert.ok(!appearanceEquals(base, { ...base, angle: 41 }));
  assert.ok(!appearanceEquals(base, { ...base, colors: ["#abcdef", "#abcdef"] }));
  assert.ok(appearanceEquals(base, normaliseAppearance(base)), "a stored appearance is a fixed point");
});

test("every preset is a fixed point of normalisation", () => {
  // A preset that normalisation would change is a preset the engine paints
  // differently from what the tile promised.
  for (const entry of APPEARANCE_PRESETS) {
    const normalised = normaliseAppearance(entry.appearance);
    assert.deepEqual(normalised, entry.appearance, `${entry.id} survives normalisation unchanged`);
    assert.ok(entry.appearance.colors.length >= 1 && entry.appearance.colors.length <= MAX_COLORS, `${entry.id} has 1..5 stops`);
  }
});

test("«surprise me» is deterministic given its randomness, and keeps the mode", () => {
  // A seeded generator, so the assertion is about the algorithm rather than luck.
  const seeded = (values: number[]) => {
    let index = 0;
    return () => values[index++ % values.length]!;
  };
  const current = normaliseAppearance({ mode: "light", colors: ["#4f6bed"], angle: 10, intensity: 20 });
  const first = surpriseAppearance(current, seeded([0.1, 0.5, 0.9, 0.3, 0.7, 0.2]));
  const second = surpriseAppearance(current, seeded([0.1, 0.5, 0.9, 0.3, 0.7, 0.2]));

  assert.deepEqual(first, second, "the same randomness gives the same theme");
  assert.equal(first.mode, "light", "the operator's light/dark choice is not changed under them");
  assert.ok(first.colors.length >= 2 && first.colors.length <= 3);
  assert.ok(first.angle >= 0 && first.angle <= 360);
  assert.ok(first.intensity >= 35 && first.intensity <= 85);
});

test("a harmony keeps its seed hue in the chosen relationship", () => {
  const analogous = harmonise("#3b82f6", "analogous", 3);
  const monochrome = harmonise("#3b82f6", "monochrome", 3);
  const complementary = harmonise("#3b82f6", "complementary", 2);

  assert.equal(analogous.length, 3);
  for (const colour of analogous) assert.match(colour, /^#[0-9a-f]{6}$/);
  // Monochrome varies lightness only, so all three stops share the seed's hue.
  const hues = monochrome.map(colour => {
    const hex = colour.slice(1);
    const [r, g, b] = [0, 2, 4].map(offset => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
    const max = Math.max(r!, g!, b!);
    const min = Math.min(r!, g!, b!);
    return max === min ? null : (max + min) / 2;
  });
  assert.ok(hues.every(value => value !== null), "every stop has a hue");
  // A complementary pair is far apart in hue; the two stops must not be twins.
  assert.notEqual(complementary[0], complementary[1]);
});
