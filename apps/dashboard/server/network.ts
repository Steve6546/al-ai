import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";
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

/**
 * The reachability verdict for one Host header. A missing port is allowed
 * (some proxies forward the host bare); an explicit port that is not ours is
 * not this server and is refused.
 */
export function isHostAllowed(
  host: string | undefined,
  options: { port: number; mode: RemoteAccessMode; machineHosts: string[]; tunnelHost: string | null }
): boolean {
  if (!host) return false;
  const { hostname, port } = splitHostPort(host);
  if (port !== null && port !== String(options.port)) return false;
  if (LOOPBACK_HOSTNAMES.has(hostname)) return true;
  if (options.mode === "off") return false;
  if (options.machineHosts.includes(hostname)) return true;
  if (options.mode === "tunnel" && options.tunnelHost && hostname === options.tunnelHost) return true;
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

/* ------------------------------------------------------------------ *
 * The manager
 * ------------------------------------------------------------------ */

type NetworkLog = { info: (object: object, message: string) => void; warn: (object: object, message: string) => void };

export function createNetworkManager(input: {
  port: number;
  getMode: () => Promise<string | null>;
  setMode: (mode: string) => Promise<void>;
  log: NetworkLog;
}) {
  let mode: RemoteAccessMode = "off";
  let tunnelUrl: string | null = null;
  let tunnelStatus: TunnelStatus = "off";
  let tunnelError: string | null = null;
  let child: ChildProcess | null = null;

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
   * The verdict for one request's Host header, against the state as it is
   * *now* — the caller (the gate hook) passes nothing, because a request
   * should be judged by the reach that is actually live.
   */
  function isHostAllowedNow(host: string | undefined): boolean {
    return isHostAllowed(host, {
      port: input.port,
      mode,
      machineHosts: machineHosts(),
      tunnelHost: tunnelUrl ? new URL(tunnelUrl).host : null
    });
  }

  function stopTunnel() {
    if (!child) return;
    const dying = child;
    child = null;
    tunnelStatus = "off";
    tunnelUrl = null;
    dying.kill();
  }

  function startTunnel() {
    if (child) return;
    if (!cloudflaredPath) {
      tunnelStatus = "error";
      tunnelError = "cloudflared غير مثبّت على هذا الجهاز — ثبّته أو اضبط CLOUDFLARED_PATH.";
      return;
    }
    tunnelStatus = "starting";
    tunnelError = null;
    try {
      child = spawn(
        cloudflaredPath,
        ["tunnel", "--url", `http://127.0.0.1:${input.port}`, "--no-autoupdate"],
        { windowsHide: true }
      );
    } catch (error) {
      child = null;
      tunnelStatus = "error";
      tunnelError = error instanceof Error ? error.message : "تعذّر تشغيل النفق.";
      return;
    }
    const read = (chunk: Buffer | string) => {
      const found = parseTunnelUrl(String(chunk));
      if (found && tunnelUrl !== found) {
        tunnelUrl = found;
        tunnelStatus = "running";
        input.log.info({ tunnelUrl: found }, "Cloudflare quick tunnel is up");
      }
    };
    child.stdout?.on("data", read);
    child.stderr?.on("data", read);
    child.on("error", error => {
      tunnelStatus = "error";
      tunnelError = error.message;
      child = null;
    });
    // An unplanned exit is surfaced, not hidden: the screen would otherwise
    // show a URL that stopped answering the moment the process died.
    child.on("exit", code => {
      if (!child) return;
      child = null;
      if (tunnelStatus !== "off") {
        tunnelStatus = "error";
        tunnelError = `انتهت عملية النفق بالرمز ${code ?? "غير معروف"}. أعد اختيار الوضع لإعادة التشغيل.`;
      }
      input.log.warn({ code }, "Cloudflare quick tunnel exited");
    });
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
    mode = normaliseRemoteAccessMode(await input.getMode());
    if (mode === "tunnel") startTunnel();
    input.log.info({ mode }, "AL AI network access loaded");
  }

  async function setMode(next: unknown): Promise<NetworkSnapshot> {
    const value = normaliseRemoteAccessMode(next);
    mode = value;
    await input.setMode(value);
    if (value === "tunnel") {
      if (!child) startTunnel();
    } else {
      stopTunnel();
    }
    input.log.info({ mode: value }, "AL AI network access changed");
    return snapshot();
  }

  function stop() {
    stopTunnel();
  }

  return { boot, setMode, snapshot, isHostAllowed: isHostAllowedNow, isOriginAllowed, stop };
}

export type NetworkManager = ReturnType<typeof createNetworkManager>;
