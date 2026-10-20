/**
 * Child process used by `instance-lock.test.ts`.
 *
 * It exists so the lock can be contended by *real* processes: a second
 * acquisition inside one process would be sequential and could never exercise
 * the window this fixture is here to expose.
 *
 *   mid-write <path> <writeAfterMs> <exitAfterMs>
 *       Open the lock exclusively, stay silent for `writeAfterMs` (the interval
 *       between `open` and `write` that a live owner really goes through), then
 *       write a live record and stay alive.
 *
 *   race <path> <holdMs>
 *       Try to take the lock normally, hold it, release. Exit 0 when it was
 *       acquired and 3 when it was refused.
 */
import { closeSync, openSync, writeSync } from "node:fs";
import { acquireInstanceLock } from "../../src/runtime/supervisor.js";

const [mode, path, a, b] = process.argv.slice(2);

if (!mode || !path) {
  console.error("usage: lock-holder <mid-write|race> <path> <ms> <ms>");
  process.exit(2);
}

if (mode === "mid-write") {
  const writeAfter = Number(a ?? 0);
  const exitAfter = Number(b ?? writeAfter + 1_000);
  const handle = openSync(path, "wx");
  setTimeout(() => {
    writeSync(handle, JSON.stringify({ pid: process.pid, execPath: process.execPath, startedAt: new Date().toISOString() }));
    closeSync(handle);
  }, writeAfter);
  setTimeout(() => process.exit(0), exitAfter);
} else if (mode === "race") {
  const holdMs = Number(a ?? 500);
  const lock = (() => {
    try {
      return acquireInstanceLock(path);
    } catch {
      process.exit(3);
    }
  })();
  setTimeout(() => {
    lock.release();
    process.exit(0);
  }, holdMs);
} else {
  console.error(`unknown mode: ${mode}`);
  process.exit(2);
}
