import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { DEFAULT_LOCK_PATH, acquireInstanceLock, resolveLockPath } from "../src/runtime/supervisor.js";

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

  assert.equal(readFileSync(path, "utf8"), String(process.pid));
  lock.release();
});

test("a second copy refuses to start while the owner is alive", () => {
  const path = freshPath();

  // This process is the owner, so the pid in the file is certainly alive.
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
  assert.equal(readFileSync(path, "utf8"), String(process.pid), "the stale lock is replaced by ours");
  lock.release();
});

test("a corrupt lock file does not wedge startup forever", () => {
  const path = freshPath();

  // A truncated write leaves something that is not a pid. Reading it as one
  // gives NaN, which is falsy, so the file is treated as stale rather than
  // blocking every future start.
  writeFileSync(path, "not-a-pid");

  const lock = acquireInstanceLock(path);
  assert.equal(readFileSync(path, "utf8"), String(process.pid));
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
