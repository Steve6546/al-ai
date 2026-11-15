#!/usr/bin/env node
/**
 * One command to publish a dashboard change.
 *
 * Why this exists: publishing used to be four manual steps — build, remember
 * that the server serves `dist/` from disk, restart the process when `server/`
 * changed, and then verify by hand that the new bundle is the one being served.
 * Forgetting the last step is invisible: the build succeeds, the old page keeps
 * working, and the "new version" bar simply never appears. That is the failure
 * this script makes impossible.
 *
 * What it does, in order:
 *
 *   1. Reads the hash of the bundle being served now (the baseline).
 *   2. Builds the SPA.
 *   3. Runs the secret gate over the fresh bundle — the built file is a real
 *      leak surface, and it is the one artifact a build creates that no test
 *      reads.
 *   4. Reads the new hash and asks the running server which one it serves.
 *   5. Says plainly what happened: whether the bundle changed, whether the live
 *      server already serves it, and therefore whether an open tab will see the
 *      bar.
 *
 * A frontend change needs no restart: the BFF reads `dist/index.html` and
 * `/api/version` from disk on every request. A change under `apps/dashboard/server`
 * does need one, and this script says so instead of guessing.
 *
 *   npm run deploy                # build + gate + verify the served build
 *   npm run deploy -- --no-build  # only verify what is served now
 *   npm run deploy -- --port 3001 # a server on a non-default port
 */
import { readFileSync, statSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const next = process.argv[index + 1];
  return next && !next.startsWith("--") ? next : true;
}

function envValue(name, fallback) {
  try {
    const line = readFileSync(join(ROOT, ".env"), "utf8")
      .split(/\r?\n/)
      .find(entry => entry.startsWith(`${name}=`));
    const value = line?.slice(name.length + 1).trim();
    return value || fallback;
  } catch {
    return fallback;
  }
}

/** The hashed entry script `index.html` names — the same value `/api/version` returns. */
function servedBundleOnDisk() {
  try {
    const html = readFileSync(join(ROOT, "apps", "dashboard", "dist", "index.html"), "utf8");
    return /assets\/index-[A-Za-z0-9_-]+\.js/.exec(html)?.[0] ?? null;
  } catch {
    return null;
  }
}

async function probeServed(baseUrl) {
  try {
    const response = await fetch(`${baseUrl}/api/version`, { signal: AbortSignal.timeout(3_000) });
    if (!response.ok) return { reachable: true, version: null };
    const body = await response.json();
    return { reachable: true, version: body.version ?? null };
  } catch {
    return { reachable: false, version: null };
  }
}

/**
 * Whether a `server/*.ts` file is newer than the running process.
 *
 * The BFF reads `dist/` from disk per request, so a frontend change needs no
 * restart — but a change under `server/` is already in memory, and serving the
 * old routes is the classic "I deployed and nothing changed". The process start
 * time comes from `/proc` on Linux; where it is unavailable the check abstains
 * rather than guessing.
 */
function serverCodeChangedSince(pid) {
  if (!pid) return null;
  let startedAt;
  try {
    startedAt = statSync(`/proc/${pid}`).mtimeMs;
  } catch {
    return null;
  }
  const walk = path => {
    let newest = 0;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) newest = Math.max(newest, walk(full));
      else if (entry.name.endsWith(".ts")) newest = Math.max(newest, statSync(full).mtimeMs);
    }
    return newest;
  };
  try {
    return walk(join(ROOT, "apps", "dashboard", "server")) > startedAt;
  } catch {
    return null;
  }
}

/** The pid of the dashboard process, so the start-time comparison has an anchor. */
function dashboardPid() {
  const result = spawnSync("pgrep", ["-f", "server/index.ts"], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) return null;
  return result.stdout.trim().split("\n")[0];
}

const port = String(arg("port") ?? envValue("PORT", "3000"));
const baseUrl = String(arg("url") ?? `http://127.0.0.1:${port}`);
const skipBuild = arg("no-build") === true;

console.log("AL AI deploy");
console.log(`  dashboard: ${baseUrl}`);

const before = servedBundleOnDisk();
console.log(`  served bundle (before): ${before ?? "none — dist/ is not built"}`);

if (!skipBuild) {
  console.log("\n[1/3] building the dashboard…");
  const build = spawnSync(
    isWindows ? "npm.cmd" : "npm",
    ["run", "build", "--workspace=@al-ai/dashboard"],
    { cwd: ROOT, stdio: "inherit", shell: isWindows }
  );
  if (build.status !== 0) {
    console.error("\ndeploy stopped: the build failed. Nothing was published.");
    process.exit(1);
  }

  console.log("\n[2/3] running the secret gate over the fresh bundle…");
  const gate = spawnSync(isWindows ? "node.exe" : "node", ["scripts/check-secrets.mjs"], {
    cwd: ROOT,
    stdio: "inherit",
    shell: isWindows
  });
  if (gate.status !== 0) {
    console.error("\ndeploy stopped: the secret gate refused the bundle. Nothing was published.");
    process.exit(1);
  }
} else {
  console.log("\n[1/3] build skipped (--no-build)");
  console.log("[2/3] secret gate skipped (nothing was rebuilt)");
}

const after = servedBundleOnDisk();
const changed = before !== after;
console.log(`\n[3/3] served bundle (after): ${after ?? "none"}`);
console.log(`  changed: ${changed ? "yes" : "no"}`);

const live = await probeServed(baseUrl);
if (!live.reachable) {
  console.log(`  live server: not reachable at ${baseUrl} — start the stack, then re-run to confirm.`);
} else if (live.version === after) {
  console.log(`  live server: serves ${live.version} — the running build is the one just published.`);
} else {
  console.log(`  live server: serves ${live.version ?? "nothing"} — that is not the bundle on disk.`);
}

const serverTouched = serverCodeChangedSince(dashboardPid());

console.log("\nresult");
if (changed) {
  console.log("  ✅ a new build is published.");
  console.log("     An open tab will show the «new version» bar within one poll (≤20s) and after a focus.");
} else {
  console.log("  • no frontend change: the bundle hash is the same, so there is nothing new to announce.");
}
if (live.reachable && live.version !== after) {
  console.log("  ⚠️ the running server is not serving the bundle on disk. Restart the dashboard:");
  console.log(isWindows ? "     npm run dev:restart" : "     ./scripts/run-linux-stack.sh");
}
if (serverTouched === true) {
  console.log("  ⚠️ apps/dashboard/server changed after the server started — restart the dashboard to pick it up.");
}
console.log("\n  reminder: a change to slash commands needs `npm run deploy-commands --workspace=@al-ai/bot`.");
