import test from "node:test";
import assert from "node:assert/strict";
import { fetchImageBytes } from "../src/runtime/welcome-image.js";

/**
 * The bot's only outbound image fetch.
 *
 * `fetchImageBytes` is the one place this process takes a URL and asks a server
 * for bytes, so the host allow-list, the https rule and the streamed ceiling are
 * what keep a future stored URL from turning the bot into a probe against
 * private addresses.
 */

const realFetch = globalThis.fetch;

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const seen: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return seen;
}

function teardown() {
  globalThis.fetch = realFetch;
}

function okResponse(body: Uint8Array) {
  // A fresh ArrayBuffer-backed copy: `Uint8Array<ArrayBufferLike>` is not a
  // BodyInit, because the "like" may be a SharedArrayBuffer.
  return new Response(new Uint8Array(body).buffer, {
    status: 200,
    headers: { "content-type": "image/png" }
  });
}

test("a non-CDN host is refused before any request is made", async () => {
  const seen = stubFetch(() => okResponse(new Uint8Array([1])));
  assert.equal(await fetchImageBytes("https://169.254.169.254/latest/meta-data"), null);
  assert.equal(await fetchImageBytes("https://example.com/a.png"), null);
  assert.equal(seen.length, 0, "the guard must not rely on the network to say no");
  teardown();
});

test("plain http and credentialed URLs are refused", async () => {
  const seen = stubFetch(() => okResponse(new Uint8Array([1])));
  assert.equal(await fetchImageBytes("http://cdn.discordapp.com/a.png"), null);
  assert.equal(await fetchImageBytes("https://u:p@cdn.discordapp.com/a.png"), null);
  assert.equal(await fetchImageBytes("not a url"), null);
  assert.equal(seen.length, 0);
  teardown();
});

test("an allowed avatar URL is fetched without following redirects", async () => {
  const seen = stubFetch(() => okResponse(new Uint8Array([9, 8, 7])));
  const bytes = await fetchImageBytes("https://cdn.discordapp.com/icons/1/abc.png");
  assert.deepEqual([...(bytes ?? new Uint8Array())], [9, 8, 7]);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.init?.redirect, "error", "a 302 to a private host must not be followed");
  teardown();
});

test("a body larger than the ceiling is abandoned mid-stream", async () => {
  stubFetch(() => {
    const chunk = new Uint8Array(1024 * 1024);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 12; i++) controller.enqueue(chunk);
        controller.close();
      }
    });
    return new Response(stream, { status: 200 });
  });
  assert.equal(await fetchImageBytes("https://cdn.discordapp.com/icons/1/big.png"), null);
  teardown();
});

test("a failed or empty response degrades to null, not a throw", async () => {
  stubFetch(() => new Response(null, { status: 404 }));
  assert.equal(await fetchImageBytes("https://cdn.discordapp.com/icons/1/gone.png"), null);
  stubFetch(() => okResponse(new Uint8Array(0)));
  assert.equal(await fetchImageBytes("https://cdn.discordapp.com/icons/1/empty.png"), null);
  stubFetch(() => {
    throw new Error("socket closed");
  });
  assert.equal(await fetchImageBytes("https://cdn.discordapp.com/icons/1/boom.png"), null);
  teardown();
});
