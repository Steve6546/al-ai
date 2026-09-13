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
  // One fewer than the schema declares: the internal `bot-log` falls off the end.
  const drifted = { ...declaration, destinations: declaration.destinations.slice(0, -1) };
  assert.throws(() => assertChannelsMatchSchema(drifted), /does not declare the destinations exactly/);
});

test("the four operational settings are settled, not left null", () => {
  assert.deepEqual(undecidedSettings(), []);
});

test("the guard still reports a value that is left undecided", () => {
  // The real file is settled, so the mechanism is exercised with a synthetic
  // plane: a future field added as `null` must still be reported.
  const plane = loadControlPlane();
  const undecided = undecidedSettings({
    ...plane,
    retention: { ...plane.retention, logDays: null }
  });
  assert.deepEqual(undecided, ["retention.logDays"]);
});

test("the settled retention and rotation values are usable numbers", () => {
  const plane = loadControlPlane();
  for (const [label, value] of [
    ["retention.auditDays", plane.retention.auditDays],
    ["retention.logDays", plane.retention.logDays],
    ["encryption.keyRotationDays", plane.encryption.keyRotationDays]
  ] as const) {
    assert.equal(typeof value, "number", `${label} is a number`);
    assert.ok(Number.isInteger(value) && (value as number) > 0, `${label} is a positive whole number of days`);
    assert.ok((value as number) <= 3_650, `${label} is a sane window, not a placeholder`);
  }
});

test("the intent renewal date parses and its due date lands a year out", () => {
  const plane = loadControlPlane();
  assert.ok(plane.intents.renewedAt, "renewedAt is set");
  const renewedAt = new Date(plane.intents.renewedAt).getTime();
  assert.ok(!Number.isNaN(renewedAt), "renewedAt parses as a date");
  assert.ok(renewedAt <= Date.now(), "the renewal happened, it is not scheduled in the future");

  const tracker = createIntentUsageTracker({ renewedAt: plane.intents.renewedAt });
  assert.equal(tracker.stats().renewalDue, false, "a freshly renewed instance is not already overdue");
  const days = tracker.stats().daysUntilRenewal;
  assert.ok(days !== null && days > 300 && days <= plane.intents.renewalDays, "roughly a year remains");
});

test("each settled section documents the decision behind its value", () => {
  const plane = loadControlPlane() as unknown as Record<string, { _note?: string; _todo?: string }>;
  for (const section of ["intents", "retention", "encryption"]) {
    assert.match(plane[section]._note ?? "", /\S/, `${section} explains the value it settled on`);
    assert.equal(plane[section]._todo, undefined, `${section} is no longer waiting on the owner`);
  }
});

test("the one genuinely undecided section still carries an owner-decision TODO", () => {
  const plane = loadControlPlane() as unknown as Record<string, { _todo?: string }>;
  assert.match(plane.commands._todo ?? "", /يحتاج قرار صريح من المالك/);
});

test("the control plane carries the directive's gateway limits", () => {
  const plane = loadControlPlane();
  assert.equal(plane.gateway.ceilingPerMinute, 120);
  assert.equal(plane.gateway.voiceDebounceMs, 2_000);
  assert.equal(plane.intents.limit, 10_000);
  assert.equal(plane.intents.warnAt, 8_000);
  assert.equal(plane.commands.deployment, "manual");
});
