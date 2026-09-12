import test from "node:test";
import assert from "node:assert/strict";
import { INTENT_HARD_LIMIT, INTENT_RENEWAL_DAYS, INTENT_WARNING_THRESHOLD, createIntentUsageTracker } from "../src/compliance/intent-usage-tracker.ts";
import { assertChannelsMatchSchema, loadChannelDeclaration, loadControlPlane, undecidedSettings } from "../src/config/control-plane.ts";

/* ------------------------------------------------------------------ *
 * Intent budget — GOVERNANCE rule 14
 * ------------------------------------------------------------------ */

test("the thresholds match the directive", () => {
  assert.equal(INTENT_WARNING_THRESHOLD, 8_000);
  assert.equal(INTENT_HARD_LIMIT, 10_000);
  assert.equal(INTENT_RENEWAL_DAYS, 365);
});

test("the tracker counts unique users, not membership rows", () => {
  const tracker = createIntentUsageTracker();
  tracker.observe(["u1", "u2", "u3"]);
  tracker.observe(["u2", "u3", "u4"]);
  assert.equal(tracker.size(), 4, "someone in two servers is counted once");
});

test("the state stays ok below the warning threshold", () => {
  const tracker = createIntentUsageTracker();
  tracker.observe(Array.from({ length: 7_999 }, (_, index) => `u${index}`));
  assert.equal(tracker.stats().state, "ok");
});

test("the state warns at exactly 8000 unique users", () => {
  const tracker = createIntentUsageTracker();
  tracker.observe(Array.from({ length: 8_000 }, (_, index) => `u${index}`));
  const stats = tracker.stats();
  assert.equal(stats.state, "warning");
  assert.equal(stats.uniqueUsers, 8_000);
  assert.match(tracker.describe(), /اقتراب من الحد/);
});

test("the state is over_limit at the 10000 ceiling", () => {
  const tracker = createIntentUsageTracker();
  tracker.observe(Array.from({ length: 10_000 }, (_, index) => `u${index}`));
  assert.equal(tracker.stats().state, "over_limit");
  assert.match(tracker.describe(), /تجاوز حد المستخدمين/);
});

test("yearly renewal is tracked and flagged when it lapses", () => {
  const renewed = new Date("2026-01-01T00:00:00.000Z");
  const beforeDue = createIntentUsageTracker({
    now: () => renewed.getTime() + 100 * 24 * 60 * 60 * 1000,
    renewedAt: renewed.toISOString()
  });
  assert.equal(beforeDue.stats().renewalDue, false);

  const afterDue = createIntentUsageTracker({
    now: () => renewed.getTime() + 400 * 24 * 60 * 60 * 1000,
    renewedAt: renewed.toISOString()
  });
  const stats = afterDue.stats();
  assert.equal(stats.renewalDue, true);
  assert.ok(stats.daysUntilRenewal !== null && stats.daysUntilRenewal < 0);
  assert.match(afterDue.describe(), /تجديد/);
});

test("a tracker with no renewal date does not claim compliance", () => {
  const tracker = createIntentUsageTracker({ renewedAt: null });
  assert.equal(tracker.stats().renewalDueAt, null);
  assert.equal(tracker.stats().renewalDue, false);
});

/* ------------------------------------------------------------------ *
 * Config contract — GOVERNANCE rule 15
 * ------------------------------------------------------------------ */

test("config/channels.json matches the compiled event schema exactly", () => {
  assert.equal(assertChannelsMatchSchema(), true);
});

test("a drifted channels.json is rejected rather than silently accepted", () => {
  const declaration = loadChannelDeclaration();
  const drifted = {
    ...declaration,
    destinations: declaration.destinations.map(destination =>
      destination.id === "voice-log" ? { ...destination, subCategories: ["voice.join"] } : destination
    )
  };
  assert.throws(() => assertChannelsMatchSchema(drifted), /out of sync for voice-log/);
});

test("a channels.json that drops a destination is rejected", () => {
  const declaration = loadChannelDeclaration();
  const drifted = { ...declaration, destinations: declaration.destinations.slice(0, 6) };
  assert.throws(() => assertChannelsMatchSchema(drifted), /seven destinations/);
});

test("undecided settings are reported instead of being invented", () => {
  const undecided = undecidedSettings();
  assert.deepEqual(undecided.sort(), [
    "encryption.keyRotationDays",
    "intents.renewedAt",
    "retention.auditDays",
    "retention.logDays"
  ]);
});

test("the control plane carries the directive's gateway limits", () => {
  const plane = loadControlPlane();
  assert.equal(plane.gateway.ceilingPerMinute, 120);
  assert.equal(plane.gateway.voiceDebounceMs, 2_000);
  assert.equal(plane.intents.limit, 10_000);
  assert.equal(plane.intents.warnAt, 8_000);
  assert.equal(plane.commands.deployment, "manual");
});

test("every undecided value carries an explicit owner-decision TODO", () => {
  const plane = loadControlPlane() as unknown as Record<string, { _todo?: string }>;
  for (const section of ["intents", "retention", "encryption", "commands"]) {
    assert.match(plane[section]._todo ?? "", /يحتاج قرار صريح من المالك/, `${section} documents that the owner must decide`);
  }
});
