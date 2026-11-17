import { execFile, spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

/**
 * Windows Firewall automation for the dashboard port.
 *
 * The BFF already listens on `0.0.0.0`, and the Host gate already admits the
 * machine's LAN addresses — but Windows drops the packet before either runs
 * when no inbound rule exists. Measured on this machine: the active Wi-Fi is
 * classified **Public**, and the old `dev.ps1` rule only covered
 * `Private,Domain`, so even an operator who passed `-OpenFirewall` still could
 * not reach `http://192.168.1.195:3000` from a phone.
 *
 * The rule itself lives in `scripts/firewall.ps1`, so the startup check, the
 * CLI and the dashboard button all agree on the name, port and profile. This
 * module only runs it and normalises the JSON.
 */

const run = promisify(execFile);

/** `status` is read-only; `ensure` needs an elevated shell. */
// AL_AI_ROOT keeps this correct under a bundle; the URL form is the dev/test
// path (firewall automation is Windows-only and a no-op elsewhere).
const SCRIPT = process.env.AL_AI_ROOT
  ? join(process.env.AL_AI_ROOT, "scripts", "firewall.ps1")
  : fileURLToPath(new URL("../../../scripts/firewall.ps1", import.meta.url));

export type FirewallState = "allowed" | "missing" | "disabled" | "unknown";

export type FirewallReport = {
  status: FirewallState;
  /** True when the rule is absent/broken and creating it needs elevation. */
  needsAdmin: boolean;
  ruleName: string;
  port: number;
  profiles: string[];
  detail: string;
  /**
   * Rules that actually admit this port, whoever created them.
   *
   * `status` answers "can a packet reach this port?", which another tool's
   * rule can make true. Naming them is what lets the screen say *why* it is
   * reachable instead of silently claiming credit for a rule AL AI never made.
   */
  covering?: string[];
  /** Present only on an explicit elevation request. */
  elevation?: { started: boolean; reason: string | null };
};

function fallback(port: number, detail: string): FirewallReport {
  return {
    status: "unknown",
    needsAdmin: false,
    ruleName: `AL AI Dashboard (TCP ${port})`,
    port,
    profiles: [],
    detail
  };
}

function parse(stdout: string, port: number, detail: string): FirewallReport {
  const line = stdout
    .split("\n")
    .map(value => value.trim())
    .filter(Boolean)
    .pop();
  if (!line) return fallback(port, detail);
  try {
    const parsed = JSON.parse(line) as Partial<FirewallReport>;
    return {
      status: parsed.status === "allowed" || parsed.status === "missing" || parsed.status === "disabled" ? parsed.status : "unknown",
      needsAdmin: parsed.needsAdmin === true,
      ruleName: typeof parsed.ruleName === "string" ? parsed.ruleName : `AL AI Dashboard (TCP ${port})`,
      port,
      profiles: Array.isArray(parsed.profiles) ? parsed.profiles.filter((value): value is string => typeof value === "string") : [],
      detail: typeof parsed.detail === "string" ? parsed.detail : detail,
      covering: Array.isArray(parsed.covering)
        ? parsed.covering.filter((value): value is string => typeof value === "string")
        : undefined
    };
  } catch {
    return fallback(port, detail);
  }
}

async function invoke(action: "status" | "ensure", port: number): Promise<FirewallReport> {
  if (process.platform !== "win32") return fallback(port, "Windows Firewall is only managed on win32.");
  const args = [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    SCRIPT,
    "-Action",
    action,
    "-Port",
    String(port)
  ];
  try {
    // `status` now enumerates every inbound rule and reads each one's port
    // filter, because a port is reachable through any rule that admits it, not
    // only through AL AI's. Measured at ~500 rules on a normal workstation, the
    // walk takes a few seconds; the old 20 s budget left too little headroom on
    // a busy machine for a read that must not fail.
    const { stdout } = await run("powershell.exe", args, { timeout: 30_000, windowsHide: true });
    return parse(stdout, port, `${action} returned no report`);
  } catch (error) {
    // Exit 2 is the script's deliberate "needs elevation" answer, not a crash:
    // it still prints the report on stdout.
    const stdout = String((error as { stdout?: unknown }).stdout ?? "");
    if (stdout.trim()) return parse(stdout, port, `${action} failed`);
    const message = error instanceof Error ? error.message : String(error);
    return fallback(port, `${action} failed: ${message}`);
  }
}

/** Read-only: is inbound TCP for this port allowed, and from which profiles? */
export function firewallStatus(port: number): Promise<FirewallReport> {
  return invoke("status", port);
}

/**
 * Create or repair the rule. Resolves with `needsAdmin: true` when the process
 * is not elevated — the caller must not report the port as open in that case.
 */
export function ensureFirewall(port: number): Promise<FirewallReport> {
  return invoke("ensure", port);
}

/**
 * Ask Windows for the one thing a non-elevated process cannot do itself: a UAC
 * prompt that runs `firewall.ps1 -Action ensure` elevated. `Start-Process -Verb
 * RunAs` is the documented mechanism; if the operator declines, the spawned
 * process exits and the next status read still says `missing`, which is the
 * honest outcome. The path is single-quoted and `'` is doubled, so a directory
 * name cannot break out of the argument.
 */
export function elevateFirewall(port: number): { started: boolean; reason: string | null } {
  if (process.platform !== "win32") return { started: false, reason: "unsupported platform" };
  const quoted = SCRIPT.replace(/'/g, "''");
  const command = [
    "Start-Process",
    "-FilePath 'powershell.exe'",
    "-Verb RunAs",
    `-ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File','${quoted}','-Action','ensure','-Port','${port}'`
  ].join(" ");
  try {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    child.unref();
    return { started: true, reason: null };
  } catch (error) {
    return { started: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
