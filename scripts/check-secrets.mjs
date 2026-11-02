#!/usr/bin/env node
/**
 * The secret gate: `npm run check:secrets`, and part of `npm run verify`.
 *
 * It exists because a credential that reaches `git log` is not undeleted by
 * deleting the file. This repository has already had one: commit `7d67921`
 * committed a 361-byte `.env` from the project that lived here before AL AI, and
 * `git log --all -- .env` still shows it even though `0ed6bff` removed it.
 *
 * Four surfaces, because they do not overlap:
 *
 *   1. **Tracked files**, named to the scanner from `git ls-files` rather than
 *      handed as `.` — the scanner skips hidden directories by default, and
 *      `.github/workflows/verify.yml` is exactly where a pasted token lands.
 *   2. **Git history, every ref** — the diff of `git log --all -p`, scanned
 *      commit by commit so a hit can be attributed to a commit instead of being
 *      a count with no address.
 *   3. **The local artefacts** a token can be printed into: the bot's own log
 *      directory and the built browser bundle. Both are gitignored, so they are
 *      walked by name, in plain JavaScript — a surface that only works when an
 *      optional CLI happens to be installed is a surface that silently vanishes
 *      in CI.
 *   4. **`.env` by membership, not by content** — it is the one file that is
 *      supposed to hold plaintext, so the failure that matters is it becoming
 *      tracked, and that is asserted directly and cheaply. `.env.local`,
 *      `.env.production` and their relatives are covered by the same rule;
 *      `.env.example` is the template and stays allowed.
 *
 * Two rules about rules, both learned by running the scanner here:
 *
 * - Only *value-shaped* matches block. `secrun`'s `password-kv` rule matches a
 *   key name holding any value, so all 23 hits on this repository's own files
 *   were type declarations (`hmacSecret: string;`) and interpolated variables
 *   (`${POSTGRES_PASSWORD}`). A gate that fails on those is a gate that gets
 *   switched off.
 * - A GitHub token is a value shape this scanner does not know, so the prefixes
 *   live in `lib/credential-shapes.mjs` — documented prefix plus documented
 *   length, never a keyword hunt.
 *
 * Nothing here prints a credential. The scanner returns a masked prefix and the
 * shape detector returns the prefix alone, so a CI log or a chat transcript can
 * carry the report without becoming a copy.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { CREDENTIAL_MARKERS, CREDENTIAL_SHAPES, describeHit, fakeTokenFor, findCredentialShapes } from "./lib/credential-shapes.mjs";

/** Vendor formats whose match is always an emergency. */
const BLOCKING_VENDOR_RULES = new Set(["aws-ak", "aliyun-ak", "bailian-apikey", "aliyun-sts", "private-key"]);

/** The gitignored places a token gets printed into, scanned without a scanner. */
const ARTEFACT_DIRS = [".al-ai", "apps/dashboard/dist"];

function run(command, args, options = {}) {
  try {
    // stderr is captured, not passed through: `secrun` prints a summary line for
    // every scan, and a gate whose output is 90% scanner chatter hides the one
    // line that matters.
    return {
      stdout: execFileSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], ...options }) ?? "",
      code: 0
    };
  } catch (error) {
    // `secrun scan` exits 3 when it finds something; that is data, not failure.
    // A missing binary is a different thing: `error.status` is undefined and the
    // call never ran, which the caller has to be able to tell apart.
    if (error.code === "ENOENT") return { stdout: "", stderr: "", code: "absent" };
    return { stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? ""), code: error.status ?? 1 };
  }
}

/**
 * Does the external scanner exist at all?
 *
 * Asked once, up front, because every caller of `run()` gets an empty result
 * when it does not — and an empty result that came from a missing program looks
 * exactly like a clean repository. The whole point of reporting coverage is
 * that a surface which did not run is never counted as a pass.
 */
function scannerStatus() {
  const probe = run("secrun", ["scan", "--stdin"], { input: "" });
  if (probe.code === "absent") return "absent";
  if (probe.code === 0) return "ready";
  return `refused (exit ${probe.code})`;
}

function vendorHits(text, scanner) {
  if (scanner !== "ready") return { hits: [], ran: false };
  const { stdout } = run("secrun", ["scan", "--stdin"], { input: text });
  return {
    hits: stdout
      .split("\n")
      .map(line => line.trim())
      .filter(line => BLOCKING_VENDOR_RULES.has(line.split(": ").slice(-2)[0] ?? "")),
    ran: true
  };
}

function trackedFiles() {
  return run("git", ["ls-files", "-z"])
    .stdout.split("\0")
    .filter(Boolean);
}

/** The scanner takes paths; the tracked list is chunked to stay under argv limits. */
function scanTracked(files, scanner) {
  const blocking = [];
  let informational = 0;
  let ran = false;
  for (let i = 0; i < files.length && scanner === "ready"; i += 40) {
    const chunk = files.slice(i, i + 40);
    const { stdout } = run("secrun", ["scan", ...chunk]);
    ran = true;
    const lines = stdout.split("\n").map(line => line.trim()).filter(line => line.includes(": "));
    informational += lines.length;
    blocking.push(...lines.filter(line => BLOCKING_VENDOR_RULES.has(line.split(": ").slice(-2)[0] ?? "")));
  }
  return { blocking, informational, ran };
}

/** Every file under a directory, forward-slashed, for the artefact pass. */
function walk(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true, encoding: "utf8" })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) found.push(...walk(path));
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

/**
 * Every ref's history, attributed.
 *
 * `git log --all -p` walks each commit's diff in order, so the current commit
 * and the current file are tracked from the diff headers themselves — a hit is
 * reported as `commit <sha> <path>` and never as the value.
 */
function scanHistory(scanner) {
  const shallow = run("git", ["rev-parse", "--is-shallow-repository"]).stdout.trim() === "true";
  const commits = run("git", ["rev-list", "--all", "--count"]).stdout.trim();
  const diff = run("git", ["log", "--all", "-p", "--format=commit %H%x09%an"]).stdout;
  const secretHits = [];
  const publicHits = [];
  let commit = "unknown";
  let path = "unknown";
  let lineInFile = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("commit ")) {
      commit = line.slice(7, 47);
      path = "unknown";
      continue;
    }
    if (line.startsWith("+++ b/")) {
      path = line.slice(6);
      lineInFile = 0;
      continue;
    }
    lineInFile += 1;
    // Only added lines are worth scanning: a context line belongs to an
    // unchanged region that the tracked-file pass already covers.
    if (!line.startsWith("+")) continue;
    for (const hit of findCredentialShapes(line.slice(1))) {
      (hit.secret ? secretHits : publicHits).push(describeHit(hit, `history ${commit.slice(0, 8)} ${path}`));
    }
  }
  return { secretHits, publicHits, vendor: vendorHits(diff, scanner), shallow, commits };
}

/**
 * The gitignored artefacts, read directly.
 *
 * These two directories are where the bot writes its logs and where the build
 * writes the browser bundle — the two places a token ends up without anyone
 * typing it into a file. The shapes are matched here in plain JavaScript rather
 * than delegated to the scanner, so this surface runs in CI too, and a directory
 * that has not been built yet is reported as absent instead of counted clean.
 */
function scanArtefacts(scanner) {
  const secretHits = [];
  const publicHits = [];
  const present = [];
  const absent = [];
  const files = [];
  for (const dir of ARTEFACT_DIRS) {
    if (!existsSync(dir)) {
      absent.push(dir);
      continue;
    }
    const listed = walk(dir);
    present.push(`${dir} (${listed.length} files)`);
    files.push(...listed);
  }
  for (const file of files) {
    let text = "";
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const hit of findCredentialShapes(text)) {
      (hit.secret ? secretHits : publicHits).push(describeHit(hit, `artefact ${file}`));
    }
  }
  return { secretHits, publicHits, vendor: vendorHits(files.map(readText).join("\n"), scanner), present, absent };
}

/** A file that cannot be read contributes nothing rather than throwing. */
function readText(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/* ------------------------------------------------------------------ *
 * The gate's own test, run every time the gate runs.
 *
 * A detector that is never tested is a detector that quietly stopped. These
 * cases are the reason the file exists: every declared shape must be found, a
 * body one character short must not be, the secret/publishable split must hold,
 * and the words `secret` / `key` / `token` must never be enough on their own.
 * ------------------------------------------------------------------ */
function selfTest() {
  const failures = [];
  for (const shape of CREDENTIAL_SHAPES) {
    const fixture = fakeTokenFor(shape);
    const hits = findCredentialShapes(`token = "${fixture}"`);
    if (!hits.some(hit => hit.rule === shape.rule)) failures.push(`${shape.rule}: a documented shape was NOT detected`);

    // One character short of the documented length is not a token, and must not
    // be reported — this is the difference between a shape and a keyword.
    const short = fixture.slice(0, -1);
    if (findCredentialShapes(short).some(hit => hit.rule === shape.rule)) {
      failures.push(`${shape.rule}: a truncated body was reported as a credential`);
    }

    // The report must carry the prefix and nothing else.
    for (const hit of findCredentialShapes(fixture)) {
      const line = describeHit(hit, "self-test");
      if (line.includes(fixture) || line.includes(fixture.slice(shape.prefix.length))) {
        failures.push(`${shape.rule}: the report leaked the value`);
      }
    }
  }

  // Supabase is declared twice because the two keys are the same length and the
  // opposite risk: the secret one bypasses row-level security, the publishable
  // one is designed to be public. If a future edit collapses that split, the
  // gate would start calling a real incident a note, so the split is asserted.
  const supabasePair = CREDENTIAL_SHAPES.filter(shape => shape.rule.startsWith("supabase-"));
  if (supabasePair.length !== 2) {
    failures.push("Supabase must be declared as exactly two shapes (publishable and secret)");
  } else {
    for (const shape of supabasePair) {
      const [hit] = findCredentialShapes(fakeTokenFor(shape));
      if (!hit) failures.push(`${shape.rule}: Supabase shape not detected`);
      else if (hit.secret !== shape.secret) failures.push(`${shape.rule}: classified as ${hit.secret ? "incident" : "note"}, expected the other`);
    }
  }

  // A private key is found by its literal header, and a paragraph *about*
  // private keys is not. Built by concatenation so this file never holds the
  // marker itself — the tracked-file pass below would otherwise flag the gate.
  const pem = ["-----BEGIN ", "PRIVATE KEY-----", "MIIEowIDAAB"].join("");
  if (!findCredentialShapes(pem).some(hit => hit.rule === "private-key")) {
    failures.push("private-key: a PEM header was NOT detected");
  }
  if (findCredentialShapes("rotate the private key and reissue the certificate").length) {
    failures.push("prose about a private key was reported as a credential");
  }

  // Anti-noise: the vocabulary of secrets is not a credential.
  const prose = 'const hmacSecret = "sessionSecret"; // rotate the API key and the OAuth token';
  if (findCredentialShapes(prose).length) failures.push("keyword-only text was reported as a credential");

  // This gate's own source must not contain a shape, or the gate would flag
  // itself on every run — and the fixtures would be a live token in the repo.
  const ownSource = readFileSync(new URL("./lib/credential-shapes.mjs", import.meta.url), "utf8");
  if (findCredentialShapes(ownSource).filter(hit => hit.secret).length) {
    failures.push("credential-shapes.mjs contains a detectable credential literal");
  }

  return failures;
}

/* ------------------------------------------------------------------ */
function main() {
  const problems = [];
  const notes = [];

  const testFailures = selfTest();
  if (testFailures.length) {
    console.error(`check:secrets — the detector failed its own test (${testFailures.length}):`);
    for (const failure of testFailures) console.error(`  ${failure}`);
    process.exit(1);
  }

  const files = trackedFiles();
  if (!files.length) problems.push("git ls-files returned nothing; the tracked-file scan did not run.");

  // Asked once, before anything depends on it: the vendor pass and the pure-JS
  // pass cover overlapping families, and which one ran changes what a clean
  // exit means.
  const scanner = scannerStatus();
  /*
   * `.env` is checked by membership, not by content.
   *
   * It is the one file that is *supposed* to hold plaintext, so scanning its
   * contents would either mean failing every run or trusting the operator not
   * to type anything real. The failure that matters is it becoming tracked, and
   * that is asserted directly. `.env.example` is excluded on purpose — it is the
   * documented template, holds names rather than values, and is the file that
   * makes a fresh clone work at all.
   */
  const trackedEnv = files.filter(
    file => /(^|\/)\.env(\.[A-Za-z0-9-]+)?$/.test(file) && !/\.env\.example$/.test(file)
  );
  for (const file of trackedEnv) problems.push(`${file} is TRACKED by git — its contents are in the repository, and deleting the file will not remove them from the history.`);

  const tracked = scanTracked(files, scanner);
  problems.push(...tracked.blocking.map(hit => `vendor credential in tracked files: ${hit}`));

  let unreadable = 0;
  for (const file of files) {
    if (!existsSync(file)) {
      unreadable += 1;
      continue;
    }
    let text = "";
    try {
      text = readFileSync(file, "utf8");
    } catch {
      // A file that could not be read is counted, not quietly skipped: "clean"
      // has to mean clean over what the gate actually looked at.
      unreadable += 1;
      continue;
    }
    for (const hit of findCredentialShapes(text)) {
      (hit.secret ? problems : notes).push(describeHit(hit, `tracked ${file}`));
    }
  }

  const history = scanHistory(scanner);
  if (history.shallow) {
    problems.push(
      `git history is a SHALLOW clone (${history.commits} commits reachable): the history surface did not really run. Fetch the full history (checkout with fetch-depth: 0) or run the gate in a complete clone.`
    );
  }
  problems.push(...history.secretHits.map(hit => `credential in git history: ${hit}`));
  problems.push(...history.vendor.hits.map(hit => `vendor credential in git history: ${hit}`));
  notes.push(...history.publicHits);

  const artefacts = scanArtefacts(scanner);
  problems.push(...artefacts.secretHits.map(hit => `credential in a local artefact: ${hit}`));
  problems.push(...artefacts.vendor.hits.map(hit => `vendor credential in local artefacts: ${hit}`));
  notes.push(...artefacts.publicHits);

  /*
   * Coverage prints on both paths. A gate that only explains itself when it
   * fails is a gate whose success nobody can audit.
   */
  const coverage = [
    `surfaces: ${files.length} tracked files${unreadable ? ` (${unreadable} unreadable — counted as a hole, not as a pass)` : ""} | git history: ${history.commits} commits over all refs${history.shallow ? " (SHALLOW — incomplete)" : ""} | artefacts: ${artefacts.present.join(", ") || "none"}`,
    artefacts.absent.length
      ? `  absent this run, so not claimed: ${artefacts.absent.join(", ")} — the built bundle is only covered once \`npm run build\` has produced it`
      : null,
    `  rules: ${CREDENTIAL_SHAPES.length} value shapes + ${CREDENTIAL_MARKERS.length} marker, built in (GitHub, Supabase, AWS, Alibaba, Bailian, PEM) | vendor scanner: ${
      scanner === "ready"
        ? "ready (adds STS.* temporary credentials)"
        : `NOT RUN (${scanner === "absent" ? "not installed here" : scanner}) — the built-in shapes above still ran; STS.* did not`
    }`
  ].filter(line => line !== null);

  if (problems.length) {
    console.error(`check:secrets — ${problems.length} problem(s)`);
    for (const problem of problems) console.error(`  ${problem}`);
    for (const line of coverage) console.error(line);
    // The notes print here too. A run that fails for one reason should still say
    // what it saw that is *not* a problem, or the next reader has to run a
    // second scan to find out.
    for (const note of notes) console.error(`  public-by-design key: ${note}`);
    console.error("\nA credential in git history is leaked even after the file is deleted: rotate it first, then decide about the history.");
    process.exit(1);
  }

  console.log("check:secrets — clean. No value-shaped credential in what the gate actually read.");
  for (const line of coverage) console.log(line);
  console.log(
    `  detector self-test: ${CREDENTIAL_SHAPES.length * 3 + 5} cases passed (every declared shape: detection, truncation, masking — plus the secret/publishable split, the PEM marker both ways, anti-noise and own source)`
  );
  console.log(
    tracked.ran
      ? `  informational: ${tracked.informational} name-shaped scanner hits (variable declarations, interpolated \${VARS}) — reported, never blocking`
      : "  informational: the name-shaped scanner pass did not run, so no count is claimed"
  );
  for (const note of notes) console.log(`  public-by-design key: ${note}`);
}

main();
