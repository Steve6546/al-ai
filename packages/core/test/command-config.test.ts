import test from "node:test";
import assert from "node:assert/strict";
import {
  assessCommandScope,
  commandCategories,
  commandCategoryLabels,
  commandDurationSeconds,
  commandDurations,
  CommandCooldowns,
  clampInteger,
  commandFlagsFor,
  commandRegistry,
  cooldownKey,
  defaultCommandConfig,
  durationSeconds,
  MAX_AUTO_DELETE_SECONDS,
  MAX_COOLDOWN_SECONDS,
  MAX_PRESET_REASONS,
  normaliseCommandConfig,
  requireCommand,
  TIMEOUT_MAX_SECONDS
} from "../src/command-registry.js";

/**
 * The per-command configuration contract.
 *
 * Every rule here is enforced on the server, in the bot, or in both — so each
 * one is pinned in the shared package the three of them read. A control that
 * survives normalisation but changes nothing is the defect this file exists to
 * prevent.
 */

/* ------------------------------------------------------------------ *
 * Categories
 * ------------------------------------------------------------------ */

test("every registered command belongs to a known category", () => {
  for (const definition of commandRegistry) {
    assert.ok(
      (commandCategories as readonly string[]).includes(definition.category),
      `${definition.name} has a category the dashboard can render`
    );
    assert.ok(commandCategoryLabels[definition.category], `${definition.category} has a label`);
  }
});

test("the directive's three sections are the ones that exist", () => {
  assert.deepEqual([...commandCategories], ["moderation", "channels", "general"]);
  assert.equal(commandCategoryLabels.moderation, "أوامر الإدارة");
  assert.equal(commandCategoryLabels.channels, "أوامر القنوات والشات");
  assert.equal(commandCategoryLabels.general, "أوامر عامة");
});

test("the commands land in the section the directive names", () => {
  const categoryOf = (name: string) => requireCommand(name).category;
  for (const name of ["ban", "unban", "kick", "timeout", "warn", "warns", "clearwarns"]) {
    assert.equal(categoryOf(name), "moderation", name);
  }
  for (const name of ["clear", "lock", "unlock", "slowmode"]) {
    assert.equal(categoryOf(name), "channels", name);
  }
  assert.equal(categoryOf("al-status"), "general");
});

/* ------------------------------------------------------------------ *
 * Defaults
 * ------------------------------------------------------------------ */

test("every scope starts empty and every switch starts off", () => {
  for (const definition of commandRegistry) {
    const config = defaultCommandConfig(definition);
    assert.deepEqual(config.allowedRoleIds, [], definition.name);
    assert.deepEqual(config.deniedRoleIds, [], definition.name);
    assert.deepEqual(config.allowedChannelIds, [], definition.name);
    assert.deepEqual(config.deniedChannelIds, [], definition.name);
    assert.deepEqual(config.presetReasons, [], definition.name);
    assert.equal(config.cooldownSeconds, 0, definition.name);
    assert.equal(config.autoDeleteResponseSeconds, 0, definition.name);
    assert.equal(config.defaultDuration, "permanent", definition.name);
  }
});

/* ------------------------------------------------------------------ *
 * Controls the command cannot honour are dropped
 * ------------------------------------------------------------------ */

test("a reason requirement only survives where a reason option exists", () => {
  // `/clear` publishes no reason option, so demanding one would be a switch that
  // can never be satisfied — the command would simply stop working.
  const clear = normaliseCommandConfig(requireCommand("clear"), { requireReason: true });
  assert.equal(clear.requireReason, false);

  const warn = normaliseCommandConfig(requireCommand("warn"), { requireReason: true });
  assert.equal(warn.requireReason, true);
});

test("the reason requirement can be turned off again", () => {
  // `/warn` ships with it on. A hard-required Discord option would make this
  // impossible, which is why the option is optional and the bot decides.
  assert.equal(requireCommand("warn").requiresReason, true);
  assert.equal(normaliseCommandConfig(requireCommand("warn"), { requireReason: false }).requireReason, false);
  assert.equal(normaliseCommandConfig(requireCommand("warn"), {}).requireReason, true, "unset keeps the default");
});

test("a duration only survives where one can be applied", () => {
  // `/ban` is permanent and `/warn` is a record, so a duration on either would be
  // stored and then silently ignored.
  assert.equal(normaliseCommandConfig(requireCommand("ban"), { defaultDuration: "7d" }).defaultDuration, "permanent");
  assert.equal(normaliseCommandConfig(requireCommand("warn"), { defaultDuration: "7d" }).defaultDuration, "permanent");
  assert.equal(normaliseCommandConfig(requireCommand("timeout"), { defaultDuration: "7d" }).defaultDuration, "7d");
});

test("preset reasons are dropped where the command has no reason option", () => {
  const presets = [{ id: "p1", label: "سبام", duration: null }];
  assert.deepEqual(normaliseCommandConfig(requireCommand("clear"), { presetReasons: presets }).presetReasons, []);
  assert.equal(normaliseCommandConfig(requireCommand("ban"), { presetReasons: presets }).presetReasons.length, 1);
});

test("a preset duration is kept only for a command that can apply it", () => {
  const presets = [{ id: "p1", label: "سبام", duration: "30m" as const }];
  // `/ban` keeps the reason but cannot pair a length with it.
  assert.equal(normaliseCommandConfig(requireCommand("ban"), { presetReasons: presets }).presetReasons[0]!.duration, null);
  assert.equal(normaliseCommandConfig(requireCommand("timeout"), { presetReasons: presets }).presetReasons[0]!.duration, "30m");
});

/* ------------------------------------------------------------------ *
 * Clamping
 * ------------------------------------------------------------------ */

/**
 * `clampInteger` is exported because the dashboard's command editor calls it
 * directly on the values an operator types. It used to exist twice — once here
 * and once as a private copy in `commands.tsx` — with the *limits* imported from
 * this module and the *rule that applies them* re-implemented in the view. Two
 * copies of one rule is how the editor and the validator drift apart.
 *
 * It is asserted directly here so a change to the shared rule is caught at the
 * rule, not only through `normaliseCommandConfig`.
 */
test("clampInteger truncates, clamps, and never yields NaN", () => {
  assert.equal(clampInteger(12.9, 0, 100), 12, "a fraction truncates toward zero");
  assert.equal(clampInteger(-12.9, 0, 100), 0, "and the truncation happens before the floor");
  assert.equal(clampInteger(999, 0, 100), 100, "above the ceiling");
  assert.equal(clampInteger(-1, 0, 100), 0, "below the floor");
  assert.equal(clampInteger(50, 0, 100), 50, "inside the range, unchanged");

  // Anything that is not a usable number becomes the floor. `min` rather than
  // `NaN` matters: a `NaN` would be stored as a value the bot cannot parse.
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, "30", null, undefined, {}]) {
    assert.equal(clampInteger(bad, 0, 100), 0, `${String(bad)} is not a usable number`);
  }

  assert.ok(Number.isInteger(clampInteger(-0.4, 0, 100)), "the result is always a whole number");
});

test("the cooldown stays inside its declared bounds", () => {
  const timeout = requireCommand("timeout");
  assert.equal(normaliseCommandConfig(timeout, { cooldownSeconds: 30 }).cooldownSeconds, 30);
  assert.equal(normaliseCommandConfig(timeout, { cooldownSeconds: 99_999 }).cooldownSeconds, MAX_COOLDOWN_SECONDS);
  assert.equal(normaliseCommandConfig(timeout, { cooldownSeconds: -5 }).cooldownSeconds, 0);
  assert.equal(normaliseCommandConfig(timeout, { cooldownSeconds: 12.7 }).cooldownSeconds, 12);
  assert.equal(normaliseCommandConfig(timeout, { cooldownSeconds: Number.NaN }).cooldownSeconds, 0);
});

test("the auto-delete delay stays inside its declared bounds", () => {
  const warn = requireCommand("warn");
  assert.equal(normaliseCommandConfig(warn, { autoDeleteResponseSeconds: 15 }).autoDeleteResponseSeconds, 15);
  assert.equal(normaliseCommandConfig(warn, { autoDeleteResponseSeconds: 99_999 }).autoDeleteResponseSeconds, MAX_AUTO_DELETE_SECONDS);
  assert.equal(normaliseCommandConfig(warn, { autoDeleteResponseSeconds: -1 }).autoDeleteResponseSeconds, 0);
});

test("only real snowflakes survive in a scope, without duplicates", () => {
  const config = normaliseCommandConfig(requireCommand("ban"), {
    allowedRoleIds: ["123456789012345678", "not-a-role", "12345", "123456789012345678"],
    deniedChannelIds: ["999888777666555444", ""]
  });
  assert.deepEqual(config.allowedRoleIds, ["123456789012345678"]);
  assert.deepEqual(config.deniedChannelIds, ["999888777666555444"]);
});

test("a scope is capped so one command cannot carry an unbounded list", () => {
  const many = Array.from({ length: 60 }, (_, index) => String(100000000000000000n + BigInt(index)));
  assert.equal(normaliseCommandConfig(requireCommand("ban"), { allowedRoleIds: many }).allowedRoleIds.length, 25);
  assert.equal(normaliseCommandConfig(requireCommand("ban"), { allowedChannelIds: many }).allowedChannelIds.length, 25);
});

/* ------------------------------------------------------------------ *
 * Durations
 * ------------------------------------------------------------------ */

test("the duration list is the one the directive specifies", () => {
  assert.deepEqual(
    commandDurations.map(option => option.label),
    ["دائم", "5 دقائق", "30 دقيقة", "ساعة", "6 ساعات", "12 ساعة", "يوم", "3 أيام", "أسبوع", "أسبوعين", "شهر"]
  );
});

test("permanent is null rather than zero", () => {
  // Zero would read as "no duration" and collapse into a one-second action.
  assert.equal(durationSeconds("permanent"), null);
  assert.equal(durationSeconds("5m"), 300);
  assert.equal(durationSeconds("1h"), 3600);
  assert.equal(durationSeconds("30d"), 30 * 24 * 60 * 60);
});

test("a timeout's duration is capped at Discord's own limit", () => {
  // "شهر" is longer than Discord accepts. The stored value is left as chosen so
  // the operator's intent survives, and the number handed to Discord is capped.
  const timeout = requireCommand("timeout");
  assert.equal(commandDurationSeconds(timeout, "30d"), TIMEOUT_MAX_SECONDS);
  assert.equal(commandDurationSeconds(timeout, "1h"), 3600);
  assert.equal(TIMEOUT_MAX_SECONDS, 28 * 24 * 60 * 60);
});

test("a command without a duration reports none, whatever is stored", () => {
  assert.equal(commandDurationSeconds(requireCommand("ban"), "7d"), null);
  assert.equal(commandDurationSeconds(requireCommand("warn"), "7d"), null);
});

test("an unknown duration falls back to permanent instead of being stored", () => {
  const config = normaliseCommandConfig(requireCommand("timeout"), { defaultDuration: "forever" as never });
  assert.equal(config.defaultDuration, "permanent");
});

/* ------------------------------------------------------------------ *
 * Preset reasons
 * ------------------------------------------------------------------ */

test("a preset reason with no label is dropped rather than offered blank", () => {
  const config = normaliseCommandConfig(requireCommand("ban"), {
    presetReasons: [
      { id: "a", label: "  ", duration: null },
      { id: "b", label: "سبام", duration: null }
    ]
  });
  assert.deepEqual(config.presetReasons.map(preset => preset.label), ["سبام"]);
});

test("a missing or duplicated id is replaced, never left to collide", () => {
  // The id is what Discord echoes back, so two presets sharing one would be
  // indistinguishable once chosen.
  const config = normaliseCommandConfig(requireCommand("ban"), {
    presetReasons: [
      { id: "", label: "أول", duration: null },
      { id: "", label: "ثانٍ", duration: null },
      { id: "same", label: "ثالث", duration: null },
      { id: "same", label: "رابع", duration: null }
    ]
  });
  const ids = config.presetReasons.map(preset => preset.id);
  assert.equal(new Set(ids).size, ids.length, "every id is unique");
  assert.ok(ids.every(id => id.length > 0));
  assert.equal(config.presetReasons.length, 4, "no reason was lost to the repair");
});

test("the preset list is capped", () => {
  const many = Array.from({ length: MAX_PRESET_REASONS + 10 }, (_, index) => ({ id: `p${index}`, label: `سبب ${index}`, duration: null }));
  assert.equal(normaliseCommandConfig(requireCommand("ban"), { presetReasons: many }).presetReasons.length, MAX_PRESET_REASONS);
});

test("a long preset label is truncated to what Discord echoes", () => {
  const config = normaliseCommandConfig(requireCommand("ban"), { presetReasons: [{ id: "p", label: "س".repeat(200), duration: null }] });
  assert.ok(config.presetReasons[0]!.label.length <= 90);
});

/* ------------------------------------------------------------------ *
 * Scope evaluation
 * ------------------------------------------------------------------ */

const scopeConfig = (overrides: Partial<ReturnType<typeof defaultCommandConfig>> = {}) => ({
  ...defaultCommandConfig(requireCommand("ban")),
  ...overrides
});

test("an empty channel list means every channel", () => {
  const verdict = assessCommandScope(scopeConfig(), { roleIds: [], channelId: "c1" });
  assert.deepEqual(verdict, { allowed: true });
});

test("a channel outside the allowed list is refused", () => {
  const config = scopeConfig({ allowedChannelIds: ["c1", "c2"] });
  assert.deepEqual(assessCommandScope(config, { roleIds: [], channelId: "c1" }), { allowed: true });
  assert.deepEqual(assessCommandScope(config, { roleIds: [], channelId: "c9" }), { allowed: false, reason: "CHANNEL_NOT_ALLOWED" });
});

test("a denied role is refused even when its tier would allow it", () => {
  const config = scopeConfig({ deniedRoleIds: ["r-bad"] });
  assert.deepEqual(assessCommandScope(config, { roleIds: ["r-bad"], channelId: "c1" }), { allowed: false, reason: "ROLE_DENIED" });
  assert.deepEqual(assessCommandScope(config, { roleIds: ["r-ok"], channelId: "c1" }), { allowed: true });
});

test("a deny beats an allow, on roles and on channels alike", () => {
  // The whole point of a deny list is to carve an exception out of a broad rule.
  const config = scopeConfig({ allowedRoleIds: ["r-bad"], deniedRoleIds: ["r-bad"] });
  assert.deepEqual(assessCommandScope(config, { roleIds: ["r-bad"], channelId: "c1" }), { allowed: false, reason: "ROLE_DENIED" });

  const channels = scopeConfig({ allowedChannelIds: ["c1"], deniedChannelIds: ["c1"] });
  assert.deepEqual(assessCommandScope(channels, { roleIds: [], channelId: "c1" }), { allowed: false, reason: "CHANNEL_DENIED" });
});

/* ------------------------------------------------------------------ *
 * Cooldowns
 * ------------------------------------------------------------------ */

test("a cooldown counts down and then releases", () => {
  const cooldowns = new CommandCooldowns();
  const key = cooldownKey("g1", "ban", "u1");

  assert.equal(cooldowns.remainingSeconds(key, 1_000_000), 0, "nothing recorded yet");
  cooldowns.start(key, 60, 1_000_000);

  assert.equal(cooldowns.remainingSeconds(key, 1_000_000), 60);
  assert.equal(cooldowns.remainingSeconds(key, 1_030_000), 30);
  assert.equal(cooldowns.remainingSeconds(key, 1_060_000), 0, "the wait is over");
});

test("a cooldown of zero clears an existing wait instead of setting one", () => {
  const cooldowns = new CommandCooldowns();
  const key = cooldownKey("g1", "ban", "u1");
  cooldowns.start(key, 60, 1_000_000);
  cooldowns.start(key, 0, 1_000_000);
  assert.equal(cooldowns.remainingSeconds(key, 1_000_000), 0);
  assert.equal(cooldowns.size, 0);
});

test("cooldowns are per member, per command and per guild", () => {
  const cooldowns = new CommandCooldowns();
  cooldowns.start(cooldownKey("g1", "ban", "u1"), 60, 1_000_000);
  assert.equal(cooldowns.remainingSeconds(cooldownKey("g1", "ban", "u2"), 1_000_000), 0, "another member is unaffected");
  assert.equal(cooldowns.remainingSeconds(cooldownKey("g1", "kick", "u1"), 1_000_000), 0, "another command is unaffected");
  assert.equal(cooldowns.remainingSeconds(cooldownKey("g2", "ban", "u1"), 1_000_000), 0, "another guild is unaffected");
});

/* ------------------------------------------------------------------ *
 * The dashboard's view
 * ------------------------------------------------------------------ */

test("the flags carry the section and the capability switches", () => {
  const flags = commandFlagsFor(new Map());
  assert.equal(flags.length, commandRegistry.length);

  const timeout = flags.find(command => command.name === "timeout")!;
  assert.equal(timeout.category, "moderation");
  assert.equal(timeout.supportsDuration, true);
  assert.equal(timeout.supportsReason, true);
  assert.equal(timeout.supportsPurge, true);

  const status = flags.find(command => command.name === "al-status")!;
  assert.equal(status.category, "general");
  assert.equal(status.supportsReason, false);
  assert.equal(status.supportsDuration, false);
});

test("a stored configuration is joined to the registry without gaps", () => {
  const flags = commandFlagsFor(
    new Map([["ban", { enabled: false, cooldownSeconds: 45, deniedRoleIds: ["999888777666555444"] }]])
  );
  const ban = flags.find(command => command.name === "ban")!;
  assert.equal(ban.enabled, false);
  assert.equal(ban.cooldownSeconds, 45);
  assert.deepEqual(ban.deniedRoleIds, ["999888777666555444"]);
  assert.equal(ban.allowedLevel, "admin", "an untouched field keeps the registry default");
});
