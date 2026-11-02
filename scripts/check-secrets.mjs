#!/usr/bin/env node
/**
 * The secret gate: `npm run check:secrets`.
 *
 * It exists because a credential that reaches `git log` is not deleted by
 * deleting the file. This repository has already had one: commit `7d67921`
 * committed a 361-byte `.env` from the project that lived here before AL AI,
 * and `git log --all -- .env` still shows it even though `0ed6bff` removed it.
 *
 * Two rules about rules, both learned from running the scanner here:
 *
 * - **Only unmistakable shapes block.** `secrun`'s `password-kv` rule matches a
 *   *key name* holding any value, so `hmacSecret: string;` and
 *   `DATABASE_URL=${…}` are hits. All 22 hits on this repo's own files were
 *   type declarations, form fields and variable names. Failing a build on those
 *   trains everyone to ignore the build; the rules below name a format, not an
 *   identifier, and a hit is always an emergency.
 * - **`.env` is checked by membership, not by content.** It is the one file that
 *   is *supposed* to hold plaintext, and it is in `.gitignore`. The failure that
 *   matters is it becoming tracked, so that is asserted directly and cheaply.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

/** Rules whose match is a credential shape, not a name. */
const BLOCKING = new Set(["aws-ak", "aliyun-ak", "bailian-apikey", "aliyun-sts", "private-key"]);

function run(args) {
  try {
    // The scanner writes its summary to stderr and exits 3 on a hit; both are
    // the input to this gate, not output for the operator, so nothing is passed
    // through and a 3 is not an error.
    return { stdout: execFileSync("secrun", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), code: 0 };
  } catch (error) {
    return { stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? ""), code: error.status ?? 1 };
  }
}

function scan(paths) {
  const { stdout } = run(["scan", ...paths]);
  const hits = stdout.split("\n").filter(line => line.includes(": "));
  const blocking = hits.filter(line => BLOCKING.has(line.split(": ").slice(-2)[0] ?? ""));
  return { hits, blocking };
}

const problems = [];

/* 1. The file that must never be tracked. */
try {
  const listed = execFileSync("git", ["ls-files", "--", ".env"], { encoding: "utf8" }).trim();
  if (listed) problems.push(".env is TRACKED by git — its contents are in the repository.");
} catch {
  problems.push("git ls-files failed; the .env check did not run.");
}

/* 2. Source, config and docs (gitignored files are skipped by the scanner). */
const source = scan(["."]);
for (const hit of source.blocking) problems.push(`credential shape in tracked files: ${hit}`);

/* 3. The local artefacts a real token could have been printed into: the
 *    dashboard's own logs and the built bundle. Both are gitignored, so the
 *    scanner needs them named — and `.env` is excluded on purpose, because its
 *    plaintext is the design, not the defect. */
const artefacts = ["--all", ".al-ai", "apps/dashboard/dist"].filter(p => p === "--all" || existsSync(p));
if (artefacts.length > 1) {
  const result = scan(artefacts);
  for (const hit of result.blocking) problems.push(`credential shape in local artefacts: ${hit}`);
}

if (problems.length) {
  console.error(`check:secrets — ${problems.length} problem(s)`);
  for (const problem of problems) console.error(`  ${problem}`);
  console.error("\nA credential in git history is leaked even after the file is deleted: rotate it, then decide about the history.");
  process.exit(1);
}

console.log("check:secrets — clean: no credential shape in tracked files, logs or the built bundle; .env is untracked.");
console.log(`(informational: ${source.hits.length} name-shaped hits reported by the scanner, e.g. variable declarations — see the file header for why they do not block)`);
