import test from "node:test";
import assert from "node:assert/strict";
import { assessRoleHierarchy, assessRoleIconGate, ROLE_ICON_MIN_PREMIUM_TIER } from "../src/hierarchy.js";

/**
 * The two guards that stop an operator from filling in a field Discord will
 * reject.
 *
 * Both exist because Discord's failure mode is an opaque `400 Bad Request` with
 * no indication of which field was wrong. Deciding in advance is the only way to
 * explain the problem in the operator's own language.
 */

/* ------------------------------------------------------------------ *
 * Role icon gate
 * ------------------------------------------------------------------ */

test("a guild below the boost threshold has the icon field locked", () => {
  for (const tier of [0, 1]) {
    const gate = assessRoleIconGate(tier);
    assert.equal(gate.locked, true, `tier ${tier} must lock the field`);
    assert.ok(gate.reason, "a locked field must explain itself");
    assert.match(gate.reason, /400/, "the reason should name the failure it prevents");
  }
});

test("the threshold itself unlocks the field", () => {
  // Discord unlocks role icons *at* level 2, so level 2 must not be locked.
  const gate = assessRoleIconGate(ROLE_ICON_MIN_PREMIUM_TIER);
  assert.equal(gate.locked, false);
  assert.equal(gate.reason, null);
  assert.equal(gate.unknown, false);
});

test("higher boost levels are unlocked", () => {
  assert.equal(assessRoleIconGate(3).locked, false);
});

test("an unreadable boost level fails open and says so", () => {
  // Locking here would punish the operator for our own failed read, and the bot
  // validates again before it writes. The field stays usable but is flagged.
  const gate = assessRoleIconGate(null);
  assert.equal(gate.locked, false);
  assert.equal(gate.unknown, true);
  assert.equal(gate.reason, null, "an unknown level must not produce a warning about a real problem");
});

/* ------------------------------------------------------------------ *
 * Role hierarchy
 * ------------------------------------------------------------------ */

test("nothing configured means nothing to warn about", () => {
  const verdict = assessRoleHierarchy(5, []);
  assert.equal(verdict.blocked, false);
  assert.equal(verdict.highestManagedPosition, null);
  assert.equal(verdict.message, null);
});

test("a bot above every managed role is not blocked", () => {
  const verdict = assessRoleHierarchy(10, [3, 7, 2]);
  assert.equal(verdict.blocked, false);
  assert.equal(verdict.highestManagedPosition, 7);
  assert.equal(verdict.message, null);
});

test("a bot below the highest managed role is blocked", () => {
  const verdict = assessRoleHierarchy(4, [3, 9]);
  assert.equal(verdict.blocked, true);
  assert.equal(verdict.highestManagedPosition, 9);
  assert.match(verdict.message ?? "", /4/);
  assert.match(verdict.message ?? "", /9/);
});

test("an equal position is already out of reach", () => {
  // Discord compares positions, not permissions: a role at the bot's own
  // position cannot be managed. This is the boundary that makes the comparison
  // `>=` rather than `>`.
  const verdict = assessRoleHierarchy(6, [6]);
  assert.equal(verdict.blocked, true);
});

test("a single unconfigured role at position zero does not block a normal bot", () => {
  const verdict = assessRoleHierarchy(5, [0]);
  assert.equal(verdict.blocked, false);
  assert.equal(verdict.highestManagedPosition, 0);
});

test("a bot holding no role at all is blocked by any managed role", () => {
  // Position 0 means the bot has no role of its own, so `@everyone` is its
  // standing and every configured role outranks it.
  const verdict = assessRoleHierarchy(0, [1]);
  assert.equal(verdict.blocked, true);
});
