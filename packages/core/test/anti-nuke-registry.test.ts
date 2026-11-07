import test from "node:test";
import assert from "node:assert/strict";
import {
  ANTI_NUKE_ACTIONS,
  ANTI_NUKE_LIMIT_KEYS,
  MAX_ANTI_NUKE_LIMIT,
  DISCORD_AUDIT_EVENTS,
  NUKE_FAMILIES,
  NUKE_FAMILY_LABELS,
  NUKE_PROTECTIONS,
  PROTECTION_KEYS_BY_ACTION,
  activeProtectionCount,
  enforcedProtections,
  isNukeProtectionKey,
  normaliseProtectionSettings,
  protectionsInFamily,
  discordPermissionLabels
} from "../src/index.js";

/**
 * The protection registry is a promise the screen makes to the operator.
 *
 * `anti-nuke.ts` decides what the engine enforces; this file decides what the
 * dashboard lists. Two tables describing one engine drift, and the drift is
 * invisible: a row with a number that nothing reads looks exactly like a
 * protection that works. These tests are what keeps the two honest with each
 * other, and with Discord's own vocabulary.
 */

test("the registry holds twelve protections, each with a unique key", () => {
  assert.equal(NUKE_PROTECTIONS.length, 12, "the security screen promises 12 rows");
  const keys = NUKE_PROTECTIONS.map(protection => protection.key);
  assert.deepEqual(keys, [...new Set(keys)], "two protections cannot share a key");
});

test("every family is named, non-empty, and covers exactly the registry", () => {
  for (const family of NUKE_FAMILIES) {
    assert.ok(NUKE_FAMILY_LABELS[family], `${family} has no Arabic label`);
    assert.ok(protectionsInFamily(family).length > 0, `${family} renders an empty panel`);
  }
  const spread = NUKE_FAMILIES.flatMap(family => protectionsInFamily(family));
  assert.equal(spread.length, NUKE_PROTECTIONS.length, "a protection outside a known family is never rendered");
});

test("every limit is a usable range, not a decoration", () => {
  for (const protection of NUKE_PROTECTIONS) {
    const { min, max, default: fallback } = protection.limit;
    // A floor of 0 would trip on the first action and read as "protected" while
    // forbidding all moderation.
    assert.ok(min >= 1, `${protection.key}: a limit of 0 bans moderation itself`);
    assert.ok(min <= fallback, `${protection.key}: the default is below its own minimum`);
    assert.ok(fallback <= max, `${protection.key}: the default is above its own maximum`);
    assert.ok(max <= MAX_ANTI_NUKE_LIMIT, `${protection.key}: a ceiling above ${MAX_ANTI_NUKE_LIMIT} can silently disable the check`);
  }
});

test("every audit event is a real Discord audit-log event name", () => {
  const known = new Set<string>(DISCORD_AUDIT_EVENTS);
  for (const protection of NUKE_PROTECTIONS) {
    assert.ok(protection.auditEvents.length > 0, `${protection.key}: nothing names what was observed`);
    for (const event of protection.auditEvents) {
      assert.ok(known.has(event), `${protection.key}: "${event}" is not a Discord audit event`);
    }
  }
});

test("every protection names a permission the shared table knows and labels", () => {
  for (const protection of NUKE_PROTECTIONS) {
    assert.ok(
      discordPermissionLabels[protection.permission],
      `${protection.key}: permission ${protection.permission} would render as a raw key`
    );
  }
});

test("the registry's enforced set and the engine's action list are one list", () => {
  const fromRegistry = new Set(enforcedProtections().map(protection => protection.limitKey));
  const fromEngine = new Set(ANTI_NUKE_ACTIONS.map(action => ANTI_NUKE_LIMIT_KEYS[action]));
  assert.deepEqual(
    [...fromRegistry].sort(),
    [...fromEngine].sort(),
    "a limit the screen edits must be a limit the engine reads, and the other way round"
  );
});

test("role create and delete deliberately share one budget", () => {
  const create = NUKE_PROTECTIONS.find(protection => protection.key === "role-create");
  const remove = NUKE_PROTECTIONS.find(protection => protection.key === "role-delete");
  assert.equal(create?.limitKey, "roleChangesPerMinute");
  assert.equal(remove?.limitKey, "roleChangesPerMinute");
  // The screen prints a sentence explaining this. If the budget is ever split,
  // that sentence becomes a lie, so the pairing is pinned here.
});

test("the badge counts what the engine actually enforces", () => {
  const enforced = enforcedProtections().length;
  assert.ok(enforced > 0 && enforced < NUKE_PROTECTIONS.length, "either nothing or everything is enforced");
  assert.equal(activeProtectionCount(true), enforced);
  // Disarmed means the operator asked for no protection, so the badge must say 0
  // rather than continuing to advertise the rows below it.
  assert.equal(activeProtectionCount(false), 0);
  // A per-protection switch only changes the count when it lands on a protection
  // the engine counts. Turning off something already unenforced must not move a
  // number that was never claiming to include it.
  const offUnenforced = { "role-update": { enabled: false, windowSeconds: 600, punishment: "remove-roles" as const, timeoutSeconds: 600 } };
  assert.equal(activeProtectionCount(true, offUnenforced), enforced, "switching an unenforced protection off changes nothing");
  const offEnforced = { "channel-delete": { enabled: false, windowSeconds: 600, punishment: "remove-roles" as const, timeoutSeconds: 600 } };
  assert.equal(activeProtectionCount(true, offEnforced), enforced - 1, "switching an enforced protection off is visible");
});

test("the action → protection map covers every action the engine watches", () => {
  for (const action of ANTI_NUKE_ACTIONS) {
    const keys = PROTECTION_KEYS_BY_ACTION[action];
    assert.ok(keys.length > 0, `${action}: no protection can switch it off`);
    for (const key of keys) {
      assert.ok(isNukeProtectionKey(key), `${action} names ${key}, which is not in the registry`);
    }
  }
});

test("stored settings reject keys the registry does not know", () => {
  const normalised = normaliseProtectionSettings({
    "channel-delete": { enabled: false, windowSeconds: 600, punishment: "remove-roles" as const, timeoutSeconds: 600 },
    "channel-delet": { enabled: false, windowSeconds: 600, punishment: "remove-roles" as const, timeoutSeconds: 600 },
    "member-ban": "yes"
  });
  assert.equal(normalised["channel-delete"].enabled, false, "a real opt-out survives");
  assert.ok(!("channel-delet" in normalised), "a typo is dropped, not stored and honoured by nothing");
  assert.equal(normalised["member-ban"].enabled, true, "an unreadable value is not read as an opt-out");
  assert.equal(Object.keys(normalised).length, NUKE_PROTECTIONS.length, "the map always covers every protection");
});
