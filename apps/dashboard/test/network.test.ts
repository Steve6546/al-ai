import test from "node:test";
import assert from "node:assert/strict";
import type { NetworkInterfaceInfo } from "node:os";
import {
  isCallbackRegisteredFor,
  isHostAllowed,
  isLoopbackOrigin,
  isOAuthCapableOrigin,
  lanHostEntriesFrom,
  lanHostsFrom,
  lastTunnelUrlIn,
  normaliseOrigin,
  packOAuthState,
  parseTunnelUrl,
  probeTunnelReachability,
  splitHostPort,
  unpackOAuthState
} from "../server/network.js";

/**
 * Unit tests for the network-reach pure functions.
 *
 * These functions are the whole security boundary of the remote-access switch:
 * the manager only decides which process to spawn, while these decide which
 * Host headers get a response at all. So every rule is exercised directly —
 * loopback, the machine's own addresses, the one tunnel host, and the ways a
 * crafted header tries to borrow one of them.
 */

const base = { port: 3000, machineHosts: ["192.0.2.10", "10.234.0.35"], tunnelHost: null as string | null };
const local = { ...base, remoteAddress: "127.0.0.1" };
const remote = { ...base, remoteAddress: "192.168.1.50" };

test("lanHostsFrom keeps only real, non-loopback addresses", () => {
  const interfaces = {
    lo: [{ address: "127.0.0.1", internal: true } as NetworkInterfaceInfo],
    ethernet: [
      { address: "192.168.1.195", internal: false } as NetworkInterfaceInfo,
      { address: "fe80::1%12", internal: false } as NetworkInterfaceInfo
    ],
    virtual: [{ address: "192.168.56.1", internal: false } as NetworkInterfaceInfo]
  };
  assert.deepEqual(lanHostsFrom(interfaces), ["192.168.1.195", "fe80::1%12", "192.168.56.1"]);
});

test("lanHostEntriesFrom labels each address by its interface", () => {
  const interfaces = {
    lo: [{ address: "127.0.0.1", internal: true } as NetworkInterfaceInfo],
    "Wi-Fi": [{ address: "192.168.1.195", internal: false } as NetworkInterfaceInfo],
    "VirtualBox Host-Only Ethernet Adapter": [
      { address: "192.168.56.1", internal: false } as NetworkInterfaceInfo
    ]
  };
  assert.deepEqual(lanHostEntriesFrom(interfaces), [
    { host: "192.168.1.195", label: "Wi-Fi" },
    { host: "192.168.56.1", label: "VirtualBox Host-Only Ethernet Adapter" }
  ]);
  // The same address on a second adapter is not listed twice — a row must not
  // duplicate the interface a VPN is mirroring.
  const mirrored = {
    wifi: [{ address: "10.0.0.5", internal: false } as NetworkInterfaceInfo],
    vpn: [{ address: "10.0.0.5", internal: false } as NetworkInterfaceInfo]
  };
  assert.deepEqual(lanHostEntriesFrom(mirrored), [{ host: "10.0.0.5", label: "wifi" }]);
});

test("splitHostPort handles bare hosts, ports, and bracketed IPv6", () => {
  assert.deepEqual(splitHostPort("example.com"), { hostname: "example.com", port: null });
  assert.deepEqual(splitHostPort("example.com:3000"), { hostname: "example.com", port: "3000" });
  assert.deepEqual(splitHostPort("[::1]:3000"), { hostname: "[::1]", port: "3000" });
  assert.deepEqual(splitHostPort("[::1]"), { hostname: "[::1]", port: null });
});

test("off answers loopback only, and refuses every other origin", () => {
  const options = { ...local, mode: "off" as const };
  assert.equal(isHostAllowed("localhost:3000", options), true);
  assert.equal(isHostAllowed("127.0.0.1:3000", options), true);
  assert.equal(isHostAllowed("[::1]:3000", options), true);
  assert.equal(isHostAllowed("192.0.2.10:3000", options), false);
  assert.equal(isHostAllowed(undefined, options), false);
});

test("lan adds the machine's own addresses, still refusing strangers", () => {
  const options = { ...local, mode: "lan" as const };
  assert.equal(isHostAllowed("192.0.2.10:3000", options), true);
  assert.equal(isHostAllowed("10.234.0.35:3000", options), true);
  // A different private-range machine is not this machine.
  assert.equal(isHostAllowed("192.168.1.200:3000", options), false);
  assert.equal(isHostAllowed("203.0.113.7:3000", options), false);
});

test("the loopback and tunnel hostname branches need a loopback peer", () => {
  // A LAN peer presenting Host: localhost is impersonating the trusted origin —
  // the header is attacker-controlled on any socket.
  assert.equal(isHostAllowed("localhost:3000", { ...remote, mode: "off" as const }), false);
  assert.equal(isHostAllowed("127.0.0.1:3000", { ...remote, mode: "lan" as const }), false);
  // The tunnel hostname from a direct-origin connection: same impersonation.
  const tunnel = { ...remote, mode: "tunnel" as const, tunnelHost: "quiet-river-1234.trycloudflare.com" };
  assert.equal(isHostAllowed("quiet-river-1234.trycloudflare.com", tunnel), false);
  // ...while cloudflared genuinely connects from loopback, so the real path
  // keeps working, and the machine's own addresses stay reachable from the LAN.
  assert.equal(isHostAllowed("quiet-river-1234.trycloudflare.com", { ...local, mode: "tunnel" as const, tunnelHost: "quiet-river-1234.trycloudflare.com" }), true);
  assert.equal(isHostAllowed("192.0.2.10:3000", { ...remote, mode: "lan" as const }), true);
  // IPv4-mapped loopback peers are still loopback.
  assert.equal(isHostAllowed("localhost:3000", { ...base, remoteAddress: "::ffff:127.0.0.1", mode: "off" as const }), true);
});

test("tunnel adds exactly the one tunnel host", () => {
  const options = { ...local, mode: "tunnel" as const, tunnelHost: "quiet-river-1234.trycloudflare.com" };
  assert.equal(isHostAllowed("quiet-river-1234.trycloudflare.com", options), true);
  assert.equal(isHostAllowed("other-tunnel-9999.trycloudflare.com", options), false);
  assert.equal(isHostAllowed("evil.example.com", options), false);
});

test("an explicit wrong port is refused even on an allowed hostname", () => {
  const options = { ...local, mode: "lan" as const };
  assert.equal(isHostAllowed("192.0.2.10:9999", options), false);
  assert.equal(isHostAllowed("localhost:9999", options), false);
  // A bare host (no port) stays allowed; some proxies forward it that way.
  assert.equal(isHostAllowed("192.0.2.10", options), true);
});

test("OAuth state packs the origin in and unpacks it back out", () => {
  const state = packOAuthState("http://192.0.2.10:3000", "abcDEF-_123456");
  assert.match(state, /^abcDEF-_123456\./);
  assert.equal(unpackOAuthState(state), "http://192.0.2.10:3000");
});

test("unpackOAuthState rejects payloads that are not origins", () => {
  const forged = packOAuthState("https://evil.example.com", "abcDEF-_123456");
  // The random part is validated first; a forged random never unpacks.
  assert.equal(unpackOAuthState(`nope.${Buffer.from("http://x", "utf8").toString("base64url")}`), null);
  assert.equal(unpackOAuthState("no-dot-at-all"), null);
  assert.equal(unpackOAuthState(undefined), null);
  assert.equal(unpackOAuthState("."), null);
  // An origin-looking payload with a valid random unpacks; the allowlist check
  // at the call site is what keeps a forged origin from being *used*.
  assert.equal(unpackOAuthState(forged), "https://evil.example.com");
});

test("parseTunnelUrl finds the quick-tunnel URL in real cloudflared output", () => {
  const line = "2026-09-30T10:00:00Z INF +-----------------------------------------------------------+\n" +
    "|  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |\n" +
    "|  https://quiet-river-1234.trycloudflare.com                                            |";
  assert.equal(parseTunnelUrl(line), "https://quiet-river-1234.trycloudflare.com");
  assert.equal(parseTunnelUrl("no url in here"), null);
  assert.equal(parseTunnelUrl("https://example.com"), null);
});

test("only https and loopback origins can hold a registered OAuth callback", () => {
  // Discord's rule: HTTPS, with loopback as the single development exception.
  assert.equal(isOAuthCapableOrigin("https://quiet-river-1234.trycloudflare.com"), true);
  assert.equal(isOAuthCapableOrigin("http://localhost:3000"), true);
  assert.equal(isOAuthCapableOrigin("http://127.0.0.1:3000"), true);
  // The LAN address that produced «Invalid OAuth2 redirect_uri».
  assert.equal(isOAuthCapableOrigin("http://192.168.1.195:3000"), false);
  assert.equal(isOAuthCapableOrigin("not a url"), false);
});

test("loopback variants are recognised for the same-machine handoff", () => {
  assert.equal(isLoopbackOrigin("http://127.0.0.1:3000"), true);
  assert.equal(isLoopbackOrigin("http://localhost:3000"), true);
  assert.equal(isLoopbackOrigin("http://[::1]:3000"), true);
  assert.equal(isLoopbackOrigin("http://192.168.1.195:3000"), false);
  assert.equal(isLoopbackOrigin("https://quiet-river-1234.trycloudflare.com"), false);
});

/**
 * A live cloudflared pid is not proof the URL answers. The probe is the only
 * thing standing between the screen and a "running" badge on a link nothing
 * can reach, so each verdict is pinned: probeable states are probed, the rest
 * pass through untouched, and every failure shape names the cause.
 */
const tunnelUrl = "https://quiet-river-1234.trycloudflare.com";
const ok = async () => new Response("ok", { status: 200 });

test("a probeable tunnel that answers is confirmed running", async () => {
  assert.deepEqual(
    await probeTunnelReachability({ mode: "tunnel", url: tunnelUrl, status: "running" }, ok),
    { status: "running", error: null }
  );
  // A URL that appeared in the log late is promoted by the round trip, not by
  // a string match on the log file.
  assert.deepEqual(
    await probeTunnelReachability({ mode: "tunnel", url: tunnelUrl, status: "starting" }, ok),
    { status: "running", error: null }
  );
});

test("a live process with a dead edge becomes an actionable error", async () => {
  for (const failure of [
    async () => new Response("nope", { status: 502 }),
    async () => {
      throw new Error("fetch failed");
    }
  ]) {
    const verdict = await probeTunnelReachability({ mode: "tunnel", url: tunnelUrl, status: "running" }, failure);
    assert.equal(verdict.status, "error");
    assert.ok(verdict.error, "the verdict names the cause rather than reporting a bare failure");
  }
});

test("states with nothing to probe are returned untouched", async () => {
  // No address to ask, and an error already says what is wrong — probing again
  // would only re-report it, and re-probing "off" must never mint an error.
  for (const status of ["off", "error"] as const) {
    assert.deepEqual(
      await probeTunnelReachability({ mode: "tunnel", url: tunnelUrl, status }, ok),
      { status, error: null },
      `${status} is not probeable`
    );
  }
  assert.deepEqual(
    await probeTunnelReachability({ mode: "lan", url: tunnelUrl, status: "running" }, ok),
    { status: "running", error: null },
    "a LAN reach has no tunnel to probe"
  );
  assert.deepEqual(
    await probeTunnelReachability({ mode: "tunnel", url: null, status: "starting" }, ok),
    { status: "starting", error: null },
    "a starting tunnel without a URL is still starting"
  );
});

/**
 * The setup card must not ask for a step the operator has already taken, and
 * must come back when the address changes. Discord has no API to read an
 * application's redirect URIs, so a completed sign-in through an origin is the
 * record of registration — and the record is compared by origin, not by the
 * raw string the operator pasted.
 */
test("normaliseOrigin ignores the differences that do not matter", () => {
  assert.equal(normaliseOrigin("https://Quiet-River-1234.trycloudflare.com/"), "https://quiet-river-1234.trycloudflare.com");
  assert.equal(normaliseOrigin("http://localhost:3000/auth/discord/callback"), "http://localhost:3000");
  assert.equal(normaliseOrigin(null), null);
  assert.equal(normaliseOrigin("not a url"), null);
});

test("an origin a login completed through counts as registered", () => {
  const url = "https://quiet-river-1234.trycloudflare.com";
  assert.equal(isCallbackRegisteredFor(url, url), true);
  // Trailing slashes and case differences are the same tunnel.
  assert.equal(isCallbackRegisteredFor(`${url}/`, url.toUpperCase()), true);
});

test("a new tunnel address is not yet registered, and no tunnel needs nothing", () => {
  assert.equal(
    isCallbackRegisteredFor("https://old-tunnel-0000.trycloudflare.com", "https://new-tunnel-9999.trycloudflare.com"),
    false,
    "a fresh quick-tunnel URL after a restart must be registered again"
  );
  assert.equal(isCallbackRegisteredFor(null, "https://quiet-river-1234.trycloudflare.com"), false);
  assert.equal(isCallbackRegisteredFor("https://quiet-river-1234.trycloudflare.com", null), false);
});

/**
 * The tunnel log is appended across runs and never truncated, so the newest URL
 * in the whole file is only the live one when nothing older is in view. The
 * manager hands `lastTunnelUrlIn` a slice starting at its own spawn offset;
 * this is the rule that keeps a restarted tunnel from inheriting its
 * predecessor's address as if it were still good.
 */
const banner = (url: string) =>
  `2026-09-30T10:00:00Z INF Your quick Tunnel has been created! Visit it at:\n${url}\n`;

test("lastTunnelUrlIn returns the newest URL in the text it is given", () => {
  const previous = banner("https://old-tunnel-0000.trycloudflare.com");
  const fresh = banner("https://new-tunnel-9999.trycloudflare.com");
  assert.equal(lastTunnelUrlIn(previous), "https://old-tunnel-0000.trycloudflare.com");
  // A slice containing only this run's output cannot see the one before it.
  assert.equal(lastTunnelUrlIn(fresh), "https://new-tunnel-9999.trycloudflare.com");
  assert.equal(lastTunnelUrlIn(previous + fresh), "https://new-tunnel-9999.trycloudflare.com");
  assert.equal(lastTunnelUrlIn("cloudflared is starting, no URL yet"), null);
});
