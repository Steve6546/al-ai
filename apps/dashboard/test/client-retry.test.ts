import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { HealthSnapshot } from "@al-ai/core/browser";
import { ApiError, health } from "../src/api/client";

/**
 * The one place the dashboard retries a request.
 *
 * `client.ts` waits out a single 429 and tries again, because the BFF forwards
 * Discord's own `retry-after` and a rate limit is momentary by definition. The
 * rule has three parts, and all three were untested:
 *
 *  1. a 429 is retried exactly once — a second one is real information and
 *     belongs in front of the operator;
 *  2. the wait comes from `retry-after`, capped, so a large hint cannot freeze
 *     the screen;
 *  3. the retry reuses the same request, so the operator's action is not lost.
 *
 * The bug this guards against is quiet in both directions: retrying forever
 * turns a hard failure into a hanging screen, and not retrying at all turns a
 * one-second hiccup into an error the operator has to dismiss by hand.
 */

type Attempt = { path: string; method: string; waited: number };

let attempts: Attempt[] = [];
let responses: (() => Response)[] = [];
let sleeps: number[] = [];

const realFetch = globalThis.fetch;
const realSetTimeout = globalThis.setTimeout;

globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
  attempts.push({
    path: String(input),
    method: (init?.method ?? "GET").toUpperCase(),
    waited: sleeps.length
  });
  const next = responses.shift();
  if (!next) throw new Error("the test ran out of scripted responses");
  return next();
}) as typeof fetch;

/**
 * A clock that records instead of sleeping.
 *
 * The real `request()` awaits a timer before retrying, and a test that actually
 * sat through a five-second cap would be slow and flaky. Recording the delay
 * keeps the assertion on the *decision* — how long the client chose to wait —
 * which is the part a wrong implementation gets wrong.
 */
globalThis.setTimeout = ((handler: () => void, delay?: number) => {
  sleeps.push(delay ?? 0);
  handler();
  return 0 as unknown as NodeJS.Timeout;
}) as typeof setTimeout;

after(() => {
  globalThis.fetch = realFetch;
  globalThis.setTimeout = realSetTimeout;
});

beforeEach(() => {
  attempts = [];
  responses = [];
  sleeps = [];
});

/** A response body in the real `HealthSnapshot` shape, from `@al-ai/core`. */
const snapshot: HealthSnapshot = {
  status: "healthy",
  dashboard: "online",
  bot: "connected",
  database: "reachable",
  gateway: { eventsLastMinute: 0, ceiling: 120 },
  verification: { guildCount: 1, uniqueUsers: 3, reviewRequired: false, warning: null }
};

const ok = () => Response.json(snapshot);
const rateLimited = (retryAfter?: string) =>
  () =>
    new Response("", {
      status: 429,
      ...(retryAfter === undefined ? {} : { headers: { "retry-after": retryAfter } })
    });

test("a rate limit is waited out and the request succeeds", async () => {
  responses = [rateLimited("2"), ok];

  const result = await health();
  assert.deepEqual(result, snapshot, "the caller receives the body the retry produced");

  assert.equal(attempts.length, 2, "the request was sent twice");
  assert.equal(sleeps.length, 1, "exactly one wait");
  assert.equal(sleeps[0], 2_000, "the wait is the retry-after hint in milliseconds");
  assert.equal(attempts[0]!.path, attempts[1]!.path, "the retry goes to the same endpoint");
});

test("a missing retry-after falls back to a one-second wait", async () => {
  responses = [rateLimited(), ok];

  await health();
  assert.equal(sleeps[0], 1_000, "a header-less 429 still waits a second rather than hammering");
});

test("a nonsensical retry-after falls back instead of waiting forever", async () => {
  for (const header of ["0", "-3", "soon", ""]) {
    attempts = [];
    responses = [rateLimited(header), ok];
    sleeps = [];
    await health();
    assert.equal(sleeps[0], 1_000, `retry-after: "${header}" is not a usable wait`);
  }
});

test("the wait is capped so a huge retry-after cannot freeze the screen", async () => {
  responses = [rateLimited("3600"), ok];

  await health();
  assert.equal(sleeps[0], 5_000, "an hour-long hint is clamped to the five-second cap");
});

test("only one retry is attempted: a second 429 reaches the operator", async () => {
  responses = [rateLimited("1"), rateLimited("1")];

  await assert.rejects(
    () => health(),
    (error: unknown) => {
      assert.ok(error instanceof ApiError, "the failure is the dashboard's own error type");
      assert.equal(error.status, 429, "the status is preserved for the caller");
      return true;
    }
  );

  assert.equal(attempts.length, 2, "no third attempt — the retry happens once only");
});

test("a non-429 failure is never retried", async () => {
  responses = [() => Response.json({ error: "NO_SESSION", message: "انتهت الجلسة." }, { status: 401 })];

  await assert.rejects(() => health(), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.code, "NO_SESSION");
    assert.equal(error.message, "انتهت الجلسة.");
    assert.equal(error.status, 401);
    return true;
  });

  assert.equal(attempts.length, 1, "a 401 is final, not a hiccup");
  assert.equal(sleeps.length, 0, "and nothing was waited out");
});
