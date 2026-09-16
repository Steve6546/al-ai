import test from "node:test";
import assert from "node:assert/strict";
import { createRetractionRegistry, RETRACTION_WINDOW_MS } from "../src/lib/retraction.js";

/**
 * A controllable clock.
 *
 * The window is fifteen minutes of wall time, so a test that waited for it
 * would never run. Injecting the clock is what makes the boundary — the one
 * place this can be wrong — assertable in microseconds.
 */
function clock(start = 1_700_000_000_000) {
  let at = start;
  return {
    now: () => at,
    advance: (ms: number) => {
      at += ms;
    }
  };
}

test("a reply is withdrawn when the member it acted on leaves", async () => {
  const time = clock();
  const registry = createRetractionRegistry({ now: time.now });
  const withdrawn: string[] = [];

  registry.remember("g1", "m1", async () => {
    withdrawn.push("m1");
  });
  assert.equal(registry.pending(), 1, "recorded before the departure");

  const attempted = await registry.retract("g1", "m1");

  assert.deepEqual(withdrawn, ["m1"], "the reply really was withdrawn");
  assert.equal(attempted, 1);
  assert.equal(registry.pending(), 0, "and nothing is left held");
});

test("a departure in another guild withdraws nothing", async () => {
  // Discord ids are unique per entity, not per guild. The same person can be in
  // two guilds AL AI serves, and a reply owed to one guild's operator must not
  // be withdrawn because that person left the other one.
  const time = clock();
  const registry = createRetractionRegistry({ now: time.now });
  const withdrawn: string[] = [];

  registry.remember("g1", "m1", async () => {
    withdrawn.push("g1:m1");
  });

  const attempted = await registry.retract("g2", "m1");

  assert.deepEqual(withdrawn, [], "another guild's departure is not ours to act on");
  assert.equal(attempted, 0);
  assert.equal(registry.pending(), 1, "and the entry survives for the guild that owns it");
});

test("a different member leaving leaves this reply alone", async () => {
  const time = clock();
  const registry = createRetractionRegistry({ now: time.now });
  const withdrawn: string[] = [];

  registry.remember("g1", "m1", async () => {
    withdrawn.push("m1");
  });

  await registry.retract("g1", "m2");

  assert.deepEqual(withdrawn, []);
  assert.equal(registry.pending(), 1);
});

test("a member punished twice has both replies withdrawn", async () => {
  const time = clock();
  const registry = createRetractionRegistry({ now: time.now });
  const withdrawn: string[] = [];

  registry.remember("g1", "m1", async () => {
    withdrawn.push("first");
  });
  registry.remember("g1", "m1", async () => {
    withdrawn.push("second");
  });
  assert.equal(registry.pending(), 2);

  const attempted = await registry.retract("g1", "m1");

  assert.deepEqual(withdrawn, ["first", "second"]);
  assert.equal(attempted, 2);
});

test("an entry past the window is dropped, not attempted", async () => {
  // Past fifteen minutes the interaction token is dead and Discord has already
  // discarded the ephemeral reply. Attempting the withdrawal would be a request
  // that cannot succeed, reported as a failure the operator can do nothing about.
  const time = clock();
  const registry = createRetractionRegistry({ now: time.now });
  const withdrawn: string[] = [];

  registry.remember("g1", "m1", async () => {
    withdrawn.push("m1");
  });
  time.advance(RETRACTION_WINDOW_MS + 1);

  const attempted = await registry.retract("g1", "m1");

  assert.deepEqual(withdrawn, [], "nothing was attempted");
  assert.equal(attempted, 0, "and the no-op is reported as one, not as a success");
});

test("the window boundary is strict: exactly fifteen minutes is already too late", async () => {
  const time = clock();
  const registry = createRetractionRegistry({ now: time.now });
  let calls = 0;

  registry.remember("g1", "m1", async () => {
    calls += 1;
  });
  time.advance(RETRACTION_WINDOW_MS);

  assert.equal(await registry.retract("g1", "m1"), 0, "`expiresAt > now` is strict, matching the rest of the codebase");
  assert.equal(calls, 0);

  // One millisecond earlier is still inside the window, which is what proves
  // the assertion above is about the boundary rather than about the call
  // failing for some unrelated reason.
  const inside = clock();
  const other = createRetractionRegistry({ now: inside.now });
  let insideCalls = 0;
  other.remember("g1", "m1", async () => {
    insideCalls += 1;
  });
  inside.advance(RETRACTION_WINDOW_MS - 1);

  assert.equal(await other.retract("g1", "m1"), 1);
  assert.equal(insideCalls, 1);
});

test("expired entries do not accumulate while the process runs", async () => {
  // Pruning on the way in is what keeps a repeatedly-punished member from
  // holding every interaction object they ever produced alive for the lifetime
  // of the process.
  const time = clock();
  const registry = createRetractionRegistry({ now: time.now });

  for (let index = 0; index < 20; index += 1) {
    // Advanced *before* each remember except the first, so the loop ends one
    // window short of the newest entry's expiry. Advancing after it instead
    // lands exactly on the strict boundary and the newest entry is gone too,
    // which reads as "pruning removed everything" rather than as the off-by-one
    // in the test.
    if (index > 0) time.advance(RETRACTION_WINDOW_MS);
    registry.remember("g1", "m1", async () => undefined);
  }

  assert.equal(registry.pending(), 1, "only the newest entry is still withdrawable");
});

test("a withdrawal that rejects does not abandon the rest, and does not throw", async () => {
  // This runs from an event handler, where a rejection would surface as an
  // unhandled one. And one dead interaction must not cost the others theirs.
  const time = clock();
  const registry = createRetractionRegistry({ now: time.now });
  const withdrawn: string[] = [];

  registry.remember("g1", "m1", async () => {
    throw new Error("Unknown interaction");
  });
  registry.remember("g1", "m1", async () => {
    withdrawn.push("second");
  });

  const attempted = await registry.retract("g1", "m1");

  assert.equal(attempted, 2, "both were attempted");
  assert.deepEqual(withdrawn, ["second"], "the second one still ran");
});

test("a failed withdrawal is not retried on the next departure", async () => {
  // Deleted before the loop, not after: otherwise every later departure would
  // replay a withdrawal that has already proved impossible.
  const time = clock();
  const registry = createRetractionRegistry({ now: time.now });
  let calls = 0;

  registry.remember("g1", "m1", async () => {
    calls += 1;
    throw new Error("Unknown interaction");
  });

  await registry.retract("g1", "m1");
  await registry.retract("g1", "m1");

  assert.equal(calls, 1, "the second departure found nothing to retry");
  assert.equal(registry.pending(), 0);
});

test("retracting an unknown member is a no-op rather than an error", async () => {
  const time = clock();
  const registry = createRetractionRegistry({ now: time.now });

  assert.equal(await registry.retract("g1", "nobody"), 0);
});

test("the registry defaults to the real clock when none is injected", async () => {
  // The default is what production uses, so it must be exercised at least once:
  // a registry that only worked with an injected clock would pass every test
  // above and do nothing in the bot.
  const registry = createRetractionRegistry();
  const withdrawn: string[] = [];

  registry.remember("g1", "m1", async () => {
    withdrawn.push("m1");
  });

  assert.equal(await registry.retract("g1", "m1"), 1);
  assert.deepEqual(withdrawn, ["m1"]);
});
