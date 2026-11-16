import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Every environment variable the code reads must be in `.env.example`.
 *
 * The gap this guards against is silent by construction: a variable that is
 * read but undocumented works perfectly on the machine that already has it in
 * `.env`, and is undiscoverable on a fresh clone. `DEVELOPER_WEBHOOK_URL` was
 * in that state — read by the bot, described in `config/channels.json`, and
 * absent from the template — so the internal `security.*` destination could
 * never be switched on by anyone reading the repository's own setup steps.
 *
 * This lives with the bot's static checks for the same reason
 * `governance.test.ts` does: the rule binds the whole monorepo, so the scan
 * reaches into `apps/dashboard` and `packages/core` too.
 */

const here = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = join(here, "..", "..", "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(entry => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx|mjs|mts)$/.test(full) ? [full] : [];
  });
}

/**
 * The ways this repository reaches for the environment.
 *
 * `read("NAME")` is `apps/dashboard/server/env.ts`'s local wrapper, and
 * `readEnv(source, "NAME")` is the shared `@al-ai/core` accessor the bot reads
 * through. A scan for `process.env` alone reported a clean bill of health while
 * `PORT`, the two retention settings, and every bot secret were being read
 * through one of the two wrappers instead.
 */
const patterns = [
  /process\.env\.([A-Z_][A-Z0-9_]*)/g,
  /process\.env\[\s*["']([A-Z_][A-Z0-9_]*)["']\s*\]/g,
  /\bread\(\s*["']([A-Z_][A-Z0-9_]*)["']\s*\)/g,
  /\breadEnv\(\s*[^,()]*,\s*["']([A-Z_][A-Z0-9_]*)["']\s*\)/g,
  /**
   * The `scripts/` helpers that take a variable *name* as their first argument:
   * `heap("AL_AI_BOT_HEAP_MB", 2048)` in `start.mjs`, `pinned("AL_AI_TEST_HEAP_MB",
   * …)` in `test-runner.mjs`. Both read `process.env[name]` internally, so the
   * four variables they own were invisible to every pattern above and sat
   * undocumented while the check reported a clean bill of health — the same
   * failure mode the `readEnv` pattern was added for.
   */
  /\b(?:heap|pinned)\(\s*["']([A-Z_][A-Z0-9_]*)["']/g
];

/**
 * Comments are stripped first, because a comment is not a read.
 *
 * The paragraph above spells out `read("NAME")` as an example, and without this
 * the scan matched its own explanation and reported `NAME` as an undocumented
 * variable. A scanner that reacts to its own prose reports the wrong thing for
 * the wrong reason.
 *
 * The heuristic leans towards stripping too little rather than too much: a
 * `//` inside a URL is not a comment, and leaving such a line whole can only
 * produce a false report, never hide a real read.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map(line => {
      if (line.includes("://")) return line;
      const index = line.indexOf("//");
      return index === -1 ? line : line.slice(0, index);
    })
    .join("\n");
}

function envNamesIn(source: string): string[] {
  return patterns.flatMap(pattern => [...withoutComments(source).matchAll(pattern)].map(match => match[1]));
}

/**
 * The shell half of the contract.
 *
 * `boot.sh`, `setup.sh` and `run-linux-stack.sh` read the environment directly —
 * `${AL_AI_HEAP_BOT:-96}` and friends — and no TypeScript pattern can see that.
 * Five variables lived in exactly that blind spot (`AL_AI_LOG_DIR`,
 * `AL_AI_HOST_STATE`, `AL_AI_RELAY_LISTEN_PORTS`, `AL_AI_RELAY_LISTEN_PORT`,
 * `AL_AI_TUNNEL_HOST`): real, supported overrides that a fresh clone could not
 * discover, while the check reported a clean bill of health.
 *
 * A shell script both *reads* and *assigns* names, so the reference alone proves
 * nothing — `ROOT`, `STATE` and `LOG_DIR` are locals. The rule is therefore
 * "referenced but never assigned in the same file", which is exactly what
 * "supplied by the environment" means. Shell built-ins and POSIX variables are
 * excluded because nothing can or should document them.
 */
const SHELL_REFERENCE = /\$\{?([A-Z_][A-Z0-9_]*)/g;
const SHELL_ASSIGNMENT = /(?:^|[\s;(])(?:export\s+)?([A-Z_][A-Z0-9_]*)=/gm;
const SHELL_SCOPE = /\b(?:local|declare|typeset)\s+(?:-\w+\s+)?([A-Z_][A-Z0-9_]*)/g;
const SHELL_LOOP = /\bfor\s+([A-Z_][A-Z0-9_]*)\s+in\b/g;
const SHELL_READ = /\bread\s+(?:-\w+\s+)*([A-Z_][A-Z0-9_]*)/g;

/** Variables the shell or the OS provides; never ours to document. */
const SHELL_BUILTINS = new Set([
  "BASH_SOURCE", "BASH_VERSION", "BASH_REMATCH", "DIRSTACK", "EUID", "FUNCNAME",
  "GROUPS", "HOME", "HOSTNAME", "IFS", "LANG", "LC_ALL", "LINENO", "OLDPWD",
  "OSTYPE", "PATH", "PIPESTATUS", "PPID", "PWD", "RANDOM", "SECONDS", "SHELL",
  "SHLVL", "TERM", "TMPDIR", "UID", "USER"
]);

function shellNamesIn(source: string): string[] {
  const body = withoutComments(source);
  const provided = new Set<string>();
  for (const pattern of [SHELL_ASSIGNMENT, SHELL_SCOPE, SHELL_LOOP, SHELL_READ]) {
    for (const match of body.matchAll(pattern)) provided.add(match[1]);
  }
  const referenced = [...body.matchAll(SHELL_REFERENCE)].map(match => match[1]);
  return referenced.filter(name => !provided.has(name) && !SHELL_BUILTINS.has(name));
}

const scanRoots = ["apps/bot/src", "apps/bot/test", "apps/dashboard/server", "apps/dashboard/test", "packages/core/src", "scripts"];
const read = new Map<string, string[]>();

function record(name: string, path: string) {
  const where = relative(repoRoot, path).replace(/\\/g, "/");
  read.set(name, [...(read.get(name) ?? []), where]);
}

for (const root of scanRoots) {
  for (const path of sourceFiles(join(repoRoot, root))) {
    for (const name of envNamesIn(readFileSync(path, "utf8"))) record(name, path);
  }
}

function shellFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(entry => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return shellFiles(full);
    return full.endsWith(".sh") ? [full] : [];
  });
}

for (const root of ["scripts", "infra"]) {
  for (const path of shellFiles(join(repoRoot, root))) {
    for (const name of shellNamesIn(readFileSync(path, "utf8"))) record(name, path);
  }
}

const documented = new Set(
  readFileSync(join(repoRoot, ".env.example"), "utf8")
    .split("\n")
    .map(line => /^([A-Z_][A-Z0-9_]*)=/.exec(line)?.[1])
    .filter((name): name is string => Boolean(name))
);

test("the scan finds the environment reads it is meant to find", () => {
  // A guard that silently matches nothing passes forever. These two are read in
  // places the scan has to reach: BOT_TOKEN through the shared `readEnv`
  // accessor, PORT through the dashboard's local `read` wrapper. If a future
  // refactor changes how either is read, this fails before the documentation
  // check can quietly pass on an empty scan.
  assert.ok(read.has("BOT_TOKEN"), "expected to see the bot read BOT_TOKEN through readEnv()");
  assert.ok(read.has("PORT"), "expected to see the dashboard read PORT through read()");
  assert.ok(read.has("AL_AI_TEST_HEAP_MB"), "expected to see test-runner.mjs read AL_AI_TEST_HEAP_MB through pinned()");
});

test("every environment variable the code reads is documented in .env.example", () => {
  const missing = [...read.keys()].filter(name => !documented.has(name)).sort();
  const detail = missing.map(name => `${name} (${read.get(name)!.join(", ")})`).join("\n  ");
  assert.deepEqual(missing, [], `read by code but absent from .env.example:\n  ${detail}`);
});
