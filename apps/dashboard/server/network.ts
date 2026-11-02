import { execFile, spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import { promisify } from "node:util";
import { normaliseRemoteAccessMode, type RemoteAccessMode } from "@al-ai/core";

/**
 * The deployment's network reach, as one switch the operator controls.
 *
 * Three pieces live here:
 *
 * - **Pure functions** — the host allowlist, the OAuth state codec that carries
 *   the browser's origin through Discord's redirect, and the ngrok URL parser.
 *   All unit-tested without a socket or a child process.
 * - **The manager** — loads the mode from `instance_settings`, spawns and stops
 *   the `ngrok` tunnel, and answers "is this Host header allowed?" for the
 *   request gate.
 *
 * The allowlist is deliberately exact rather than pattern-based. "Off" means
 * loopback, "lan" means the machine's own addresses, "tunnel" adds exactly one
 * tunnel hostname — anything else is refused with 403. A pattern rule such as
 * "any private address" would let a request whose Host header merely *claims*
 * to be an internal IP through the gate; matching the machine's real interfaces
 * does not.
 */

export type TunnelStatus = "off" | "starting" | "running" | "error";

/**
 * One of the machine's own addresses, with the interface it belongs to.
 *
 * A machine answers on several adapters at once — the Wi-Fi it is joined to, a
 * virtual host-only adapter, a VPN's virtual NIC — and every one of them is a
 * real way to reach the dashboard. Listing them as bare identical «شبكة
 * محلية» rows told the operator nothing about which was which, so each row
 * carries the adapter's name as well.
 */
export type MachineHostEntry = { host: string; label: string };

export type NetworkSnapshot = {
  mode: RemoteAccessMode;
  tunnelProvider: "ngrok";
  tunnelUrl: string | null;
  /** The configured ngrok domain, stable across restarts. */
  tunnelDomain: string | null;
  /** True when the live URL is the configured domain, not a random one. */
  tunnelStable: boolean;
  tunnelStatus: TunnelStatus;
  tunnelError: string | null;
  /** The machine's own non-loopback addresses, each with its interface name. */
  machineHosts: MachineHostEntry[];
  port: number;
  /**
   * Whether a sign-in has completed through the tunnel address, which is the
   * only real proof that its redirect URI is registered in Discord. The
   * «خطوة واحدة في Discord» card is gated on this — see
   * {@link markOriginVerified}.
   */
  tunnelCallbackVerified: boolean;
};

/* ------------------------------------------------------------------ *
 * Pure helpers
 * ------------------------------------------------------------------ */

/** Real, non-loopback addresses of this machine, as bare hostnames. */
export function lanHostsFrom(
  interfaces: Record<string, NetworkInterfaceInfo[] | undefined>
): string[] {
  const hosts: string[] = [];
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      if (!hosts.includes(entry.address)) hosts.push(entry.address);
    }
  }
  return hosts;
}

/**
 * The same addresses, each paired with the interface it came from. Used for
 * display, where a bare IP gives no hint which adapter it is.
 */
export function lanHostEntriesFrom(
  interfaces: Record<string, NetworkInterfaceInfo[] | undefined>
): MachineHostEntry[] {
  const entries: MachineHostEntry[] = [];
  for (const [name, list] of Object.entries(interfaces)) {
    for (const entry of list ?? []) {
      if (entry.internal) continue;
      // Two adapters can hold the same address (a VPN mirroring the host's IP);
      // the first name wins, so a row is never listed twice.
      if (entries.some(existing => existing.host === entry.address)) continue;
      entries.push({ host: entry.address, label: name });
    }
  }
  return entries;
}


/**
 * Splits a Host header (or an origin's host part) into hostname and port.
 * IPv6 hosts arrive bracketed — `[::1]:3000` — and the brackets stay on the
 * hostname so callers can match against the same bracketed spelling.
 */
export function splitHostPort(host: string): { hostname: string; port: string | null } {
  const index = host.lastIndexOf(":");
  // No colon, or the only one sits inside brackets: a bare hostname or an
  // unbracketed IPv6 with no port. `host.lastIndexOf` on `[::1]` finds the
  // colon before `1]`, so guard on the bracket closing first.
  if (index < 0 || (host.startsWith("[") && index < host.indexOf("]"))) {
    return { hostname: host, port: null };
  }
  const hostname = host.slice(0, index);
  const port = host.slice(index + 1);
  return /^\d+$/.test(port) ? { hostname, port } : { hostname: host, port: null };
}

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** The socket-level loopback peers a request can genuinely arrive from. */
export function isLoopbackPeer(remoteAddress: string | undefined): boolean {
  return (
    remoteAddress === "127.0.0.1" ||
    remoteAddress === "::1" ||
    remoteAddress === "::ffff:127.0.0.1"
  );
}

/**
 * The reachability verdict for one Host header **from one TCP peer**. A missing
 * port is allowed (some proxies forward the host bare); an explicit port that
 * is not ours is not this server and is refused.
 *
 * The Host header is attacker-controlled on any socket, so the loopback and
 * tunnel-hostname branches — the ones that would otherwise let a *direct*
 * origin connection impersonate a trusted origin — are honored only for
 * requests whose peer is genuinely loopback: a browser on this machine, or the
 * `ngrok` process, which targets `http://127.0.0.1:<port>` by construction. A LAN peer may present the machine's real interface addresses;
 * anything else is refused.
 */
export function isHostAllowed(
  host: string | undefined,
  options: { port: number; mode: RemoteAccessMode; machineHosts: string[]; tunnelHost: string | null; remoteAddress?: string }
): boolean {
  if (!host) return false;
  const { hostname, port } = splitHostPort(host);
  if (port !== null && port !== String(options.port)) return false;
  const peerIsLocal = isLoopbackPeer(options.remoteAddress);
  if (LOOPBACK_HOSTNAMES.has(hostname)) return peerIsLocal;
  if (options.mode === "off") return false;
  if (options.machineHosts.includes(hostname)) return true;
  if (options.mode === "tunnel" && options.tunnelHost && hostname === options.tunnelHost) return peerIsLocal;
  return false;
}

/**
 * Carries the browser's origin through the OAuth round trip inside the `state`
 * value.
 *
 * The redirect URI is `env.redirectUri` today, which pins sign-in to one host
 * name forever — a LAN device or a tunnel URL could load the dashboard but
 * could never finish a login. Discord requires the *same* redirect URI at the
 * authorize and token legs, and the `state` value is echoed back verbatim, so
 * it is the one channel that survives the round trip without server-side
 * storage. The callback validates the unpacked origin against the same
 * allowlist before using it, so a forged state cannot pick an arbitrary host.
 */
export function packOAuthState(origin: string, random: string): string {
  return `${random}.${Buffer.from(origin, "utf8").toString("base64url")}`;
}

const OAUTH_RANDOM_PATTERN = /^[A-Za-z0-9_-]{8,}$/;
const ORIGIN_PATTERN = /^https?:\/\/[^\s/]+$/;

/** The origin a state value carries, or null when it does not carry one. */
export function unpackOAuthState(state: string | undefined | null): string | null {
  if (!state) return null;
  const dot = state.indexOf(".");
  if (dot <= 0) return null;
  const random = state.slice(0, dot);
  if (!OAUTH_RANDOM_PATTERN.test(random)) return null;
  try {
    const origin = Buffer.from(state.slice(dot + 1), "base64url").toString("utf8");
    return ORIGIN_PATTERN.test(origin) ? origin : null;
  } catch {
    return null;
  }
}

const NGROK_FREE_URL = /https:\/\/[a-z0-9][a-z0-9.-]*\.(?:ngrok-free\.app|ngrok-free\.dev|ngrok\.app|ngrok\.io)/i;

/** The tunnel URL inside an ngrok log line, lower-cased, or null. */
export function parseTunnelUrl(text: string): string | null {
  // The JSON log line carries the authoritative URL, including a custom
  // domain. `"url":"https://…"` is preferred over a hostname pattern.
  const json = /"url"\s*:\s*"([^"]+)"/i.exec(text);
  if (json) {
    try {
      const url = new URL(json[1]);
      if (url.protocol === "https:" && !url.hostname.endsWith("ngrok.com")) return url.origin.toLowerCase();
    } catch {
      /* not a URL; fall through to the hostname pattern */
    }
  }
  const match = NGROK_FREE_URL.exec(text);
  return match ? match[0].toLowerCase() : null;
}

/**
 * The *last* tunnel URL in the given text, lower-cased, or null.
 *
 * The log is appended across runs, so the newest URL is the one this run
 * printed. Both readers share this one parser, so the address shape cannot
 * drift between them.
 */
export function lastTunnelUrlIn(text: string): string | null {
  const fromJson = [...text.matchAll(/"url"\s*:\s*"([^"]+)"/gi)]
    .map(match => match[1])
    .reverse()
    .find(value => {
      try {
        const url = new URL(value);
        return url.protocol === "https:" && !url.hostname.endsWith("ngrok.com");
      } catch {
        return false;
      }
    });
  if (fromJson) return new URL(fromJson).origin.toLowerCase();
  const matches = text.match(new RegExp(NGROK_FREE_URL.source, "gi"));
  return matches ? matches[matches.length - 1].toLowerCase() : null;
}

/**
 * A configured ngrok hostname, normalised to a bare lower-case host.
 * Accepts `https://name.ngrok-free.dev/` and returns `name.ngrok-free.dev`.
 * A custom domain is allowed too (ngrok paid plans).
 */
export function normaliseNgrokDomain(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const host = value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/\.$/, "");
  if (!host || host.length > 253) return null;
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(host)) return null;
  return host;
}

/**
 * Origins Discord lets an application register as redirect URIs.
 *
 * Discord's rule: redirect URIs must be HTTPS, with loopback (`localhost`,
 * `127.0.0.1`) as the single development exception. A plain-HTTP LAN address
 * like `http://192.168.1.195:3000` cannot be saved in the Developer Portal at
 * all — which is what produced the «Invalid OAuth2 redirect_uri» screen: the
 * sign-in leg built a redirect URI Discord would never accept. The login and
 * invite legs therefore hand such browsers to an origin that *can* hold a
 * registered callback (the tunnel), instead of walking them into a wall.
 */
export function isOAuthCapableOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return url.protocol === "https:" || LOOPBACK_HOSTNAMES.has(url.hostname);
  } catch {
    return false;
  }
}

export function isLoopbackOrigin(origin: string): boolean {
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/**
 * Ask the tunnel's own public address whether it is really serving.
 *
 * A live `ngrok` pid is not proof the URL works: the process can stay alive
 * while its edge connection is dead, because a VPN or a filtering proxy on this
 * machine can break the outbound session without killing the process. The
 * snapshot would then advertise "running" with a link nothing on the internet
 * can reach — worse than no answer, since the screen offers it and gives no
 * reason. So the read probes `/api/health` through the public address, and a
 * tunnel that does not answer becomes an error the operator can act on.
 *
 * Only `starting` and `running` are probeable: `off` has no address and
 * `error` already says what is wrong. `starting` is promoted to `running` by a
 * successful probe, which is how a URL that appeared in the log late is
 * confirmed by a round trip rather than by a string match.
 *
 * Pure apart from the fetch it is handed, so the verdict is unit-tested with a
 * stub and the manager keeps only the throttle and the race guard.
 */
export const TUNNEL_UNREACHABLE_ERROR =
  "النفق يعلن أنه يعمل لكن الرابط لا يستجيب. تحقق من VPN أو جدار الحماية، أو أعد اختيار الوضع.";

export const PROBE_TIMEOUT_MS = 5_000;

export type ProbeVerdict = { status: TunnelStatus; error: string | null };

/** Consecutive unreachable probes that justify re-minting the agent. */
export const RESTART_AFTER_FAILURES = 2;

/**
 * The heal decision, kept pure so the dangerous case is testable without a real
 * agent.
 *
 * A tunnel that never got an address must **not** be re-minted forever: that is
 * `ERR_NGROK_9040`, an ISP block, and the spaced retry ladder already owns it —
 * re-minting on a probe failure would turn a visible "gave up after 2 attempts"
 * into an endless respawn. Only an address we advertised and that stopped
 * answering is a wedged agent, and only a wedged agent is worth killing.
 */
export function nextProbeState(state: {
  url: string | null;
  verdict: TunnelStatus;
  failures: number;
}): { failures: number; remint: boolean } {
  if (!state.url) return { failures: 0, remint: false };
  const failures = state.verdict === "running" ? 0 : state.failures + 1;
  return failures >= RESTART_AFTER_FAILURES ? { failures: 0, remint: true } : { failures, remint: false };
}

export async function probeTunnelReachability(
  state: { mode: RemoteAccessMode; url: string | null; status: TunnelStatus },
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = PROBE_TIMEOUT_MS
): Promise<ProbeVerdict> {
  if (state.mode !== "tunnel" || !state.url) return { status: state.status, error: null };
  // An `error` is probed too: a transient failed probe (ngrok edge reconnect,
  // a VPN blip) must recover on its own, or the screen keeps calling a working
  // URL broken until the operator toggles the mode.
  if (state.status !== "running" && state.status !== "starting" && state.status !== "error") {
    return { status: state.status, error: null };
  }
  try {
    const response = await fetchImpl(`${state.url}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`health check returned ${response.status}`);
    return { status: "running", error: null };
  } catch {
    return { status: "error", error: TUNNEL_UNREACHABLE_ERROR };
  }
}

/**
 * Has the tunnel address already proved its redirect URI is registered?
 *
 * `verifiedOrigin` is the origin a completed sign-in travelled through. A match
 * means the setup step is done and the card should not ask for it again; a
 * mismatch — including a brand-new tunnel address after a restart — means it is
 * not, and the card correctly returns. No tunnel address is never "verified":
 * there is nothing to set up.
 */
export function isCallbackRegisteredFor(
  verifiedOrigin: string | null,
  tunnelUrl: string | null
): boolean {
  if (!tunnelUrl) return false;
  return normaliseOrigin(verifiedOrigin) === normaliseOrigin(tunnelUrl);
}

/**
 * Two ways of writing the same origin — trailing slash, letter case — must not
 * make a registered tunnel look unregistered. Returns null for anything that is
 * not an origin at all.
 */
export function normaliseOrigin(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`.toLowerCase();
  } catch {
    return null;
  }
}

/** The log's current size in bytes, or 0 when it does not exist yet. */
function statSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * The ngrok CLI. Its own config file carries the account authtoken, so this
 * app never stores a second copy of the secret. `NGROK_PATH` is only for a
 * non-standard install.
 */
function resolveNgrokPath(): string {
  return process.env.NGROK_PATH?.trim() || "ngrok";
}

/** A fixed ngrok hostname from the environment, when one is configured. */
function envNgrokDomain(): string | null {
  return normaliseNgrokDomain(process.env.NGROK_DOMAIN);
}

/**
 * A boot-time override for the reach mode, from `AL_AI_REMOTE_ACCESS`.
 *
 * A random ngrok address is best-effort, and a machine that once turned the
 * tunnel on would otherwise mint a fresh URL on every local boot. The
 * bootstrapper therefore passes `off` for a plain local run and `on` only when
 * `--tunnel` was requested. Neither value is written to the operator's saved
 * setting: the switch in the dashboard remains the only thing that persists a
 * mode, so an override lasts exactly one process and a restart without it
 * returns to the stored choice.
 */
function remoteAccessOverride(): RemoteAccessMode | null {
  const value = process.env.AL_AI_REMOTE_ACCESS?.trim().toLowerCase();
  if (value === "off") return "off";
  if (value === "on" || value === "tunnel") return "tunnel";
  return null;
}

/* ------------------------------------------------------------------ *
 * The manager
 * ------------------------------------------------------------------ */

type NetworkLog = { info: (object: object, message: string) => void; warn: (object: object, message: string) => void };

/** `instance_settings` keys owned by the network manager. */
export const REMOTE_ACCESS_MODE_KEY = "remote_access_mode";
export const TUNNEL_PID_KEY = "remote_access_tunnel_pid";
export const TUNNEL_URL_KEY = "remote_access_tunnel_url";
/** The operator's fixed ngrok hostname; empty means a random tunnel URL. */
export const NGROK_DOMAIN_KEY = "remote_access_ngrok_domain";
/**
 * The origin a completed sign-in travelled through.
 *
 * An origin that exchanged a code answered a `redirect_uri` Discord accepted,
 * which cannot happen for an unregistered URI — so the round trip is evidence
 * stronger than any list: it proves a browser actually got here and back.
 *
 * (This used to claim Discord offers no API to read the registered URIs. It
 * does: `GET /applications/@me` with the bot token returns `redirect_uris`, and
 * `scripts/oauth-preflight.mjs` reads it before launch. Reading the list says a
 * URI *could* work; the round trip says it did.)
 */
export const VERIFIED_ORIGIN_KEY = "remote_access_verified_origin";

const execFileAsync = promisify(execFile);
const TUNNEL_START_TIMEOUT_MS = 20_000;

/** Spacing for the automatic re-spawn after an unexpected tunnel exit. */
const TUNNEL_RETRY_DELAYS_MS = [5_000, 15_000, 45_000];

/** The tunnel log lives next to the dashboard process; `*.log` is git-ignored. */
function tunnelLogPath(): string {
  return join(process.cwd(), ".al-tunnel.log");
}

/**
 * Is `pid` a live `ngrok` process? The image-name check matters: PIDs are
 * recycled, and adopting an unrelated process by number alone would make the
 * gate trust a tunnel that does not exist.
 */
async function isNgrokPid(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    const { stdout } = await execFileAsync(
      "tasklist",
      ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
      { timeout: 5_000 }
    );
    return stdout.toLowerCase().includes("ngrok");
  } catch {
    return false;
  }
}

async function killTree(pid: number): Promise<void> {
  try {
    await execFileAsync("taskkill", ["/PID", String(pid), "/T", "/F"], { timeout: 5_000 });
  } catch {
    // Already gone, or not ours to kill. The caller verifies with waitForGone.
  }
}

/**
 * Wait until the pid is no longer a live ngrok process.
 *
 * Starting the replacement before the old agent has released the endpoint is
 * what produced two agents on one static domain (`ERR_NGROK_6030`). A pid check
 * after the kill closes that window instead of trusting `taskkill`'s exit.
 */
async function waitForGone(pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isNgrokPid(pid))) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

export function createNetworkManager(input: {
  port: number;
  getSetting: (key: string) => Promise<string | null>;
  setSetting: (key: string, value: string) => Promise<void>;
  log: NetworkLog;
  /** Overridable so a test can watch the retry ladder without waiting minutes. */
  retryDelaysMs?: number[];
}) {
  const retryDelaysMs = input.retryDelaysMs ?? TUNNEL_RETRY_DELAYS_MS;
  let mode: RemoteAccessMode = "off";
  let tunnelUrl: string | null = null;
  let tunnelStatus: TunnelStatus = "off";
  let tunnelError: string | null = null;
  /** The fixed ngrok hostname, or null for a random tunnel URL. */
  let domain: string | null = null;
  // `child` is set only when THIS process spawned ngrok; an adopted tunnel
  // from a previous dashboard life is tracked by pid alone.
  let child: ChildProcess | null = null;
  let tunnelPid: number | null = null;
  let verifiedOrigin: string | null = null;
  // A tunnel can die for a reason that fixes itself: ngrok refuses agents from
  // some ISP addresses (ERR_NGROK_9040), and a residential line rotates to an
  // allowed one minutes later. Dying on the first attempt made the operator
  // re-pick the mode by hand every time, so a few spaced retries happen first —
  // bounded, because an auth failure that is *not* transient must not retry
  // forever and spawn an ngrok per attempt.
  let startAttempts = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const machineHosts = () => lanHostsFrom(networkInterfaces());
  const machineHostEntries = () => lanHostEntriesFrom(networkInterfaces());

  const ngrokPath = resolveNgrokPath();

  function isOriginAllowed(origin: string): boolean {
    let host: string;
    try {
      host = new URL(origin).host;
    } catch {
      return false;
    }
    // The tunnel branch of isHostAllowed judges the *request's* TCP peer,
    // because the Host header is forgeable from a foreign socket. An origin
    // question has no socket: the login leg only asks which hosts this
    // deployment serves, and the callback it produces always arrives through
    // `ngrok`, whose upstream target is loopback by construction. So the
    // live tunnel host is accepted here directly — delegating would run the
    // peer check with no peer and refuse, handing every remote sign-in a
    // localhost redirect URI that lands the member on their own machine.
    if (
      mode === "tunnel" &&
      tunnelUrl &&
      host === new URL(tunnelUrl).host
    ) {
      return true;
    }
    return isHostAllowed(host, { port: input.port, mode, machineHosts: machineHosts(), tunnelHost: tunnelUrl ? new URL(tunnelUrl).host : null });
  }

  /**
   * The verdict for one request's Host header **and TCP peer**, against the
   * state as it is *now* — a request should be judged by the reach that is
   * actually live, and by where it actually came from (see isHostAllowed).
   */
  function isHostAllowedNow(host: string | undefined, remoteAddress: string | undefined): boolean {
    return isHostAllowed(host, {
      port: input.port,
      mode,
      machineHosts: machineHosts(),
      tunnelHost: tunnelUrl ? new URL(tunnelUrl).host : null,
      remoteAddress
    });
  }

  /**
   * The last quick-tunnel URL written to the log at or after `since`, or null.
   *
   * The log is appended across runs and never truncated, so the last URL in the
   * file is the previous run's address until the new process prints its own. A
   * fresh tunnel would otherwise inherit a stale URL — reporting "running" for
   * an address nothing answers on, which is how a restart looked like it had
   * kept a link that no longer existed. Reading from the byte offset the spawn
   * started at means only *this* tunnel's URL can be accepted.
   */
  /**
   * Only a URL this deployment can actually be serving is trusted from the log.
   * A JSON log parser that accepted any https URL could be steered by a future
   * log line (or a planted file) into advertising a foreign host; the fixed
   * domain, or an ngrok hostname, is the only shape this manager starts.
   */
  function isExpectedTunnelUrl(value: string | null): boolean {
    if (!value) return false;
    try {
      const hostname = new URL(value).hostname.toLowerCase();
      if (domain) return hostname === domain;
      return (
        hostname.endsWith(".ngrok-free.app") ||
        hostname.endsWith(".ngrok-free.dev") ||
        hostname.endsWith(".ngrok.app") ||
        hostname.endsWith(".ngrok.io")
      );
    } catch {
      return false;
    }
  }

  function readTunnelUrlFromLog(since = 0): string | null {
    try {
      const candidate = lastTunnelUrlIn(readFileSync(tunnelLogPath(), "utf8").slice(since));
      return isExpectedTunnelUrl(candidate) ? candidate : null;
    } catch {
      return null;
    }
  }

  /**
   * Adopt a tunnel left running by a previous dashboard life, or start one.
   *
   * The URL is persisted with the pid precisely so that restarting the
   * dashboard does not mint a new address: the OAuth callback registered in
   * the Discord Developer Portal keeps working across restarts, and the mode
   * toggle remains the only thing that ends the process.
   *
   * The persisted URL is checked rather than trusted. A quick tunnel that lost
   * its edge connection asks for a *new* one without changing its pid — the
   * same process, a different address — and the log records the replacement.
   * Believing the persisted value then advertises a URL nothing answers on
   * while the live tunnel sits under a second name the dashboard never heard
   * of, which is how a restart looked like it had kept a link that no longer
   * existed. When the persisted URL does not answer, the newest URL in the log
   * is the replacement candidate, and it is adopted if it does answer.
   */
  async function adoptOrStartTunnel(): Promise<void> {
    if (child || tunnelStatus === "running" || tunnelStatus === "starting") return;
    const savedPid = Number((await input.getSetting(TUNNEL_PID_KEY)) ?? 0);
    const savedUrl = await input.getSetting(TUNNEL_URL_KEY);
    if (savedPid > 0 && savedUrl && isExpectedTunnelUrl(savedUrl) && (await isNgrokPid(savedPid))) {
      const replacement = await replacementTunnelUrl(savedUrl);
      const liveUrl = replacement ?? (await urlAnswers(savedUrl) ? savedUrl : null);
      if (liveUrl) {
        tunnelPid = savedPid;
        tunnelUrl = liveUrl;
        tunnelStatus = "running";
        if (liveUrl !== savedUrl) {
          input.log.info({ from: savedUrl, to: liveUrl }, "Adopted the tunnel's replacement URL");
          void input.setSetting(TUNNEL_URL_KEY, liveUrl).catch(() => undefined);
        } else {
          input.log.info({ tunnelUrl: liveUrl, pid: savedPid }, "Adopted the ngrok tunnel from a previous run");
        }
        return;
      }
      // The process is alive but its address no longer answers and the log has
      // no replacement: the tunnel is wedged, not adopted. Starting a fresh one
      // is the only way to have a working address again.
      input.log.warn({ pid: savedPid, url: savedUrl }, "The saved tunnel process is live but its URL does not answer; restarting it");
      await killTree(savedPid);
      await waitForGone(savedPid);
      void input.setSetting(TUNNEL_PID_KEY, "").catch(() => undefined);
      void input.setSetting(TUNNEL_URL_KEY, "").catch(() => undefined);
    }
    startTunnel();
  }

  /** Does `url` reach this dashboard's own health check? */
  async function urlAnswers(url: string): Promise<boolean> {
    try {
      const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * A newer tunnel URL in the log than `stale`, when the persisted one no
   * longer answers. ngrok prints a replacement after a reconnect, so the newest
   * URL in the file is the candidate — provided it answers, since a log line
   * alone does not prove the edge is up.
   */
  async function replacementTunnelUrl(stale: string): Promise<string | null> {
    const candidate = readTunnelUrlFromLog();
    if (!candidate || candidate === stale.toLowerCase()) return null;
    return (await urlAnswers(candidate)) ? candidate : null;
  }

  function startTunnel() {
    if (child) return;
    tunnelStatus = "starting";
    tunnelError = null;
    // A previous run's address is not this tunnel's. Drop it now so the gate,
    // the OAuth handoff and the screen never offer the old one.
    tunnelUrl = null;
    const logOffset = statSize(tunnelLogPath());
    // Detached, with the log file as stdout/stderr: the child outlives this
    // process (a restart keeps the URL) and a blocked pipe cannot stall it.
    let logFd: number;
    try {
      logFd = openSync(tunnelLogPath(), "a");
    } catch (error) {
      tunnelStatus = "error";
      tunnelError = error instanceof Error ? error.message : "تعذّر فتح سجل النفق.";
      return;
    }
    try {
      const args = ["http", String(input.port), "--log=stdout", "--log-format=json"];
      if (domain) args.push(`--url=https://${domain}`);
      child = spawn(ngrokPath, args, {
        stdio: ["ignore", logFd, logFd],
        detached: true,
        windowsHide: true
      });
      child.unref();
      tunnelPid = child.pid ?? null;
    } catch (error) {
      child = null;
      tunnelPid = null;
      tunnelStatus = "error";
      tunnelError = error instanceof Error ? error.message : "تعذّر تشغيل ngrok. تأكد من تثبيته أو اضبط NGROK_PATH.";
      return;
    } finally {
      closeSync(logFd);
    }
    void input.setSetting(TUNNEL_PID_KEY, String(tunnelPid)).catch(() => undefined);
    child.on("error", error => {
      tunnelStatus = "error";
      tunnelError =
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? "ngrok غير مثبّت أو غير موجود في PATH — ثبّته أو اضبط NGROK_PATH."
          : error.message;
      child = null;
    });
    // An unplanned exit of OUR child is surfaced, not hidden. An adopted
    // tunnel has no child handle here; its death is caught on the next boot's
    // adopt check (and by the error the screen already shows once the URL
    // stops answering).
    child.on("exit", code => {
      if (!child) return;
      child = null;
      tunnelUrl = null;
      if (tunnelStatus === "off") return;

      const delay = retryDelaysMs[startAttempts];
      input.log.warn({ code, attempt: startAttempts + 1 }, "ngrok tunnel exited");
      if (delay === undefined) {
        tunnelStatus = "error";
        tunnelError = `انتهت عملية النفق بالرمز ${code ?? "غير معروف"} بعد ${startAttempts} محاولات. أعد اختيار الوضع لإعادة التشغيل.`;
        return;
      }
      startAttempts += 1;
      tunnelStatus = "starting";
      tunnelError = `انتهت عملية النفق بالرمز ${code ?? "غير معروف"} — إعادة المحاولة ${startAttempts} بعد ${Math.round(delay / 1000)} ثانية.`;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        if (tunnelStatus === "off") return;
        void startTunnel();
      }, delay);
    });
    // ngrok prints the public URL once; poll the log rather than hold pipes.
    const startedAt = Date.now();
    const poll = setInterval(() => {
      if (tunnelStatus !== "starting") {
        clearInterval(poll);
        return;
      }
      const found = readTunnelUrlFromLog(logOffset);
      if (found) {
        clearInterval(poll);
        tunnelUrl = found;
        tunnelStatus = "running";
        // It is up: the next unexpected exit starts the ladder over.
        startAttempts = 0;
        void input.setSetting(TUNNEL_URL_KEY, found).catch(() => undefined);
        input.log.info({ tunnelUrl: found }, "ngrok tunnel is up");
        return;
      }
      if (Date.now() - startedAt > TUNNEL_START_TIMEOUT_MS) {
        clearInterval(poll);
        tunnelStatus = "error";
        tunnelError = domain
          ? `لم يظهر رابط النفق للنطاق ${domain} خلال 20 ثانية. تأكد أن النطاق محجوز في ngrok.`
          : "لم يظهر رابط النفق خلال 20 ثانية — راجع ملف .al-tunnel.log.";
      }
    }, 500);
  }

  async function stopTunnel(): Promise<void> {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    startAttempts = 0;
    const dyingChild = child;
    const dyingPid = tunnelPid ?? dyingChild?.pid ?? null;
    child = null;
    tunnelPid = null;
    tunnelStatus = "off";
    tunnelUrl = null;
    tunnelError = null;

    if (dyingChild && dyingChild.exitCode === null && dyingChild.signalCode === null) {
      const exited = new Promise<void>(resolve => dyingChild.once("exit", () => resolve()));
      dyingChild.kill();
      await Promise.race([exited, new Promise<void>(resolve => setTimeout(resolve, 2_000))]);
    }
    // A detached ngrok ignores a polite kill often enough that the replacement
    // used to start while the old agent still held the endpoint. Verify the
    // process is actually gone before releasing the pid to the caller.
    if (dyingPid && (await isNgrokPid(dyingPid))) {
      await killTree(dyingPid);
      await waitForGone(dyingPid);
    }
    await input.setSetting(TUNNEL_PID_KEY, "").catch(() => undefined);
    await input.setSetting(TUNNEL_URL_KEY, "").catch(() => undefined);
  }

  /**
   * Verify the tunnel actually answers, instead of trusting that a live
   * `ngrok` pid means a working URL.
   *
   * An adopted tunnel from a previous boot is believed on pid alone, and a
   * quick tunnel can stay alive while its edge connection is dead — a VPN or
   * a filtering proxy on this machine breaks the handshake to ngrok's edge
   * without killing the process. The URL then stays in the
   * snapshot as "running" while nothing on the internet can reach it, which is
   * worse than no answer at all: the screen offers a link that cannot work and
   * gives no reason. So the read probes its own public address.
   *
   * Fire-and-forget and throttled: the caller gets the snapshot it asked for
   * immediately, and the next read sees the corrected status. Blocking here
   * would make every poll pay a dead tunnel's timeout.
   */
  let lastProbeAt = 0;
  const PROBE_INTERVAL_MS = 15_000;
  let probeFailures = 0;
  let healing = false;

  function probeTunnel(): void {
    if (mode !== "tunnel" || healing) return;
    if (Date.now() - lastProbeAt < PROBE_INTERVAL_MS) return;
    lastProbeAt = Date.now();
    const url = tunnelUrl;
    const status = tunnelStatus;
    void probeTunnelReachability({ mode, url, status }).then(async verdict => {
      // Re-test against the state as it is now, not as it was at send time:
      // a mode switch to "off" in between must not be overwritten.
      if (mode !== "tunnel" || tunnelUrl !== url) return;
      if (verdict.status !== status) {
        tunnelStatus = verdict.status;
        tunnelError = verdict.error;
      }
      const heal = nextProbeState({ url, verdict: verdict.status, failures: probeFailures });
      probeFailures = heal.failures;
      if (!heal.remint) return;

      /*
       * The URL is dead and the process that owns it is alive — the one failure
       * this deployment keeps meeting, three times in one evening. Reporting it
       * was as far as it went: the screen said «أعد اختيار الوضع» and the
       * operator pressed the toggle, or restarted the whole stack, by hand.
       *
       * `stopTunnel` then `adoptOrStartTunnel` is exactly what that toggle did,
       * and it is safe to do without asking: the endpoint is already
       * unreachable, the domain is configuration that survives the restart, and
       * the reserved address comes back the same. A wedged agent is not
       * something an operator should have to notice.
       */
      healing = true;
      input.log.warn({ tunnelUrl: url, afterFailures: RESTART_AFTER_FAILURES }, "The tunnel URL stopped answering; re-minting the tunnel");
      try {
        await stopTunnel();
        await adoptOrStartTunnel();
      } catch (error) {
        // `warn`, not `error`: the manager's log seam carries info and warn, and
        // a failed re-mint is the same class of event as the wedge that caused it
        // — the retry ladder still has a chance to recover it.
        input.log.warn({ err: error }, "The tunnel could not be re-minted");
      } finally {
        healing = false;
      }
    });
  }

  function snapshot(): NetworkSnapshot {
    const stable = Boolean(domain && tunnelUrl && new URL(tunnelUrl).hostname === domain);
    return {
      mode,
      tunnelProvider: "ngrok",
      tunnelUrl,
      tunnelDomain: domain,
      tunnelStable: stable,
      tunnelStatus,
      tunnelError,
      machineHosts: machineHostEntries(),
      port: input.port,
      tunnelCallbackVerified: isCallbackRegisteredFor(verifiedOrigin, tunnelUrl)
    };
  }

  /**
   * Record that a sign-in completed through `origin`.
   *
   * Discord accepts a `redirect_uri` it has registered and rejects any other
   * with `Invalid OAuth2 redirect_uri` *before* the token is ever issued — so
   * an origin that exchanged a code is one whose callback is registered, and
   * the setup card for it can stop showing. No API has to be asked: the login
   * itself is the check, which is why it sees a registration made by hand in
   * the Developer Portal as readily as one made through the dashboard.
   *
   * The comparison is against the origin, not the raw URL, so a trailing slash
   * or a case difference does not make a registered tunnel look unregistered.
   * A *new* tunnel address will not match the stored origin, and the card
   * returns — correctly, since the new address is not registered yet.
   */
  function markOriginVerified(origin: string): void {
    const value = normaliseOrigin(origin);
    if (!value || value === normaliseOrigin(verifiedOrigin)) return;
    verifiedOrigin = value;
    void input.setSetting(VERIFIED_ORIGIN_KEY, value).catch(() => undefined);
  }

  async function boot() {
    mode = normaliseRemoteAccessMode(await input.getSetting(REMOTE_ACCESS_MODE_KEY));
    const override = remoteAccessOverride();
    if (override) mode = override;
    domain = normaliseNgrokDomain(await input.getSetting(NGROK_DOMAIN_KEY)) ?? envNgrokDomain();
    verifiedOrigin = normaliseOrigin(await input.getSetting(VERIFIED_ORIGIN_KEY));
    if (mode === "tunnel") await adoptOrStartTunnel();
    /*
     * The probe used to run only when something read the network screen, so a
     * dead tunnel stayed dead for as long as the operator stayed on another
     * page — which is most of the time. The timer costs one local request per
     * interval and is what makes the healing above reachable at all;
     * `probeTunnel` returns immediately in `off` and `lan`, so it is harmless
     * when there is no tunnel.
     */
    setInterval(() => probeTunnel(), PROBE_INTERVAL_MS).unref();
    input.log.info({ mode, domain, ...(override ? { overrideFrom: "AL_AI_REMOTE_ACCESS" } : {}) }, "AL AI network access loaded");
  }

  /**
   * Apply the reach settings in one step.
   *
   * Mode and domain used to be two calls, and a request that carried both made
   * two agents start on one endpoint — the second found the first still alive
   * and started a replacement, leaving `ERR_NGROK_6030` behind. Deciding both
   * here means at most one stop and one start, whatever the request changed.
   * Clearing the domain falls back to a random ngrok URL; the domain is
   * configuration, so stopping the tunnel does not clear it.
   */
  async function applyReach(change: { mode: unknown; hasDomain: boolean; domain: string | null }): Promise<NetworkSnapshot> {
    const nextMode = normaliseRemoteAccessMode(change.mode);
    const nextDomain = change.hasDomain
      ? change.domain === null
        ? null
        : normaliseNgrokDomain(change.domain)
      : domain;
    if (change.hasDomain && change.domain !== null && !nextDomain) {
      throw new Error("النطاق غير صالح. استخدم اسماً مثل name.ngrok-free.dev.");
    }

    const modeChanged = nextMode !== mode;
    const domainChanged = change.hasDomain && nextDomain !== domain;
    mode = nextMode;
    domain = nextDomain;

    await input.setSetting(REMOTE_ACCESS_MODE_KEY, mode);
    if (change.hasDomain) await input.setSetting(NGROK_DOMAIN_KEY, domain ?? "");

    if (mode === "tunnel") {
      if (modeChanged || domainChanged) {
        await stopTunnel();
        startTunnel();
      } else if (tunnelStatus !== "running" && tunnelStatus !== "starting") {
        await adoptOrStartTunnel();
      }
    } else if (modeChanged) {
      await stopTunnel();
    }

    input.log.info({ mode, domain, modeChanged, domainChanged }, "AL AI network access changed");
    return snapshot();
  }

  /**
   * Shutdown intentionally leaves the tunnel running: a dashboard restart then
   * re-adopts it and the registered OAuth callback survives. Only the mode
   * toggle ends the process (applyReach → stopTunnel).
   */
  function stop(): void {}

  /**
   * The one HTTPS origin that can hold a registered OAuth callback while a
   * tunnel is up, or null. This is where sign-in legs from plain-HTTP LAN
   * origins hand off to.
   */
  function tunnelOrigin(): string | null {
    return mode === "tunnel" && tunnelUrl ? tunnelUrl : null;
  }

  return { boot, applyReach, snapshot, probe: probeTunnel, markOriginVerified, isHostAllowed: isHostAllowedNow, isOriginAllowed, tunnelOrigin, stop };
}

