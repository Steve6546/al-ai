import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { newNonce, layerSignature } from "@al-ai/core";
import type { EventPipeline } from "./event-pipeline.js";
import type { BotDatabase } from "../storage/database.js";

/**
 * Single-instance lock.
 *
 * Two bot processes sharing one token cause duplicated logs and double command
 * handling, so the supervisor refuses to start a second copy.
 */

/**
 * The repository root, resolved from this file rather than from the working
 * directory. Everything below is anchored here.
 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

export const DEFAULT_LOCK_PATH = join(REPO_ROOT, ".al-ai-bot.lock");

/**
 * Where the lock lives.
 *
 * The bot is documented to start both from the repository root and from
 * `apps/bot`, and a cwd-relative path made those two invocations write
 * *different* lock files — so the same token ran as two live processes, each
 * duplicating every log line and handling every command twice. Measured: the
 * instance started from the root held `.al-ai-bot.lock`, while the one started
 * from `apps/bot` wrote `apps/bot/.al-ai-bot.lock` and started anyway. That is
 * precisely the failure this lock exists to prevent.
 *
 * `BOT_LOCK_FILE` is documented in `.env.example` as a bare file name, so a
 * relative value means "this name, at the repository root" and only an absolute
 * value names its own place. Reading it as a cwd-relative path is what put the
 * second lock file there in the first place.
 */
export function resolveLockPath(configured = process.env.BOT_LOCK_FILE?.trim()): string {
  if (!configured) return DEFAULT_LOCK_PATH;
  return isAbsolute(configured) ? configured : join(REPO_ROOT, configured);
}

export function acquireInstanceLock(path = resolveLockPath()) {
  try {
    const handle = openSync(path, "wx");
    writeSync(handle, String(process.pid));
    closeSync(handle);
    return {
      path,
      release() {
        try {
          unlinkSync(path);
        } catch {
          // Already gone: nothing to clean up.
        }
      }
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;

    // Stale lock from a crashed process is reclaimed; a live one blocks startup.
    const owner = Number(readFileSync(path, "utf8").trim());
    if (owner && isAlive(owner)) {
      throw new Error(`AL AI bot is already running as pid ${owner}. Refusing to start a second instance.`);
    }
    unlinkSync(path);
    return acquireInstanceLock(path);
  }
}

function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export type HealthReport = {
  database: "reachable" | "unreachable";
  gateway: { eventsLastMinute: number; ceiling: number; queued: number };
  guildCount: number;
};

export type SupervisorDeps = {
  pipeline: EventPipeline;
  database: BotDatabase;
  dashboardUrl: string | null;
  hmacSecret: string;
  guildIds: () => string[];
  /**
   * Unique users observed by the privileged-intent tracker. Discord's 8,000 /
   * 10,000 verification thresholds count unique *users*, so this — not the guild
   * count — is what the dashboard must compare them against.
   */
  uniqueUsers?: () => number;
  /**
   * Discord's own gateway heartbeat, in milliseconds.
   *
   * Only the bot can read this, and it is the one latency figure that means
   * something to an operator: it is the live socket, not a REST round-trip.
   * Returning null is honest and renders as "—"; a fabricated 0 would read as
   * "0 ms" and look perfect while the connection is dead.
   */
  gatewayPingMs?: () => number | null;
  intervalMs?: number;
};

/**
 * Periodic health loop. When a dashboard URL is configured it also pushes a
 * signed, nonce-protected snapshot so the BFF can show live gateway state.
 *
 * GOVERNANCE rule 10: the dashboard is not trusted because of where it runs.
 * Every push carries an HMAC signature and a single-use nonce.
 */
export function startSupervisor(deps: SupervisorDeps) {
  const intervalMs = deps.intervalMs ?? 30_000;

  const tick = async () => {
    const stats = deps.pipeline.stats();
    let database: HealthReport["database"] = "reachable";
    try {
      await deps.database.ping();
    } catch {
      database = "unreachable";
    }

    const guildIds = deps.guildIds();
    const state = database === "reachable" ? "online" : "degraded";
    const uniqueUsers = Math.max(0, Math.trunc(deps.uniqueUsers?.() ?? 0) || 0);
    const pingMs = normalisePing(deps.gatewayPingMs?.() ?? null);
    for (const guildId of guildIds) {
      await deps.database.upsertHealth(guildId, state, true, stats.eventsLastMinute, uniqueUsers, pingMs).catch(() => undefined);
    }

    if (!deps.dashboardUrl) return;
    for (const guildId of guildIds) {
      await pushHealth(deps.dashboardUrl, deps.hmacSecret, {
        guildId,
        state,
        botPresent: true,
        gatewayEvents: stats.eventsLastMinute,
        uniqueUsers,
        pingMs
      }).catch(() => undefined);
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  void tick();

  return {
    stop() {
      clearInterval(timer);
    }
  };
}

/**
 * Discord reports -1 before the first heartbeat completes. That is "no reading
 * yet", not a negative latency, so it is normalised to null.
 */
function normalisePing(value: number | null): number | null {
  if (value === null || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value);
}

async function pushHealth(
  dashboardUrl: string,
  secret: string,
  payload: {
    guildId: string;
    state: string;
    botPresent: boolean;
    gatewayEvents: number;
    uniqueUsers: number;
    pingMs: number | null;
  }
) {
  const body = JSON.stringify(payload);
  const nonce = newNonce();
  const timestamp = new Date().toISOString();
  await fetch(`${dashboardUrl.replace(/\/$/, "")}/internal/layer/health`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-al-nonce": nonce,
      "x-al-timestamp": timestamp,
      "x-al-signature": layerSignature(nonce, timestamp, body, secret)
    },
    body
  });
}
