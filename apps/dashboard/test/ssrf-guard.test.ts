/**
 * The image-by-URL path is an SSRF boundary: the server fetches a URL the
 * operator typed and returns the bytes. These cases pin the refusals that must
 * happen before any socket is opened.
 *
 * Every URL here is rejected by the pre-flight check, so the test performs no
 * network I/O; `127.0.0.1.nip.io` may resolve, and the assertion holds either
 * way (a public name for a private address is still refused).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { fetchImageAsDataUrl } from "../server/appearance.js";

const FORBIDDEN = /غير مسموح/;

test("a plain-http image URL is refused before fetching", async () => {
  await assert.rejects(fetchImageAsDataUrl("http://example.com/avatar.png"), /https/);
});

test("loopback IPv4, IPv6 and localhost are refused", async () => {
  await assert.rejects(fetchImageAsDataUrl("https://127.0.0.1/avatar.png"), FORBIDDEN);
  await assert.rejects(fetchImageAsDataUrl("https://[::1]/avatar.png"), FORBIDDEN);
  await assert.rejects(fetchImageAsDataUrl("https://localhost/avatar.png"), FORBIDDEN);
  await assert.rejects(fetchImageAsDataUrl("https://printer.local/avatar.png"), FORBIDDEN);
});

test("private and link-local ranges are refused", async () => {
  await assert.rejects(fetchImageAsDataUrl("https://10.1.2.3/avatar.png"), FORBIDDEN);
  await assert.rejects(fetchImageAsDataUrl("https://192.168.1.10/avatar.png"), FORBIDDEN);
  await assert.rejects(fetchImageAsDataUrl("https://172.20.0.1/avatar.png"), FORBIDDEN);
  await assert.rejects(fetchImageAsDataUrl("https://169.254.169.254/latest/meta-data"), FORBIDDEN);
  await assert.rejects(fetchImageAsDataUrl("https://100.64.0.1/avatar.png"), FORBIDDEN);
});

test("a public name that resolves to loopback is refused", async () => {
  await assert.rejects(fetchImageAsDataUrl("https://127.0.0.1.nip.io/avatar.png"), FORBIDDEN);
});

test("credentials embedded in the URL are refused instead of forwarded", async () => {
  await assert.rejects(fetchImageAsDataUrl("https://user:secret@example.com/avatar.png"), FORBIDDEN);
});
