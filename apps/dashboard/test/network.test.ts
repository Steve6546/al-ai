import test from "node:test";
import assert from "node:assert/strict";
import type { NetworkInterfaceInfo } from "node:os";
import {
  isCallbackRegisteredFor,
  isHostAllowed,
  isLoopbackOrigin,
  isNgrokQuotaResponse,
  isOAuthCapableOrigin,
  lanHostEntriesFrom,
  lanHostsFrom,
  lastTunnelUrlIn,
  nextProbeState,
  normaliseOrigin,
  packOAuthState,
  parseTunnelUrl,
  primaryLanHostFrom,
  probeTunnelLocally,
  probeTunnelReachability,
  splitHostPort,
  tunnelHostForGate,
  unpackOAuthReturnTo,
  unpackOAuthState,
  vpnAdaptersFrom,
  NGROK_AGENT_API_ORIGIN,
  PUBLIC_VERIFY_INTERVAL_MS,
  REMINT_COOLDOWN_MS,
  TUNNEL_QUOTA_ERROR
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

test("lan admits an RFC1918 Host only from an RFC1918 peer", () => {
  // A router-assigned alias the interface table did not report is still this
  // machine to a device on the LAN...
  assert.equal(isHostAllowed("192.168.1.200:3000", { ...remote, mode: "lan" as const }), true);
  // ...but the same header from loopback (the tunnel's peer) is a Host-header
  // claim, not a LAN visit, and stays refused.
  assert.equal(isHostAllowed("192.168.1.200:3000", { ...local, mode: "lan" as const }), false);
  // "off" refuses it even from a private peer: the switch means loopback only.
  assert.equal(isHostAllowed("192.168.1.200:3000", { ...remote, mode: "off" as const }), false);
  // A public Host from a private peer is still a stranger.
  assert.equal(isHostAllowed("203.0.113.7:3000", { ...remote, mode: "lan" as const }), false);
});

test("vpnAdaptersFrom reports live VPN NICs and ignores disconnected ones", () => {
  const interfaces = {
    HotspotShield_Wireguard: [{ address: "10.234.0.9", internal: false, family: "IPv4" } as NetworkInterfaceInfo],
    Tailscale: [{ address: "100.101.102.103", internal: false, family: "IPv4" } as NetworkInterfaceInfo],
    tun0: [{ address: "10.8.0.2", internal: false, family: "IPv4" } as NetworkInterfaceInfo],
    utun3: [{ address: "192.168.99.1", internal: false, family: "IPv6" } as NetworkInterfaceInfo],
    "Wi-Fi": [{ address: "192.168.1.195", internal: false, family: "IPv4" } as NetworkInterfaceInfo]
  };
  assert.deepEqual(vpnAdaptersFrom(interfaces), ["HotspotShield_Wireguard", "Tailscale", "tun0"]);
});

test("primaryLanHostFrom prefers the physical private adapter", () => {
  const interfaces = {
    HotspotShield_Wireguard: [{ address: "10.234.0.9", internal: false, family: "IPv4" } as NetworkInterfaceInfo],
    "Ethernet 4": [{ address: "192.168.56.1", internal: false, family: "IPv4" } as NetworkInterfaceInfo],
    "Wi-Fi": [{ address: "192.168.1.195", internal: false, family: "IPv4" } as NetworkInterfaceInfo]
  };
  // The VPN address and the VirtualBox host-only default are not scannable by
  // a phone on the router; the Wi-Fi address is.
  assert.equal(primaryLanHostFrom(interfaces), "192.168.1.195");
  assert.equal(primaryLanHostFrom({}), null);
});

test("the loopback and tunnel hostname branches need a loopback peer", () => {
  // A LAN peer presenting Host: localhost is impersonating the trusted origin —
  // the header is attacker-controlled on any socket.
  assert.equal(isHostAllowed("localhost:3000", { ...remote, mode: "off" as const }), false);
  assert.equal(isHostAllowed("127.0.0.1:3000", { ...remote, mode: "lan" as const }), false);
  // The tunnel hostname from a direct-origin connection: same impersonation.
  const tunnel = { ...remote, mode: "tunnel" as const, tunnelHost: "quiet-river-1234.ngrok-free.app" };
  assert.equal(isHostAllowed("quiet-river-1234.ngrok-free.app", tunnel), false);
  // ...while ngrok genuinely connects from loopback, so the real path
  // keeps working, and the machine's own addresses stay reachable from the LAN.
  assert.equal(isHostAllowed("quiet-river-1234.ngrok-free.app", { ...local, mode: "tunnel" as const, tunnelHost: "quiet-river-1234.ngrok-free.app" }), true);
  assert.equal(isHostAllowed("192.0.2.10:3000", { ...remote, mode: "lan" as const }), true);
  // IPv4-mapped loopback peers are still loopback.
  assert.equal(isHostAllowed("localhost:3000", { ...base, remoteAddress: "::ffff:127.0.0.1", mode: "off" as const }), true);
});

test("tunnel adds exactly the one tunnel host", () => {
  const options = { ...local, mode: "tunnel" as const, tunnelHost: "quiet-river-1234.ngrok-free.app" };
  assert.equal(isHostAllowed("quiet-river-1234.ngrok-free.app", options), true);
  assert.equal(isHostAllowed("other-tunnel-9999.ngrok-free.app", options), false);
  assert.equal(isHostAllowed("evil.example.com", options), false);
});

test("an explicit wrong port is refused even on an allowed hostname", () => {
  const options = { ...local, mode: "lan" as const };
  assert.equal(isHostAllowed("192.0.2.10:9999", options), false);
  assert.equal(isHostAllowed("localhost:9999", options), false);
  // A bare host (no port) stays allowed; some proxies forward it that way.
  assert.equal(isHostAllowed("192.0.2.10", options), true);
});

/**
 * The gate must not depend on a value that can be missing.
 *
 * Measured failure: the agent was alive and serving the reserved domain while
 * `remote_access_tunnel_url` was empty (the URL write lost a race with the
 * spawn). The gate only knew the live URL, so it answered every request through
 * the tunnel with `REMOTE_ACCESS_DISABLED` — and the probe that decides whether
 * to re-mint read that refusal as "the URL does not answer" and replaced a
 * working agent, every eight minutes, forever.
 */
test("the tunnel host survives an empty live URL when a domain is configured", () => {
  assert.equal(tunnelHostForGate(null, "quiet-river-1234.ngrok-free.dev"), "quiet-river-1234.ngrok-free.dev");
  assert.equal(tunnelHostForGate("", "quiet-river-1234.ngrok-free.dev"), "quiet-river-1234.ngrok-free.dev");
  // The domain wins: the agent is started with `--url=https://<domain>`, so a
  // differing live URL is a stale quick-tunnel address.
  assert.equal(
    tunnelHostForGate("https://old-quick-9999.ngrok-free.app", "quiet-river-1234.ngrok-free.dev"),
    "quiet-river-1234.ngrok-free.dev"
  );
  // A quick tunnel has no domain to fall back on, so the live URL is the answer.
  assert.equal(tunnelHostForGate("https://old-quick-9999.ngrok-free.app", null), "old-quick-9999.ngrok-free.app");
  // Nothing known: nothing allowed, rather than a wildcard.
  assert.equal(tunnelHostForGate(null, null), null);
  assert.equal(tunnelHostForGate("not a url", null), null);
});

test("OAuth state packs the origin in and unpacks it back out", () => {
  const state = packOAuthState("http://192.0.2.10:3000", "abcDEF-_123456");
  assert.match(state, /^abcDEF-_123456\./);
  assert.equal(unpackOAuthState(state), "http://192.0.2.10:3000");
  assert.equal(unpackOAuthReturnTo(state), null, "a plain sign-in has no LAN return address");
});

test("OAuth state carries a LAN return address for the tunnel leg", () => {
  // A phone on the router cannot hold a Discord callback; the tunnel leg packs
  // its origin so the callback can hand the finished session back.
  const state = packOAuthState("https://quiet-river.ngrok-free.app", "abcDEF-_123456", "http://192.168.1.195:3000");
  assert.equal(unpackOAuthState(state), "https://quiet-river.ngrok-free.app");
  assert.equal(unpackOAuthReturnTo(state), "http://192.168.1.195:3000");
  // The newline separator cannot be smuggled: a payload with three parts is
  // rejected rather than silently using one of them.
  const three = `abcDEF-_123456.${Buffer.from("http://a\nhttp://b\nhttp://c", "utf8").toString("base64url")}`;
  assert.equal(unpackOAuthReturnTo(three), null);
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

test("parseTunnelUrl finds the tunnel URL in real ngrok output", () => {
  const line = JSON.stringify({
    lvl: "info",
    msg: "started tunnel",
    url: "https://quiet-river-1234.ngrok-free.app"
  });
  assert.equal(parseTunnelUrl(line), "https://quiet-river-1234.ngrok-free.app");
  // The free plan's assigned dev domain uses `.ngrok-free.dev`; both the JSON
  // field and the plain-text fallback must recognise it.
  const devLine = JSON.stringify({
    lvl: "info",
    msg: "started tunnel",
    url: "https://quiet-river-1234.ngrok-free.dev"
  });
  assert.equal(parseTunnelUrl(devLine), "https://quiet-river-1234.ngrok-free.dev");
  assert.equal(parseTunnelUrl("started https://quiet-river-1234.ngrok-free.dev"), "https://quiet-river-1234.ngrok-free.dev");
  assert.equal(parseTunnelUrl("no url in here"), null);
  assert.equal(parseTunnelUrl("https://example.com"), null);
});

test("only https and loopback origins can hold a registered OAuth callback", () => {
  // Discord's rule: HTTPS, with loopback as the single development exception.
  assert.equal(isOAuthCapableOrigin("https://quiet-river-1234.ngrok-free.app"), true);
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
  assert.equal(isLoopbackOrigin("https://quiet-river-1234.ngrok-free.app"), false);
});

/**
 * A live ngrok pid is not proof the URL answers. The probe is the only
 * thing standing between the screen and a "running" badge on a link nothing
 * can reach, so each verdict is pinned: probeable states are probed, the rest
 * pass through untouched, and every failure shape names the cause.
 */
const tunnelUrl = "https://quiet-river-1234.ngrok-free.app";
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
  // No address to ask, and "off" must never mint an error.
  assert.deepEqual(
    await probeTunnelReachability({ mode: "tunnel", url: tunnelUrl, status: "off" }, ok),
    { status: "off", error: null },
    "off is not probeable"
  );
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

test("an error recovers on its own when the URL answers again", async () => {
  // A transient failed probe (edge reconnect, VPN blip) must not latch the
  // screen into "broken" until the operator toggles the mode.
  assert.deepEqual(
    await probeTunnelReachability({ mode: "tunnel", url: tunnelUrl, status: "error" }, ok),
    { status: "running", error: null }
  );
});

/**
 * When a dead URL is worth killing the agent for.
 *
 * Three times in one evening the ngrok agent stayed alive while its edge
 * dropped: the screen said "running", the browser got `ERR_NGROK_3200`, and the
 * only fix was the toggle the operator had to find and press. The heal is the
 * toggle, taken automatically — but only for an address that was advertised and
 * then stopped answering.
 */
test("an address that stops answering is re-minted after two probes", () => {
  const first = nextProbeState({ url: tunnelUrl, verdict: "error", failures: 0 });
  assert.deepEqual(first, { failures: 1, remint: false }, "one failed probe is a hiccup, not evidence");

  const second = nextProbeState({ url: tunnelUrl, verdict: "error", failures: first.failures });
  assert.deepEqual(second, { failures: 0, remint: true }, "the second one thirty seconds later is a wedged agent");
});

test("a probe that answers clears the count without re-minting", () => {
  assert.deepEqual(
    nextProbeState({ url: tunnelUrl, verdict: "running", failures: 1 }),
    { failures: 0, remint: false },
    "the tunnel came back on its own, which is what an edge reconnect looks like"
  );
});

test("a tunnel with no address is never re-minted by the probe", () => {
  // ERR_NGROK_9040 — ngrok refusing this ISP address — leaves no URL at all.
  // That state belongs to the spaced retry ladder, which stops and reports;
  // healing it would respawn an agent forever against a block no restart fixes.
  assert.deepEqual(
    nextProbeState({ url: null, verdict: "error", failures: 4 }),
    { failures: 0, remint: false }
  );
});

/**
 * ERR_NGROK_727 (the free plan's 20,000-request monthly quota) is an account
 * fact, not a dead URL. The old healer read the 403 as "the address stopped
 * answering" and re-minted the agent forever; every new agent inherited the
 * same exhausted account. These tests pin the classification and the refusal.
 */
test("an exhausted ngrok quota is recognised and never re-minted", async () => {
  assert.equal(isNgrokQuotaResponse(403, "This ngrok account has reached its HTTP requests limit (ERR_NGROK_727)"), true);
  assert.equal(isNgrokQuotaResponse(403, "HTTP Requests exceeded"), true);
  assert.equal(isNgrokQuotaResponse(403, "forbidden by our own host gate"), false);
  assert.equal(isNgrokQuotaResponse(502, "ERR_NGROK_727"), false);

  const quotaPage = async () =>
    new Response("This ngrok account has reached its HTTP requests limit for the month. (ERR_NGROK_727)", { status: 403 });
  const verdict = await probeTunnelReachability(
    { mode: "tunnel", url: tunnelUrl, status: "running" },
    quotaPage
  );
  assert.equal(verdict.status, "error");
  assert.equal(verdict.quotaExceeded, true);
  assert.equal(verdict.error, TUNNEL_QUOTA_ERROR);
  assert.deepEqual(
    nextProbeState({ url: tunnelUrl, verdict: "error", failures: 4, quotaExceeded: true }),
    { failures: 0, remint: false }
  );
});

test("a wedged agent waits out the re-mint cooldown", () => {
  const now = 1_000_000;
  assert.deepEqual(
    nextProbeState({ url: tunnelUrl, verdict: "error", failures: 1, lastRemintAt: now - 1_000, now }),
    { failures: 0, remint: false },
    "a restart a second ago cannot be worth another one"
  );
  assert.deepEqual(
    nextProbeState({ url: tunnelUrl, verdict: "error", failures: 1, lastRemintAt: now - REMINT_COOLDOWN_MS - 1, now }),
    { failures: 0, remint: true }
  );
});

/** A fetch stub that records every URL, so "no public request" is measurable. */
function recordingFetch(
  answers: Record<string, { status: number; body: unknown }>
): { fetchImpl: typeof fetch; asked: string[] } {
  const asked: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    asked.push(url);
    const prefix = Object.keys(answers).find(key => url.startsWith(key));
    if (!prefix) return new Response("{}", { status: 404 });
    const answer = answers[prefix];
    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;
  return { fetchImpl, asked };
}

const localOptions = {
  agentApi: NGROK_AGENT_API_ORIGIN,
  upstream: "http://127.0.0.1:3000",
  expectedUrl: tunnelUrl
};

const healthyAgent = {
  [`${NGROK_AGENT_API_ORIGIN}/api/status`]: { status: 200, body: { status: "online" } },
  [`${NGROK_AGENT_API_ORIGIN}/api/tunnels`]: {
    status: 200,
    body: { tunnels: [{ public_url: tunnelUrl }] }
  },
  "http://127.0.0.1:3000/api/health": { status: 200, body: { status: "healthy" } }
};

test("liveness is proved on loopback and spends zero public requests", async () => {
  const { fetchImpl, asked } = recordingFetch(healthyAgent);
  const verdict = await probeTunnelLocally(localOptions, fetchImpl);
  assert.equal(verdict.healthy, true, verdict.reason ?? "healthy");
  assert.ok(verdict.urls.includes(tunnelUrl.toLowerCase()));
  assert.equal(asked.some(url => url.startsWith(tunnelUrl)), false, "no request may leave through the tunnel");
  assert.ok(PUBLIC_VERIFY_INTERVAL_MS >= 60 * 60 * 1000, "public verification stays at most hourly");
});

test("an offline agent, a changed URL and a dead upstream are all unhealthy", async () => {
  for (const broken of [
    { ...healthyAgent, [`${NGROK_AGENT_API_ORIGIN}/api/status`]: { status: 200, body: { status: "offline" } } },
    {
      ...healthyAgent,
      [`${NGROK_AGENT_API_ORIGIN}/api/tunnels`]: {
        status: 200,
        body: { tunnels: [{ public_url: "https://another-1234.ngrok-free.dev" }] }
      }
    },
    { ...healthyAgent, "http://127.0.0.1:3000/api/health": { status: 503, body: {} } }
  ]) {
    const { fetchImpl } = recordingFetch(broken);
    assert.equal((await probeTunnelLocally(localOptions, fetchImpl)).healthy, false);
  }
});

test("a reconnecting agent is alive, not a reason to kill it", async () => {
  const { fetchImpl } = recordingFetch({
    ...healthyAgent,
    [`${NGROK_AGENT_API_ORIGIN}/api/status`]: { status: 200, body: { status: "reconnecting" } }
  });
  assert.equal((await probeTunnelLocally(localOptions, fetchImpl)).healthy, true);
});

test("a non-loopback agent API is refused instead of becoming an outbound probe", async () => {
  const { fetchImpl, asked } = recordingFetch(healthyAgent);
  const verdict = await probeTunnelLocally({ ...localOptions, agentApi: "https://attacker.example" }, fetchImpl);
  assert.equal(verdict.healthy, false);
  assert.equal(asked.length, 0);
});

/**
 * The setup card must not ask for a step the operator has already taken, and
 * must come back when the address changes. Discord has no API to read an
 * application's redirect URIs, so a completed sign-in through an origin is the
 * record of registration — and the record is compared by origin, not by the
 * raw string the operator pasted.
 */
test("normaliseOrigin ignores the differences that do not matter", () => {
  assert.equal(normaliseOrigin("https://Quiet-River-1234.ngrok-free.app/"), "https://quiet-river-1234.ngrok-free.app");
  assert.equal(normaliseOrigin("http://localhost:3000/auth/discord/callback"), "http://localhost:3000");
  assert.equal(normaliseOrigin(null), null);
  assert.equal(normaliseOrigin("not a url"), null);
});

test("an origin a login completed through counts as registered", () => {
  const url = "https://quiet-river-1234.ngrok-free.app";
  assert.equal(isCallbackRegisteredFor(url, url), true);
  // Trailing slashes and case differences are the same tunnel.
  assert.equal(isCallbackRegisteredFor(`${url}/`, url.toUpperCase()), true);
});

test("a new tunnel address is not yet registered, and no tunnel needs nothing", () => {
  assert.equal(
    isCallbackRegisteredFor("https://old-tunnel-0000.ngrok-free.app", "https://new-tunnel-9999.ngrok-free.app"),
    false,
    "a fresh quick-tunnel URL after a restart must be registered again"
  );
  assert.equal(isCallbackRegisteredFor(null, "https://quiet-river-1234.ngrok-free.app"), false);
  assert.equal(isCallbackRegisteredFor("https://quiet-river-1234.ngrok-free.app", null), false);
});

/**
 * The tunnel log is appended across runs and never truncated, so the newest URL
 * in the whole file is only the live one when nothing older is in view. The
 * manager hands `lastTunnelUrlIn` a slice starting at its own spawn offset;
 * this is the rule that keeps a restarted tunnel from inheriting its
 * predecessor's address as if it were still good.
 */
const banner = (url: string) => JSON.stringify({ lvl: "info", msg: "started tunnel", url });

test("lastTunnelUrlIn returns the newest URL in the text it is given", () => {
  const previous = banner("https://old-tunnel-0000.ngrok-free.app");
  const fresh = banner("https://new-tunnel-9999.ngrok-free.app");
  assert.equal(lastTunnelUrlIn(previous), "https://old-tunnel-0000.ngrok-free.app");
  // A slice containing only this run's output cannot see the one before it.
  assert.equal(lastTunnelUrlIn(fresh), "https://new-tunnel-9999.ngrok-free.app");
  assert.equal(lastTunnelUrlIn(previous + fresh), "https://new-tunnel-9999.ngrok-free.app");
  assert.equal(lastTunnelUrlIn("ngrok is starting, no URL yet"), null);
});
