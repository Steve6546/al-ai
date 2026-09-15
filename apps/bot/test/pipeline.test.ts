import test from "node:test";
import assert from "node:assert/strict";
import { EventPipeline, GATEWAY_CEILING_PER_MINUTE, VOICE_DEBOUNCE_MS } from "../src/runtime/event-pipeline.ts";

const tick = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * The default ceiling is what the *constructor* resolves, not what the constant
 * says.
 *
 * This test used to be `assert.equal(GATEWAY_CEILING_PER_MINUTE, 120)` — a
 * constant compared with itself, which proves nothing about the pipeline and
 * would still pass if the constructor dropped its `?? GATEWAY_CEILING_PER_MINUTE`
 * fallback, or if the bot were wired to a ceiling of 1. Every other test in this
 * file passes an explicit `ceiling`, so the default path had no coverage at all.
 * Reading it back through `stats()` is what makes it a real assertion.
 */
test("a pipeline built with no ceiling uses the documented gateway default", () => {
  const pipeline = new EventPipeline({ now: () => 1_000_000 });

  assert.equal(pipeline.stats().ceiling, GATEWAY_CEILING_PER_MINUTE);
  assert.equal(pipeline.stats().ceiling, 120, "and that default is the documented 120");
});

test("the default ceiling actually throttles: the 121st job waits", async () => {
  let clock = 1_000_000;
  const pipeline = new EventPipeline({ now: () => clock });
  let ran = 0;
  // One more than the ceiling, with no ceiling passed in — so this measures the
  // real default rather than a number the test chose.
  for (let index = 0; index < GATEWAY_CEILING_PER_MINUTE + 1; index += 1) {
    pipeline.enqueue(0, { run: async () => void (ran += 1) });
  }

  await tick();
  assert.equal(ran, GATEWAY_CEILING_PER_MINUTE, "the default window admits exactly the ceiling");
  assert.equal(pipeline.stats().queued, 1, "the overflow waits rather than being dropped");

  clock += 61_000;
  await pipeline.drain();
  assert.equal(ran, GATEWAY_CEILING_PER_MINUTE + 1);
});

test("the voice debounce window is two seconds", () => {
  assert.equal(VOICE_DEBOUNCE_MS, 2_000);
});

/**
 * The debounce has to be *reachable*, not merely constant.
 *
 * `dispatch` reads `pipeline.voiceDebounceMs` so the window can come from
 * config. While that property did not exist the only copy lived in this
 * module as a hard-coded constant, and `control-plane.json`'s
 * `gateway.voiceDebounceMs` was decoration nothing consulted.
 */
test("a pipeline exposes the debounce window its caller should use", () => {
  assert.equal(new EventPipeline({ now: () => 0 }).voiceDebounceMs, VOICE_DEBOUNCE_MS);

  const configured = new EventPipeline({ now: () => 0, voiceDebounceMs: 7_500 });
  assert.equal(configured.voiceDebounceMs, 7_500, "a configured window wins over the default");
});

test("pipeline pauses at the ceiling and resumes instead of dropping work", async () => {
  let clock = 1_000_000;
  const pipeline = new EventPipeline({ now: () => clock, ceiling: 3, windowMs: 60_000 });
  let ran = 0;
  for (let index = 0; index < 5; index += 1) pipeline.enqueue(2, { run: async () => void (ran += 1) });

  await tick();
  assert.equal(ran, 3, "only the ceiling worth of jobs should run");
  assert.equal(pipeline.stats().queued, 2, "remaining jobs must stay queued, not be dropped");

  clock += 61_000;
  await pipeline.drain();
  assert.equal(ran, 5);
  assert.equal(pipeline.stats().queued, 0);
});

test("pipeline reports throttling so the bot can log it", async () => {
  let throttled = 0;
  const pipeline = new EventPipeline({ now: () => 1_000_000, ceiling: 1, windowMs: 60_000 });
  pipeline.onThrottled(() => void (throttled += 1));
  pipeline.enqueue(0, { run: async () => undefined });
  pipeline.enqueue(0, { run: async () => undefined });
  await tick();
  assert.equal(throttled, 1);
});

test("a failing job is reported and does not stop the queue", async () => {
  const failures: unknown[] = [];
  const pipeline = new EventPipeline({ now: () => 1_000_000, ceiling: 10, windowMs: 60_000 });
  pipeline.onJobFailed(error => failures.push(error));
  let ran = 0;
  pipeline.enqueue(0, { run: async () => { throw new Error("boom"); } });
  pipeline.enqueue(0, { run: async () => void (ran += 1) });
  await tick();
  assert.equal(failures.length, 1);
  assert.equal(ran, 1);
});

test("priority order is respected: critical work drains before routine work", async () => {
  const order: string[] = [];
  const pipeline = new EventPipeline({ now: () => 1_000_000, ceiling: 10, windowMs: 60_000 });
  pipeline.enqueue(3, { run: async () => void order.push("voice") });
  pipeline.enqueue(1, { run: async () => void order.push("moderation") });
  pipeline.enqueue(0, { run: async () => void order.push("critical") });
  await tick();
  assert.deepEqual(order, ["critical", "moderation", "voice"]);
});

test("debounce coalesces a burst into a single job", async () => {
  const pipeline = new EventPipeline({ now: () => 1_000_000, ceiling: 10, windowMs: 60_000 });
  let runs = 0;
  for (let index = 0; index < 5; index += 1) {
    pipeline.debounce(3, "voice:guild:member", 20, { run: async () => void (runs += 1) });
  }
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(runs, 1, "five rapid voice moves must produce one log entry");
});

test("flush drains buffered debounced work on shutdown", async () => {
  const pipeline = new EventPipeline({ now: () => 1_000_000, ceiling: 10, windowMs: 60_000 });
  let runs = 0;
  pipeline.debounce(3, "voice:guild:member", 60_000, { run: async () => void (runs += 1) });
  const flushed = await pipeline.flush(1_000);
  assert.equal(flushed, true);
  assert.equal(runs, 1);
});
