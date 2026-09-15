import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Static governance checks.
 *
 * These are the rules from docs/GOVERNANCE.md that a reviewer would otherwise
 * have to catch by eye. If one of these fails, the contract is broken.
 */

const botRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(entry => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

const files = sourceFiles(join(botRoot, "src")).map(path => ({ path, relativePath: relative(botRoot, path).replace(/\\/g, "/"), source: readFileSync(path, "utf8") }));

/**
 * Every source tree that is allowed to cite a rule.
 *
 * The contract binds the whole monorepo, not just the bot: rules 25 to 27 are
 * implemented in `packages/core` and `apps/dashboard/server`, and a citation
 * there has to be checked as well. Scanning only the bot is what would let a
 * comment in core point at a rule number that no longer exists.
 */
const repoRoot = join(botRoot, "..", "..");
const citationRoots = ["apps/bot/src", "apps/dashboard/server", "packages/core/src"];
const citationFiles = citationRoots
  .flatMap(root => sourceFiles(join(repoRoot, root)))
  .map(path => ({
    path,
    relativePath: relative(repoRoot, path).replace(/\\/g, "/"),
    source: readFileSync(path, "utf8")
  }));

test("discord.js is imported by exactly one module", () => {
  const importers = files.filter(file => /from\s+"discord\.js"/.test(file.source)).map(file => file.relativePath);
  assert.deepEqual(importers, ["src/lib/discord.ts"]);
});

test("no module requests the presence intent", () => {
  const offenders = files.filter(file => /GatewayIntentBits\.GuildPresences/.test(file.source)).map(file => file.relativePath);
  assert.deepEqual(offenders, [], "member presence is out of scope, so online/idle state is never tracked");
});

test("the runtime never deploys slash commands", () => {
  const runtimeFiles = files.filter(file => !file.relativePath.includes("scripts/"));
  const offenders = runtimeFiles
    .filter(file =>
      file.source
        .split("\n")
        .some(line => /deploySlashCommands\s*\(/.test(line) && !/export\s+async\s+function\s+deploySlashCommands/.test(line))
    )
    .map(file => file.relativePath);
  assert.deepEqual(offenders, [], "deployment belongs to scripts/deploy-commands.ts only");
});

test("no hard-coded Discord snowflake IDs in bot source", () => {
  const offenders = files
    .filter(file => /(?<![\w.])\d{17,20}(?![\w.])/.test(file.source))
    .map(file => file.relativePath);
  assert.deepEqual(offenders, [], "user, role, and channel IDs must come from configuration");
});

test("no prefix command handling exists", () => {
  const offenders = files.filter(file => /message\.content\.startsWith\s*\(/.test(file.source)).map(file => file.relativePath);
  assert.deepEqual(offenders, []);
});

test("direct Discord delivery happens only through the injected transport", () => {
  const senders = files.filter(file => /sendLogEmbed\s*\(/.test(file.source)).map(file => file.relativePath).sort();
  // The router calls runtime.send(); only the runtime wires that to Discord.
  assert.deepEqual(senders, ["src/index.ts", "src/lib/discord.ts"].sort());
});

test("the log router is the only module that calls the delivery transport", () => {
  const callers = files
    .filter(file => !file.relativePath.includes("lib/discord.ts"))
    .filter(file => /runtime\.send\s*\(/.test(file.source))
    .map(file => file.relativePath);
  assert.deepEqual(callers, ["src/logging/log-router.ts"]);
});

test("channel IDs are resolved only by the channel registry", () => {
  const offenders = files
    .filter(file => /channelId\s*[:=]\s*["'`]\d+/.test(file.source))
    .map(file => file.relativePath);
  assert.deepEqual(offenders, []);
});

test("the bot never reads the guild_log_channels constraint mirror", () => {
  // The mirror exists so the database itself rejects two destinations sharing one
  // channel. It stores no global-channel row, so a reader built on it would return
  // null for every guild routed by the global fallback and drop those events
  // silently. Routing reads guild_logging; only the dashboard writes the mirror.
  const offenders = files
    .map(file => ({
      relativePath: file.relativePath,
      // Comments may explain the rule; only real code counts.
      code: file.source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
    }))
    .filter(file => /guild_log_channels/.test(file.code))
    .map(file => file.relativePath);
  assert.deepEqual(offenders, [], "the mirror is write-only from the bot's point of view");
});

/* ------------------------------------------------------------------ *
 * The governance document and the source must not drift apart.
 * ------------------------------------------------------------------ */

const governancePath = join(botRoot, "..", "..", "docs", "GOVERNANCE.md");
const governance = readFileSync(governancePath, "utf8");

/** Rule numbers declared in docs/GOVERNANCE.md, e.g. "1. **Slash commands only.**" */
const declaredRules = [...governance.matchAll(/^(\d+)\.\s+\*\*/gm)].map(match => Number(match[1]));

test("docs/GOVERNANCE.md declares exactly twenty-seven rules", () => {
  assert.equal(declaredRules.length, 27, `found ${declaredRules.length} numbered rules`);
  assert.deepEqual(
    declaredRules,
    Array.from({ length: 27 }, (_, index) => index + 1),
    "rules are numbered 1..27 with no gaps"
  );
});

test("every GOVERNANCE rule reference in the source points at a real rule", () => {
  const dangling: string[] = [];
  for (const file of citationFiles) {
    for (const match of file.source.matchAll(/GOVERNANCE rule (\d+)/g)) {
      const rule = Number(match[1]);
      if (!declaredRules.includes(rule)) dangling.push(`${file.relativePath} cites rule ${rule}`);
    }
  }
  assert.deepEqual(dangling, [], "a comment must not cite a rule that does not exist");
});

test("the rule numbers actually used cover the rules that need code", () => {
  const cited = new Set<number>();
  for (const file of citationFiles) {
    for (const match of file.source.matchAll(/GOVERNANCE rule (\d+)/g)) cited.add(Number(match[1]));
  }
  // Rules 1, 4, 6, 8 and 9 are enforced structurally by the other tests above
  // and by the deploy/registry modules; the rest must be cited where they live.
  for (const rule of [2, 3, 5, 7, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 24, 25, 26, 27]) {
    assert.ok(cited.has(rule), `rule ${rule} is not cited anywhere in src`);
  }
});

/* ------------------------------------------------------------------ *
 * GOVERNANCE rule 19 — no credential enters through the dashboard.
 * ------------------------------------------------------------------ */

test("no bot module reads a token from anywhere but the environment", () => {
  // The only permitted sources are process.env and the config loader. A token
  // arriving from the database or an HTTP body is the defect this rule names.
  const offenders = files
    .filter(file => /bot_tokens|token_ciphertext|tokenCiphertext/.test(codeOf(file.source)))
    .map(file => file.relativePath);
  assert.deepEqual(offenders, [], "the retired token store is never read back");
});

/* ------------------------------------------------------------------ *
 * The integration adapter must never become a public listener.
 * ------------------------------------------------------------------ */

test("the integration adapter never binds to a wildcard address", () => {
  const adapter = files.find(file => file.relativePath === "src/integration-adapter.ts");
  assert.ok(adapter, "the adapter exists");

  // Comments may explain why 0.0.0.0 is refused; only real code counts.
  const code = adapter!.source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  assert.equal(/0\.0\.0\.0/.test(code), false, "binding to 0.0.0.0 is refused");
  assert.match(code, /127\.0\.0\.1/, "the adapter is pinned to loopback");
});

/* ------------------------------------------------------------------ *
 * Operational state files must never carry a secret.
 * ------------------------------------------------------------------ */

const configFiles = ["control-plane.json", "channels.json"].map(name => {
  const path = join(botRoot, "config", name);
  return { name, source: readFileSync(path, "utf8") };
});

test("no config file contains a secret-shaped value", () => {
  for (const file of configFiles) {
    assert.equal(/[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}/.test(file.source), false, `${file.name} holds no bot token`);
    assert.equal(/(SECRET|PASSWORD|TOKEN)\s*[:=]\s*"[^"]+"/i.test(file.source), false, `${file.name} holds no credential`);
  }
});

test("config files stay valid JSON", () => {
  for (const file of configFiles) {
    assert.doesNotThrow(() => JSON.parse(file.source), `${file.name} parses`);
  }
});

/* ------------------------------------------------------------------ *
 * GOVERNANCE rule 18 — a saved setting must be one the bot applies.
 *
 * The retired design offered a per-guild avatar and banner, which the dashboard
 * saved successfully and the bot could never apply: Discord gives an application
 * one global image. These tests keep that class of fake setting out.
 * ------------------------------------------------------------------ */

/** Source with comments stripped, so an explanation of the rule is not a breach. */
const codeOf = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

test("no bot module reads or writes a per-guild avatar or banner", () => {
  const offenders = files
    .filter(file => /avatar_url|banner_url|avatarUrl|bannerUrl/.test(codeOf(file.source)))
    .map(file => file.relativePath);
  assert.deepEqual(offenders, [], "a per-guild bot image cannot be applied, so it is never stored");
});

test("the bot never applies the appearance it does not own", () => {
  // The writer moved. The dashboard performs the REST writes — nickname, avatar,
  // banner, role colour, icon and bio — because it can report each field's
  // outcome straight back to the operator. The bot keeps exactly one appearance
  // writer, the presence, because only a live gateway connection can set a
  // status and Discord exposes no REST route for it.
  //
  // This is the assertion that keeps a second writer from appearing: two writers
  // for one field would fight, and the losing one would look like a save that
  // did nothing.
  const offenders = files
    .filter(file => /applyBotAppearance|applyAppearance/.test(codeOf(file.source)))
    .map(file => file.relativePath);
  assert.deepEqual(offenders, [], "the appearance is applied by the dashboard, not the bot");
});

test("the bot's only appearance write is the presence, over the gateway", () => {
  const sync = files.find(file => file.relativePath === "src/runtime/presence-sync.ts");
  assert.ok(sync, "the presence sync module exists");

  const code = codeOf(sync!.source);
  assert.match(code, /normaliseBotIdentity/, "the presence is normalised with the shared helper");
  assert.equal(/avatarDataUrl|bannerDataUrl|roleColor/.test(code), false, "the sync touches the presence only");

  // The sync works on plain data and must never reach Discord itself: the
  // gateway call belongs in the one module allowed to import discord.js.
  assert.equal(/from\s+"discord\.js"/.test(sync!.source), false, "the sync does not reach Discord directly");
});

test("the presence is the only field the bot writes to the gateway", () => {
  const discord = files.find(file => file.relativePath === "src/lib/discord.ts");
  assert.ok(discord, "the Discord module exists");

  const code = codeOf(discord!.source);
  assert.match(code, /applyBotPresence/, "the gateway write lives here");

  // The bot's *own* identity — its avatar, its username — is owned by the
  // dashboard, and a write from here would be a second writer for a field
  // `bot_identity` already holds. That is the guarantee, and it is what is
  // asserted: no avatar and no username write exists anywhere in the module.
  assert.equal(/setAvatar|setUsername/.test(code), false, "the bot writes its own avatar or username");

  // `setNickname` is a different thing and this test used to conflate the two.
  // The only call site is `/setnick`, which renames *a member* — moderation, not
  // identity. So the assertion is narrowed rather than dropped: the write must
  // exist, and it must be the moderation action and nowhere else. Counting
  // occurrences is what makes "nowhere else" testable; a bare `false` would have
  // banned the moderation feature along with the defect it was written for.
  const nicknameWrites = code.match(/setNickname/g) ?? [];
  assert.equal(nicknameWrites.length, 1, "the only nickname write is the moderation action");
  assert.match(code, /case "setnick":[\s\S]{0,200}?setNickname/, "and it lives in the setnick branch");
});

test("the runtime applies the presence through the sync, not by hand", () => {
  const index = files.find(file => file.relativePath === "src/index.ts")!;
  assert.match(codeOf(index.source), /createPresenceSync\s*\(/, "the runtime builds the sync");
});

/* ------------------------------------------------------------------ *
 * The layers stay apart.
 *
 * GOVERNANCE rule 2 separates the Discord access points; these tests separate
 * the packages. The dependency direction is one-way — the bot and the BFF both
 * depend on core, and core depends on neither — because a cycle would make the
 * shared contract impossible to test on its own, and an npm dependency inside
 * core would land in the browser bundle whether or not the SPA uses it.
 * ------------------------------------------------------------------ */

const coreFiles = sourceFiles(join(repoRoot, "packages", "core", "src"));
const spaFiles = sourceFiles(join(repoRoot, "apps", "dashboard", "src"));

/** Import specifiers that are not relative, i.e. packages or node builtins. */
function externalImports(source: string): string[] {
  return [...source.matchAll(/^import[^;]*?from\s+"([^"]+)"/gm)]
    .map(match => match[1])
    .filter(specifier => !specifier.startsWith("."));
}

test("the shared contract imports nothing but node:crypto", () => {
  const found = coreFiles.flatMap(path =>
    externalImports(readFileSync(path, "utf8")).map(
      specifier => `${relative(repoRoot, path).replace(/\\/g, "/")} -> ${specifier}`
    )
  );

  // `security.ts` is the one exception, and it is a node builtin rather than a
  // package. It is also excluded from `browser.ts`, so the SPA never sees it.
  assert.deepEqual(
    found,
    ["packages/core/src/security.ts -> node:crypto"],
    "an npm dependency in core would be bundled into the dashboard whether it is used or not"
  );
});

test("the SPA never reaches the bot or the BFF's server modules", () => {
  const offenders = spaFiles
    .filter(path => /from\s+"[^"]*(apps\/bot|\/server\/|apps\/dashboard\/server)/.test(readFileSync(path, "utf8")))
    .map(path => relative(repoRoot, path).replace(/\\/g, "/"));

  assert.deepEqual(offenders, [], "the browser talks to the BFF over HTTP, never by import");
});

test("the bot never reaches the dashboard", () => {
  const offenders = files
    .filter(file => /from\s+"[^"]*apps\/dashboard/.test(file.source))
    .map(file => file.relativePath);

  assert.deepEqual(offenders, [], "the dashboard is not a dependency of the bot");
});

