#!/usr/bin/env node
/**
 * The manifest and the lockfile must agree, and the root must declare no
 * runtime dependencies.
 *
 * Two failures this catches, both of which are silent until a deploy:
 *
 *   1. `package.json` and `package-lock.json` disagree. `npm ci` — which
 *      `scripts/host/setup.sh` runs on every commit change — refuses to
 *      install in that state and exits non-zero, so the container boots with
 *      no dependencies and the dashboard answers 502 while the platform shows
 *      a restart loop. A hand edit to one file, or a package manager that
 *      rewrote the lock, produces exactly this.
 *
 *   2. The root gains a runtime `dependency`. The managed host's Packages
 *      panel reads `/package.json` and lists what it finds there as the
 *      deployment's packages; the root is a workspace manifest, so anything it
 *      declares is shown but never installed (`npm ci --omit=dev` in
 *      setup.sh). A phantom entry there invites the operator to "remove" a
 *      package that was never installed, which rewrites the manifest and
 *      desynchronises the lock. Runtime dependencies belong to the workspace
 *      that uses them.
 *
 * The comparison is exact for *declared* dependencies, which is what `npm ci`
 * validates at each tree root. It does not walk transitive versions — the
 * lockfile already pins those, and re-resolving the tree here would duplicate
 * npm's job (and its memory cost on a 256 MB host).
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const readJson = path => JSON.parse(readFileSync(path, "utf8"));
const problems = [];

const manifestPath = join(repoRoot, "package.json");
const lockPath = join(repoRoot, "package-lock.json");

if (!existsSync(lockPath)) {
  console.error("check:lock — package-lock.json is missing; `npm ci` cannot run on the host.");
  process.exit(1);
}

const manifest = readJson(manifestPath);
const lock = readJson(lockPath);

if (typeof lock.lockfileVersion !== "number" || lock.lockfileVersion < 2) {
  problems.push(`package-lock.json is lockfileVersion ${lock.lockfileVersion}; npm ci needs 2 or newer.`);
}
if (!lock.packages || typeof lock.packages !== "object") {
  problems.push("package-lock.json has no `packages` map (lockfileVersion 1 shape).");
}

/** Compare one manifest entry against its lock entry. */
function compare(where, manifestDeps, lockEntry) {
  const locked = lockEntry ?? {};
  const keys = ["dependencies", "devDependencies", "optionalDependencies"];
  for (const field of keys) {
    const declared = manifestDeps[field] ?? {};
    const pinned = locked[field] ?? {};
    for (const [name, spec] of Object.entries(declared)) {
      if (!(name in pinned)) {
        problems.push(`${where}: ${field} declares "${name}" but package-lock.json does not have it.`);
      } else if (pinned[name] !== spec) {
        problems.push(`${where}: ${field} "${name}" is "${spec}" in package.json but "${pinned[name]}" in the lock.`);
      }
    }
    for (const name of Object.keys(pinned)) {
      if (!(name in declared)) {
        problems.push(`${where}: package-lock.json pins "${name}" in ${field} but package.json no longer declares it.`);
      }
    }
  }
}

compare("package.json", manifest, lock.packages?.[""]);

// The root is a workspace manifest: it must not claim runtime dependencies.
const runtime = Object.keys(manifest.dependencies ?? {});
if (runtime.length) {
  problems.push(
    `package.json declares runtime dependencies (${runtime.join(", ")}). ` +
      "The root installs nothing on the host (npm ci --omit=dev), so the Packages panel would " +
      "advertise packages that are never installed. Move them to the workspace that uses them."
  );
}

/** Expand `apps/*` style workspace globs to the package directories present. */
function workspaceDirs(globs) {
  const dirs = [];
  for (const glob of globs ?? []) {
    if (!glob.endsWith("/*")) {
      dirs.push(glob);
      continue;
    }
    const base = glob.slice(0, -2);
    const basePath = join(repoRoot, base);
    if (!existsSync(basePath)) continue;
    for (const entry of readdirSync(basePath)) {
      const full = join(basePath, entry);
      if (statSync(full).isDirectory() && existsSync(join(full, "package.json"))) {
        dirs.push(`${base}/${entry}`);
      }
    }
  }
  return dirs;
}

for (const dir of workspaceDirs(manifest.workspaces)) {
  const path = join(repoRoot, dir, "package.json");
  if (!existsSync(path)) continue;
  const key = relative(repoRoot, path).replace(/\\/g, "/").replace(/\/package\.json$/, "");
  compare(`${key}/package.json`, readJson(path), lock.packages?.[key]);
}

if (problems.length) {
  console.error("check:lock — package.json and package-lock.json are out of sync:\n");
  for (const problem of problems) console.error(`  • ${problem}`);
  console.error("\nFix with `npm install --package-lock-only`, then commit both files together.");
  process.exit(1);
}

const workspaces = workspaceDirs(manifest.workspaces).length;
console.log(
  `check:lock — in sync (root + ${workspaces} workspace${workspaces === 1 ? "" : "s"}, lockfileVersion ${lock.lockfileVersion}); root declares no runtime dependencies.`
);
