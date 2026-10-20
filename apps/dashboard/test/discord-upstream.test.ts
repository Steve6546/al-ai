/**
 * The upstream Discord call policy.
 *
 * Three behaviours are pinned here, each of them a fix rather than a style
 * choice:
 *
 * 1. A *read* survives one transient upstream fault (a 5xx, a dropped
 *    connection, a timeout). The dashboard's own log recorded
 *    `Discord /users/@me/guilds failed with 500` twice, and the request right
 *    after them answered 200 - so the retry turns a broken screen into a
 *    slightly slower one.
 * 2. A *write* is never repeated. The first attempt may already have taken
 *    effect even when its answer was lost, and a second PATCH is a second
 *    mutation.
 * 3. Every call is bounded by a timeout. `fetch` has none of its own, so a
 *    connection Discord never finishes would otherwise hang the request, the
 *    socket and the operator's spinner forever.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DiscordApiError, requestJson } from "../server/discord.js";

type Call = { url: string; method?: string };

function stubFetch(responses: Array<{ status: number; body?: string; throws?: Error }>) {
  const original = globalThis.fetch;
  const calls: Call[] = [];
  let index = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (next.throws) throw next.throws;
    return new Response(next.body ?? "", { status: next.status, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    }
  };
}

test("a read is retried once when Discord answers 5xx", async () => {
  const stub = stubFetch([
    { status: 500, body: '{"message":"500: Internal Server Error","code":0}' },
    { status: 200, body: '{"ok":true}' }
  ]);
  try {
    const result = await requestJson<{ ok: boolean }>("/users/@me/guilds", { token: "t", method: "GET" });
    assert.equal(result.ok, true);
    assert.equal(stub.calls.length, 2, "the second attempt is the one that answered");
  } finally {
    stub.restore();
  }
});

test("a read is not retried when Discord answers 4xx", async () => {
  const stub = stubFetch([{ status: 403, body: '{"message":"Missing Access"}' }]);
  try {
    await assert.rejects(
      requestJson("/guilds/1", { token: "t", method: "GET" }),
      (error: unknown) => error instanceof DiscordApiError && error.status === 403
    );
    assert.equal(stub.calls.length, 1, "a refusal is an answer, not a fault");
  } finally {
    stub.restore();
  }
});

test("a write is not retried when Discord answers 5xx", async () => {
  const stub = stubFetch([{ status: 500, body: '{"message":"500: Internal Server Error","code":0}' }]);
  try {
    await assert.rejects(requestJson("/guilds/1", { token: "t", method: "PATCH", body: { a: 1 } }));
    assert.equal(stub.calls.length, 1, "a repeated write is a repeated mutation");
  } finally {
    stub.restore();
  }
});

test("a read survives a dropped connection", async () => {
  const stub = stubFetch([{ status: 0, throws: new TypeError("fetch failed") }, { status: 200, body: '{"ok":true}' }]);
  try {
    const result = await requestJson<{ ok: boolean }>("/users/@me/guilds", { token: "t", method: "GET" });
    assert.equal(result.ok, true);
    assert.equal(stub.calls.length, 2);
  } finally {
    stub.restore();
  }
});

test("a read that keeps failing surfaces the upstream status", async () => {
  const stub = stubFetch([{ status: 503, body: '{"message":"503"}' }]);
  try {
    await assert.rejects(
      requestJson("/users/@me/guilds", { token: "t", method: "GET" }),
      (error: unknown) => error instanceof DiscordApiError && error.status === 503
    );
    assert.equal(stub.calls.length, 2, "one attempt plus exactly one retry");
  } finally {
    stub.restore();
  }
});
