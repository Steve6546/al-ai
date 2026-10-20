import { execFileSync } from "node:child_process";
import { closeSync, openSync, readFileSync, readlinkSync, statSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
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

/**
 * What a live owner records about itself.
 *
 * A bare pid is not enough to answer "is this still the bot?": pids are
 * recycled, and a dead bot's number can be handed to an unrelated process the
 * moment it exits. The record therefore carries the owner's `execPath` and the
 * time it took the lock, so a refuse-versus-reclaim decision can be made with
 * evidence rather than the number alone.
 */
export type LockRecord = {
  pid: number;
  /** `process.execPath` of the owner — diagnostics only, never trusted alone. */
  execPath?: string;
  /**
   * When the lock was taken, as an ISO timestamp.
   *
   * The lock is only ever written while its owner is alive, so this is never
   * later than nothing: it is at or after the owner's own process start. That
   * ordering is what makes the lock immune to pid recycling. A number the OS
   * hands out again belongs to a process that started after the owner died, and
   * therefore *after* this timestamp, so comparing the live process start
   * against it rejects a recycled number outright — even when the new holder is
   * itself a Node process. See `isLiveOwner`.
   */
  startedAt?: string;
};

/** Two clocks report the same moment within a couple of seconds at most. */
const START_TIME_SKEW_MS = 2_000;

/**
 * How long an empty lock file is assumed to be a write in progress.
 *
 * `open(..., "wx")` and the `write` that follows are two syscalls, and between
 * them the file exists with no contents. An empty file younger than this is
 * therefore not evidence of a crash — waiting is the only way to tell the two
 * apart without deleting a live owner's lock. The value only bounds how long a
 * genuinely crashed empty lock delays the next boot.
 */
const WRITE_GRACE_MS = 2_000;
const RETRY_DELAY_MS = 50;
const MAX_ATTEMPTS = 240;

function sleepSync(ms: number) {
  // The acquisition path is synchronous by contract; a spin loop would burn a
  // core, and this only ever runs while contending for the lock.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function lockRecord(): LockRecord & { startedAt: string } {
  return { pid: process.pid, execPath: process.execPath, startedAt: new Date().toISOString() };
}

type LockSnapshot = { raw: string; record: LockRecord | null; mtimeMs: number };

/** The whole file as it is right now, or null when it has gone away. */
function readSnapshot(path: string): LockSnapshot | null {
  try {
    const { mtimeMs } = statSync(path);
    const raw = readFileSync(path, "utf8").trim();
    return { raw, record: parseLockText(raw), mtimeMs };
  } catch {
    return null;
  }
}

function parseLockText(raw: string): LockRecord | null {
  if (!raw) return null;

  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as Partial<LockRecord>;
      const pid = Number(parsed.pid);
      if (!Number.isInteger(pid) || pid <= 0) return null;
      return {
        pid,
        ...(typeof parsed.execPath === "string" ? { execPath: parsed.execPath } : {}),
        ...(typeof parsed.startedAt === "string" ? { startedAt: parsed.startedAt } : {})
      };
    } catch {
      return null;
    }
  }

  const pid = Number(raw);
  return Number.isInteger(pid) && pid > 0 ? { pid } : null;
}

/**
 * Parse a lock file.
 *
 * Accepts the JSON written today and the bare pid an older build wrote, so an
 * upgrade does not strand a lock a live instance still holds. Returns null for
 * an empty, truncated or otherwise unreadable file, which the caller treats as
 * stale after the write grace — exactly what `Number("not-a-pid")` did before
 * this carried a shape.
 */
export function readLockRecord(path: string): LockRecord | null {
  try {
    return parseLockText(readFileSync(path, "utf8").trim());
  } catch {
    return null;
  }
}

/**
 * Take the lock, or refuse when a live instance holds it.
 *
 * The loop is not decoration. With a single `open`/`write` pair the file exists
 * empty for a moment, and a second starter that read it in that moment used to
 * delete it and write its own — measurably: a writer that held the handle and
 * wrote 700 ms later was "reclaimed" by a second starter after 2 ms, and both
 * then ran as owners. So an empty-but-fresh file is waited out, and a stale
 * file is re-read immediately before it is removed so a newer lock written in
 * between is left alone.
 */
export function acquireInstanceLock(path = resolveLockPath()) {
  const record = lockRecord();
  const contents = JSON.stringify(record);
  const ownerStartedAt = record.startedAt;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      const handle = openSync(path, "wx");
      writeSync(handle, contents);
      closeSync(handle);
      return {
        path,
        release() {
          releaseOwnedLock(path, ownerStartedAt);
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    const seen = readSnapshot(path);
    // Vanished between the open and the read: whoever held it has gone.
    if (!seen) continue;

    // Stale lock from a crashed process is reclaimed; a live one blocks startup.
    if (seen.record && isLiveOwner(seen.record)) {
      throw new Error(`AL AI bot is already running as pid ${seen.record.pid}. Refusing to start a second instance.`);
    }

    // Empty or unreadable: either that crash between `open` and `write`, or an
    // instance writing its record right now. Only age can tell them apart.
    if (!seen.record && Date.now() - seen.mtimeMs < WRITE_GRACE_MS) {
      sleepSync(RETRY_DELAY_MS);
      continue;
    }

    // Compare the exact content and stamp, not just the pid: another starter may
    // have replaced the stale file with a fresh record since we read it.
    const confirm = readSnapshot(path);
    if (!confirm || confirm.raw !== seen.raw || confirm.mtimeMs !== seen.mtimeMs) continue;

    try {
      unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  throw new Error(`AL AI could not acquire the instance lock at ${path} after ${MAX_ATTEMPTS} attempts.`);
}

/**
 * Remove the lock only while it is still the one we wrote.
 *
 * A boot that ended in `login` failure releases explicitly, and an operator can
 * start a replacement while the old process is still tearing down. Deleting by
 * path alone would then erase the replacement's lock and let a third instance
 * in. The recorded lock time identifies *this* acquisition, not merely the pid.
 */
function releaseOwnedLock(path: string, startedAt: string) {
  const current = readLockRecord(path);
  if (!current || current.pid !== process.pid || current.startedAt !== startedAt) return;
  try {
    unlinkSync(path);
  } catch {
    // Already gone: nothing to clean up.
  }
}

function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another account — that is
    // very much alive, and treating it as dead let a second instance start
    // with the same token (duplicated logs, doubled commands, doubled
    // anti-nuke counting). Only "no such process" may read as dead.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Is the recorded owner still the bot?
 *
 * `isAlive` alone is not enough on Windows. Pids are recycled, and the number a
 * crashed bot left behind was observed held by an unrelated `svchost` process:
 * `process.kill(pid, 0)` succeeded for it, so every later start was refused —
 * and logged as "already running as pid …" against a process that had never
 * heard of AL AI — until the file was deleted by hand.
 *
 * Identity is therefore checked in two steps. First the live image must be a
 * Node process; a number held by anything else is a stale lock. Second, when the
 * live process's start time can be read, it must not be later than the recorded
 * lock time. That second step closes the hole the image check leaves: the
 * recycled number is very often *another Node process*, which the image check
 * cannot reject, while the start time can. When neither probe can read the
 * process we assume it is genuinely ours, because refusing wrongly is a lockout
 * while reclaiming wrongly is two bots sharing one token.
 *
 * The recorded `execPath` stays deliberately diagnostic. Reclaiming on a path
 * mismatch would not be safe: two bot instances can legitimately run under
 * different Node installs, so a differing path does not prove the holder is not
 * a live bot.
 */
function isLiveOwner(record: LockRecord): boolean {
  if (!isAlive(record.pid)) return false;
  const image = describeProcessImage(record.pid);
  // Uninspectable (tasklist/ps unavailable): assume it is genuinely ours rather
  // than risk two instances sharing one token. The second probe only downgrades
  // that when the process is now gone — a death between the two calls, not an
  // uninspectable live owner.
  if (!image) return isAlive(record.pid);
  if (!isNodeImage(image)) return false;

  // A Node process holds the number — but is it *our* Node? The recorded lock
  // time settles it: the owner was alive when it wrote the lock, so a holder
  // that started demonstrably later cannot be that owner. Nothing to compare
  // against (a bare-pid lock from an older build) means we trust the image.
  const recordedStartedAt = record.startedAt ? Date.parse(record.startedAt) : Number.NaN;
  if (!Number.isFinite(recordedStartedAt)) return true;

  const liveStartedAt = describeProcessStartedAtMs(record.pid);
  if (liveStartedAt === null) return true;

  return liveStartedAt <= recordedStartedAt + START_TIME_SKEW_MS;
}

/**
 * When `pid` started, as epoch milliseconds, or null when the platform cannot
 * say. Kept dependency-free to match `describeProcessImage`: an extra package to
 * read one number would be a poor trade.
 */
function describeProcessStartedAtMs(pid: number): number | null {
  if (process.platform === "win32") {
    try {
      const stdout = execFileSync(
        "powershell",
        ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`],
        { timeout: 5_000, windowsHide: true }
      )
        .toString()
        .trim();
      const parsed = Date.parse(stdout);
      return Number.isFinite(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  try {
    // `lstart` prints a full local timestamp; `-p` restricts to the one process.
    const stdout = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { timeout: 5_000 }).toString().trim();
    const parsed = Date.parse(stdout);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** The executable image name for `pid`, or null when it cannot be read. */
function describeProcessImage(pid: number): string | null {
  if (process.platform === "win32") {
    try {
      // CSV without the header: `"node.exe","1234","Console","1","1,234 K"`.
      const stdout = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
        timeout: 5_000,
        windowsHide: true
      }).toString();
      const match = /^"([^"]+)"/m.exec(stdout);
      return match ? match[1]! : null;
    } catch {
      return null;
    }
  }

  try {
    return basename(readlinkSync(`/proc/${pid}/exe`));
  } catch {
    // /proc is absent (macOS, some sandboxes) — fall back to ps.
  }
  try {
    const stdout = execFileSync("ps", ["-o", "comm=", "-p", String(pid)], { timeout: 5_000 }).toString().trim();
    return stdout || null;
  } catch {
    return null;
  }
}

function isNodeImage(image: string): boolean {
  const name = basename(image).toLowerCase().replace(/\.exe$/, "");
  return name === "node" || name === "nodejs";
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
