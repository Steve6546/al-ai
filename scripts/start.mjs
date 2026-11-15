#!/usr/bin/env node
/**
 * The portable stack launcher behind `npm start`.
 *
 * `npm run dev` is still the supervised launcher on Windows: it owns the
 * database, the single-instance lock, graceful Ctrl+C, and the watchdog's pid
 * bookkeeping. It is PowerShell, though, so it cannot be the entry point on
 * Linux, macOS or a VPS. This file is the small, dependency-free alternative:
 * it starts the same two Node services directly, with no shell, no PowerShell
 * and no `--env-file=../../.env` path that only exists in this workspace
 * layout.
 *
 * Environment is loaded once here with `process.loadEnvFile` (Node >= 22) and
 * inherited by both children, so neither service needs a workspace-relative
 * env path. Missing `.env` is not fatal: Compose and hosting platforms inject
 * real variables instead.
 *
 * It deliberately does NOT start PostgreSQL, adopt an existing ngrok agent, or
 * write pid files. Those are supervisor concerns. A container orchestrator or
 * the local `npm run dev` owns them; this launcher owns exactly two children.
 *
 * Usage:
 *   npm start
 *   npm start -- --dry-run                 # print the resolved commands only
 *   npm start -- --service=dashboard       # one service (also accepts "bot")
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envFile = resolve(root, ".env");
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const only = args.find(arg => arg.startsWith("--service="))?.slice("--service=".length) ?? null;

if (existsSync(envFile)) {
  // `loadEnvFile` never overrides a variable the host already provided, which
  // is what makes Compose's DATABASE_URL / NODE_ENV win over a local .env.
  try {
    process.loadEnvFile(envFile);
  } catch (error) {
    console.error(`[start] could not read .env: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}

const heap = (name, fallback) => {
  const raw = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(raw) && raw >= 256 ? String(raw) : String(fallback);
};

/**
 * The addresses another device on the router can actually open. This mirrors
 * `reachableLanEntries` in packages/core/src/remote-access.ts — the launcher
 * runs under plain `node` and cannot import the TypeScript core. The dashboard
 * itself is the authority (GET /api/network); these lines are only so the two
 * ready-to-use URLs are visible in the terminal the moment the stack starts.
 */
const UNUSABLE_ADAPTER = /wireguard|vpn|tap|virtual|vmware|virtualbox|hyper-?v|vethernet|wsl|docker|loopback|bluetooth/i;

function lanAddresses() {
  const found = [];
  for (const [label, list] of Object.entries(networkInterfaces())) {
    if (UNUSABLE_ADAPTER.test(label)) continue;
    for (const entry of list ?? []) {
      if (entry.internal || entry.family !== "IPv4") continue;
      const host = entry.address;
      if (host.startsWith("169.254.") || host.startsWith("192.168.56.")) continue;
      if (found.some(item => item.host === host)) continue;
      found.push({ host, label });
    }
  }
  return found;
}

function printAccessUrls() {
  const port = Number(process.env.PORT) || 3000;
  console.log(`[start] ready on this device : http://localhost:${port}`);
  const lan = lanAddresses();
  if (lan.length === 0) {
    console.log("[start] ready on the LAN     : no active IPv4 adapter found");
  } else {
    for (const { host, label } of lan) {
      console.log(`[start] ready on the LAN     : http://${host}:${port}  [${label}]`);
    }
  }
  const reach = process.env.AL_AI_REMOTE_ACCESS?.trim().toLowerCase() ?? "(saved setting)";
  if (reach === "off") {
    console.log("[start] LAN Host gate is OFF - use AL_AI_REMOTE_ACCESS=lan (or the «الوصول للشبكة» screen)");
  } else {
    console.log(`[start] reach                : ${reach}`);
  }
}

// These match the ceilings the Windows bootstrapper already proved in
// production; both are overridable on a bigger or smaller host.
const services = [
  {
    name: "dashboard",
    cwd: resolve(root, "apps", "dashboard"),
    heap: heap("AL_AI_DASHBOARD_HEAP_MB", 512),
    script: "server/index.ts"
  },
  {
    name: "bot",
    cwd: resolve(root, "apps", "bot"),
    heap: heap("AL_AI_BOT_HEAP_MB", 2048),
    script: "src/index.ts"
  }
];

const selected = only ? services.filter(service => service.name === only) : services;
if (selected.length === 0) {
  console.error(`[start] unknown --service=${only}; expected dashboard or bot`);
  process.exit(1);
}

const commands = selected.map(service => ({
  ...service,
  argv: [`--max-old-space-size=${service.heap}`, "--import", "tsx", service.script]
}));

if (dryRun) {
  console.log(`[start] env file: ${existsSync(envFile) ? envFile : "(not present; using host environment)"}`);
  for (const service of commands) {
    console.log(`[start] ${service.name}: cwd=${service.cwd}`);
    console.log(`[start] ${service.name}: ${process.execPath} ${service.argv.join(" ")}`);
  }
  console.log(`[start] NODE_ENV=${process.env.NODE_ENV ?? "(unset)"} PORT=${process.env.PORT ?? "3000"}`);
  printAccessUrls();
  process.exit(0);
}

printAccessUrls();

const children = [];
let stopping = false;

function stop(signal) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  }
}

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));

for (const service of commands) {
  const child = spawn(process.execPath, service.argv, { cwd: service.cwd, stdio: "inherit" });
  children.push(child);
  child.on("error", error => {
    console.error(`[start] ${service.name} failed to launch: ${error.message}`);
    stop("SIGTERM");
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    if (stopping) return;
    console.error(`[start] ${service.name} exited (${signal ?? `code ${code}`}); stopping the other service`);
    stop("SIGTERM");
    process.exitCode = code ?? 1;
  });
}
