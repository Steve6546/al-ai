/**
 * A load measurement for the local stack.
 *
 * What it is for: to put a number on the dashboard's local paths - the ones
 * an operator's browser hits - instead of guessing. What it is *not*: a load
 * test against Discord. The routes measured here are local by construction
 * (the health check reads the database, the session check reads the session
 * table, the static check reads the built SPA), and the guild routes are
 * deliberately *not* measured, because every one of them spends Discord's
 * rate-limit budget and hammering that budget is exactly what this project
 * is built to avoid.
 *
 * It reports latency percentiles, throughput, event-loop delay and memory.
 * The numbers are a measurement, not a gate: the script fails only when
 * requests actually fail.
 *
 *   node scripts/load-check.mjs [--url http://127.0.0.1:3000] [--concurrency 1,10,50] [--requests 200]
 */
import { monitorEventLoopDelay } from "node:perf_hooks";
import { randomUUID } from "node:crypto";

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const baseUrl = arg("url", "http://127.0.0.1:3000").replace(/\/$/, "");
const concurrencyLevels = arg("concurrency", "1,10,50")
  .split(",")
  .map(value => Number(value.trim()))
  .filter(value => Number.isFinite(value) && value > 0);
const requestsPerLevel = Number(arg("requests", "200"));

/** The local routes only. Nothing here reaches Discord. */
const ROUTES = [
  { path: "/api/health", name: "health (db)" },
  { path: "/api/session", name: "session (db)" },
  { path: "/", name: "static SPA" }
];

function percentile(sorted, fraction) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index];
}

async function measure(route, concurrency) {
  const latency = [];
  let issued = 0;
  let throttled = 0;
  let failed = 0;
  const started = process.hrtime.bigint();

  // A fresh session id per request, so the measurement is of the *server* and
  // not of the throttle: the throttle is 120 requests a minute per client
  // bucket, which is the protection this project wants, and a load run that
  // shared one bucket would measure nothing but the protection answering 429.
  //
  // The cookie name depends on the mode (`al_ai_session` in development,
  // `__Host-al_ai_session` in production), so both are sent: the server reads
  // the one it expects, and the request lands in a per-session bucket - the
  // case a signed-in operator is in. The throttle is measured separately, on
  // purpose, below.
  const worker = async () => {
    for (;;) {
      if (issued >= requestsPerLevel) return;
      issued += 1;
      const id = randomUUID();
      const begin = process.hrtime.bigint();
      let status = 0;
      try {
        const response = await fetch(`${baseUrl}${route.path}`, {
          headers: { accept: "*/*", cookie: `al_ai_session=${id}; __Host-al_ai_session=${id}` }
        });
        await response.arrayBuffer();
        status = response.status;
      } catch {
        status = 0;
      }
      const end = process.hrtime.bigint();
      latency.push(Number(end - begin) / 1e6);
      if (status === 429) throttled += 1;
      else if (status === 0 || status >= 500) failed += 1;
    }
  };

  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  await Promise.all(Array.from({ length: concurrency }, worker));
  delay.disable();
  const finished = process.hrtime.bigint();
  const seconds = Number(finished - started) / 1e9;

  latency.sort((a, b) => a - b);
  const total = latency.length;
  return {
    route: route.name,
    concurrency,
    requests: total,
    throttled,
    failed,
    rps: total / seconds,
    p50: percentile(latency, 0.5),
    p95: percentile(latency, 0.95),
    p99: percentile(latency, 0.99),
    max: latency[total - 1] ?? 0,
    eventLoopP99: delay.percentile(99) / 1e6,
    eventLoopMax: delay.max / 1e6
  };
}

const health = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(5_000) })
  .then(response => response.json())
  .catch(() => null);
if (!health) {
  console.log(`SKIP  ${baseUrl} is not answering - start the stack first (npm run dev -- -Detach)`);
  process.exitCode = 0;
} else {
  console.log(`AL AI local load check against ${baseUrl} (${requestsPerLevel} requests per level)`);
  console.log(`memory before: ${(process.memoryUsage().rss / 1024 / 1024).toFixed(1)} MB rss\n`);
  console.log("route                 conc   rps    p50     p95     p99     max     loopP99  loopMax  429  err");
  let failures = 0;
  let throttled = 0;
  for (const route of ROUTES) {
    for (const concurrency of concurrencyLevels) {
      const result = await measure(route, concurrency);
      failures += result.failed;
      throttled += result.throttled;
      console.log(
        `${result.route.padEnd(20)} ${String(result.concurrency).padStart(4)} ${result.rps.toFixed(0).padStart(6)} ${result.p50
          .toFixed(1)
          .padStart(7)} ${result.p95.toFixed(1).padStart(7)} ${result.p99.toFixed(1).padStart(7)} ${result.max
          .toFixed(1)
          .padStart(7)} ${result.eventLoopP99.toFixed(1).padStart(8)} ${result.eventLoopMax.toFixed(1).padStart(8)} ${String(
          result.throttled
        ).padStart(5)} ${String(result.failed).padStart(4)}`
      );
    }
  }
  console.log(`\nmemory after: ${(process.memoryUsage().rss / 1024 / 1024).toFixed(1)} MB rss`);
  console.log(`throttled (429, the protection working): ${throttled}`);

  // The protection, measured on purpose: one client, one bucket, more than
  // the allowance. The throttle is supposed to answer 429 with `retry-after`
  // once the allowance is spent.
  const bucket = randomUUID();
  const bucketCookie = `al_ai_session=${bucket}; __Host-al_ai_session=${bucket}`;
  const statuses = new Map();
  let retryAfterSeen = false;
  for (let index = 0; index < 130; index += 1) {
    const response = await fetch(`${baseUrl}/api/health`, {
      headers: { accept: "*/*", cookie: bucketCookie }
    });
    await response.arrayBuffer();
    statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1);
    if (response.headers.get("retry-after")) retryAfterSeen = true;
  }
  const throttledNow = statuses.get(429) ?? 0;
  console.log(
    `throttle check: one client, 130 requests -> ${[...statuses].map(([code, count]) => `${code}x${count}`).join(" ")}${
      retryAfterSeen ? " (retry-after present)" : " (no retry-after!)"
    }`
  );
  if (throttledNow === 0) {
    console.log("the throttle did not answer 429 - the flood was not bounded");
    failures += 1;
  }

  if (failures > 0) {
    console.log(`${failures} request(s) failed`);
    process.exitCode = 1;
  } else {
    console.log("no failed requests");
  }
}
