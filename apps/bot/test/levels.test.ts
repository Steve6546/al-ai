import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_LEVEL_SETTINGS, xpForLevel, type LevelRoleReward, type LevelSettings } from "@al-ai/core";
import {
  TextCooldownGate,
  VoiceSessionTracker,
  countEligibleVoiceMembers,
  desiredLevelRoles,
  isVoiceEligible,
  levelStep,
  planLevelRoleChanges,
  shouldEarnTextXp,
  textXpGain
} from "../src/runtime/levels.js";

const armed: LevelSettings = { ...DEFAULT_LEVEL_SETTINGS, enabled: true };

const rewards: LevelRoleReward[] = [
  { id: "t1", kind: "text", level: 5, voiceLevel: null, roleId: "111111111111111111", alwaysKeep: false },
  { id: "t2", kind: "text", level: 10, voiceLevel: null, roleId: "222222222222222222", alwaysKeep: false },
  { id: "v1", kind: "voice", level: 5, voiceLevel: null, roleId: "333333333333333333", alwaysKeep: false },
  { id: "v2", kind: "voice", level: 10, voiceLevel: null, roleId: "444444444444444444", alwaysKeep: false },
  { id: "d1", kind: "dual", level: 10, voiceLevel: 5, roleId: "555555555555555555", alwaysKeep: false }
];

test("the cooldown gate grants once per window and never touches the database twice", () => {
  const gate = new TextCooldownGate();
  const now = 1_000_000;
  assert.equal(gate.tryConsume("g", "u", 120, now), true);
  assert.equal(gate.tryConsume("g", "u", 120, now + 60_000), false);
  assert.equal(gate.tryConsume("g", "u", 120, now + 120_000), true);
  // A different author has their own window.
  assert.equal(gate.tryConsume("g", "other", 120, now), true);
});

test("the cooldown gate sweeps entries idle for an hour", () => {
  const gate = new TextCooldownGate();
  const now = Date.now();
  gate.tryConsume("g", "u", 120, now);
  assert.equal(gate.sweep(now), 0);
  assert.equal(gate.sweep(now + 3_600_000), 1);
});

test("text XP stays inside the shipped 15–25 range", () => {
  for (let i = 0; i < 200; i += 1) {
    const gain = textXpGain(armed);
    assert.ok(gain >= 15 && gain <= 25, `gain ${gain} outside [15, 25]`);
  }
});

test("bots, webhooks, system messages, ignored channels and ignored roles earn no text XP", () => {
  const base = {
    isBot: false,
    isWebhook: false,
    channelId: "c1",
    parentChannelId: null,
    isSystem: false,
    memberRoleIds: ["888888888888888888"]
  };
  assert.equal(shouldEarnTextXp(armed, base), true);
  assert.equal(shouldEarnTextXp({ ...armed, enabled: false }, base), false);
  assert.equal(shouldEarnTextXp({ ...armed, textXpEnabled: false }, base), false);
  assert.equal(shouldEarnTextXp(armed, { ...base, isBot: true }), false);
  assert.equal(shouldEarnTextXp(armed, { ...base, isWebhook: true }), false);
  // System messages (join/boost/pin) never earn XP — but media-only messages
  // are not system and do, by documented product policy.
  assert.equal(shouldEarnTextXp(armed, { ...base, isSystem: true }), false);
  // An ignored channel blocks the message — and its threads too, via the
  // parent channel id.
  assert.equal(
    shouldEarnTextXp({ ...armed, ignoredTextChannelIds: ["ignored"] }, { ...base, channelId: "ignored" }),
    false
  );
  assert.equal(
    shouldEarnTextXp({ ...armed, ignoredTextChannelIds: ["parent"] }, { ...base, parentChannelId: "parent" }),
    false
  );
  assert.equal(
    shouldEarnTextXp({ ...armed, ignoredRoleIds: ["888888888888888888"] }, base),
    false
  );
  // A member whose roles could not be resolved still passes the role rule.
  assert.equal(shouldEarnTextXp({ ...armed, ignoredRoleIds: ["888888888888888888"] }, { ...base, memberRoleIds: null }), true);
});

const human = (over: Partial<Parameters<typeof isVoiceEligible>[1]> = {}) => ({
  isBot: false,
  channelId: "room1",
  memberRoleIds: [] as string[],
  selfMute: false,
  selfDeaf: false,
  serverMute: false,
  serverDeaf: false,
  ...over
});

test("voice eligibility enforces the AFK, mute, deafen and solo-farming guards", () => {
  const member = human();
  const context = { afkChannelId: "afk", eligibleCount: 2 };
  assert.equal(isVoiceEligible(armed, member, context), true);

  // Solo farming: one eligible member in the room earns nothing at the default
  // minimum — and ineligible lurkers do not legitimise the room either.
  assert.equal(isVoiceEligible(armed, member, { ...context, eligibleCount: 1 }), false);
  assert.equal(isVoiceEligible({ ...armed, voiceMinMembers: 1 }, member, { ...context, eligibleCount: 1 }), true);

  // Mutes and deafens, self or server, each block.
  assert.equal(isVoiceEligible(armed, human({ selfMute: true }), context), false);
  assert.equal(isVoiceEligible(armed, human({ serverMute: true }), context), false);
  assert.equal(isVoiceEligible(armed, human({ selfDeaf: true }), context), false);
  assert.equal(isVoiceEligible(armed, human({ serverDeaf: true }), context), false);
  assert.equal(isVoiceEligible({ ...armed, ignoreMuted: false }, human({ selfMute: true }), context), true);

  // AFK room and ignored room are refused, unless the guard is off.
  assert.equal(isVoiceEligible(armed, human({ channelId: "afk" }), context), false);
  assert.equal(isVoiceEligible({ ...armed, ignoreAfk: false }, human({ channelId: "afk" }), context), true);
  assert.equal(isVoiceEligible({ ...armed, ignoredVoiceChannelIds: ["room1"] }, member, context), false);
  assert.equal(isVoiceEligible(armed, human({ isBot: true }), context), false);
});

test("the min-members count uses the same eligibility policy as the grant", () => {
  // One talker + one muted lurker + one member carrying an ignored role.
  const members = [
    human(),
    human({ selfMute: true }),
    human({ memberRoleIds: ["888888888888888888"] }),
    human({ isBot: true })
  ];
  const settings = { ...armed, ignoredRoleIds: ["888888888888888888"] };
  // Only ONE member is eligible: the muted and ignored-role humans do not
  // legitimise the room, and neither does the bot.
  assert.equal(countEligibleVoiceMembers(settings, members, { afkChannelId: "afk" }), 1);
  // With the minimum at 2, the talker earns nothing in that room...
  assert.equal(
    isVoiceEligible(settings, human(), { afkChannelId: "afk", eligibleCount: 1 }),
    false
  );
  // ...but a second talker flips the room legitimate for both.
  const twoTalkers = [human(), human({ memberRoleIds: ["999999999999999999"] })];
  assert.equal(countEligibleVoiceMembers(settings, twoTalkers, { afkChannelId: "afk" }), 2);
  assert.equal(
    isVoiceEligible(settings, human(), { afkChannelId: "afk", eligibleCount: 2 }),
    true
  );
  // An AFK channel member is not counted as eligible either.
  const inAfk = [human(), human({ channelId: "afk" })];
  assert.equal(countEligibleVoiceMembers(settings, inAfk, { afkChannelId: "afk" }), 1);
});

test("hybrid voice timing: sessions accrue from join, credit whole minutes, close on leave", () => {
  const tracker = new VoiceSessionTracker();
  const join = 1_000_000;
  tracker.onJoin("g", "u", "room", join);
  assert.equal(tracker.isActive("g", "u"), true);
  // 59 seconds in: not even one minute — nothing to credit.
  assert.equal(tracker.minutesToCredit("g", "u", join + 59_000), 0);
  // 2 minutes: two whole minutes, credited and the anchor advanced.
  assert.equal(tracker.minutesToCredit("g", "u", join + 120_000), 2);
  tracker.markCredited("g", "u", join + 120_000);
  // 30 seconds after the credit: no further whole minute.
  assert.equal(tracker.minutesToCredit("g", "u", join + 150_000), 0);
  // A channel move keeps the anchor; leaving closes the session.
  tracker.onMove("g", "u", "room2");
  assert.equal(tracker.minutesToCredit("g", "u", join + 180_000), 1);
  tracker.onLeave("g", "u");
  assert.equal(tracker.isActive("g", "u"), false);
  assert.equal(tracker.minutesToCredit("g", "u", join + 999_000), 0);
});

test("a jump across several levels notifies once, for the highest level reached", () => {
  // A multi-minute voice credit can cross more than one threshold; the policy
  // is one notification for the top level, expressed by the single levelStep.
  const step = levelStep(0, xpForLevel(3) + 10, 100);
  assert.deepEqual(step, { level: 3, leveledUp: true });
  // At the level cap the member stops levelling up entirely.
  const capped = levelStep(xpForLevel(100) * 2, xpForLevel(100) * 3, 100);
  assert.deepEqual(capped, { level: 100, leveledUp: false });
});

test("desired roles honour stacking and the per-track highest without it", () => {
  // Text 10, voice 5, stacking: every satisfied rule is kept.
  assert.deepEqual(
    desiredLevelRoles(rewards, 10, 5, true).sort(),
    ["111111111111111111", "222222222222222222", "333333333333333333", "555555555555555555"]
  );
  // Without stacking: the highest per track only — and the dual rule needs
  // both 10-text and 5-voice, which this member meets.
  assert.deepEqual(desiredLevelRoles(rewards, 10, 5, false), [
    "222222222222222222",
    "333333333333333333",
    "555555555555555555"
  ]);
  // The dual rule is lost the moment one condition drops below its threshold —
  // and the text track falls back to the highest *satisfied* rule, not the
  // highest rule overall.
  assert.deepEqual(desiredLevelRoles(rewards, 9, 5, false), [
    "111111111111111111",
    "333333333333333333"
  ]);
  assert.deepEqual(desiredLevelRoles(rewards, 10, 4, false), ["222222222222222222"]);
});

test("a keep-marked rule pins its role even without guild-wide stacking", () => {
  const rewards: LevelRoleReward[] = [
    { id: "t1", kind: "text", level: 5, voiceLevel: null, roleId: "111111111111111111", alwaysKeep: true },
    { id: "t2", kind: "text", level: 10, voiceLevel: null, roleId: "222222222222222222", alwaysKeep: false }
  ];
  // Stacking off, member at text 10: normally only the highest (t2) survives —
  // but the keep-marked t1 stays pinned because its rule is still satisfied.
  assert.deepEqual(desiredLevelRoles(rewards, 10, 0, false), [
    "111111111111111111",
    "222222222222222222"
  ]);
  // Below the keep rule's level, the pin loses its power: nothing satisfied,
  // nothing kept.
  assert.deepEqual(desiredLevelRoles(rewards, 4, 0, false), []);
  // With stacking on, keep adds nothing new — everything is kept anyway.
  assert.deepEqual(desiredLevelRoles(rewards, 10, 0, true), [
    "111111111111111111",
    "222222222222222222"
  ]);
});

test("role changes only ever touch roles this system's rules name", () => {
  const held = [
    "111111111111111111", // earned before, lost after a reset
    "999999999999999999" // a moderator's hand-assigned role
  ];
  const plan = planLevelRoleChanges(held, ["333333333333333333"], rewards.map(reward => reward.roleId));
  assert.deepEqual(plan.toAdd, ["333333333333333333"]);
  assert.deepEqual(plan.toRemove, ["111111111111111111"]);
});

test("a level rises only when the XP crosses a threshold", () => {
  assert.deepEqual(levelStep(0, 625, 100), { level: 1, leveledUp: true });
  assert.deepEqual(levelStep(0, 624, 100), { level: 0, leveledUp: false });
  assert.deepEqual(levelStep(625, 700, 100), { level: 1, leveledUp: false });
  assert.deepEqual(levelStep(700, 100, 100), { level: 0, leveledUp: false });
});
