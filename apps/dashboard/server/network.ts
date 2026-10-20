import { execFile, spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, statSync } from "node:fs";
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
 *   the browser's origin through Discord's redirect, and the quick-tunnel URL
 *   parser. All unit-tested without a socket or a child process.
 * - **The manager** — loads the mode from `instance_settings`, spawns and stops
 *   the `cloudflared` quick tunnel, and answers "is this Host header allowed?"
 *   for the request gate.
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
  tunnelUrl: string | null;
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
 * `cloudflared` process, which targets `http://127.0.0.1:<port>` by
 * construction. A LAN peer may present the machine's real interface addresses;
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

const QUICK_TUNNEL_URL = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/i;

/** The tunnel URL inside a `cloudflared` output line, lower-cased, or null. */
export function parseTunnelUrl(text: string): string | null {
  const match = QUICK_TUNNEL_URL.exec(text);
  return match ? match[0].toLowerCase() : null;
}

/**
 * The *last* tunnel URL in the given text, lower-cased, or null.
 *
 * `parseTunnelUrl` finds the first — the right call for one cloudflared banner
 * line. A log file accumulates banners across runs, so the manager asks for the
 * newest one, and asks it of a slice of the file that starts where this run's
 * output began. Both read the same pattern rather than each keeping its own
 * copy of it, so the address shape cannot drift between the two.
 */
export function lastTunnelUrlIn(text: string): string | null {
  const matches = text.match(new RegExp(QUICK_TUNNEL_URL.source, "gi"));
  return matches ? matches[matches.length - 1].toLowerCase() : null;
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
 * A live `cloudflared` pid is not proof the URL works: a quick tunnel stays
 * alive while its edge connection is dead, because a VPN or a filtering proxy
 * on this machine breaks the mTLS handshake to `*.argotunnel.com` without
 * killing the process. The snapshot would then advertise "running" with a link
 * nothing on the internet can reach — worse than no answer, since the screen
 * offers it and gives no reason. So the read probes `/api/health` through the
 * public address, and a tunnel that does not answer becomes an error the
 * operator can act on.
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
  "النفق يعلن أنه يعمل لكن الرابط لا يستجيب. غالبًا السبب شبكة افتراضية (VPN) أو فلتر يعترض اتصال Cloudflare — أوقفها ثم أعد اختيار الوضع، أو استخدم شبكة محلية.";

export const PROBE_TIMEOUT_MS = 5_000;

export type ProbeVerdict = { status: TunnelStatus; error: string | null };

export async function probeTunnelReachability(
  state: { mode: RemoteAccessMode; url: string | null; status: TunnelStatus },
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = PROBE_TIMEOUT_MS
): Promise<ProbeVerdict> {
  if (state.mode !== "tunnel" || !state.url) return { status: state.status, error: null };
  if (state.status !== "running" && state.status !== "starting") return { status: state.status, error: null };
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

/** Known install locations, checked in order; null when cloudflared is absent. */
function resolveCloudflaredPath(): string | null {
  const candidates = [
    process.env.CLOUDFLARED_PATH,
    "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe",
    "C:\\Program Files\\cloudflared\\cloudflared.exe"
  ].filter((path): path is string => Boolean(path));
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Production tunnel configuration, from the environment.
 *
 * A quick tunnel (trycloudflare.com) is a *testing* facility: the URL is
 * random per run and Cloudflare gives it no SLA. A production deployment
 * should create a remotely-managed tunnel in the Cloudflare dashboard and set:
 *
 * - `CLOUDFLARED_TUNNEL_TOKEN` — the tunnel's run token, so the manager starts
 *   `cloudflared tunnel run --token …` instead of a quick tunnel.
 * - `CLOUDFLARED_HOSTNAME` — the fixed hostname routed to that tunnel, which
 *   is what the OAuth callback and the reach gate use. The Developer Portal
 *   redirect is then registered once and never changes.
 */
function productionTunnel(): { token: string; hostname: string | null } | null {
  const token = process.env.CLOUDFLARED_TUNNEL_TOKEN?.trim();
  if (!token) return null;
  return { token, hostname: process.env.CLOUDFLARED_HOSTNAME?.trim() || null };
}

/**
 * A boot-time override for the reach mode, from `AL_AI_REMOTE_ACCESS`.
 *
 * A quick tunnel is a rotating, best-effort address, and a machine that once
 * turned the tunnel on would otherwise mint a fresh trycloudflare URL on every
 * local boot — a public endpoint nobody asked for and a slower start. The
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
/**
 * The origin a completed sign-in travelled through. Discord offers no API to
 * read an application's registered redirect URIs, so the round trip *is* the
 * check: an origin that exchanged a code answered `redirect_uri` that Discord
 * accepted, which cannot happen for an unregistered URI.
 */
export const VERIFIED_ORIGIN_KEY = "remote_access_verified_origin";

const execFileAsync = promisify(execFile);
const TUNNEL_START_TIMEOUT_MS = 20_000;

/** The tunnel log lives next to the dashboard process; `*.log` is git-ignored. */
function tunnelLogPath(): string {
  return join(process.cwd(), ".al-tunnel.log");
}

/**
 * Is `pid` a live `cloudflared` process? The image-name check matters: PIDs
 * are recycled, and adopting an unrelated process by number alone would make
 * the gate trust a tunnel that does not exist.
 */
async function isCloudflaredPid(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    const { stdout } = await execFileAsync(
      "tasklist",
      ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
      { timeout: 5_000 }
    );
    return stdout.toLowerCase().includes("cloudflared");
  } catch {
    return false;
  }
}

function killTree(pid: number): void {
  execFileAsync("taskkill", ["/PID", String(pid), "/T", "/F"], { timeout: 5_000 }).catch(() => undefined);
}

export function createNetworkManager(input: {
  port: number;
  getSetting: (key: string) => Promise<string | null>;
  setSetting: (key: string, value: string) => Promise<void>;
  log: NetworkLog;
}) {
  let mode: RemoteAccessMode = "off";
  let tunnelUrl: string | null = null;
  let tunnelStatus: TunnelStatus = "off";
  let tunnelError: string | null = null;
  // `child` is set only when THIS process spawned cloudflared; an adopted
  // tunnel from a previous dashboard life is tracked by pid alone.
  let child: ChildProcess | null = null;
  let tunnelPid: number | null = null;
  let verifiedOrigin: string | null = null;

  const machineHosts = () => lanHostsFrom(networkInterfaces());
  const machineHostEntries = () => lanHostEntriesFrom(networkInterfaces());

  const cloudflaredPath = resolveCloudflaredPath();

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
    // `cloudflared`, whose upstream target is loopback by construction. So the
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
  function readTunnelUrlFromLog(since = 0): string | null {
    try {
      return lastTunnelUrlIn(readFileSync(tunnelLogPath(), "utf8").slice(since));
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
    if (savedPid > 0 && savedUrl && (await isCloudflaredPid(savedPid))) {
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
          input.log.info({ tunnelUrl: liveUrl, pid: savedPid }, "Adopted the cloudflared tunnel from a previous run");
        }
        return;
      }
      // The process is alive but its address no longer answers and the log has
      // no replacement: the tunnel is wedged, not adopted. Starting a fresh one
      // is the only way to have a working address again.
      input.log.warn({ pid: savedPid, url: savedUrl }, "The saved tunnel process is live but its URL does not answer; restarting it");
      killTree(savedPid);
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
   * A newer quick-tunnel URL in the log than `stale`, when the persisted one no
   * longer answers. cloudflared asks for a replacement on reconnect and prints
   * it after the original, so the newest URL in the file is the candidate —
   * provided it answers, since a log line alone does not prove the edge is up.
   */
  async function replacementTunnelUrl(stale: string): Promise<string | null> {
    const candidate = readTunnelUrlFromLog();
    if (!candidate || candidate === stale.toLowerCase()) return null;
    return (await urlAnswers(candidate)) ? candidate : null;
  }

  function startTunnel() {
    if (child) return;
    const managed = productionTunnel();
    if (!cloudflaredPath && !managed) {
      tunnelStatus = "error";
      tunnelError = "cloudflared غير مثبّت على هذا الجهاز — ثبّته أو اضبط CLOUDFLARED_PATH.";
      return;
    }
    tunnelStatus = "starting";
    tunnelError = null;
    // A fresh quick tunnel has no address yet, and the one a previous run left
    // in this manager — or in the log — is not this tunnel's. Drop it now so
    // nothing between here and the new URL's appearance offers the old one:
    // the gate, the OAuth origin handoff, and the screen all read `tunnelUrl`.
    tunnelUrl = null;
    // Where the log currently ends: cloudflared writes its new URL after this
    // point, so the poll below can be held to this tunnel's address only.
    const logOffset = statSize(tunnelLogPath());
    // A managed tunnel's hostname is configuration, not discovery: it is known
    // before the process answers, so the gate and the OAuth origin can use it
    // immediately.
    if (managed?.hostname) {
      tunnelUrl = `https://${managed.hostname}`;
      tunnelStatus = "running";
    }
    // Detached, with the log file as stdout/stderr: the child outlives this
    // process (a restart keeps the URL) and no pipe can fill up and stall it —
    // cloudflared is chatty, and a blocked pipe would freeze the tunnel.
    let logFd: number;
    try {
      logFd = openSync(tunnelLogPath(), "a");
    } catch (error) {
      tunnelStatus = "error";
      tunnelError = error instanceof Error ? error.message : "تعذّر فتح سجل النفق.";
      return;
    }
    try {
      child = spawn(
        cloudflaredPath!,
        managed
          ? ["tunnel", "run", "--token", managed.token]
          : ["tunnel", "--url", `http://127.0.0.1:${input.port}`, "--no-autoupdate"],
        { stdio: ["ignore", logFd, logFd], detached: true, windowsHide: true }
      );
      child.unref();
      tunnelPid = child.pid ?? null;
    } catch (error) {
      child = null;
      tunnelPid = null;
      tunnelStatus = managed?.hostname ? "running" : "error";
      tunnelError = error instanceof Error ? error.message : "تعذّر تشغيل النفق.";
      return;
    } finally {
      closeSync(logFd);
    }
    void input.setSetting(TUNNEL_PID_KEY, String(tunnelPid)).catch(() => undefined);
    child.on("error", error => {
      tunnelStatus = "error";
      tunnelError = error.message;
      child = null;
    });
    // An unplanned exit of OUR child is surfaced, not hidden. An adopted
    // tunnel has no child handle here; its death is caught on the next boot's
    // adopt check (and by the error the screen already shows once the URL
    // stops answering).
    child.on("exit", code => {
      if (!child) return;
      child = null;
      if (tunnelStatus !== "off") {
        tunnelStatus = "error";
        tunnelError = `انتهت عملية النفق بالرمز ${code ?? "غير معروف"}. أعد اختيار الوضع لإعادة التشغيل.`;
      }
      input.log.warn({ code }, "Cloudflare quick tunnel exited");
    });
    // cloudflared prints the URL once; poll the log rather than hold pipes.
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
        void input.setSetting(TUNNEL_URL_KEY, found).catch(() => undefined);
        input.log.info({ tunnelUrl: found }, "Cloudflare quick tunnel is up");
        return;
      }
      if (Date.now() - startedAt > TUNNEL_START_TIMEOUT_MS) {
        clearInterval(poll);
        tunnelStatus = "error";
        tunnelError = "لم يظهر رابط النفق خلال 20 ثانية — راجع ملف .al-tunnel.log.";
      }
    }, 500);
  }

  async function stopTunnel(): Promise<void> {
    const dyingChild = child;
    const dyingPid = tunnelPid;
    child = null;
    tunnelPid = null;
    tunnelStatus = "off";
    tunnelUrl = null;
    tunnelError = null;
    if (dyingChild) dyingChild.kill();
    else if (dyingPid) killTree(dyingPid);
    await input.setSetting(TUNNEL_PID_KEY, "").catch(() => undefined);
    await input.setSetting(TUNNEL_URL_KEY, "").catch(() => undefined);
  }

  /**
   * Verify the tunnel actually answers, instead of trusting that a live
   * `cloudflared` pid means a working URL.
   *
   * An adopted tunnel from a previous boot is believed on pid alone, and a
   * quick tunnel can stay alive while its edge connection is dead — a VPN or
   * a filtering proxy on this machine breaks the mTLS handshake to
   * `*.argotunnel.com` without killing the process. The URL then stays in the
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

  function probeTunnel(): void {
    if (Date.now() - lastProbeAt < PROBE_INTERVAL_MS) return;
    lastProbeAt = Date.now();
    const url = tunnelUrl;
    const status = tunnelStatus;
    void probeTunnelReachability({ mode, url, status }).then(verdict => {
      // Re-test against the state as it is now, not as it was at send time:
      // a mode switch to "off" in between must not be overwritten.
      if (mode !== "tunnel" || tunnelUrl !== url) return;
      if (verdict.status === status) return;
      tunnelStatus = verdict.status;
      tunnelError = verdict.error;
    });
  }

  function snapshot(): NetworkSnapshot {
    return {
      mode,
      tunnelUrl,
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
    verifiedOrigin = normaliseOrigin(await input.getSetting(VERIFIED_ORIGIN_KEY));
    if (mode === "tunnel") await adoptOrStartTunnel();
    input.log.info({ mode, ...(override ? { overrideFrom: "AL_AI_REMOTE_ACCESS" } : {}) }, "AL AI network access loaded");
  }

  async function setMode(next: unknown): Promise<NetworkSnapshot> {
    const value = normaliseRemoteAccessMode(next);
    mode = value;
    await input.setSetting(REMOTE_ACCESS_MODE_KEY, value);
    if (value === "tunnel") {
      await adoptOrStartTunnel();
    } else {
      await stopTunnel();
    }
    input.log.info({ mode: value }, "AL AI network access changed");
    return snapshot();
  }

  /**
   * Shutdown intentionally leaves the tunnel running: a dashboard restart then
   * re-adopts it and the registered OAuth callback survives. Only the mode
   * toggle ends the process (setMode → stopTunnel).
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

  return { boot, setMode, snapshot, probe: probeTunnel, markOriginVerified, isHostAllowed: isHostAllowedNow, isOriginAllowed, tunnelOrigin, stop };
}

