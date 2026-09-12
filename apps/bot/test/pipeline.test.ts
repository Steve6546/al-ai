import test from "node:test";
import assert from "node:assert/strict";
import { EventPipeline, GATEWAY_CEILING_PER_MINUTE, VOICE_DEBOUNCE_MS } from "../src/runtime/event-pipeline.ts";

const tick = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms));

test("the documented gateway ceiling is 120 events per minute", () => {
  assert.equal(GATEWAY_CEILING_PER_MINUTE, 120);
});

test("the voice debounce window is two seconds", () => {
  assert.equal(VOICE_DEBOUNCE_MS, 2_000);
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
