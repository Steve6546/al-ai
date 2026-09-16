import type { RoleActionResult } from "../lib/discord.js";
import type { MemberState } from "../storage/database.js";

/**
 * Ending a punishment that carries a length.
 *
 * Kept out of the interval that drives it so the behaviour can be tested without
 * a live client, a real database or a clock. The interval in `index.ts` supplies
 * the collaborators; everything that decides *what happens* is here.
 *
 * Only `/down` has a length. A mute, a prison, a blacklist and a block are states
 * a person ends, and their `expires_at` is null — so a row that arrives here with
 * another kind is skipped rather than guessed at. That guard is the reason this
 * is a function and not three lines in a timer: a future punishment that gains a
 * duration has to say what ending it means, instead of silently inheriting the
 * `/down` restore and handing back roles the member never lost.
 */
export type ExpirySweep = {
  /** The states whose time is up, oldest first. */
  due: () => Promise<MemberState[]>;
  /** Gives the snapshot back. Failure is an outcome, not an exception. */
  restore: (state: MemberState) => Promise<RoleActionResult>;
  /** Removes the state. Called whether or not the restore worked. */
  consume: (state: MemberState) => Promise<void>;
  /** Writes the outcome down. */
  record: (state: MemberState, counts: { restored: number; failed: number }) => Promise<unknown>;
};

/** What one pass did, as counts — so the caller can log it without re-reading. */
export type ExpiryOutcome = { expired: number; restored: number; failed: number };

/**
 * One pass.
 *
 * The state is consumed whatever the restore did, matching `/unprison`: the
 * snapshot is handed back exactly once. Retrying would mean a member who left the
 * server, or a role deleted in the meantime, filling the log with the same
 * failure every minute and burying the entry that actually needs reading.
 *
 * The cost is that a restore blocked by a permission problem is not retried
 * either — so both numbers are reported, and a partial restore cannot read as a
 * clean expiry.
 */
export async function sweepExpiredDowns(sweep: ExpirySweep): Promise<ExpiryOutcome> {
  // A read that fails is not a reason to stop the loop: the next tick tries
  // again, and an unhandled rejection inside an interval takes the process down.
  const due = await sweep.due().catch(() => [] as MemberState[]);

  let expired = 0;
  let restored = 0;
  let failed = 0;

  for (const state of due) {
    if (state.kind !== "down") continue;

    const result = await sweep.restore(state);
    const counts = result.ok
      ? { restored: result.changed.length, failed: result.failed.length }
      : // Nothing came back, and every role in the snapshot is still missing —
        // reporting 0 here would hide the whole failure behind a clean-looking
        // "expired" line.
        { restored: 0, failed: state.roleIds.length };

    await sweep.consume(state).catch(() => undefined);
    await sweep.record(state, counts).catch(() => undefined);

    expired += 1;
    restored += counts.restored;
    failed += counts.failed;
  }

  return { expired, restored, failed };
}
