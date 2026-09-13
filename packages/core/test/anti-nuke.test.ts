import test from "node:test";
import assert from "node:assert/strict";
import {
  ANTI_NUKE_ACTIONS,
  ANTI_NUKE_LIMIT_KEYS,
  assessNukeAction,
  DEFAULT_ANTI_NUKE_CONFIG,
  DEFAULT_ANTI_NUKE_LIMITS,
  MAX_ANTI_NUKE_LIMIT,
  normaliseAntiNukeConfig
} from "../src/anti-nuke.js";

/**
 * Anti-nuke configuration and the trip decision.
 *
 * The engine strips a moderator's roles when it fires, so both halves of this
 * file are safety-critical in opposite directions: a limit that is too eager
 * punishes innocent staff, and one that cannot be reached is a guard that looks
 * armed and is not.
 */

const limits = { channelDeletesPerMinute: 3, bansPerMinute: 5, roleChangesPerMinute: 2 };

/* ------------------------------------------------------------------ *
 * The trip decision
 * ------------------------------------------------------------------ */

test("every watched action has a limit", () => {
  for (const action of ANTI_NUKE_ACTIONS) {
    assert.ok(ANTI_NUKE_LIMIT_KEYS[action], `${action} must map to a limit key`);
    assert.equal(typeof limits[ANTI_NUKE_LIMIT_KEYS[action]], "number");
  }
});

test("the limit is inclusive: reaching it is still allowed", () => {
  // A limit of 3 means three deletions are permitted. Tripping *at* the limit
  // would punish exactly the behaviour the operator said was fine.
  const verdict = assessNukeAction("channel-delete", 3, limits);
  assert.equal(verdict.tripped, false);
  assert.equal(verdict.limit, 3);
});

test("crossing the limit by one trips it", () => {
  assert.equal(assessNukeAction("channel-delete", 4, limits).tripped, true);
});

test("a single action never trips a sane limit", () => {
  for (const action of ANTI_NUKE_ACTIONS) {
    assert.equal(assessNukeAction(action, 1, limits).tripped, false, `${action} tripped on one action`);
  }
});

test("each action is measured against its own limit", () => {
  // Five bans is at the ban limit; five channel deletions is well past it. The
  // two must not share a budget, or a ban wave would look like a channel purge.
  assert.equal(assessNukeAction("ban", 5, limits).tripped, false);
  assert.equal(assessNukeAction("channel-delete", 5, limits).tripped, true);
  assert.equal(assessNukeAction("role-change", 3, limits).tripped, true);
});

test("the assessment reports the count and the limit it was measured against", () => {
  const verdict = assessNukeAction("ban", 9, limits);
  assert.deepEqual(verdict, { action: "ban", count: 9, limit: 5, tripped: true });
});

/* ------------------------------------------------------------------ *
 * Normalisation
 * ------------------------------------------------------------------ */

test("a guild with no saved settings is armed at the shipped defaults", () => {
  const config = normaliseAntiNukeConfig(undefined);
  assert.deepEqual(config, DEFAULT_ANTI_NUKE_CONFIG);
  assert.equal(config.enabled, true, "a guild is protected from the moment the bot joins it");
});

test("an explicit opt-out survives in every shape it can arrive in", () => {
  // The engine ships armed, so `false` is now the value that must never be lost:
  // dropping it would re-arm a protection the operator deliberately switched off.
  for (const value of [false, "false", "0", 0]) {
    assert.equal(
      normaliseAntiNukeConfig({ enabled: value }).enabled,
      false,
      `enabled:${String(value)} was ignored and the engine stayed armed`
    );
  }
  assert.equal(normaliseAntiNukeConfig({ enabled: true }).enabled, true);
});

test("an unreadable flag falls back to the default rather than counting as consent", () => {
  // A null from an absent column, or an object from a malformed body, is not a
  // decision in either direction — so the documented default is what stands.
  for (const value of [null, undefined, {}, []]) {
    assert.equal(
      normaliseAntiNukeConfig({ enabled: value }).enabled,
      DEFAULT_ANTI_NUKE_CONFIG.enabled,
      `enabled:${String(value)} did not fall back to the default`
    );
  }
});

test("limits are clamped to the allowed range", () => {
  const config = normaliseAntiNukeConfig({
    limits: { channelDeletesPerMinute: 0, bansPerMinute: 10_000, roleChangesPerMinute: -4 }
  });
  assert.equal(config.limits.channelDeletesPerMinute, 1, "zero would trip on the first action");
  assert.equal(config.limits.bansPerMinute, MAX_ANTI_NUKE_LIMIT, "a huge limit would disable the guard silently");
  assert.equal(config.limits.roleChangesPerMinute, 1);
});

test("a non-numeric limit falls back to the default", () => {
  const config = normaliseAntiNukeConfig({ limits: { bansPerMinute: "many" } });
  assert.equal(config.limits.bansPerMinute, DEFAULT_ANTI_NUKE_LIMITS.bansPerMinute);
});

test("fractional limits are truncated, not rounded up", () => {
  // Rounding 2.9 up to 3 would give the operator more than they asked for.
  assert.equal(normaliseAntiNukeConfig({ limits: { bansPerMinute: 2.9 } }).limits.bansPerMinute, 2);
});

test("a valid quarantine role is kept", () => {
  const config = normaliseAntiNukeConfig({ quarantineRoleId: "1540515175826985080" });
  assert.equal(config.quarantineRoleId, "1540515175826985080");
});

test("a malformed quarantine role is dropped rather than stored", () => {
  // A stored ID that matches no role would make mitigation silently do half its
  // job while the screen claimed it was configured.
  for (const value of ["", "   ", "abc", "123", "154051517582698508012345", 42, null]) {
    assert.equal(normaliseAntiNukeConfig({ quarantineRoleId: value }).quarantineRoleId, null, `kept ${String(value)}`);
  }
});

test("normalisation is idempotent", () => {
  const once = normaliseAntiNukeConfig({
    enabled: true,
    limits: { channelDeletesPerMinute: 7, bansPerMinute: 2, roleChangesPerMinute: 50 },
    quarantineRoleId: "1540515175826985080"
  });
  assert.deepEqual(normaliseAntiNukeConfig(once), once);
});
