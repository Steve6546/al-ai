import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_INVITE_SETTINGS,
  classifyInviteJoin,
  desiredInviteMilestoneRoles,
  formatAccountAge,
  inviteNet,
  inviteTotal,
  normaliseInviteMilestones,
  normaliseInviteSettings,
  planMilestoneRoleChanges,
  renderInviteTemplate
} from "@al-ai/core";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

/** A joining member with a five-month-old account, invited by someone else. */
const regular = {
  joinerId: "1111111111111111111",
  inviteCode: "abc123",
  inviterId: "2222222222222222222",
  isVanity: false,
  accountAgeMs: 150 * DAY,
  previous: null,
  settings: DEFAULT_INVITE_SETTINGS
};

test("a first join through someone else's link counts as a regular referral", () => {
  const decision = classifyInviteJoin(regular);
  assert.deepEqual(decision, {
    kind: "regular",
    inviterId: regular.inviterId,
    countsToInviter: true,
    countsAsFake: false,
    countsAsRejoin: false
  });
});

test("an account younger than the guild's threshold is fake: logged, never counted in the net", () => {
  const decision = classifyInviteJoin({ ...regular, accountAgeMs: 2 * DAY });
  assert.equal(decision.kind, "fake");
  assert.equal(decision.countsToInviter, false);
  assert.equal(decision.countsAsFake, true);
});

test("the fake threshold follows the guild's setting, including 0 = keep every account", () => {
  assert.equal(classifyInviteJoin({ ...regular, accountAgeMs: 2 * DAY, settings: { fakeAccountDays: 0 } }).kind, "regular");
  assert.equal(classifyInviteJoin({ ...regular, accountAgeMs: 2 * DAY, settings: { fakeAccountDays: 7 } }).kind, "fake");
});

test("a returning member is a rejoin and never earns a second point", () => {
  const decision = classifyInviteJoin({ ...regular, previous: { counted: true } });
  assert.equal(decision.kind, "rejoin");
  assert.equal(decision.countsToInviter, false);
  assert.equal(decision.countsAsRejoin, true);
});

test("re-join spam: ten returns through the same link still leave one point on the board", () => {
  // Every return reads "rejoin" regardless of the prior row's counted flag —
  // the point was given on the first entry, and leaves have already taken it
  // back where they should.
  for (const counted of [true, false]) {
    const decision = classifyInviteJoin({ ...regular, previous: { counted } });
    assert.equal(decision.kind, "rejoin");
    assert.equal(decision.countsToInviter, false);
  }
});

test("a member arriving through their own link earns nothing", () => {
  const decision = classifyInviteJoin({ ...regular, inviterId: regular.joinerId });
  assert.equal(decision.kind, "self");
  assert.equal(decision.inviterId, null);
  assert.equal(decision.countsToInviter, false);
  assert.equal(decision.countsAsFake, false);
});

test("an unattributed join counts for nobody — vanity and cannot-tell are the same verdict", () => {
  const vanity = classifyInviteJoin({ ...regular, inviteCode: null, inviterId: null, isVanity: true });
  assert.equal(vanity.kind, "vanity");
  assert.equal(vanity.inviterId, null);
  assert.equal(vanity.countsToInviter, false);

  const unknown = classifyInviteJoin({ ...regular, inviteCode: null, inviterId: null });
  assert.equal(unknown.kind, "unknown");
  assert.equal(unknown.countsToInviter, false);
});

test("the net is regular minus leaves plus manual adjustments; the total counts everything attributed", () => {
  const stats = { regular: 12, fakes: 3, rejoins: 4, leaves: 5, bonus: -1 };
  assert.equal(inviteNet(stats), 6);
  assert.equal(inviteTotal(stats), 19);
});

test("milestone roles stack: a member at 25 net holds the 5, 10 and 25 roles", () => {
  const milestones = [
    { id: "m1", net: 5, roleId: "5555555555555550001" },
    { id: "m2", net: 10, roleId: "5555555555555550002" },
    { id: "m3", net: 25, roleId: "5555555555555550003" }
  ];
  assert.deepEqual(desiredInviteMilestoneRoles(milestones, 25), milestones.map(milestone => milestone.roleId));
  assert.deepEqual(desiredInviteMilestoneRoles(milestones, 4), []);
  assert.deepEqual(desiredInviteMilestoneRoles(milestones, 10), [milestones[0].roleId, milestones[1].roleId]);
});

test("the plan grants newly-earned roles and revokes only milestone roles the net no longer backs", () => {
  const milestones = [{ id: "m1", net: 5, roleId: "5555555555555550001" }];
  const held = ["5555555555555550001", "4444444444444444444"];

  const falling = planMilestoneRoleChanges(held, 2, milestones, false);
  assert.deepEqual(falling.toAdd, []);
  // A moderator's hand-assigned role is never touched, only the named ones.
  assert.deepEqual(falling.toRemove, ["5555555555555550001"]);

  const rising = planMilestoneRoleChanges(["4444444444444444444"], 9, milestones, false);
  assert.deepEqual(rising.toAdd, ["5555555555555550001"]);
  assert.deepEqual(rising.toRemove, []);
});

test("keep_roles_on_leave turns the revoke half off but keeps granting", () => {
  const milestones = [{ id: "m1", net: 5, roleId: "5555555555555550001" }];
  const plan = planMilestoneRoleChanges(["5555555555555550001"], 2, milestones, true);
  assert.deepEqual(plan.toRemove, []);
  assert.deepEqual(plan.toAdd, []);

  const plan2 = planMilestoneRoleChanges([], 9, milestones, true);
  assert.deepEqual(plan2.toAdd, ["5555555555555550001"]);
});

test("templates fill every documented token and leave unknown ones alone", () => {
  const stats = { regular: 12, fakes: 3, rejoins: 4, leaves: 5, bonus: 0 };
  const text = renderInviteTemplate(
    "{user} ({user.id}) عمره {user.age} جاء بـ {invite.code} من {inviter}: صافي {inviter.net} من {inviter.total}، غادر {inviter.leaves}، وهمي {inviter.fakes} {unknown}",
    {
      userMention: "<@1111111111111111111>",
      userId: "1111111111111111111",
      userAge: "منذ 5 أشهر",
      inviterMention: "<@2222222222222222222>",
      stats,
      inviteCode: "abc123"
    }
  );
  assert.ok(text.includes("<@1111111111111111111>"));
  assert.ok(text.includes("منذ 5 أشهر"));
  assert.ok(text.includes("`abc123`"));
  assert.ok(text.includes("صافي 7 من 19، غادر 5، وهمي 3"));
  assert.ok(text.includes("{unknown}"), "an unknown token is left as the operator typed it");
});

test("a missing inviter reads as غير معروف, never as an empty slot", () => {
  const text = renderInviteTemplate("من {inviter}: صافي {inviter.net}", {
    userMention: "<@1111111111111111111>",
    userId: "1111111111111111111",
    userAge: "",
    inviterMention: "",
    stats: { regular: 0, fakes: 0, rejoins: 0, leaves: 0, bonus: 0 },
    inviteCode: ""
  });
  assert.equal(text, "من غير معروف: صافي غير معروف");
});

test("account ages take Arabic plurals and the largest readable unit", () => {
  const t = NOW;
  assert.equal(formatAccountAge(t - 3 * DAY, t), "منذ 3 أيام");
  assert.equal(formatAccountAge(t - DAY, t), "منذ يوم");
  assert.equal(formatAccountAge(t - 2 * DAY, t), "منذ يومين");
  assert.equal(formatAccountAge(t - 15 * DAY, t), "منذ أسبوعين");
  assert.equal(formatAccountAge(t - 6 * 30 * DAY, t), "منذ 6 أشهر");
  assert.equal(formatAccountAge(t - 400 * DAY, t), "منذ سنة");
  assert.equal(formatAccountAge(t - 10_000, t), "أقل من يوم");
});

test("the settings normaliser clamps what a hand-crafted PUT could store", () => {
  const normalised = normaliseInviteSettings({
    enabled: "yes",
    fakeAccountDays: 999,
    milestoneRoles: [{ id: "a", net: 0, roleId: "<@123>" }, { id: "b", net: 5, roleId: "2222222222222222222" }],
    joinMessage: "   "
  });
  assert.equal(normalised.enabled, false);
  assert.equal(normalised.fakeAccountDays, 30);
  assert.deepEqual(normalised.milestoneRoles, [{ id: "b", net: 5, roleId: "2222222222222222222" }]);
  assert.equal(normalised.joinMessage, DEFAULT_INVITE_SETTINGS.joinMessage);
  assert.equal(normalised.logJoins, true, "logging defaults on");
});

test("milestone normalisation dedupes roles and thresholds", () => {
  const rules = normaliseInviteMilestones([
    { net: 5, roleId: "2222222222222222222" },
    { net: 5, roleId: "3333333333333333333" },
    { net: 5, roleId: "2222222222222222222" },
    { net: 10, roleId: "2222222222222222222" }
  ]);
  // One role appears once (the same role at two thresholds is inert), and one
  // threshold appears once — the first claim wins in both directions.
  assert.equal(rules.length, 1);
  assert.deepEqual(rules, [{ id: "", net: 5, roleId: "2222222222222222222" }]);
});
