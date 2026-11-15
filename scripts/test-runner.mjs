#!/usr/bin/env node
/**
 * A RAM-budgeted wrapper around `node --test`.
 *
 * `node --test` defaults its concurrency to the machine's logical CPU count.
 * On a 20-thread developer laptop that means twenty simultaneous child
 * processes, each loading the tsx loader, the TypeScript compiler, and (for
 * the dashboard) React + jsdom. That is 8-15 GiB of resident memory for a
 * 16 GiB machine: the suites start swapping, the OS kills processes, and the
 * whole desktop stalls. The failure looks like "the tests are flaky" but it is
 * really an unbounded worker count.
 *
 * The rule here is a hard ceiling, not a polite suggestion:
 *
 *   - Every worker is budgeted ~900 MiB of free RAM. Never more than two
 *     workers at once, regardless of how many cores the machine reports.
 *   - Every descendant process gets an explicit V8 heap ceiling through
 *     `NODE_OPTIONS`, so one runaway suite cannot reclaim the memory the
 *     concurrency cap saved.
 *   - If the machine is already below the floor, refuse to start instead of
 *     making the situation worse. A clear refusal beats a half-killed run.
 *
 * The caps are computed from *available* memory at start, so CI with plenty of
 * RAM still runs two workers, and a laptop with one browser open runs one.
 * They can be pinned for reproducible CI with `AL_AI_TEST_CONCURRENCY` and
 * `AL_AI_TEST_HEAP_MB`; both are still clamped to the safe range.
 */
import { spawnSync } from "node:child_process";
import { availableParallelism, freemem } from "node:os";

const MiB = 1024 ** 2;
const freeMB = Math.floor(freemem() / MiB);

/** Below this, starting another tsx worker is the wrong move. */
const MIN_FREE_MB = 512;
/** One test worker: tsx + TypeScript + React/jsdom + the test's own data. */
const WORKER_BUDGET_MB = 900;
const MAX_CONCURRENCY = 2;
const MIN_HEAP_MB = 256;
const MAX_HEAP_MB = 768;

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const pinned = (name, low, high) => {
  const raw = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(raw) ? clamp(raw, low, high) : null;
};

if (freeMB < MIN_FREE_MB) {
  console.error(
    `[test-runner] refusing to start: only ${freeMB} MiB free (need ${MIN_FREE_MB} MiB). ` +
      "Close a browser or another build first, then run the suite again."
  );
  process.exit(1);
}

const cores = typeof availableParallelism === "function" ? availableParallelism() : 2;
const concurrency =
  pinned("AL_AI_TEST_CONCURRENCY", 1, MAX_CONCURRENCY) ??
  clamp(Math.floor(freeMB / WORKER_BUDGET_MB), 1, Math.min(MAX_CONCURRENCY, cores));
const heapMB =
  pinned("AL_AI_TEST_HEAP_MB", MIN_HEAP_MB, MAX_HEAP_MB) ??
  clamp(Math.floor(freeMB / (concurrency + 1)), MIN_HEAP_MB, MAX_HEAP_MB);

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("[test-runner] no test files were given.");
  process.exit(1);
}

// Strip any inherited ceiling first: two --max-old-space-size flags make Node
// exit before a single test runs.
const inherited = (process.env.NODE_OPTIONS ?? "").replace(/--max-old-space-size=\d+/g, "").trim();
const env = {
  ...process.env,
  NODE_OPTIONS: `${inherited} --max-old-space-size=${heapMB}`.trim()
};

console.log(
  `[test-runner] free=${freeMB} MiB cores=${cores} concurrency=${concurrency} heap<=${heapMB} MiB files=${files.length}`
);

// `node --import tsx` loads the loader in this process; the test runner passes
// its execArgv (including --import and NODE_OPTIONS) to every child worker, so
// every file still resolves .ts/.tsx sources with the same ceiling.
const result = spawnSync(
  process.execPath,
  ["--import", "tsx", "--test", `--test-concurrency=${concurrency}`, ...files],
  { stdio: "inherit", env, cwd: process.cwd() }
);

if (result.error) console.error(`[test-runner] ${result.error.message}`);
process.exit(result.status ?? 1);
