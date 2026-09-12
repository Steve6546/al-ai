/**
 * GOVERNANCE rule 13 — a silent security component is itself a security event.
 *
 * The watchdog does not assume the intrusion detector or the audit trail are
 * alive. Each component must check in; if one goes quiet for longer than the
 * staleness budget the watchdog raises `security.watchdog-down` so the failure
 * is visible instead of silently degrading protection.
 */

export const WATCHED_COMPONENTS = ["intrusion-detector", "audit-trail"] as const;
export type WatchedComponent = (typeof WATCHED_COMPONENTS)[number] | (string & {});

export type WatchdogDeps = {
  intervalMs?: number;
  staleAfterMs?: number;
  /** Called once per silence episode, not on every tick. */
  onSilent: (component: WatchedComponent, silentForMs: number) => void;
  now?: () => number;
};

export type WatchdogSnapshot = {
  component: WatchedComponent;
  lastBeatAt: number | null;
  silentForMs: number;
  healthy: boolean;
};

export function createWatchdog(deps: WatchdogDeps) {
  const now = deps.now ?? (() => Date.now());
  const intervalMs = deps.intervalMs ?? 15_000;
  const staleAfterMs = deps.staleAfterMs ?? 60_000;

  const beats = new Map<WatchedComponent, number>();
  const reported = new Set<WatchedComponent>();

  function beat(component: WatchedComponent) {
    beats.set(component, now());
    reported.delete(component);
  }

  function snapshot(): WatchdogSnapshot[] {
    const current = now();
    return [...beats.keys()].map(component => {
      const lastBeatAt = beats.get(component) ?? null;
      const silentForMs = lastBeatAt === null ? Number.POSITIVE_INFINITY : current - lastBeatAt;
      return { component, lastBeatAt, silentForMs, healthy: silentForMs <= staleAfterMs };
    });
  }

  function tick() {
    const current = now();
    for (const [component, lastBeatAt] of beats) {
      const silentForMs = current - lastBeatAt;
      if (silentForMs <= staleAfterMs) continue;
      if (reported.has(component)) continue;
      reported.add(component);
      deps.onSilent(component, silentForMs);
    }
  }

  const timer = setInterval(tick, intervalMs);
  timer.unref?.();

  return {
    beat,
    snapshot,
    /** Exposed so tests and the supervisor can drive the loop deterministically. */
    tick,
    stop() {
      clearInterval(timer);
    }
  };
}

export type Watchdog = ReturnType<typeof createWatchdog>;
