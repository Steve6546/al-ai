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

test("docs/GOVERNANCE.md declares exactly nineteen rules", () => {
  assert.equal(declaredRules.length, 19, `found ${declaredRules.length} numbered rules`);
  assert.deepEqual(
    declaredRules,
    Array.from({ length: 19 }, (_, index) => index + 1),
    "rules are numbered 1..19 with no gaps"
  );
});

test("every GOVERNANCE rule reference in the source points at a real rule", () => {
  const dangling: string[] = [];
  for (const file of files) {
    for (const match of file.source.matchAll(/GOVERNANCE rule (\d+)/g)) {
      const rule = Number(match[1]);
      if (!declaredRules.includes(rule)) dangling.push(`${file.relativePath} cites rule ${rule}`);
    }
  }
  assert.deepEqual(dangling, [], "a comment must not cite a rule that does not exist");
});

test("the rule numbers actually used cover the rules that need code", () => {
  const cited = new Set<number>();
  for (const file of files) {
    for (const match of file.source.matchAll(/GOVERNANCE rule (\d+)/g)) cited.add(Number(match[1]));
  }
  // Rules 1, 4, 6, 8 and 9 are enforced structurally by the other tests above
  // and by the deploy/registry modules; the rest must be cited where they live.
  for (const rule of [2, 3, 5, 7, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]) {
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

test("the customization sync applies the whole appearance, not just the nickname", () => {
  const sync = files.find(file => file.relativePath === "src/runtime/customization-sync.ts");
  assert.ok(sync, "the sync module exists");

  const code = codeOf(sync!.source);
  assert.match(code, /applyAppearance/, "the sync applies the full appearance");
  assert.equal(/applyNickname|loadNickname/.test(code), false, "the nickname-only shape is retired");
});

test("the bot applies the appearance through the one module allowed to touch Discord", () => {
  const discord = files.find(file => file.relativePath === "src/lib/discord.ts");
  assert.ok(discord, "the Discord module exists");
  assert.match(codeOf(discord!.source), /applyBotAppearance/, "the Discord call lives here, not in the sync");

  // The sync must not reach Discord directly: it works on plain data.
  const sync = files.find(file => file.relativePath === "src/runtime/customization-sync.ts")!;
  assert.equal(/from\s+"discord\.js"/.test(sync.source), false);
});

