/**
 * The image-by-URL path is an SSRF boundary: the server fetches a URL the
 * operator typed and returns the bytes.
 *
 * The first file pins the refusals that must happen before any socket is
 * opened. This one pins the *transport* policy, with a fake resolver and a
 * fake connector so the rebinding and redirect cases are proved rather than
 * described:
 *
 * - the socket is pinned to the address that was vetted, not to a name that is
 *   resolved a second time at connect time;
 * - a redirect is validated like the first URL, so a public URL cannot walk
 *   the request into loopback;
 * - a name that answers with a private address is refused outright, even
 *   alongside a public one.
 *
 * No test here touches a real host, and no target outside this machine is
 * contacted: the connector is a function, not a socket.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { fetchImageAsDataUrl, type Connector, type ImageResponse, type Resolver } from "../server/appearance.js";

const PNG = Buffer.from("89504e470d0a1a0a", "hex");

function imageResponse(overrides: Partial<ImageResponse> = {}): ImageResponse {
  return {
    status: 200,
    headers: { "content-type": "image/png" },
    body: (async function* () {
      yield PNG;
    })(),
    ...overrides
  };
}

test("the connection is pinned to the vetted address", async () => {
  const resolve: Resolver = async () => [{ address: "93.184.216.34", family: 4 }];
  const seen: Array<{ url: string; address: string; family: number }> = [];
  const connect: Connector = async (url, pinned) => {
    seen.push({ url: url.toString(), address: pinned.address, family: pinned.family });
    return imageResponse();
  };

  const dataUrl = await fetchImageAsDataUrl("https://images.example.com/a.png", 1024, { resolve, connect });

  assert.ok(dataUrl.startsWith("data:image/png;base64,"));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].address, "93.184.216.34", "the socket uses the checked address, not a fresh lookup");
  assert.equal(seen[0].family, 4);
});

test("a redirect into a private host is refused and never fetched", async () => {
  const resolve: Resolver = async () => [{ address: "93.184.216.34", family: 4 }];
  const requested: string[] = [];
  const connect: Connector = async url => {
    requested.push(url.toString());
    return imageResponse({
      status: 302,
      headers: { location: "https://127.0.0.1/secret" }
    });
  };

  await assert.rejects(
    fetchImageAsDataUrl("https://images.example.com/a.png", 1024, { resolve, connect }),
    /غير مسموح/
  );
  assert.deepEqual(requested, ["https://images.example.com/a.png"], "only the first, public URL was requested");
});

test("a redirect to another public host is followed and re-validated", async () => {
  const resolve: Resolver = async hostname =>
    hostname === "cdn.example.com" ? [{ address: "93.184.216.34", family: 4 }] : [{ address: "93.184.216.35", family: 4 }];
  const requested: string[] = [];
  const connect: Connector = async url => {
    requested.push(url.toString());
    if (requested.length === 1) {
      return imageResponse({ status: 301, headers: { location: "https://cdn.example.com/b.png" } });
    }
    return imageResponse();
  };

  const dataUrl = await fetchImageAsDataUrl("https://images.example.com/a.png", 1024, { resolve, connect });
  assert.ok(dataUrl.startsWith("data:image/png;base64,"));
  assert.deepEqual(requested, ["https://images.example.com/a.png", "https://cdn.example.com/b.png"]);
});

test("a name that answers with a private address is refused", async () => {
  const resolve: Resolver = async () => [{ address: "127.0.0.1", family: 4 }];
  let called = false;
  const connect: Connector = async () => {
    called = true;
    return imageResponse();
  };

  await assert.rejects(fetchImageAsDataUrl("https://rebind.example.com/a.png", 1024, { resolve, connect }), /غير مسموح/);
  assert.equal(called, false, "nothing is fetched when the name points home");
});

test("a name that answers with a public and a private address is refused", async () => {
  const resolve: Resolver = async () => [
    { address: "93.184.216.34", family: 4 },
    { address: "10.0.0.5", family: 4 }
  ];
  let called = false;
  const connect: Connector = async () => {
    called = true;
    return imageResponse();
  };

  await assert.rejects(fetchImageAsDataUrl("https://mixed.example.com/a.png", 1024, { resolve, connect }), /غير مسموح/);
  assert.equal(called, false, "a mixed answer is the shape a rebinding attack uses");
});

test("a response that is not an image is refused", async () => {
  const resolve: Resolver = async () => [{ address: "93.184.216.34", family: 4 }];
  const connect: Connector = async () =>
    imageResponse({ headers: { "content-type": "text/html" }, body: (async function* () { yield Buffer.from("<html>"); })() });

  await assert.rejects(fetchImageAsDataUrl("https://images.example.com/a.png", 1024, { resolve, connect }), /لا يشير إلى صورة/);
});

test("a body larger than the ceiling is refused", async () => {
  const resolve: Resolver = async () => [{ address: "93.184.216.34", family: 4 }];
  const connect: Connector = async () =>
    imageResponse({
      body: (async function* () {
        yield Buffer.alloc(64);
        yield Buffer.alloc(64);
      })()
    });

  await assert.rejects(fetchImageAsDataUrl("https://images.example.com/a.png", 100, { resolve, connect }), /يتجاوز الحد/);
});

test("too many redirects end the attempt instead of looping", async () => {
  const resolve: Resolver = async () => [{ address: "93.184.216.34", family: 4 }];
  let hops = 0;
  const connect: Connector = async () => {
    hops += 1;
    return imageResponse({ status: 302, headers: { location: `https://images.example.com/${hops}.png` } });
  };

  await assert.rejects(fetchImageAsDataUrl("https://images.example.com/a.png", 1024, { resolve, connect }));
  assert.ok(hops <= 4, `the redirect chain is bounded, got ${hops} hops`);
});
