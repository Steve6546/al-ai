import test from "node:test";
import assert from "node:assert/strict";
import { clientKey, RequestThrottle, TtlCache } from "../server/cache.js";

/**
 * The caching and throttling layer.
 *
 * Both exist for one reported symptom: switching between dashboard tabs fired
 * the same Discord reads repeatedly until Discord answered `429`, and the
 * operator saw the dashboard "break". Neither behaviour is visible in a
 * screenshot, so it is pinned here instead.
 */

/* ------------------------------------------------------------------ *
 * TtlCache
 * ------------------------------------------------------------------ */

test("a value inside its TTL is served without loading again", async () => {
  const cache = new TtlCache<string, number>(60_000);
  let loads = 0;
  const load = async () => {
    loads += 1;
    return 7;
  };

  assert.equal(await cache.resolve("guild", load), 7);
  assert.equal(await cache.resolve("guild", load), 7);
  assert.equal(loads, 1, "the second read never reached the loader");
});

test("an expired value is loaded again", async () => {
  // A zero TTL expires the moment it is written, which lets the expiry path be
  // tested without waiting on a real clock.
  const cache = new TtlCache<string, number>(0);
  let loads = 0;
  const load = async () => {
    loads += 1;
    return loads;
  };

  assert.equal(await cache.resolve("guild", load), 1);
  assert.equal(await cache.resolve("guild", load), 2);
  assert.equal(loads, 2);
});

test("keys are isolated from one another", async () => {
  const cache = new TtlCache<string, string>(60_000);
  await cache.resolve("a", async () => "alpha");
  await cache.resolve("b", async () => "beta");
  assert.equal(cache.get("a"), "alpha");
  assert.equal(cache.get("b"), "beta");
});

test("concurrent callers share a single load", async () => {
  // This is the burst that caused the 429: three screens opening together used
  // to fire three identical requests at Discord.
  const cache = new TtlCache<string, number>(60_000);
  let loads = 0;
  let release: (value: number) => void = () => {};
  const load = () => {
    loads += 1;
    return new Promise<number>(resolve => {
      release = resolve;
    });
  };

  const first = cache.resolve("guild", load);
  const second = cache.resolve("guild", load);
  const third = cache.resolve("guild", load);
  assert.equal(loads, 1, "only one request was started");

  release(42);
  assert.deepEqual(await Promise.all([first, second, third]), [42, 42, 42]);
  assert.equal(loads, 1);
});

test("a failed load falls back to the last known value", async () => {
  // Roles and channels are stable, so a slightly old answer is still a true one
  // — and the alternative is failing a screen that could have been answered.
  const cache = new TtlCache<string, string>(0);
  await cache.resolve("guild", async () => "cached");
  const value = await cache.resolve("guild", async () => {
    throw new Error("Discord is down");
  });
  assert.equal(value, "cached");
});

test("a failed load with nothing cached reaches the caller", async () => {
  const cache = new TtlCache<string, string>(60_000);
  await assert.rejects(
    cache.resolve("guild", async () => {
      throw new Error("Discord is down");
    }),
    /Discord is down/
  );
});

test("a failed load does not poison the next attempt", async () => {
  // The in-flight entry has to be released on the error path too, or every later
  // call would await a rejected promise forever.
  const cache = new TtlCache<string, number>(60_000);
  await assert.rejects(
    cache.resolve("guild", async () => {
      throw new Error("first attempt fails");
    })
  );
  assert.equal(await cache.resolve("guild", async () => 5), 5);
});

test("clear drops one key, or all of them", async () => {
  const cache = new TtlCache<string, number>(60_000);
  await cache.resolve("a", async () => 1);
  await cache.resolve("b", async () => 2);

  cache.clear("a");
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.get("b"), 2, "the other key is untouched");

  cache.clear();
  assert.equal(cache.size, 0);
});

/* ------------------------------------------------------------------ *
 * RequestThrottle
 * ------------------------------------------------------------------ */

test("the throttle allows exactly its limit, then refuses with a wait", () => {
  const throttle = new RequestThrottle(60_000, 3);
  const now = 1_000_000;

  assert.equal(throttle.check("client", now).allowed, true);
  assert.equal(throttle.check("client", now).allowed, true);
  assert.equal(throttle.check("client", now).allowed, true);

  const refused = throttle.check("client", now);
  assert.equal(refused.allowed, false);
  assert.ok(refused.allowed === false && refused.retryAfterSeconds >= 1, "a wait is always at least one second");
});

test("the window slides: an old attempt stops counting", () => {
  const throttle = new RequestThrottle(1_000, 2);
  const start = 1_000_000;

  assert.equal(throttle.check("client", start).allowed, true);
  assert.equal(throttle.check("client", start).allowed, true);
  assert.equal(throttle.check("client", start).allowed, false);

  // One second later the first two attempts have left the window.
  assert.equal(throttle.check("client", start + 1_001).allowed, true);
});

test("one client's flood does not throttle another", () => {
  const throttle = new RequestThrottle(60_000, 1);
  assert.equal(throttle.check("noisy", 1_000_000).allowed, true);
  assert.equal(throttle.check("noisy", 1_000_000).allowed, false);
  assert.equal(throttle.check("quiet", 1_000_000).allowed, true);
});

test("sweeping forgets clients with nothing left in the window", () => {
  const throttle = new RequestThrottle(1_000, 5);
  throttle.check("gone", 1_000_000);
  throttle.check("active", 1_000_900);

  assert.equal(throttle.sweep(1_001_500), 1, "only the idle client was dropped");
  assert.equal(throttle.size, 1);
});

/* ------------------------------------------------------------------ *
 * Client attribution
 * ------------------------------------------------------------------ */

test("the client is the first hop in x-forwarded-for", () => {
  // `trustProxy` is on, so the header is populated by the proxy in front of the
  // dashboard. Counting the proxy's own address would throttle everybody at once.
  assert.equal(clientKey({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" }, "127.0.0.1"), "203.0.113.7");
  assert.equal(clientKey({}, "127.0.0.1"), "127.0.0.1");
  assert.equal(clientKey({}, undefined), "unknown");
});
