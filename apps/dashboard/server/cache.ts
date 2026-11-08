/**
 * Memoisation and request throttling for the dashboard's Discord reads.
 *
 * GOVERNANCE rule 27 — never spend a Discord request on data this process
 * already holds. This module is where that rule is implemented for the BFF: the
 * TTLs below are the bound on staleness, and `resolve` coalesces concurrent
 * callers so a burst becomes one request rather than one per screen.
 *
 * WHY THIS EXISTS
 *
 * Every screen that shows a guild reads the same two Discord lists — its roles
 * and its channels — and several screens read them at once. Navigating between
 * tabs therefore fired a burst of identical requests at Discord, which answered
 * `429 Too Many Requests`. That was reported as "the dashboard breaks when I
 * move between tabs": Discord was rate limiting AL AI, not the operator.
 *
 * Discord rate-limits per *application*, not per route, so this is not an
 * optimisation — a burst here also degrades the bot's own calls.
 *
 * Two mechanisms fix it, and they are deliberately separate:
 *
 * - `TtlCache` removes the repeated *reads*. Roles and channels change on the
 *   scale of minutes, so answering from memory for a minute costs nothing and
 *   removes almost every call. The window itself lives beside each cache in
 *   `discord.ts` (`GUILD_READ_CACHE_MS`), because that is where it can be read
 *   against the write that invalidates it.
 * - `RequestThrottle` bounds the *unauthenticated* traffic, so a flood of
 *   sign-in attempts cannot consume the budget AL AI needs for its own reads.
 *
 * A signed-in operator is never throttled in practice: the limit is sized so a
 * dashboard session cannot reach it, and the throttle key is the TCP peer
 * address, which a client cannot choose.
 */

/* ------------------------------------------------------------------ *
 * TTL cache
 * ------------------------------------------------------------------ */

type Entry<V> = { value: V; at: number };

export class TtlCache<K, V> {
  private readonly entries = new Map<K, Entry<V>>();
  private readonly inFlight = new Map<K, Promise<V>>();

  /**
   * `maxEntries` bounds the map itself, not just the age of an entry.
   *
   * An expired entry used to stay in the map forever: `get` answered `undefined`
   * and the value was never reachable again, but its memory was never given back
   * either. With one key per guild that is small; with one key per *viewed
   * resource* it is a leak that grows with uptime and never shows in a screen.
   */
  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 1_000
  ) {}

  /** The value if it is still inside its TTL, otherwise undefined. */
  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.at >= this.ttlMs) {
      // Dropped here rather than left for a sweep: this is the only place that
      // knows the entry is dead, and a dead entry still holds its value.
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  /** The last value seen for this key, however old it is. */
  peek(key: K): V | undefined {
    return this.entries.get(key)?.value;
  }

  set(key: K, value: V): void {
    this.entries.set(key, { value, at: Date.now() });
    // Oldest first: `Map` keeps insertion order, so the first key is the one
    // written longest ago — good enough for a cache whose keys are equivalent.
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /** Drop one key, or every key when called with no argument. */
  clear(key?: K): void {
    if (key === undefined) this.entries.clear();
    else this.entries.delete(key);
  }

  get size(): number {
    return this.entries.size;
  }

  /**
   * The value for a key, loading it when necessary.
   *
   * Three behaviours matter, and each one was a reported problem:
   *
   * - **A fresh value is returned without calling `load`.** This is the whole
   *   point: it is what stops a tab switch from reaching Discord.
   * - **Concurrent callers share one load.** Three screens opening together
   *   cost one request, not three — the burst was the actual cause of the 429.
   * - **A failed load falls back to the last known value.** Guild roles and
   *   channels are stable, so a slightly old answer is still a true one, and
   *   the alternative is failing a screen that could have been answered. Only
   *   when there is nothing cached does the error reach the caller.
   */
  async resolve(key: K, load: () => Promise<V>): Promise<V> {
    // Captured *before* `get`, which drops an expired entry: a failed load must
    // still fall back to the last known value rather than fail a screen that
    // could have been answered from it.
    const stale = this.peek(key);

    const cached = this.get(key);
    if (cached !== undefined) return cached;

    const running = this.inFlight.get(key);
    if (running) return running;

    const promise = (async () => {
      try {
        const value = await load();
        this.set(key, value);
        return value;
      } catch (error) {
        if (stale !== undefined) return stale;
        throw error;
      } finally {
        this.inFlight.delete(key);
      }
    })();

    this.inFlight.set(key, promise);
    return promise;
  }
}

/* ------------------------------------------------------------------ *
 * Request throttle
 * ------------------------------------------------------------------ */

export type ThrottleVerdict = { allowed: true } | { allowed: false; retryAfterSeconds: number };

/**
 * A sliding-window limiter, keyed by whatever the caller decides.
 *
 * A sliding window rather than a fixed one because a fixed window lets twice the
 * allowance through across a boundary — a flood can be timed to land either side
 * of the reset. The timestamp list is pruned on every access and can never grow
 * past `max`, so the memory a key can hold is bounded by the limit itself.
 */
export class RequestThrottle {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly windowMs: number,
    private readonly max: number
  ) {}

  /** Records an attempt and says whether it may proceed. */
  check(key: string, now: number): ThrottleVerdict {
    const recent = (this.hits.get(key) ?? []).filter(at => now - at < this.windowMs);

    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      const oldest = recent[0]!;
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((this.windowMs - (now - oldest)) / 1000)) };
    }

    recent.push(now);
    this.hits.set(key, recent);
    // A key that has been quiet for a whole window holds nothing useful, and the
    // map had no other way to forget it: every peer address that ever made one
    // request kept an array for the life of the process.
    if (this.hits.size > 1_000) {
      for (const [other, stamps] of this.hits) {
        const last = stamps[stamps.length - 1] ?? 0;
        if (now - last >= this.windowMs) this.hits.delete(other);
      }
    }
    return { allowed: true };
  }

  /** Drops keys with nothing left in the window. Returns how many were removed. */
  sweep(now: number): number {
    let removed = 0;
    for (const [key, timestamps] of this.hits) {
      const recent = timestamps.filter(at => now - at < this.windowMs);
      if (recent.length === 0) {
        this.hits.delete(key);
        removed += 1;
      } else {
        this.hits.set(key, recent);
      }
    }
    return removed;
  }

  get size(): number {
    return this.hits.size;
  }
}

/** The client a request is attributed to, for throttling purposes. */
export function clientKey(remoteAddress: string | undefined): string {
  // The key must not be attacker-controlled. `trustProxy` is gated to loopback
  // peers, so `x-forwarded-for` from a direct client is ignored — the TCP peer
  // cannot be forged, so it is the key. Behind a reverse proxy every proxied
  // request shares the proxy's address; that is the right trade for a
  // single-operator dashboard, since the alternative was no effective limit.
  if (!remoteAddress) return "unknown";
  // IPv6 privacy extensions rotate the interface identifier inside a /64 at
  // zero cost to the caller, so a raw address made the limit optional for
  // anyone with a /64. Aggregate the key to the prefix instead.
  if (remoteAddress.startsWith("::ffff:") || !remoteAddress.includes(":")) return remoteAddress;
  const head = remoteAddress.split("::")[0]!;
  const groups = head.split(":").filter(Boolean).slice(0, 4);
  return `${groups.join(":")}::/64`;
}
