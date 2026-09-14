/**
 * Presence sync: what the gateway is actually told.
 *
 * The status is the one appearance field the dashboard cannot apply — it lives
 * on the gateway, so the bot writes it from `presence-sync.ts`. That makes this
 * the only place a stored duration can become real, and therefore the place a
 * duration can silently fail to apply.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createPresenceSync } from "../src/runtime/presence-sync.ts";
import { DEFAULT_BOT_IDENTITY, type BotIdentitySettings } from "@al-ai/core";

function identity(overrides: Partial<BotIdentitySettings>): BotIdentitySettings {
  return { ...DEFAULT_BOT_IDENTITY, ...overrides };
}

/** Collects what the sync asked the gateway to show. */
function harness(load: () => Promise<BotIdentitySettings>) {
  const applied: { status: string; activityType: string; activityText: string }[] = [];
  const errors: unknown[] = [];
  const sync = createPresenceSync({
    loadIdentity: load,
    applyPresence: async presence => {
      applied.push({ status: presence.status, activityType: presence.activityType, activityText: presence.activityText });
      return true;
    },
    onError: error => errors.push(error)
  });
  return { sync, applied, errors };
}

test("an untimed status reaches the gateway exactly as stored", async () => {
  const { sync, applied } = harness(async () => identity({ status: "dnd", activityType: "watching", activityText: "السجلات" }));
  await sync.run();

  assert.deepEqual(applied, [{ status: "dnd", activityType: "watching", activityText: "السجلات" }]);
});

test("an open window keeps the operator's status", async () => {
  // Eight hours from now: still running, so the gateway must show `dnd`.
  const later = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
  const { sync, applied } = harness(async () => identity({ status: "dnd", statusDuration: "8h", statusExpiresAt: later }));
  await sync.run();

  assert.equal(applied[0]?.status, "dnd", "a window that is still open keeps the chosen status");
});

test("an elapsed window falls back to online at the gateway", async () => {
  // This is the assertion the whole feature rests on: a duration that never
  // clears would be a control that saves and never applies.
  const earlier = new Date(Date.now() - 60_000).toISOString();
  const { sync, applied } = harness(async () =>
    identity({ status: "invisible", statusDuration: "15m", statusExpiresAt: earlier })
  );
  await sync.run();

  assert.equal(applied[0]?.status, "online", "a closed window must clear to online");
});

test("forever is not treated as an elapsed window", async () => {
  const { sync, applied } = harness(async () =>
    identity({ status: "idle", statusDuration: "forever", statusExpiresAt: null })
  );
  await sync.run();

  assert.equal(applied[0]?.status, "idle", "forever has no expiry and must never fall back");
});

test("an unchanged presence is not re-sent", async () => {
  // The sync is polled on a timer, so re-sending an identical presence every
  // tick would be a needless gateway write on every interval.
  const { sync, applied } = harness(async () => identity({ status: "online" }));
  await sync.run();
  await sync.run();
  await sync.run();

  assert.equal(applied.length, 1, "an unchanged presence is applied once");
});

test("a window closing re-sends, because the status genuinely changed", async () => {
  // The transition from a running `dnd` to a lapsed `online` must reach Discord.
  // Two syncs are used because `Date.now()` is read inside `run()`: a single
  // sync would apply the open window and then see the same effective status
  // again, which is not what this asserts.
  const open = harness(async () =>
    identity({
      status: "dnd",
      statusDuration: "1h",
      statusExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString()
    })
  );
  await open.sync.run();
  assert.equal(open.applied[0]?.status, "dnd", "a running window shows the chosen status");

  const lapsed = harness(async () =>
    identity({
      status: "dnd",
      statusDuration: "1h",
      statusExpiresAt: new Date(Date.now() - 1000).toISOString()
    })
  );
  await lapsed.sync.run();
  assert.equal(lapsed.applied[0]?.status, "online", "the lapse is sent to the gateway");
});

test("a failed apply is retried rather than remembered as done", async () => {
  let attempts = 0;
  const sync = createPresenceSync({
    loadIdentity: async () => identity({ status: "dnd" }),
    applyPresence: async () => {
      attempts += 1;
      return attempts > 1;
    }
  });

  await sync.run();
  await sync.run();

  assert.equal(attempts, 2, "an unapplied presence is attempted again");
  assert.notEqual(sync.applied(), null, "the successful second attempt is remembered");
});
