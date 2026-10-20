import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_LEVEL,
  detectLevelConfigProblems,
  levelFromXp,
  levelProgress,
  normaliseLevelRewardList,
  normaliseLevelSettings,
  applyXpMultipliers,
  renderLevelMessage,
  roleSourcesFor,
  xpForLevel
} from "../src/levels.js";

test("the XP formula is (level × 25)² with the shipped reference points", () => {
  assert.equal(xpForLevel(1), 625);
  assert.equal(xpForLevel(5), 15_625);
  assert.equal(xpForLevel(10), 62_500);
  assert.equal(xpForLevel(20), 250_000);
  assert.equal(xpForLevel(0), 0);
});

test("the inverse returns the whole level a member is on", () => {
  assert.equal(levelFromXp(0), 0);
  assert.equal(levelFromXp(624), 0);
  assert.equal(levelFromXp(625), 1);
  assert.equal(levelFromXp(15_624), 4);
  assert.equal(levelFromXp(15_625), 5);
  assert.equal(levelFromXp(62_500), 10);
});

test("the progress bar measures the span inside the current level", () => {
  const progress = levelProgress(15_625);
  assert.equal(progress.level, 5);
  assert.equal(progress.xpInLevel, 0);
  assert.equal(progress.percent, 0);
  assert.equal(progress.nextLevelXp, xpForLevel(6));

  const halfway = levelProgress(xpForLevel(5) + Math.floor((xpForLevel(6) - xpForLevel(5)) / 2));
  assert.equal(halfway.level, 5);
  assert.ok(halfway.percent > 45 && halfway.percent < 55, `a mid-level member reads ~50%, got ${halfway.percent}`);
});

test("the progress bar clamps at the level ceiling instead of dividing by zero", () => {
  const progress = levelProgress(xpForLevel(MAX_LEVEL) * 4);
  assert.equal(progress.level, MAX_LEVEL);
  assert.equal(progress.percent, 100);
});

test("settings normalisation clamps numbers and drops non-snowflakes", () => {
  const settings = normaliseLevelSettings({
    enabled: true,
    textCooldownSeconds: 1,
    textXpMin: 40,
    textXpMax: 5,
    voiceXpMin: 200,
    maxLevelCap: 9_999,
    voiceMinMembers: 0,
    notifyMode: "custom_channel",
    notifyChannelId: "not-a-snowflake",
    ignoredTextChannelIds: ["123456789012345678", "bad", ""],
    ignoredRoleIds: "not-a-list"
  });
  assert.equal(settings.textCooldownSeconds, 10);
  // A crossed draw range is swapped, not rejected.
  assert.equal(settings.textXpMin, 5);
  assert.equal(settings.textXpMax, 40);
  assert.equal(settings.voiceXpMax, 100);
  // The cap clamps to the sane band; 0 would mean unlimited.
  assert.equal(settings.maxLevelCap, 1000);
  assert.equal(settings.voiceMinMembers, 1);
  // A mode whose channel id could not survive normalisation degrades to the
  // default destination rather than pointing at a channel that cannot exist.
  assert.equal(settings.notifyChannelId, null);
  assert.deepEqual(settings.ignoredTextChannelIds, ["123456789012345678"]);
  assert.deepEqual(settings.ignoredRoleIds, []);
  // Multipliers clamp into [0.1, 10] and dedupe by id.
  assert.deepEqual(
    normaliseLevelSettings({
      roleMultipliers: [
        { id: "123456789012345678", multiplier: 99 },
        { id: "123456789012345678", multiplier: 2 }
      ]
    }).roleMultipliers,
    [{ id: "123456789012345678", multiplier: 10 }]
  );
  // Off is the shipped state: a garbled row must not arm the feature.
  assert.equal(normaliseLevelSettings(undefined).enabled, false);
});

test("multipliers compound across matching roles and the channel", () => {
  const roleRules = [
    { id: "111111111111111111", multiplier: 2 },
    { id: "222222222222222222", multiplier: 1.5 }
  ];
  const channelRules = [{ id: "333333333333333333", multiplier: 1.5 }];
  // Base 10, both roles matched and the channel matched: 2 × 1.5 × 1.5 = 4.5×.
  assert.equal(
    applyXpMultipliers(10, roleRules, channelRules, {
      roleIds: ["111111111111111111", "222222222222222222"],
      channelId: "333333333333333333"
    }),
    45
  );
  // Nothing matches: the draw passes through untouched.
  assert.equal(applyXpMultipliers(10, roleRules, channelRules, { roleIds: [], channelId: "999" }), 10);
  // The floor keeps whole XP even with a fractional factor.
  assert.equal(applyXpMultipliers(5, [{ id: "1", multiplier: 0.5 }], [], { roleIds: ["1"], channelId: null }), 2);
});

test("reward normalisation drops roleless rows and deduplicates rules", () => {
  const rewards = normaliseLevelRewardList([
    { id: "a", kind: "voice", level: 3, roleId: "123456789012345678" },
    { id: "b", kind: "text", level: 2, roleId: "123456789012345678" },
    { id: "c", kind: "dual", level: 10, voiceLevel: 5, roleId: "123456789012345679" },
    { id: "d", kind: "text", level: 0, roleId: "" },
    { id: "b2", kind: "text", level: 2, roleId: "123456789012345678" }
  ]);
  assert.equal(rewards.length, 3);
  assert.deepEqual(
    rewards.map(reward => reward.kind),
    ["voice", "text", "dual"]
  );
  assert.equal(rewards[2]!.voiceLevel, 5);
});

test("the level cap is one policy everywhere, not a display-only ceiling", () => {
  // 4× the cap's XP would be level 200 by the raw formula — the product cap
  // binds in the one place every caller shares.
  assert.equal(levelFromXp(xpForLevel(MAX_LEVEL) * 4), MAX_LEVEL);
  assert.equal(levelFromXp(xpForLevel(MAX_LEVEL)), MAX_LEVEL);
  assert.equal(levelFromXp(xpForLevel(MAX_LEVEL) - 1), MAX_LEVEL - 1);
  // 0–624 XP is level 0, 625 XP is level 1 — the boundary belongs to level 1.
  assert.equal(levelFromXp(0), 0);
  assert.equal(levelFromXp(624), 0);
  assert.equal(levelFromXp(625), 1);
});

test("role sources keep a role while any rule still earns it", () => {
  const rewards = normaliseLevelRewardList([
    { id: "t", kind: "text", level: 5, roleId: "111111111111111111" },
    { id: "d", kind: "dual", level: 10, voiceLevel: 5, roleId: "111111111111111111" },
    { id: "v", kind: "voice", level: 5, roleId: "222222222222222222" }
  ]);
  // Text 10, voice 5: the role is earned by text AND dual.
  const both = roleSourcesFor(rewards, 10, 5);
  assert.deepEqual(both.get("111111111111111111"), ["text", "dual"]);
  // Voice drops to 4: the dual source is gone, but the text source alone
  // keeps the role alive — exactly the multi-source reconciliation contract.
  const textOnly = roleSourcesFor(rewards, 10, 4);
  assert.deepEqual(textOnly.get("111111111111111111"), ["text"]);
  // Below the text level too, the role has no reason left to exist.
  assert.equal(roleSourcesFor(rewards, 4, 10).get("111111111111111111"), undefined);
  assert.deepEqual(roleSourcesFor(rewards, 4, 10).get("222222222222222222"), ["voice"]);
});

test("config problems come from real data, not guesses", () => {
  const settings = normaliseLevelSettings({ enabled: true, notifyMode: "custom_channel", notifyChannelId: "999999999999999999" });
  const rewards = normaliseLevelRewardList([{ id: "r", kind: "text", level: 5, roleId: "123456789012345678" }]);
  const problems = detectLevelConfigProblems(
    settings,
    rewards,
    new Set(["222222222222222222"]),
    new Set(["999999999999999999"])
  );
  // The reward's role is not grantable → flagged. The notify channel exists → not flagged.
  assert.equal(problems.length, 1);
  assert.equal(problems[0]!.code, "reward-role-missing");
  const channelGone = detectLevelConfigProblems(settings, [], new Set(), new Set());
  assert.equal(channelGone.length, 1);
  assert.equal(channelGone[0]!.code, "notify-channel-missing");
  const clean = detectLevelConfigProblems(
    normaliseLevelSettings({ notifyMode: "same_channel" }),
    rewards,
    new Set(["123456789012345678"]),
    new Set()
  );
  assert.equal(clean.length, 0);
});

test("level-up templates substitute known tokens and leave unknown ones", () => {
  const rendered = renderLevelMessage("{user} وصل {level} بـ {xp} في {server}", {
    user: "<@42>",
    level: 3,
    xp: 6250,
    server: "السيرفر"
  });
  assert.equal(rendered, "<@42> وصل 3 بـ 6250 في السيرفر");
  assert.equal(renderLevelMessage("{nobody}", { user: "u", level: 1, xp: 1, server: "s" }), "{nobody}");
});
