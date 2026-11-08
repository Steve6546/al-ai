import test from "node:test";
import assert from "node:assert/strict";
import { ANTI_NUKE_LIMIT_KEYS, DEFAULT_ANTI_NUKE_CONFIG, DEFAULT_ANTI_NUKE_LIMITS, DEFAULT_PROTECTION_SETTINGS, type AntiNukeConfig, type AntiNukeLimits } from "@al-ai/core";
import {
  createAntiNukeEngine,
  createAntiNukeTracker,
  mitigateNuke,
  nukeActionOf,
  ownerAlert,
  type MitigationDeps,
  type NukeIncident
} from "../src/security/anti-nuke.js";
import type { BotEvent } from "../src/lib/discord.js";

/**
 * The anti-nuke engine.
 *
 * These tests run the whole response path with fake effects, so the ordering and
 * the failure modes are pinned without Discord: the actor is neutralised before
 * the owner is told, and neither step can cancel the other.
 */

const GUILD = "1540515175826985080";
const ACTOR = "111111111111111111";
const OTHER = "222222222222222222";
const QUARANTINE_ROLE = "333333333333333333";

const limits: AntiNukeLimits = {
  ...DEFAULT_ANTI_NUKE_LIMITS,
  channelDeletesPerMinute: 2,
  bansPerMinute: 3,
  roleChangesPerMinute: 2
};

const armed: AntiNukeConfig = {
  enabled: true,
  limits,
  protections: DEFAULT_PROTECTION_SETTINGS,
  quarantineRoleId: QUARANTINE_ROLE
};

/** A tracker with a clock the test controls. */
function makeTracker() {
  let current = 1_000_000;
  const tracker = createAntiNukeTracker({ now: () => current, windowMs: 60_000 });
  return { tracker, advance: (ms: number) => (current += ms) };
}

const channelDelete = (actorId = ACTOR): BotEvent => ({
  type: "server.channel-delete",
  guildId: GUILD,
  channelId: "999",
  actorId
});

/* ------------------------------------------------------------------ *
 * Counting
 * ------------------------------------------------------------------ */

test("an actor is allowed up to the limit and trips on the next action", () => {
  const { tracker } = makeTracker();

  assert.equal(tracker.record({ guildId: GUILD, actorId: ACTOR, action: "channel-delete", limits })?.tripped, false);
  assert.equal(tracker.record({ guildId: GUILD, actorId: ACTOR, action: "channel-delete", limits })?.tripped, false);
  const third = tracker.record({ guildId: GUILD, actorId: ACTOR, action: "channel-delete", limits });
  assert.equal(third?.tripped, true, "the third deletion is past a limit of two");
  assert.equal(third?.count, 3);
});

test("two actors do not share a budget", () => {
  const { tracker } = makeTracker();
  tracker.record({ guildId: GUILD, actorId: ACTOR, action: "channel-delete", limits });
  tracker.record({ guildId: GUILD, actorId: ACTOR, action: "channel-delete", limits });

  const first = tracker.record({ guildId: GUILD, actorId: OTHER, action: "channel-delete", limits });
  assert.equal(first?.tripped, false, "the second actor has done nothing yet");
  assert.equal(first?.count, 1);
});

test("two guilds do not share a budget", () => {
  const { tracker } = makeTracker();
  tracker.record({ guildId: GUILD, actorId: ACTOR, action: "ban", limits });
  tracker.record({ guildId: GUILD, actorId: ACTOR, action: "ban", limits });
  tracker.record({ guildId: GUILD, actorId: ACTOR, action: "ban", limits });

  const elsewhere = tracker.record({ guildId: "888", actorId: ACTOR, action: "ban", limits });
  assert.equal(elsewhere?.count, 1);
});

test("role creation and deletion share one budget", () => {
  // Splitting them would silently double the allowance for the exact behaviour
  // the limit exists to stop.
  const { tracker } = makeTracker();
  tracker.record({ guildId: GUILD, actorId: ACTOR, action: "role-change", limits });
  tracker.record({ guildId: GUILD, actorId: ACTOR, action: "role-change", limits });
  const third = tracker.record({ guildId: GUILD, actorId: ACTOR, action: "role-change", limits });
  assert.equal(third?.tripped, true);
});

test("the window expires and the count restarts", () => {
  const { tracker, advance } = makeTracker();
  tracker.record({ guildId: GUILD, actorId: ACTOR, action: "channel-delete", limits });
  tracker.record({ guildId: GUILD, actorId: ACTOR, action: "channel-delete", limits });

  advance(60_001);
  const after = tracker.record({ guildId: GUILD, actorId: ACTOR, action: "channel-delete", limits });
  assert.equal(after?.count, 1, "an hour-old burst is not evidence about the last minute");
  assert.equal(after?.tripped, false);
});

/* ------------------------------------------------------------------ *
 * Latching
 * ------------------------------------------------------------------ */

test("an actor is not re-reported after being mitigated", () => {
  const { tracker } = makeTracker();
  for (let i = 0; i < 3; i += 1) tracker.record({ guildId: GUILD, actorId: ACTOR, action: "channel-delete", limits });

  assert.equal(tracker.isLatched(GUILD, ACTOR), true);
  assert.equal(
    tracker.record({ guildId: GUILD, actorId: ACTOR, action: "channel-delete", limits }),
    null,
    "the owner must receive one message per incident, not one per action"
  );
});

test("releasing an actor lets them be evaluated again", () => {
  // Without this a false positive could never be undone.
  const { tracker } = makeTracker();
  for (let i = 0; i < 3; i += 1) tracker.record({ guildId: GUILD, actorId: ACTOR, action: "channel-delete", limits });

  tracker.release(GUILD, ACTOR);
  assert.equal(tracker.isLatched(GUILD, ACTOR), false);
  const after = tracker.record({ guildId: GUILD, actorId: ACTOR, action: "channel-delete", limits });
  assert.ok(after, "a released actor is counted again");
});

test("pruning drops expired counters", () => {
  const { tracker, advance } = makeTracker();
  tracker.record({ guildId: GUILD, actorId: ACTOR, action: "ban", limits });
  advance(60_001);
  tracker.prune();
  assert.equal(tracker.countFor(GUILD, ACTOR, "ban"), 0);
});

/* ------------------------------------------------------------------ *
 * Event mapping
 * ------------------------------------------------------------------ */

test("the watched events map to their action class", () => {
  assert.deepEqual(nukeActionOf(channelDelete()), {
    action: "channel-delete",
    protectionKey: "channel-delete",
    guildId: GUILD,
    actorId: ACTOR
  });
  assert.equal(nukeActionOf({ type: "moderation.ban", guildId: GUILD, targetId: "t", actorId: ACTOR })?.action, "ban");
  assert.equal(nukeActionOf({ type: "role.create", guildId: GUILD, roleId: "r", actorId: ACTOR })?.action, "role-change");
  assert.equal(nukeActionOf({ type: "role.delete", guildId: GUILD, roleId: "r", actorId: ACTOR })?.action, "role-change");
  // One budget, two protections: the switch that must be able to silence creation
  // alone depends on the observation carrying the event's own key.
  assert.equal(nukeActionOf({ type: "role.create", guildId: GUILD, roleId: "r", actorId: ACTOR })?.protectionKey, "role-create");
  assert.equal(nukeActionOf({ type: "role.delete", guildId: GUILD, roleId: "r", actorId: ACTOR })?.protectionKey, "role-delete");
});

test("ordinary events are not treated as destructive", () => {
  for (const event of [
    { type: "member.join", guildId: GUILD, memberId: "m" },
    { type: "message.delete", guildId: GUILD, messageId: "m", channelId: "c" },
    { type: "client.ready", tag: "AL AI#0001", guildCount: 1 }
  ] as BotEvent[]) {
    assert.equal(nukeActionOf(event), null, `${event.type} must not be watched`);
  }
});

/**
 * `role.update` is counted, on its own budget, and this pins both halves.
 *
 * It used to be observed but ignored: a role edit is a rename, a colour or a
 * permission toggle, and a busy server produces them in normal moderation —
 * counting them against `roleChangesPerMinute` would have quarantined a
 * moderator for tidying up role colours. That reasoning still holds for the
 * *shared* budget; what changed is that raising a role's permissions is the
 * privilege-escalation path, and it deserves its own number rather than
 * silence. So the assertion is now two-sided: the action maps, and it maps to
 * a different limit than create/delete.
 */
test("role.update is counted against its own budget, never the churn budget", () => {
  const observation = nukeActionOf({ type: "role.update", guildId: GUILD, roleId: "r", actorId: ACTOR });
  assert.equal(observation?.action, "role-update");
  assert.equal(observation?.protectionKey, "role-update");
  assert.notEqual(
    ANTI_NUKE_LIMIT_KEYS["role-update"],
    ANTI_NUKE_LIMIT_KEYS["role-change"],
    "a role edit must not consume the create/delete budget"
  );
});

test("the five newly wired actions map to their own protections", () => {
  const cases: { event: BotEvent; action: string; protection: string }[] = [
    { event: { type: "moderation.kick", guildId: GUILD, targetId: OTHER, actorId: ACTOR }, action: "kick", protection: "member-kick" },
    { event: { type: "moderation.timeout", guildId: GUILD, targetId: OTHER, actorId: ACTOR }, action: "timeout", protection: "member-timeout" },
    // Creating a webhook and editing one are separate protections with separate
    // budgets; deleting stays with editing, because both change a webhook that
    // already exists.
    { event: { type: "webhook.create", guildId: GUILD, webhookId: "w", channelId: "c", actorId: ACTOR }, action: "webhook-create", protection: "webhook-create" },
    { event: { type: "webhook.update", guildId: GUILD, webhookId: "w", channelId: "c", actorId: ACTOR }, action: "webhook-update", protection: "webhook-update" },
    { event: { type: "webhook.delete", guildId: GUILD, webhookId: "w", channelId: "c", actorId: ACTOR }, action: "webhook-update", protection: "webhook-update" },
    { event: { type: "message.bulk-delete", guildId: GUILD, channelId: "c", count: 200, actorId: ACTOR }, action: "message-bulk-delete", protection: "message-purge" }
  ];
  for (const entry of cases) {
    const observation = nukeActionOf(entry.event);
    assert.equal(observation?.action, entry.action, `${entry.event.type} must be counted`);
    assert.equal(observation?.protectionKey, entry.protection, `${entry.event.type} belongs to ${entry.protection}`);
  }
});

test("an event nobody is named in is never counted", () => {
  // The resolver's "unknown" is not a person. Counting it would accumulate
  // every unattributable action into one phantom budget and eventually trip a
  // punishment Discord would refuse to apply to anybody.
  assert.equal(nukeActionOf({ type: "moderation.timeout", guildId: GUILD, targetId: OTHER, actorId: "unknown" }), null);
  assert.equal(nukeActionOf({ type: "role.update", guildId: GUILD, roleId: "r", actorId: "unknown" }), null);
  assert.equal(nukeActionOf({ type: "message.bulk-delete", guildId: GUILD, channelId: "c", count: 5 }), null, "no actor at all");
  assert.equal(nukeActionOf({ type: "webhook.create", guildId: GUILD, webhookId: "w", channelId: "c" }), null, "no actor at all");
});

/* ------------------------------------------------------------------ *
 * Mitigation
 * ------------------------------------------------------------------ */

const incident: NukeIncident = { guildId: GUILD, actorId: ACTOR, action: "channel-delete", protectionKey: "channel-delete", count: 3, limit: 2 };

function deps(overrides: Partial<MitigationDeps> = {}): MitigationDeps {
  const ok = async () => ({ ok: true, detail: "done" });
  return { ban: ok, kick: ok, timeout: ok, removeRoles: ok, warn: ok, notifyOwner: async () => true, ...overrides };
}

test("the actor is acted on before the owner is told", () => {
  const order: string[] = [];
  return mitigateNuke(
    incident,
    armed,
    deps({
      removeRoles: async () => {
        order.push("punish");
        return { ok: true, detail: "roles removed" };
      },
      notifyOwner: async () => {
        order.push("notify");
        return true;
      }
    })
  ).then(outcome => {
    assert.deepEqual(order, ["punish", "notify"]);
    assert.equal(outcome.applied, true);
    assert.equal(outcome.ownerNotified, true);
  });
});

test("a refused punishment is not reported as success, and the owner is still told", () => {
  return mitigateNuke(
    incident,
    armed,
    deps({ removeRoles: async () => ({ ok: false, detail: "hierarchy" }) })
  ).then(outcome => {
    assert.equal(outcome.applied, false, "a refused punishment must not be reported as a success");
    assert.equal(outcome.detail, "hierarchy");
    assert.equal(outcome.ownerNotified, true);
  });
});

test("a thrown punishment does not abort the notification", () => {
  return mitigateNuke(
    incident,
    armed,
    deps({
      removeRoles: async () => {
        throw new Error("Discord is down");
      }
    })
  ).then(outcome => {
    assert.equal(outcome.applied, false);
    assert.equal(outcome.ownerNotified, true);
  });
});

test("a failed DM is reported rather than thrown", () => {
  return mitigateNuke(incident, armed, deps({ notifyOwner: async () => false })).then(outcome => {
    assert.equal(outcome.ownerNotified, false);
    assert.equal(outcome.applied, true, "a closed DM must not undo the punishment");
  });
});

test("the punishment is read from the protection that tripped", () => {
  const cfg = {
    ...armed,
    protections: { ...armed.protections, "channel-delete": { ...armed.protections["channel-delete"], punishment: "ban" as const } }
  };
  let banned = false;
  return mitigateNuke(incident, cfg, deps({ ban: async () => { banned = true; return { ok: true, detail: "banned" }; } })).then(outcome => {
    assert.equal(banned, true, "the ban punishment must run when the protection asks for it");
    assert.equal(outcome.punishment, "ban");
  });
});

/* ------------------------------------------------------------------ *
 * The engine, end to end
 * ------------------------------------------------------------------ */

function makeEngine(overrides: Partial<AntiNukeConfig> = {}, deps: Partial<Parameters<typeof createAntiNukeEngine>[0]> = {}) {
  const calls = { punish: 0, notify: 0, report: 0 };
  const config: AntiNukeConfig = { ...armed, ...overrides };
  let current = 1_000_000;
  const punish = async () => {
    calls.punish += 1;
    return { ok: true, detail: "done" };
  };

  const engine = createAntiNukeEngine(
    {
      configFor: async () => config,
      ban: punish,
      kick: punish,
      timeout: punish,
      removeRoles: punish,
      warn: punish,
      notifyOwner: async () => {
        calls.notify += 1;
        return true;
      },
      report: async () => {
        calls.report += 1;
      },
      ...deps
    },
    { now: () => current, windowMs: 60_000 }
  );

  return { engine, calls, advance: (ms: number) => (current += ms) };
}

test("a disarmed engine observes but never acts", async () => {
  const { engine, calls } = makeEngine({ enabled: false });
  for (let i = 0; i < 5; i += 1) {
    assert.equal(await engine.observe(channelDelete()), null);
  }
  assert.deepEqual(calls, { punish: 0, notify: 0, report: 0 });
});

test("an exempt member is not counted, and cannot trip the shared budget", async () => {
  const exempt = {
    ...DEFAULT_PROTECTION_SETTINGS,
    "channel-delete": { enabled: true, windowSeconds: 600, punishment: "remove-roles" as const, timeoutSeconds: 600, exceptions: [ACTOR] }
  };
  const { engine, calls } = makeEngine({ protections: exempt });

  for (let i = 0; i < 10; i += 1) {
    assert.equal(await engine.observe(channelDelete(ACTOR)), null, "an exempt member is never counted");
  }
  assert.deepEqual(calls, { punish: 0, notify: 0, report: 0 }, "an exemption cannot end in a punishment");

  // The exemption is not a shield for everybody: the same actions from somebody
  // else still count from zero and trip the limit they would have tripped.
  assert.equal(await engine.observe(channelDelete(OTHER)), null);
  assert.equal(await engine.observe(channelDelete(OTHER)), null);
  const tripped = await engine.observe(channelDelete(OTHER));
  assert.ok(tripped, "a non-exempt actor still trips a limit of two on the third action");
  assert.equal(calls.punish, 1);
});

test("an exemption on one protection does not cover another", async () => {
  const exempt = {
    ...DEFAULT_PROTECTION_SETTINGS,
    "channel-delete": { enabled: true, windowSeconds: 600, punishment: "remove-roles" as const, timeoutSeconds: 600, exceptions: [ACTOR] }
  };
  const { engine, calls } = makeEngine({ protections: exempt });

  const ban = (): BotEvent => ({ type: "moderation.ban", guildId: GUILD, targetId: OTHER, actorId: ACTOR });
  await engine.observe(ban());
  await engine.observe(ban());
  await engine.observe(ban());
  const outcome = await engine.observe(ban());
  assert.ok(outcome, "banning has its own exception list, and this one is empty");
  assert.equal(calls.punish, 1);
});

test("a protection switched off is not counted, while the others keep counting", async () => {
  const off = { ...DEFAULT_PROTECTION_SETTINGS, "channel-delete": { enabled: false, windowSeconds: 600, punishment: "remove-roles" as const, timeoutSeconds: 600, exceptions: [] } };
  const { engine, calls } = makeEngine({ protections: off });

  for (let i = 0; i < 6; i += 1) {
    assert.equal(await engine.observe(channelDelete()), null, "channel deletion is off, so nothing accumulates");
  }
  assert.deepEqual(calls, { punish: 0, notify: 0, report: 0 }, "an off protection cannot trip");

  // The gate asks about the *event's* protection, not about the budget it feeds.
  // Turning role creation off must not silence role deletion, which shares that
  // budget — the operator who disabled one still expects the other caught.
  const roleOff = { ...DEFAULT_PROTECTION_SETTINGS, "role-create": { enabled: false, windowSeconds: 600, punishment: "remove-roles" as const, timeoutSeconds: 600, exceptions: [] } };
  const other = makeEngine({ protections: roleOff });
  const roleDelete = (): BotEvent => ({ type: "role.delete", guildId: GUILD, roleId: "r", actorId: ACTOR });
  assert.equal(await other.engine.observe({ type: "role.create", guildId: GUILD, roleId: "r", actorId: ACTOR }), null);
  await other.engine.observe(roleDelete());
  await other.engine.observe(roleDelete());
  const outcome = await other.engine.observe(roleDelete());
  assert.ok(outcome, "the third deletion trips a limit of two, creation being off included");
});

test("an armed engine mitigates and reports once the burst crosses the limit", async () => {
  const { engine, calls } = makeEngine();

  assert.equal(await engine.observe(channelDelete()), null, "the first deletion is within the limit");
  assert.equal(await engine.observe(channelDelete()), null, "the second is at the limit");
  const outcome = await engine.observe(channelDelete());

  assert.ok(outcome, "the third crosses a limit of two");
  assert.equal(calls.punish, 1);
  assert.equal(calls.notify, 1);
  assert.equal(calls.report, 1);
});

test("a further action after mitigation is silent", async () => {
  const { engine, calls } = makeEngine();
  for (let i = 0; i < 4; i += 1) await engine.observe(channelDelete());

  assert.equal(calls.report, 1, "one incident produces one record, not one per action");
  assert.equal(calls.notify, 1, "and one message to the owner");
});

test("the bot never trips its own limit", async () => {
  // Its role creation on invite would otherwise look like an attack on a busy
  // server, and it would quarantine itself.
  const { engine, calls } = makeEngine({}, { selfId: () => ACTOR });
  for (let i = 0; i < 5; i += 1) await engine.observe(channelDelete(ACTOR));
  assert.equal(calls.report, 0);
});

test("events with no actor are ignored", async () => {
  const { engine, calls } = makeEngine();
  await engine.observe({ type: "message.delete", guildId: GUILD, messageId: "m", channelId: "c" });
  assert.equal(calls.report, 0);
});

test("an unreadable config leaves the guild unguarded rather than guessed", async () => {
  const { engine, calls } = makeEngine(
    {},
    {
      configFor: async () => {
        throw new Error("database is down");
      }
    }
  );
  assert.equal(await engine.observe(channelDelete()), null);
  assert.equal(calls.punish, 0, "acting on a guessed config would strip roles for no reason");
});

test("a failing report never escapes into the event path", async () => {
  // This runs in front of the logger; an exception here would be a security tool
  // taking down the audit trail it exists to protect.
  const { engine } = makeEngine(
    {},
    {
      report: async () => {
        throw new Error("audit trail unavailable");
      }
    }
  );
  await engine.observe(channelDelete());
  await engine.observe(channelDelete());
  await assert.doesNotReject(engine.observe(channelDelete()));
});

/* ------------------------------------------------------------------ *
 * Owner alert wording
 * ------------------------------------------------------------------ */

test("the owner is told what happened and what was done", () => {
  const message = ownerAlert(incident, { punishment: "remove-roles", applied: true, detail: "roles removed" });
  assert.match(message, new RegExp(ACTOR), "the actor is named");
  assert.match(message, /remove-roles/);
  assert.match(message, /نُفِّذت/);
});

test("the owner is told when the punishment was refused", () => {
  const message = ownerAlert(incident, { punishment: "ban", applied: false, detail: "hierarchy" });
  assert.match(message, /ban/);
  assert.match(message, /فشلت/);
  assert.match(message, /hierarchy/);
});

test("the default config is armed", () => {
  // The owner decided the engine ships on: the cost of a forgotten setting is a
  // wiped server, so protection is the default and disarming is deliberate.
  assert.equal(DEFAULT_ANTI_NUKE_CONFIG.enabled, true);
});
