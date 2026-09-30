import { execFile, spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
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

export type NetworkSnapshot = {
  mode: RemoteAccessMode;
  tunnelUrl: string | null;
  tunnelStatus: TunnelStatus;
  tunnelError: string | null;
  /** The machine's own non-loopback addresses, as bare hostnames. */
  machineHosts: string[];
  port: number;
};

/* ------------------------------------------------------------------ *
 * Pure helpers
 * ------------------------------------------------------------------ */

/** Real, non-loopback addresses of this machine, in interface order. */
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

/* ------------------------------------------------------------------ *
 * The manager
 * ------------------------------------------------------------------ */

type NetworkLog = { info: (object: object, message: string) => void; warn: (object: object, message: string) => void };

/** `instance_settings` keys owned by the network manager. */
export const REMOTE_ACCESS_MODE_KEY = "remote_access_mode";
export const TUNNEL_PID_KEY = "remote_access_tunnel_pid";
export const TUNNEL_URL_KEY = "remote_access_tunnel_url";

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

  const machineHosts = () => lanHostsFrom(networkInterfaces());

  const cloudflaredPath = resolveCloudflaredPath();

  function isOriginAllowed(origin: string): boolean {
    let host: string;
    try {
      host = new URL(origin).host;
    } catch {
      return false;
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

  /** The last quick-tunnel URL in the log file, or null. */
  function readTunnelUrlFromLog(): string | null {
    try {
      const matches = readFileSync(tunnelLogPath(), "utf8").match(/https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/gi);
      return matches ? matches[matches.length - 1].toLowerCase() : null;
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
   */
  async function adoptOrStartTunnel(): Promise<void> {
    if (child || tunnelStatus === "running" || tunnelStatus === "starting") return;
    const savedPid = Number((await input.getSetting(TUNNEL_PID_KEY)) ?? 0);
    const savedUrl = await input.getSetting(TUNNEL_URL_KEY);
    if (savedPid > 0 && savedUrl && (await isCloudflaredPid(savedPid))) {
      tunnelPid = savedPid;
      tunnelUrl = savedUrl;
      tunnelStatus = "running";
      input.log.info({ tunnelUrl: savedUrl, pid: savedPid }, "Adopted the cloudflared tunnel from a previous run");
      return;
    }
    startTunnel();
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
      const found = readTunnelUrlFromLog();
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

  function snapshot(): NetworkSnapshot {
    return {
      mode,
      tunnelUrl,
      tunnelStatus,
      tunnelError,
      machineHosts: machineHosts(),
      port: input.port
    };
  }

  async function boot() {
    mode = normaliseRemoteAccessMode(await input.getSetting(REMOTE_ACCESS_MODE_KEY));
    if (mode === "tunnel") await adoptOrStartTunnel();
    input.log.info({ mode }, "AL AI network access loaded");
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

  return { boot, setMode, snapshot, isHostAllowed: isHostAllowedNow, isOriginAllowed, tunnelOrigin, stop };
}

export type NetworkManager = ReturnType<typeof createNetworkManager>;
