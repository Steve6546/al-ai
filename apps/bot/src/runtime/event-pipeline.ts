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

/**
 * How many jobs may wait at once before the oldest low-priority ones are shed.
 *
 * The queue needs a ceiling because the drain rate has one: Discord accepts 120
 * events a minute per connection, so a busy server produces faster than the
 * pipeline can send. Without a cap the backlog is not a queue, it is a leak —
 * every waiting job is a closure holding the whole event (message content,
 * embeds, attachments), and a bot left running for a day reached several
 * gigabytes of them while the dashboard showed nothing wrong.
 *
 * The number is generous on purpose: a burst that briefly outruns the drain
 * should survive. What must not happen is unbounded growth.
 */
export const MAX_QUEUE_DEPTH = 1_500;

export type Job = { run: () => Promise<void>; key?: string };
export type Priority = 0 | 1 | 2 | 3 | 4;

export type PipelineOptions = {
  now?: () => number;
  ceiling?: number;
  windowMs?: number;
  voiceDebounceMs?: number;
  /** Queue depth ceiling; defaults to `MAX_QUEUE_DEPTH`. */
  maxDepth?: number;
};

export class EventPipeline {
  private readonly queues: Job[][] = Array.from({ length: 5 }, () => []);
  private readonly pending = new Map<string, { timer: NodeJS.Timeout; job: Job }>();
  private readonly now: () => number;
  private readonly ceiling: number;
  private readonly windowMs: number;
  /**
   * How long voice churn is coalesced for.
   *
   * Exposed because `dispatch` needs it and config is the authority (rule 15):
   * the value lives in `control-plane.json` as `gateway.voiceDebounceMs`, and a
   * second copy here would be the drift this project keeps finding.
   */
  readonly voiceDebounceMs: number;
  private timestamps: number[] = [];
  private dropped = 0;
  private droppedSinceReport = 0;
  private readonly maxDepth: number;
  private draining = false;
  private drainScheduled = false;
  private retryTimer: NodeJS.Timeout | null = null;
  private throttleHandler: ((queued: number) => void) | null = null;
  private failureHandler: ((error: unknown, job: Job) => void) | null = null;
  private dropHandler: ((dropped: number, queued: number) => void) | null = null;

  constructor(options: PipelineOptions = {}) {
    this.now = options.now ?? Date.now;
    this.ceiling = options.ceiling ?? GATEWAY_CEILING_PER_MINUTE;
    this.windowMs = options.windowMs ?? WINDOW_MS;
    this.voiceDebounceMs = options.voiceDebounceMs ?? VOICE_DEBOUNCE_MS;
    this.maxDepth = options.maxDepth ?? MAX_QUEUE_DEPTH;
  }

  onThrottled(handler: (queued: number) => void) {
    this.throttleHandler = handler;
  }

  onJobFailed(handler: (error: unknown, job: Job) => void) {
    this.failureHandler = handler;
  }

  /**
   * Called when the ceiling forces jobs out.
   *
   * GOVERNANCE rule 11 says nothing is dropped silently, so a shed job is
   * *reported* — once per burst, with a count, not one log line per job (which
   * would be its own flood).
   */
  onDropped(handler: (dropped: number, queued: number) => void) {
    this.dropHandler = handler;
  }

  enqueue(priority: Priority, job: Job) {
    // `makeRoom` answers whether the job may enter: a refused job must not be
    // pushed anyway, or the ceiling would hold only for the jobs that were shed.
    if (this.queued() >= this.maxDepth && !this.makeRoom(priority)) return;
    this.queues[priority].push(job);
    this.scheduleDrain();
  }

  /**
   * Makes room for one job by discarding the oldest job of the lowest priority
   * that has any — reaction noise must never push a ban out of the queue.
   *
   * Priority 0 (security and moderation) is never discarded: if the queue is
   * full of those, the incoming job is the one that waits, because the work
   * already queued is at least as important as the work arriving.
   */
  private makeRoom(incoming: Priority): boolean {
    for (let level = 4 as Priority; level >= 1; level -= 1) {
      if (this.queues[level].length > 0) {
        this.queues[level].shift();
        this.countDrop();
        return true;
      }
    }
    // Nothing below the top priority to give up, and the incoming job is not
    // itself top priority: refuse it rather than grow.
    if (incoming !== 0) {
      this.countDrop();
      return false;
    }
    // A full queue of priority-0 work: accept the newcomer and let the oldest go,
    // since a security event that never runs is worse than one that runs late.
    this.queues[0].shift();
    this.countDrop();
    return true;
  }

  private countDrop() {
    this.dropped += 1;
    this.droppedSinceReport += 1;
    if (this.droppedSinceReport === 1) {
      this.dropHandler?.(this.droppedSinceReport, this.queued());
    }
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
    return {
      eventsLastMinute: this.windowUsage(),
      ceiling: this.ceiling,
      queued: this.queued(),
      /** Jobs shed since the process started, because the queue hit its ceiling. */
      dropped: this.dropped
    };
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
    let throttled = false;
    try {
      for (const queue of this.queues) {
        while (queue.length) {
          if (this.windowUsage() >= this.ceiling) {
            this.scheduleRetry();
            throttled = true;
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
      // A job enqueued while this drain was in flight scheduled a microtask that
      // no-oped on `draining` and cleared `drainScheduled`, so nothing was left
      // to drain it but the next arrival — the tail of a burst could sit in a
      // queue until an event arrives minutes later, while `stats().queued`
      // reported a backlog nobody acted on. Re-checking here is what closes that
      // window: the drain that consumed the burst also picks up its own tail.
      //
      // But not when the stop was the throttle: there `scheduleRetry` has the
      // next drain already arranged, and the queue stays non-empty until the
      // window moves. Re-scheduling here would spin a microtask against a clock
      // that has not advanced, forever.
      if (!throttled && this.queues.some(queue => queue.length > 0)) this.scheduleDrain();
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
