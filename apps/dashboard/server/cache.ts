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
 * A signed-in operator is never throttled. Locking someone out of their own
 * dashboard to protect Discord would be a cure worse than the disease.
 */

/* ------------------------------------------------------------------ *
 * TTL cache
 * ------------------------------------------------------------------ */

type Entry<V> = { value: V; at: number };

export class TtlCache<K, V> {
  private readonly entries = new Map<K, Entry<V>>();
  private readonly inFlight = new Map<K, Promise<V>>();

  constructor(private readonly ttlMs: number) {}

  /** The value if it is still inside its TTL, otherwise undefined. */
  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.at >= this.ttlMs) return undefined;
    return entry.value;
  }

  /** The last value seen for this key, however old it is. */
  peek(key: K): V | undefined {
    return this.entries.get(key)?.value;
  }

  set(key: K, value: V): void {
    this.entries.set(key, { value, at: Date.now() });
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
        const stale = this.peek(key);
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
export function clientKey(headers: Record<string, unknown>, remoteAddress: string | undefined): string {
  // `trustProxy` is on, so `x-forwarded-for` is populated by the proxy in front
  // of the dashboard. Only the first entry is the client; the rest are hops.
  const forwarded = headers["x-forwarded-for"];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (typeof raw === "string" && raw.length > 0) return raw.split(",")[0]!.trim();
  return remoteAddress ?? "unknown";
}
