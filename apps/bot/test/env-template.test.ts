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
 * The three ways this repository reaches for the environment.
 *
 * `read("NAME")` is `apps/dashboard/server/env.ts`'s own accessor, which is why
 * a scan for `process.env` alone reported a clean bill of health while `PORT`
 * and the two retention settings were being read through it.
 */
const patterns = [
  /process\.env\.([A-Z_][A-Z0-9_]*)/g,
  /process\.env\[\s*["']([A-Z_][A-Z0-9_]*)["']\s*\]/g,
  /\bread\(\s*["']([A-Z_][A-Z0-9_]*)["']\s*\)/g
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

const scanRoots = ["apps/bot/src", "apps/bot/test", "apps/dashboard/server", "apps/dashboard/test", "packages/core/src", "scripts"];
const read = new Map<string, string[]>();

for (const root of scanRoots) {
  for (const path of sourceFiles(join(repoRoot, root))) {
    for (const name of envNamesIn(readFileSync(path, "utf8"))) {
      const where = relative(repoRoot, path).replace(/\\/g, "/");
      read.set(name, [...(read.get(name) ?? []), where]);
    }
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
  // places the scan has to reach: the bot's own source and the dashboard's
  // accessor wrapper.
  assert.ok(read.has("BOT_TOKEN"), "expected to see the bot read BOT_TOKEN");
  assert.ok(read.has("PORT"), "expected to see the dashboard read PORT through read()");
});

test("every environment variable the code reads is documented in .env.example", () => {
  const missing = [...read.keys()].filter(name => !documented.has(name)).sort();
  const detail = missing.map(name => `${name} (${read.get(name)!.join(", ")})`).join("\n  ");
  assert.deepEqual(missing, [], `read by code but absent from .env.example:\n  ${detail}`);
});
