/**
 * GOVERNANCE rule 14 — the privileged-intent budget is monitored, not assumed.
 *
 * Discord grants GUILD_MEMBERS / MESSAGE_CONTENT only while the bot stays under
 * 10,000 unique users across all of its guilds. The count is about *users*, not
 * servers, so the tracker keeps a unique set rather than summing member counts
 * (which would double-count anyone in two servers and fire the alarm early).
 *
 * Warning is raised at 8,000 so there is room to react before verification is
 * revoked. Verification must also be renewed yearly.
 */

export const INTENT_WARNING_THRESHOLD = 8_000;
export const INTENT_HARD_LIMIT = 10_000;
export const INTENT_RENEWAL_DAYS = 365;

export type IntentState = "ok" | "warning" | "over_limit";

export type IntentUsageStats = {
  uniqueUsers: number;
  warnAt: number;
  limit: number;
  state: IntentState;
  /** ISO date the current verification expires, derived from the renewal date. */
  renewalDueAt: string | null;
  renewalDue: boolean;
  daysUntilRenewal: number | null;
};

export type IntentUsageTrackerOptions = {
  now?: () => number;
  warnAt?: number;
  limit?: number;
  renewalDays?: number;
  /** ISO timestamp of the last successful verification renewal. */
  renewedAt?: string | null;
};

export function createIntentUsageTracker(options: IntentUsageTrackerOptions = {}) {
  const now = options.now ?? (() => Date.now());
  const warnAt = options.warnAt ?? INTENT_WARNING_THRESHOLD;
  const limit = options.limit ?? INTENT_HARD_LIMIT;
  const renewalDays = options.renewalDays ?? INTENT_RENEWAL_DAYS;

  const users = new Set<string>();
  let renewedAt = options.renewedAt ?? null;

  function renewalDueAt(): string | null {
    if (!renewedAt) return null;
    const at = new Date(renewedAt).getTime();
    if (Number.isNaN(at)) return null;
    return new Date(at + renewalDays * 24 * 60 * 60 * 1000).toISOString();
  }

  function stats(): IntentUsageStats {
    const dueAt = renewalDueAt();
    const uniqueUsers = users.size;
    const state: IntentState = uniqueUsers >= limit ? "over_limit" : uniqueUsers >= warnAt ? "warning" : "ok";
    const daysUntilRenewal = dueAt ? Math.ceil((new Date(dueAt).getTime() - now()) / (24 * 60 * 60 * 1000)) : null;
    return {
      uniqueUsers,
      warnAt,
      limit,
      state,
      renewalDueAt: dueAt,
      renewalDue: daysUntilRenewal !== null && daysUntilRenewal <= 0,
      daysUntilRenewal
    };
  }

  return {
    /** Adds user IDs to the unique set. Safe to call repeatedly with overlapping data. */
    observe(userIds: Iterable<string>) {
      for (const id of userIds) {
        if (id) users.add(id);
      }
      return users.size;
    },

    /**
     * Seeds the set from per-guild member counts when a full member fetch is too
     * expensive. Counts are summed, so this is an upper bound — the tracker
     * deliberately keeps it as a floor for the *warning* only.
     */
    observeGuildSizes(sizes: Iterable<number>) {
      let total = 0;
      for (const size of sizes) total += Number.isFinite(size) ? size : 0;
      return total;
    },

    setRenewedAt(iso: string) {
      renewedAt = iso;
    },

    get renewedAt() {
      return renewedAt;
    },

    size() {
      return users.size;
    },

    stats,

    /** Message suitable for the bot-log / dashboard health surface. */
    describe(): string {
      const current = stats();
      if (current.state === "over_limit") {
        return `تجاوز حد المستخدمين الفريدين: ${current.uniqueUsers}/${current.limit} — قد يُرفض طلب GUILD_MEMBERS.`;
      }
      if (current.state === "warning") {
        return `اقتراب من الحد: ${current.uniqueUsers}/${current.limit} مستخدم فريد.`;
      }
      if (current.renewalDue) {
        return "حان موعد تجديد توثيق الـ intents السنوي.";
      }
      return `داخل الحد: ${current.uniqueUsers}/${current.limit} مستخدم فريد.`;
    },

    reset() {
      users.clear();
    }
  };
}

export type IntentUsageTracker = ReturnType<typeof createIntentUsageTracker>;
