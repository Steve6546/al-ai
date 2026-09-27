/**
 * Which invite brought a member in.
 *
 * Discord names no invite on a join — the gateway event says only that the
 * member arrived. The one observable difference is in the guild's invite list
 * itself: the invite that was used comes back with a higher use count. So the
 * tracker holds one snapshot per guild, built from `inviteCreate` reports and
 * refreshed by each fetch, and attribution is the diff between the snapshot a
 * join started from and the fetch that join triggered.
 *
 * Held in memory only. A restart forgets the baseline, which means the first
 * join after a boot is logged but unattributed: the fetch it triggered becomes
 * the new baseline, and every join after it carries an invite code. Guessing an
 * attribution for a join nobody diffed would put a fabricated code in the log.
 */
export type TrackedInvite = {
  code: string;
  /** Discord's own id of the member who created it, if the invite carried one. */
  inviterId: string | null;
  /** How many times the invite has been used when it was last observed. */
  uses: number;
};

/**
 * The pure half of attribution: given the snapshot a join started from and the
 * list the join's fetch returned, name the invite whose use count rose.
 *
 * Ties resolve to the largest rise, and a code absent from the previous
 * snapshot never wins — an invite created between the two observations cannot
 * have been the one that brought this member in. Two joins in flight between
 * one fetch and the next are the unsolvable case: both counts rose, the rise is
 * split across members, and the largest one is reported. The join is logged
 * either way; only the attribution can be ambiguous.
 */
export function detectUsedInvite(previous: readonly TrackedInvite[] | undefined, fetched: readonly TrackedInvite[]): string | null {
  if (!previous) return null;
  const before = new Map(previous.map(invite => [invite.code, invite.uses]));
  let best: { code: string; rise: number } | null = null;
  for (const invite of fetched) {
    const was = before.get(invite.code);
    if (was === undefined) continue;
    const rise = invite.uses - was;
    if (rise > 0 && (!best || rise > best.rise)) best = { code: invite.code, rise };
  }
  return best?.code ?? null;
}

export function createInviteTracker() {
  const guilds = new Map<string, Map<string, TrackedInvite>>();

  return {
    /** Records an invite as `inviteCreate` reported it, into its guild's snapshot. */
    remember(guildId: string, invite: TrackedInvite) {
      const snapshot = guilds.get(guildId) ?? new Map<string, TrackedInvite>();
      snapshot.set(invite.code, invite);
      guilds.set(guildId, snapshot);
    },
    /** Drops an invite `inviteDelete` already reported. */
    forget(guildId: string, code: string) {
      guilds.get(guildId)?.delete(code);
    },
    /** How many invites are currently held, across every guild. */
    size() {
      let total = 0;
      for (const snapshot of guilds.values()) total += snapshot.size;
      return total;
    },
    /**
     * Diffs the guild's held snapshot against a fresh fetch, stores the fetch as
     * the new snapshot, and returns the code whose use count rose — or null when
     * there was no snapshot to diff against, which is the honest "cannot
     * attribute yet" rather than a guess.
     */
    observe(guildId: string, fetched: readonly TrackedInvite[]): string | null {
      const previous = guilds.get(guildId);
      const code = detectUsedInvite(previous ? [...previous.values()] : undefined, fetched);
      guilds.set(guildId, new Map(fetched.map(invite => [invite.code, invite])));
      return code;
    }
  };
}

export type InviteTracker = ReturnType<typeof createInviteTracker>;
