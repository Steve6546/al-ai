/**
 * AL AI event pipeline.
 *
 * Five priority queues feed a single drain loop. The loop honours Discord's
 * documented Gateway ceiling of 120 events per 60 seconds per connection and,
 * crucially, *reschedules itself* when the window is full instead of dropping
 * the remaining work.
 *
 * GOVERNANCE rule 11: nothing is silently dropped. Hitting the ceiling defers
 * work via scheduleRetry(); shutdown flushes what is still buffered.
 */

export const WINDOW_MS = 60_000;
export const GATEWAY_CEILING_PER_MINUTE = 120;
export const VOICE_DEBOUNCE_MS = 2_000;

export type Job = { run: () => Promise<void>; key?: string };
export type Priority = 0 | 1 | 2 | 3 | 4;

export type PipelineOptions = {
  now?: () => number;
  ceiling?: number;
  windowMs?: number;
};

export class EventPipeline {
  private readonly queues: Job[][] = Array.from({ length: 5 }, () => []);
  private readonly pending = new Map<string, { timer: NodeJS.Timeout; job: Job }>();
  private readonly now: () => number;
  private readonly ceiling: number;
  private readonly windowMs: number;
  private timestamps: number[] = [];
  private draining = false;
  private drainScheduled = false;
  private retryTimer: NodeJS.Timeout | null = null;
  private throttleHandler: ((queued: number) => void) | null = null;
  private failureHandler: ((error: unknown, job: Job) => void) | null = null;

  constructor(options: PipelineOptions = {}) {
    this.now = options.now ?? Date.now;
    this.ceiling = options.ceiling ?? GATEWAY_CEILING_PER_MINUTE;
    this.windowMs = options.windowMs ?? WINDOW_MS;
  }

  onThrottled(handler: (queued: number) => void) {
    this.throttleHandler = handler;
  }

  onJobFailed(handler: (error: unknown, job: Job) => void) {
    this.failureHandler = handler;
  }

  enqueue(priority: Priority, job: Job) {
    this.queues[priority].push(job);
    this.scheduleDrain();
  }

  /**
   * Draining starts on the next microtask, not synchronously.
   * A burst of events arriving in the same tick is therefore queued first and
   * drained in priority order, instead of the first event winning the race.
   */
  private scheduleDrain() {
    if (this.drainScheduled) return;
    this.drainScheduled = true;
    queueMicrotask(() => {
      this.drainScheduled = false;
      void this.drain();
    });
  }

  /**
   * Coalesces a burst of related events into one job.
   * Voice channel churn is the main user: a member hopping between rooms
   * produces one log entry after the movement settles.
   */
  debounce(priority: Priority, key: string, delayMs: number, job: Job) {
    const existing = this.pending.get(key);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      this.pending.delete(key);
      this.enqueue(priority, job);
    }, delayMs);
    timer.unref?.();
    this.pending.set(key, { timer, job });
  }

  private windowUsage() {
    const current = this.now();
    this.timestamps = this.timestamps.filter(stamp => current - stamp < this.windowMs);
    return this.timestamps.length;
  }

  private queued() {
    return this.queues.reduce((total, queue) => total + queue.length, 0) + this.pending.size;
  }

  stats() {
    return { eventsLastMinute: this.windowUsage(), ceiling: this.ceiling, queued: this.queued() };
  }

  private scheduleRetry() {
    if (this.retryTimer) return;
    const current = this.now();
    const oldest = this.timestamps[0] ?? current;
    const wait = Math.max(this.windowMs - (current - oldest), 250);
    this.throttleHandler?.(this.queued());
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.drain();
    }, wait);
    this.retryTimer.unref?.();
  }

  async drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      for (const queue of this.queues) {
        while (queue.length) {
          if (this.windowUsage() >= this.ceiling) {
            this.scheduleRetry();
            return;
          }
          const job = queue.shift()!;
          this.timestamps.push(this.now());
          try {
            await job.run();
          } catch (error) {
            this.failureHandler?.(error, job);
          }
        }
      }
    } finally {
      this.draining = false;
    }
  }

  /** Used on shutdown so buffered work is not lost silently. */
  async flush(timeoutMs = 5_000) {
    const deadline = this.now() + timeoutMs;
    for (const [key, entry] of this.pending) {
      clearTimeout(entry.timer);
      this.pending.delete(key);
      this.enqueue(4, entry.job);
    }
    while (this.queued() > 0 && this.now() < deadline) {
      await this.drain();
      if (this.queued() > 0) await new Promise(resolve => setTimeout(resolve, 50));
    }
    return this.queued() === 0;
  }
}
