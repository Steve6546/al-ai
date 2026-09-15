import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireInstanceLock } from "../src/runtime/supervisor.js";

/**
 * The single-instance lock.
 *
 * Two bot processes sharing one token duplicate every log line and handle every
 * command twice, so this file is the guard against that. It had no test: the
 * refusal, the reclaim of a crashed process's lock, and the release were all
 * unverified, and the reclaim path is the one that runs in production after a
 * crash — which is exactly when nobody is watching.
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
