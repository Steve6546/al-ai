/**
 * Replies waiting to be withdrawn when the member they acted on leaves.
 *
 * Extracted from `bindEvents` so the two things that actually decide its
 * behaviour — the fifteen-minute window and the (guild, member) key — can be
 * tested. Inside the event binder they were unreachable: the clock was
 * `Date.now()` and the map was a closure variable, so the only way to observe
 * an expiry would have been to wait fifteen minutes.
 *
 * No discord.js import lives here on purpose. GOVERNANCE rule 2 keeps every
 * Discord call in one file; this module decides *whether* to withdraw, and the
 * caller supplies the withdrawal itself.
 */

/**
 * How long a reply stays withdrawable.
 *
 * Not a preference: an interaction reply is ephemeral, and Discord accepts
 * `deleteReply` only while the interaction token lives — fifteen minutes. Past
 * that the message is already gone along with the token, so a longer window
 * would queue work that cannot succeed.
 */
export const RETRACTION_WINDOW_MS = 15 * 60 * 1000;

type PendingRetraction = {
  /** The withdrawal itself. Supplied by the caller; never called from `remember`. */
  retract: () => Promise<void>;
  expiresAt: number;
};

export type RetractionRegistry = {
  /** Records a reply to withdraw if `memberId` leaves `guildId` within the window. */
  remember: (guildId: string, memberId: string, retract: () => Promise<void>) => void;
  /**
   * Withdraws everything recorded for this member and forgets them.
   *
   * Returns how many withdrawals were actually attempted, which is what makes
   * "the entry had already expired" distinguishable from "there was never an
   * entry" — from outside, both are a silent no-op.
   */
  retract: (guildId: string, memberId: string) => Promise<number>;
  /** How many entries are currently held. For tests and diagnostics. */
  pending: () => number;
};

/**
 * A registry over an injectable clock.
 *
 * The clock is a parameter rather than `Date.now()` read inline so the window
 * can be tested at its boundary. A boundary test that needs fifteen real
 * minutes is a test nobody runs.
 */
export function createRetractionRegistry(options: { now?: () => number } = {}): RetractionRegistry {
  const now = options.now ?? (() => Date.now());
  const pending = new Map<string, PendingRetraction[]>();

  /**
   * Guild and member together, never the member alone.
   *
   * Discord ids are unique per entity, not per guild: the same snowflake can be
   * a member of two guilds AL AI is in, and a reply owed to one guild's
   * operator must not be withdrawn because that person left the other one.
   */
  const keyFor = (guildId: string, memberId: string) => `${guildId}:${memberId}`;

  /** Drops what can no longer be withdrawn. Applied on the way in and out. */
  function live(entries: PendingRetraction[], at: number): PendingRetraction[] {
    return entries.filter(entry => entry.expiresAt > at);
  }

  return {
    remember(guildId, memberId, retract) {
      const at = now();
      const key = keyFor(guildId, memberId);
      // Pruned before appending, not after: a member who is punished repeatedly
      // would otherwise accumulate dead entries for as long as the process runs,
      // and each one is an interaction object held alive.
      const entries = live(pending.get(key) ?? [], at);
      entries.push({ retract, expiresAt: at + RETRACTION_WINDOW_MS });
      pending.set(key, entries);
    },

    async retract(guildId, memberId) {
      const key = keyFor(guildId, memberId);
      const entries = pending.get(key);
      // Deleted before the loop, not after: a withdrawal that rejects must not
      // leave the entry behind to be retried on every later departure.
      pending.delete(key);
      if (!entries) return 0;

      const at = now();
      let attempted = 0;
      for (const entry of live(entries, at)) {
        attempted += 1;
        // One failing withdrawal must not abandon the rest — and must not
        // propagate, because this runs from an event handler where a rejection
        // would surface as an unhandled one.
        await entry.retract().catch(() => undefined);
      }
      return attempted;
    },

    pending() {
      const at = now();
      let count = 0;
      for (const entries of pending.values()) count += live(entries, at).length;
      return count;
    }
  };
}
