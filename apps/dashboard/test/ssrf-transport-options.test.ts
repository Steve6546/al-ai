/**
 * The transport half of the image-by-URL policy.
 *
 * The policy tests (ssrf-guard, ssrf-transport) prove which URLs are *allowed*.
 * These prove what the socket actually does with an allowed one - because a
 * policy that is only checked, and a transport that resolves the name again,
 * is exactly the gap DNS rebinding walks through.
 *
 * The assertion is on the request options themselves, because that is where
 * the decision lives: the `lookup` override is what makes the connection
 * pinned, and `servername` is what keeps the TLS check on the hostname.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildPinnedRequestOptions } from "../server/appearance.js";

test("the socket connects to the vetted address, not to a fresh lookup", async () => {
  const url = new URL("https://images.example.com/avatar.png");
  const options = buildPinnedRequestOptions(url, { address: "93.184.216.34", family: 4 }, 5_000);

  // The resolver is asked for whatever the socket wants to connect to - the
  // name, or a second lookup after a redirect - and always answers with the
  // address that was checked.
  const answered = await new Promise<{ address: string; family: number }>(resolve => {
    options.lookup("images.example.com", {}, (_error, address, family) => resolve({ address, family }));
  });
  assert.equal(answered.address, "93.184.216.34");
  assert.equal(answered.family, 4);

  // Even if the socket asked for a different name entirely, the answer is the
  // pinned address: the name is never resolved a second time.
  const other = await new Promise<{ address: string }>(resolve => {
    options.lookup("some-other.example.com", {}, (_error, address) => resolve({ address }));
  });
  assert.equal(other.address, "93.184.216.34", "no second resolution can redirect the connection");
});

test("the TLS name and the Host header still carry the hostname", () => {
  const url = new URL("https://cdn.example.com:8443/a.png?x=1");
  const options = buildPinnedRequestOptions(url, { address: "93.184.216.34", family: 4 }, 5_000);

  assert.equal(options.servername, "cdn.example.com", "SNI must be the hostname, not the pinned address");
  assert.equal(options.headers.host, "cdn.example.com:8443", "the Host header must be the hostname too");
  assert.equal(options.hostname, "cdn.example.com");
  assert.equal(options.port, "8443", "the port is the one the URL names");
  assert.equal(options.path, "/a.png?x=1");
  assert.equal(options.protocol, "https:");
  assert.equal(options.method, "GET");
});

test("an IPv6 answer keeps its family, so the socket does not fall back to IPv4", async () => {
  const url = new URL("https://images.example.com/a.png");
  const options = buildPinnedRequestOptions(url, { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 }, 5_000);

  const answered = await new Promise<{ address: string; family: number }>(resolve => {
    options.lookup("images.example.com", {}, (_error, address, family) => resolve({ address, family }));
  });
  assert.equal(answered.address, "2606:2800:220:1:248:1893:25c8:1946");
  assert.equal(answered.family, 6);
});

test("the request is bounded by a timeout", () => {
  const options = buildPinnedRequestOptions(new URL("https://images.example.com/a.png"), { address: "93.184.216.34", family: 4 }, 5_000);
  assert.ok(options.signal, "the request carries an abort signal");
  assert.equal(options.signal.aborted, false);
});

test("the image request identifies itself and asks for an uncompressed body", () => {
  const options = buildPinnedRequestOptions(new URL("https://images.example.com/a.png"), { address: "93.184.216.34", family: 4 }, 5_000);

  // A request with no user-agent is answered 403 by several image hosts, and a
  // 403 reads to the operator as "your link is broken".
  assert.match(String(options.headers["user-agent"]), /^AL-AI-Bot/, "the host must be able to identify the caller");
  assert.equal(options.headers["accept-encoding"], "identity", "a gzipped body would not match the byte ceiling");
  assert.equal(options.headers.accept, "image/*");
});

test("the pinned socket does not run Happy Eyeballs", () => {
  const options = buildPinnedRequestOptions(new URL("https://images.example.com/a.png"), { address: "93.184.216.34", family: 4 }, 5_000);

  // With autoSelectFamily on, Node asks the resolver for all addresses and reads
  // the single-address callback above as undefined — the connect then dies with
  // ERR_INVALID_IP_ADDRESS and every image link, valid or not, is reported as
  // unreachable. The address is already vetted, so there is nothing to select.
  assert.equal(options.autoSelectFamily, false, "one vetted address, no racing");
});
