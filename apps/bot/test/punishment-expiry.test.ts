import test from "node:test";
import assert from "node:assert/strict";
import { sweepExpiredDowns, type ExpirySweep } from "../src/punishments/expiry.ts";
import type { MemberState } from "../src/storage/database.ts";

/**
 * One due state, in the shape `guild_member_states` returns.
 *
 * Built from the real `MemberState` type rather than a hand-written object
 * literal, so a column added to the table makes this fail to compile instead of
 * silently dropping out of the sweep.
 */
function dueDown(overrides: Partial<MemberState> = {}): MemberState {
  return {
    id: "state-1",
    guildId: "guild-1",
    userId: "member-1",
    kind: "down",
    roleIds: ["role-a", "role-b"],
    blockedRoleIds: [],
    moderatorId: "moderator-1",
    reason: "إساءة إدارية",
    expiresAt: new Date("2026-09-16T00:00:00Z"),
    createdAt: new Date("2026-09-15T00:00:00Z"),
    ...overrides
  };
}

/**
 * A sweep over a fixed set of due states, with every call recorded.
 *
 * The collaborators are fakes on purpose: what is under test is the decision —
 * which states are acted on, what is consumed, and what gets written down — not
 * Discord's API or Postgres.
 */
function harness(due: MemberState[], restore?: ExpirySweep["restore"]) {
  const consumed: string[] = [];
  const recorded: { userId: string; restored: number; failed: number }[] = [];

  const sweep: ExpirySweep = {
    due: async () => due,
    restore: restore ?? (async state => ({ ok: true, changed: state.roleIds, failed: [] })),
    consume: async state => {
      consumed.push(state.userId);
    },
    record: async (state, counts) => {
      recorded.push({ userId: state.userId, ...counts });
    }
  };

  return { sweep, consumed, recorded };
}

test("an expired /down gives the roles back, consumes the state and records both counts", async () => {
  const state = dueDown();
  const { sweep, consumed, recorded } = harness([state]);

  const outcome = await sweepExpiredDowns(sweep);

  assert.deepEqual(consumed, ["member-1"], "the snapshot is handed back exactly once");
  assert.deepEqual(recorded, [{ userId: "member-1", restored: 2, failed: 0 }]);
  assert.deepEqual(outcome, { expired: 1, restored: 2, failed: 0 });
});

test("a state with another kind is left alone entirely", async () => {
  // A mute with a stray expiry is the case this guard exists for. Acting on it
  // would grant roles the member never lost, from a snapshot that a mute does not
  // even take — so it must not be restored, consumed, or written to the log.
  const mute = dueDown({ kind: "mute", roleIds: [] });
  const { sweep, consumed, recorded } = harness([mute]);

  const outcome = await sweepExpiredDowns(sweep);

  assert.deepEqual(consumed, [], "nothing was consumed");
  assert.deepEqual(recorded, [], "nothing was recorded");
  assert.deepEqual(outcome, { expired: 0, restored: 0, failed: 0 });
});

test("a restore that fails outright still consumes the state, and says so", async () => {
  // The failure has to be visible. Consuming the state is deliberate: retrying a
  // member who left, or a role that was deleted, would repeat the same failure
  // every minute and bury the entry worth reading.
  const { sweep, consumed, recorded } = harness([dueDown()], async () => ({ ok: false, reason: "MEMBER_NOT_FOUND" }));

  const outcome = await sweepExpiredDowns(sweep);

  assert.deepEqual(consumed, ["member-1"], "the state is consumed rather than retried forever");
  assert.deepEqual(
    recorded,
    [{ userId: "member-1", restored: 0, failed: 2 }],
    "the whole snapshot counts as unrestored — a clean-looking 0/0 would hide the failure"
  );
  assert.deepEqual(outcome, { expired: 1, restored: 0, failed: 2 });
});

test("a partial restore reports both numbers rather than reading as a clean expiry", async () => {
  const { sweep, recorded } = harness([dueDown()], async () => ({
    ok: true,
    changed: ["role-a"],
    failed: ["role-b"]
  }));

  const outcome = await sweepExpiredDowns(sweep);

  assert.deepEqual(recorded, [{ userId: "member-1", restored: 1, failed: 1 }]);
  assert.deepEqual(outcome, { expired: 1, restored: 1, failed: 1 });
});

test("a read that throws is one empty pass, not an unhandled rejection", async () => {
  // This runs inside an interval. An exception escaping here would be an
  // unhandled rejection in a timer, which is a process-level failure rather than
  // a missed sweep.
  const consumed: string[] = [];
  const outcome = await sweepExpiredDowns({
    due: async () => {
      throw new Error("connection terminated");
    },
    restore: async () => ({ ok: true, changed: [], failed: [] }),
    consume: async state => {
      consumed.push(state.userId);
    },
    record: async () => undefined
  });

  assert.deepEqual(outcome, { expired: 0, restored: 0, failed: 0 });
  assert.deepEqual(consumed, []);
});

test("several due states are all handled in one pass", async () => {
  const states = [dueDown({ userId: "member-1" }), dueDown({ userId: "member-2", id: "state-2" })];
  const { sweep, consumed } = harness(states);

  const outcome = await sweepExpiredDowns(sweep);

  assert.deepEqual(consumed, ["member-1", "member-2"]);
  assert.deepEqual(outcome, { expired: 2, restored: 4, failed: 0 });
});
