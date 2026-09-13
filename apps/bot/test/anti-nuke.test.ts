import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_ANTI_NUKE_CONFIG, type AntiNukeConfig } from "@al-ai/core";
import {
  createAntiNukeEngine,
  createAntiNukeTracker,
  mitigateNuke,
  nukeActionOf,
  ownerAlert,
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

const limits = { channelDeletesPerMinute: 2, bansPerMinute: 3, roleChangesPerMinute: 2 };

const armed: AntiNukeConfig = {
  enabled: true,
  limits,
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
  assert.deepEqual(nukeActionOf(channelDelete()), { action: "channel-delete", guildId: GUILD, actorId: ACTOR });
  assert.equal(nukeActionOf({ type: "moderation.ban", guildId: GUILD, targetId: "t", actorId: ACTOR })?.action, "ban");
  assert.equal(nukeActionOf({ type: "role.create", guildId: GUILD, roleId: "r", actorId: ACTOR })?.action, "role-change");
  assert.equal(nukeActionOf({ type: "role.delete", guildId: GUILD, roleId: "r", actorId: ACTOR })?.action, "role-change");
});

test("ordinary events are not treated as destructive", () => {
  for (const event of [
    { type: "member.join", guildId: GUILD, memberId: "m" },
    { type: "message.delete", guildId: GUILD, messageId: "m", channelId: "c" },
    { type: "server.channel-create", guildId: GUILD, channelId: "c", actorId: ACTOR },
    { type: "client.ready", tag: "AL AI#0001", guildCount: 1 }
  ] as BotEvent[]) {
    assert.equal(nukeActionOf(event), null, `${event.type} must not be watched`);
  }
});

/* ------------------------------------------------------------------ *
 * Mitigation
 * ------------------------------------------------------------------ */

const incident: NukeIncident = { guildId: GUILD, actorId: ACTOR, action: "channel-delete", count: 3, limit: 2 };

test("the actor is neutralised before the owner is told", () => {
  // Reversing this leaves the attacker active for a network round trip, which is
  // exactly when they would delete the rest.
  const order: string[] = [];
  return mitigateNuke(incident, armed, {
    quarantine: async () => {
      order.push("quarantine");
      return 4;
    },
    notifyOwner: async () => {
      order.push("notify");
      return true;
    }
  }).then(outcome => {
    assert.deepEqual(order, ["quarantine", "notify"]);
    assert.equal(outcome.quarantined, 4);
    assert.equal(outcome.ownerNotified, true);
  });
});

test("a failed quarantine still notifies the owner", () => {
  return mitigateNuke(incident, armed, {
    quarantine: async () => null,
    notifyOwner: async () => true
  }).then(outcome => {
    assert.equal(outcome.quarantined, null, "a failed strip must not be reported as a success");
    assert.equal(outcome.ownerNotified, true, "the owner still needs to know");
  });
});

test("a thrown quarantine does not abort the notification", () => {
  return mitigateNuke(incident, armed, {
    quarantine: async () => {
      throw new Error("Discord is down");
    },
    notifyOwner: async () => true
  }).then(outcome => {
    assert.equal(outcome.quarantined, null);
    assert.equal(outcome.ownerNotified, true);
  });
});

test("without a quarantine role no roles are touched, but the owner is still told", () => {
  let touched = false;
  return mitigateNuke(incident, { ...armed, quarantineRoleId: null }, {
    quarantine: async () => {
      touched = true;
      return 1;
    },
    notifyOwner: async () => true
  }).then(outcome => {
    assert.equal(touched, false, "no role was configured, so none may be stripped");
    assert.equal(outcome.quarantined, null);
    assert.equal(outcome.ownerNotified, true);
  });
});

test("a failed DM is reported rather than thrown", () => {
  return mitigateNuke(incident, armed, {
    quarantine: async () => 2,
    notifyOwner: async () => false
  }).then(outcome => {
    assert.equal(outcome.ownerNotified, false);
    assert.equal(outcome.quarantined, 2, "a closed DM must not undo the quarantine");
  });
});

/* ------------------------------------------------------------------ *
 * The engine, end to end
 * ------------------------------------------------------------------ */

function makeEngine(overrides: Partial<AntiNukeConfig> = {}, deps: Partial<Parameters<typeof createAntiNukeEngine>[0]> = {}) {
  const calls = { quarantine: 0, notify: 0, report: 0 };
  const config: AntiNukeConfig = { ...armed, ...overrides };
  let current = 1_000_000;

  const engine = createAntiNukeEngine(
    {
      configFor: async () => config,
      quarantine: async () => {
        calls.quarantine += 1;
        return 5;
      },
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
  assert.deepEqual(calls, { quarantine: 0, notify: 0, report: 0 });
});

test("an armed engine mitigates and reports once the burst crosses the limit", async () => {
  const { engine, calls } = makeEngine();

  assert.equal(await engine.observe(channelDelete()), null, "the first deletion is within the limit");
  assert.equal(await engine.observe(channelDelete()), null, "the second is at the limit");
  const outcome = await engine.observe(channelDelete());

  assert.ok(outcome, "the third crosses a limit of two");
  assert.equal(calls.quarantine, 1);
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
  assert.equal(calls.quarantine, 0, "acting on a guessed config would strip roles for no reason");
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
  const message = ownerAlert(incident, { quarantined: 4 });
  assert.match(message, new RegExp(ACTOR), "the actor is named");
  assert.match(message, /4/, "how many roles were stripped");
  assert.match(message, /رتبة الحجر/);
});

test("the owner is told when no quarantine role is configured", () => {
  // Otherwise a half-configured engine looks identical to a working one.
  const message = ownerAlert(incident, { quarantined: null });
  assert.match(message, /لم تُسحب رتبه/);
  assert.match(message, /رتبة حجر/);
});

test("the default config is armed", () => {
  // The owner decided the engine ships on: the cost of a forgotten setting is a
  // wiped server, so protection is the default and disarming is deliberate.
  assert.equal(DEFAULT_ANTI_NUKE_CONFIG.enabled, true);
});
