import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertControlPlane,
  loadControlPlane,
  CONTROL_PLANE_SCHEMA_VERSION,
  type ControlPlane
} from "../src/config/control-plane.ts";

const BOT_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

/**
 * GOVERNANCE rule 15 — the file is the authority, so a file that has drifted
 * must not reach the runtime.
 *
 * Every test below drifts exactly one thing in a copy of the shipped file. The
 * first one is the defect that motivated the whole file: `readJson` casts
 * without looking, so deleting `gateway.ceilingPerMinute` used to leave
 * `undecidedSettings()` empty, leave the field `undefined`, and let
 * `EventPipeline` throttle at its own constant of 120 — a rate ceiling the
 * config never stated, with nothing printed and nothing logged.
 */

/** The shipped file, validated on load, as a mutable copy. */
const settled = (): ControlPlane => structuredClone(loadControlPlane());

/** Drift a key that TypeScript believes is required — the shape a hand-edited file takes. */
const drift = (plane: ControlPlane, section: string, key: string, value?: unknown) => {
  const owner = (plane as unknown as Record<string, Record<string, unknown>>)[section];
  if (value === undefined) delete owner[key];
  else owner[key] = value;
};

test("the shipped control plane satisfies its own contract", () => {
  assert.equal(assertControlPlane(loadControlPlane()), true);
});

test("a deleted gateway ceiling is rejected instead of silently becoming 120", () => {
  const plane = settled();
  drift(plane, "gateway", "ceilingPerMinute");
  assert.throws(
    () => assertControlPlane(plane),
    /gateway\.ceilingPerMinute must be a whole number of at least 1 \(got undefined\)/
  );
});

test("a deleted voice debounce is rejected", () => {
  const plane = settled();
  drift(plane, "gateway", "voiceDebounceMs");
  assert.throws(() => assertControlPlane(plane), /gateway\.voiceDebounceMs must be a whole number of at least 0/);
});

test("a whole missing section is reported once, by name", () => {
  const plane = settled();
  delete (plane as unknown as Record<string, unknown>).gateway;
  assert.throws(() => assertControlPlane(plane), /gateway must be an object \(got undefined\)/);
});

test("a section of the wrong type is rejected", () => {
  const plane = settled();
  (plane as unknown as Record<string, unknown>).retention = "90 days";
  assert.throws(() => assertControlPlane(plane), /retention must be an object/);
});

test("a ceiling that is a string is rejected", () => {
  const plane = settled();
  drift(plane, "gateway", "ceilingPerMinute", "120");
  assert.throws(() => assertControlPlane(plane), /gateway\.ceilingPerMinute must be a whole number/);
});

test("a non-positive ceiling and a negative debounce are rejected", () => {
  const zero = settled();
  zero.gateway.ceilingPerMinute = 0;
  assert.throws(() => assertControlPlane(zero), /gateway\.ceilingPerMinute must be a whole number of at least 1/);

  const negative = settled();
  negative.gateway.voiceDebounceMs = -1;
  assert.throws(() => assertControlPlane(negative), /gateway\.voiceDebounceMs must be a whole number of at least 0/);
});

test("an empty source layer is rejected", () => {
  const plane = settled();
  plane.instance.sourceLayer = "   ";
  assert.throws(() => assertControlPlane(plane), /instance\.sourceLayer must be a non-empty string/);
});

test("an intent limit that is not a number is rejected", () => {
  const plane = settled();
  drift(plane, "intents", "limit");
  assert.throws(() => assertControlPlane(plane), /intents\.limit must be a whole number of at least 1/);
});

test("a renewal date that does not parse is rejected", () => {
  // Left unchecked this is silent: `renewalDueAt()` returns null for an
  // unparseable date, so the yearly renewal alert never fires at all.
  const plane = settled();
  plane.intents.renewedAt = "not-a-date";
  assert.throws(() => assertControlPlane(plane), /intents\.renewedAt must be an ISO date or null/);
});

test("an undecided value is a decision, not a malformed file", () => {
  // The boundary the validator must not cross: `null` is how the owner records
  // "not decided yet". `undecidedSettings` reports it and a production boot
  // refuses to start on it — the shape check must let it through.
  const plane = settled();
  plane.intents.renewedAt = null;
  plane.retention.auditDays = null;
  plane.retention.logDays = null;
  plane.encryption.keyRotationDays = null;
  assert.equal(assertControlPlane(plane), true);
});

test("a retention window of the wrong type is rejected even though null is allowed", () => {
  const plane = settled();
  drift(plane, "retention", "auditDays", "90");
  assert.throws(() => assertControlPlane(plane), /retention\.auditDays must be a positive whole number of days or null/);
});

test("a control plane written for another schema version is rejected", () => {
  const plane = settled();
  plane.schemaVersion = CONTROL_PLANE_SCHEMA_VERSION + 1;
  assert.throws(() => assertControlPlane(plane), /schemaVersion must be 1 \(got 2\)/);
});

/* ------------------------------------------------------------------ *
 * Reading the file — a failure must name the file it came from.
 * ------------------------------------------------------------------ */

test("a malformed config file names itself instead of throwing a bare SyntaxError", () => {
  const dir = mkdtempSync(join(tmpdir(), "al-ai-config-"));
  writeFileSync(join(dir, "control-plane.json"), '{ "schemaVersion": 1, }', "utf8");
  assert.throws(() => loadControlPlane(dir), /config\/control-plane\.json is not valid JSON/);
});

test("a missing config file names itself", () => {
  const dir = mkdtempSync(join(tmpdir(), "al-ai-config-"));
  assert.throws(() => loadControlPlane(dir), /config\/control-plane\.json could not be read/);
});

/* ------------------------------------------------------------------ *
 * The boot wires the validator, and takes the source layer from the file.
 * ------------------------------------------------------------------ */

test("the boot validates the control plane before it contacts Discord", () => {
  const index = readFileSync(join(BOT_ROOT, "src", "index.ts"), "utf8");
  assert.match(
    index,
    /assertChannelsMatchSchema\(\);\s*controlPlane = loadControlPlane\(\);/,
    "both config reads sit inside the same guard"
  );
  assert.match(index, /AL AI configuration is invalid/, "the guard reports which config is broken");
});

test("the runtime takes its source layer from the control plane, not from a constant", () => {
  // Until this was fixed `index.ts` held `const SOURCE_LAYER = "bot-runtime"` —
  // the same string `instance.sourceLayer` declares, so editing the config
  // changed nothing. Rule 15 forbids exactly that second copy.
  const index = readFileSync(join(BOT_ROOT, "src", "index.ts"), "utf8");
  assert.equal(/SOURCE_LAYER/.test(index), false, "no local copy of the layer name survives");
  assert.match(index, /sourceLayer: controlPlane\.instance\.sourceLayer/, "the layer comes from config/");
});
