import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_LOCK_PATH, acquireInstanceLock, readLockRecord, resolveLockPath } from "../src/runtime/supervisor.js";

/**
 * The single-instance lock.
 *
 * Two bot processes sharing one token duplicate every log line and handle every
 * command twice, so this file is the guard against that. It had no test: the
 * refusal, the reclaim of a crashed process's lock, and the release were all
 * unverified, and the reclaim path is the one that runs in production after a
 * crash — which is exactly when nobody is watching.
 *
 * The last two tests cover the *path*, which turned out to be the part that was
 * actually broken: the lock existed and worked, but the bot is documented to
 * start from two different working directories, and each one wrote its own lock
 * file. A guard that both sides agree on is worth nothing.
 */

const dir = mkdtempSync(join(tmpdir(), "al-ai-lock-"));
let counter = 0;
const freshPath = () => join(dir, `lock-${++counter}`);

after(() => rmSync(dir, { recursive: true, force: true }));

test("acquiring creates the lock and records the owning pid", () => {
  const path = freshPath();
  const lock = acquireInstanceLock(path);

  const record = readLockRecord(path);
  assert.equal(record?.pid, process.pid);
  assert.equal(record?.execPath, process.execPath, "the owner's image path is recorded for diagnostics");
  assert.ok(
    record?.startedAt && Number.isFinite(Date.parse(record.startedAt)),
    "the owner's lock time is recorded — it is what defeats pid recycling"
  );
  lock.release();
});

test("a second copy refuses to start while the owner is alive", () => {
  const path = freshPath();

  // This process is the owner, so the pid in the file is certainly alive — and
  // it is a Node process, which is what the liveness check now requires.
  writeFileSync(path, String(process.pid));

  assert.throws(() => acquireInstanceLock(path), /already running as pid/);
  assert.ok(existsSync(path), "the refusal must not remove the live owner's lock");
});

test("the lock of a process that has exited is reclaimed", () => {
  const path = freshPath();

  // A real process that has really finished, rather than a made-up pid: the
  // test is worthless if the owner turns out to be alive.
  const child = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  const deadPid = child.pid;
  assert.ok(deadPid, "expected the child to report a pid");
  assert.throws(() => process.kill(deadPid!, 0), "the child should have exited");

  writeFileSync(path, String(deadPid));

  const lock = acquireInstanceLock(path);
  assert.equal(readLockRecord(path)?.pid, process.pid, "the stale lock is replaced by ours");
  lock.release();
});

test("a pid recycled by a non-Node process is treated as stale", async () => {
  const path = freshPath();

  // The reported production failure: a crashed bot left its pid behind, the OS
  // handed that number to an unrelated process (a `svchost`), and `kill(pid, 0)`
  // then reported a live owner forever. The holder here is deliberately a
  // non-Node process, which is exactly what must be reclaimed.
  const [command, args] =
    process.platform === "win32" ? ["cmd", ["/c", "ping", "-n", "30", "127.0.0.1"]] : ["sleep", ["30"]];
  const holder = spawn(command, args, { stdio: "ignore" });
  assert.ok(holder.pid, "expected the holder to report a pid");

  try {
    // Wait until the holder is really registered, so liveness is not a race.
    for (let i = 0; i < 80 && !pidIsAlive(holder.pid!); i += 1) await new Promise(resolve => setTimeout(resolve, 25));
    assert.ok(pidIsAlive(holder.pid!), "the holder should be running");

    writeFileSync(path, String(holder.pid));
    const lock = acquireInstanceLock(path);
    assert.equal(readLockRecord(path)?.pid, process.pid, "a recycled pid must not block startup");
    lock.release();
  } finally {
    spawnSync("taskkill", ["/PID", String(holder.pid), "/T", "/F"], { stdio: "ignore" });
    holder.kill();
  }
});

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("a pid recycled by a different Node process is treated as stale", () => {
  const path = freshPath();

  // The hole the image check leaves open: the OS reuses a dead bot's number for
  // *another Node process*, so `isNodeImage` sees a Node and used to refuse
  // forever. This test process is such a live Node. A recycled number always
  // belongs to a process that started after the dead owner wrote the lock, so a
  // lock stamped an hour ago cannot have been written by us — the live start
  // time is later than the record, which is the signature of recycling.
  writeFileSync(
    path,
    JSON.stringify({
      pid: process.pid,
      execPath: process.execPath,
      startedAt: new Date(Date.now() - 60 * 60_000).toISOString()
    })
  );

  const lock = acquireInstanceLock(path);
  assert.equal(readLockRecord(path)?.pid, process.pid, "a same-image recycled pid must not block startup");
  lock.release();
});

test("a corrupt lock file does not wedge startup forever", () => {
  const path = freshPath();

  // A truncated write leaves something that is not a pid. Reading it as one
  // gives NaN, which is falsy, so the file is treated as stale rather than
  // blocking every future start.
  writeFileSync(path, "not-a-pid");

  const lock = acquireInstanceLock(path);
  assert.equal(readLockRecord(path)?.pid, process.pid);
  lock.release();
});

test("release removes the file", () => {
  const path = freshPath();
  const lock = acquireInstanceLock(path);

  assert.ok(existsSync(path));
  lock.release();
  assert.equal(existsSync(path), false);
});

test("releasing twice is not an error", () => {
  const path = freshPath();
  const lock = acquireInstanceLock(path);

  lock.release();
  lock.release();
  assert.equal(existsSync(path), false);
});

/**
 * The window between `open` and `write`.
 *
 * `acquireInstanceLock` must create the file and fill it in two syscalls. A
 * second starter that read the file inside that window used to call it empty,
 * delete it, and take the lock — measured at 2 ms while the first writer still
 * held the handle and wrote its own live record 700 ms later. Two processes,
 * one token, which is the exact failure the lock exists to prevent. These tests
 * use real child processes because in-process attempts are sequential and can
 * never interleave.
 */
const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "lock-holder.ts");

function holdLock(mode: "mid-write" | "race", path: string, a: number, b?: number) {
  return spawn(process.execPath, ["--import", "tsx", fixture, mode, path, String(a), ...(b === undefined ? [] : [String(b)])], {
    stdio: "ignore"
  });
}

async function waitForFile(path: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      statSync(path);
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  throw new Error(`expected ${path} to appear`);
}

test("a lock caught mid-write is not stolen", async () => {
  const path = freshPath();
  // Opened immediately, left empty for 1.5 s, then filled with a live record and
  // kept alive — the worst interleaving of the two-syscall window.
  const holder = holdLock("mid-write", path, 1_500, 8_000);
  try {
    await waitForFile(path, 5_000);

    const started = Date.now();
    assert.throws(
      () => acquireInstanceLock(path),
      /already running as pid/,
      "the reader must wait for the writer and then see its live record"
    );
    assert.ok(
      Date.now() - started >= 500,
      "an empty lock must be waited out, not deleted on sight"
    );
    assert.ok(existsSync(path), "the live writer's lock must still be there");
  } finally {
    holder.kill();
  }
});

test("a simultaneous pair of starters produces exactly one owner", async () => {
  const path = freshPath();
  // The winner holds the lock far longer than process startup jitter, so a
  // late-arriving starter cannot legitimately acquire after a release and be
  // mistaken for a second winner.
  const holders = [holdLock("race", path, 2_500), holdLock("race", path, 2_500)];
  const codes = await Promise.all(
    holders.map(
      holder =>
        new Promise<number | null>(resolve => {
          holder.on("exit", code => resolve(code));
        })
    )
  );

  assert.equal(codes.filter(code => code === 0).length, 1, `exactly one starter may own the lock (exit codes ${codes.join(",")})`);
  assert.equal(codes.filter(code => code === 3).length, 1, "the other must be refused, not crash");
});

test("an empty lock older than the write grace is reclaimed", () => {
  const path = freshPath();
  writeFileSync(path, "");
  const old = new Date(Date.now() - 30_000);
  utimesSync(path, old, old);

  const started = Date.now();
  const lock = acquireInstanceLock(path);
  assert.ok(Date.now() - started < 2_000, "a genuinely stale empty lock must not sit out the write grace");
  assert.equal(readLockRecord(path)?.pid, process.pid);
  lock.release();
});

test("release leaves a lock that no longer belongs to it", () => {
  const path = freshPath();
  const lock = acquireInstanceLock(path);

  // A replacement start wrote its own record between our acquisition and our
  // teardown (an operator restarting while the old process drains). Deleting by
  // path alone would erase the replacement's lock and admit a third instance.
  const replacement = {
    pid: process.pid,
    execPath: process.execPath,
    startedAt: new Date(Date.now() - 60_000).toISOString()
  };
  writeFileSync(path, JSON.stringify(replacement));

  lock.release();
  assert.ok(existsSync(path), "the newer owner's lock must survive our release");
  assert.equal(readLockRecord(path)?.startedAt, replacement.startedAt);
});

/* ------------------------------------------------------------------ *
 * The path the lock is taken at must not depend on the working directory.
 * ------------------------------------------------------------------ */

test("the default lock path is absolute and sits at the repository root", () => {
  // Measured before this was fixed: the instance started from the repository
  // root held `.al-ai-bot.lock` while the instance started from `apps/bot` wrote
  // `apps/bot/.al-ai-bot.lock` and started anyway. Two live processes, one
  // token — the exact failure this lock exists to prevent.
  assert.ok(isAbsolute(DEFAULT_LOCK_PATH), "a relative default resolves differently per working directory");
  assert.equal(basename(DEFAULT_LOCK_PATH), ".al-ai-bot.lock");

  // The repository root is the directory whose manifest declares the
  // workspaces, not one of the workspaces themselves.
  const manifest = JSON.parse(readFileSync(join(dirname(DEFAULT_LOCK_PATH), "package.json"), "utf8")) as {
    workspaces?: unknown;
  };
  assert.ok(manifest.workspaces, "the lock sits at the repository root, not inside a workspace");
});

test("a relative BOT_LOCK_FILE is anchored to the repository root, not the cwd", () => {
  // `.env.example` ships the bare name `.al-ai-bot.lock`, which is also what the
  // real `.env` sets. Read as a cwd-relative path that is a *second* lock file,
  // which is how the root instance and the `apps/bot` instance stopped seeing
  // each other.
  const previous = process.env.BOT_LOCK_FILE;
  try {
    process.env.BOT_LOCK_FILE = ".al-ai-bot.lock";
    assert.equal(resolveLockPath(), DEFAULT_LOCK_PATH, "the documented value is the default lock");

    process.env.BOT_LOCK_FILE = "ops.lock";
    assert.equal(resolveLockPath(), join(dirname(DEFAULT_LOCK_PATH), "ops.lock"), "a bare name means the repository root");

    const absolute = join(tmpdir(), "elsewhere.lock");
    process.env.BOT_LOCK_FILE = absolute;
    assert.equal(resolveLockPath(), absolute, "an absolute value names its own place");

    delete process.env.BOT_LOCK_FILE;
    assert.equal(resolveLockPath(), DEFAULT_LOCK_PATH, "unset falls back to the repository lock");
  } finally {
    if (previous === undefined) delete process.env.BOT_LOCK_FILE;
    else process.env.BOT_LOCK_FILE = previous;
  }
});
