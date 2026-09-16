import test from "node:test";
import assert from "node:assert/strict";
import {
  assessCommandScope,
  commandCategories,
  commandCategoryDescriptions,
  commandCategoryLabels,
  commandDurationSeconds,
  commandDurations,
  CommandCooldowns,
  clampInteger,
  commandFlagsFor,
  commandRegistry,
  cooldownKey,
  buildAliasMap,
  defaultCommandConfig,
  durationSeconds,
  isAdmittedByAllowList,
  isUsableAlias,
  MAX_ALIASES_PER_COMMAND,
  MAX_AUTO_DELETE_SECONDS,
  MAX_COOLDOWN_SECONDS,
  MAX_PRESET_REASONS,
  normaliseCommandConfig,
  requireCommand,
  resolveCommandDuration,
  TIMEOUT_MAX_SECONDS
} from "../src/command-registry.js";
import { discordPermissionLabels, DISCORD_PERMISSION_BITS } from "../src/discord-permissions.js";

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

test("the fourteen sections are the ones that exist, in render order", () => {
  assert.deepEqual(
    [...commandCategories],
    [
      "core",
      "penalties",
      "punishment-logs",
      "channel-management",
      "chat-tools",
      "voice",
      "role-management",
      "special-roles",
      "member-info",
      "bot-tools",
      "protection",
      "levels",
      "server-stats",
      "profile"
    ]
  );
  assert.equal(commandCategoryLabels.core, "الأوامر الأساسية");
  assert.equal(commandCategoryLabels.penalties, "العقوبات");
  assert.equal(commandCategoryLabels["chat-tools"], "أدوات الشات");
});

test("every section has a label and a description, including the empty ones", () => {
  // A section with no commands is still rendered, so a missing label would show
  // up as a blank row in the sidebar rather than as a build failure.
  for (const category of commandCategories) {
    assert.ok(commandCategoryLabels[category], `${category} has a label`);
    assert.ok(commandCategoryDescriptions[category], `${category} has a description`);
  }
});

test("the commands land in the section the directive names", () => {
  const categoryOf = (name: string) => requireCommand(name).category;
  for (const name of ["help", "commands", "settings", "dashboard", "al-status", "colors"]) {
    assert.equal(categoryOf(name), "core", name);
  }
  for (const name of ["ban", "unban", "kick", "timeout", "untimeout", "warn", "warns", "delwarn", "clearwarns", "setnick"]) {
    assert.equal(categoryOf(name), "penalties", name);
  }
  for (const name of ["clear", "lock", "unlock", "slowmode"]) {
    assert.equal(categoryOf(name), "chat-tools", name);
  }
});

test("the eleven sections with no commands really are empty", () => {
  // Pinned so a placeholder command cannot be slipped in later without this
  // test being changed deliberately: the brief forbids inventing commands, and
  // a count that quietly stops being zero is how that rule gets broken.
  const populated = new Set(commandRegistry.map(definition => definition.category));
  const empty = commandCategories.filter(category => !populated.has(category));
  assert.deepEqual(
    [...empty],
    [
      "punishment-logs",
      "channel-management",
      "voice",
      "role-management",
      "special-roles",
      "member-info",
      "bot-tools",
      "protection",
      "levels",
      "server-stats",
      "profile"
    ]
  );
});

test("the registry is exactly the twenty commands the bot publishes", () => {
  assert.deepEqual(
    [...commandRegistry].map(definition => definition.name).sort(),
    [
      "al-status",
      "ban",
      "clear",
      "clearwarns",
      "colors",
      "commands",
      "dashboard",
      "delwarn",
      "help",
      "kick",
      "lock",
      "setnick",
      "settings",
      "slowmode",
      "timeout",
      "unban",
      "unlock",
      "untimeout",
      "warn",
      "warns"
    ]
  );
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
    assert.deepEqual(config.allowedUserIds, [], definition.name);
    assert.deepEqual(config.deniedUserIds, [], definition.name);
    assert.deepEqual(config.presetReasons, [], definition.name);
    assert.equal(config.cooldownSeconds, 0, definition.name);
    assert.equal(config.autoDeleteResponseSeconds, 0, definition.name);
    assert.equal(config.defaultDuration, "permanent", definition.name);
    assert.equal(config.allowCustomReason, true, definition.name);
  }
});

test("a member scope is validated and capped exactly like a role scope", () => {
  const config = normaliseCommandConfig(requireCommand("ban"), {
    allowedUserIds: ["123456789012345678", "nope", "123456789012345678"],
    deniedUserIds: ["999888777666555444", ""]
  });
  assert.deepEqual(config.allowedUserIds, ["123456789012345678"], "a bad id is dropped and a repeat collapsed");
  assert.deepEqual(config.deniedUserIds, ["999888777666555444"]);

  const many = Array.from({ length: 60 }, (_, index) => String(100000000000000000n + BigInt(index)));
  assert.equal(normaliseCommandConfig(requireCommand("ban"), { allowedUserIds: many }).allowedUserIds.length, 25);
  assert.equal(normaliseCommandConfig(requireCommand("ban"), { deniedUserIds: many }).deniedUserIds.length, 25);
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

test("the custom-reason switch is dropped where there is no reason option", () => {
  // `/clear` publishes no reason option, so "may they type one?" is unanswerable
  // there — and a `false` would read as a restriction that does not exist.
  assert.equal(normaliseCommandConfig(requireCommand("clear"), { allowCustomReason: false }).allowCustomReason, true);
  assert.equal(normaliseCommandConfig(requireCommand("warn"), { allowCustomReason: false }).allowCustomReason, false);
});

test("the custom-reason switch defaults to allowing free text", () => {
  // On, because that is what the screen did before the switch existed. A default
  // that narrowed an existing behaviour would be a regression wearing a default's
  // clothes.
  assert.equal(defaultCommandConfig(requireCommand("warn")).allowCustomReason, true);
  assert.equal(normaliseCommandConfig(requireCommand("warn"), {}).allowCustomReason, true, "unset keeps the default");
  assert.equal(normaliseCommandConfig(requireCommand("warn"), { allowCustomReason: true }).allowCustomReason, true);
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
    ["دائم", "5 دقائق", "30 دقيقة", "ساعة", "6 ساعات", "12 ساعة", "يوم", "3 أيام", "أسبوع", "أسبوعين", "شهر", "مخصص — يجب كتابة مدة عند الاستخدام"]
  );
});

test("`custom` is a policy, not a length, and is not a second spelling of `permanent`", () => {
  // Both resolve to null seconds, so both end in "write a duration" — but they
  // differ on whether a preset reason's paired length may fill the gap, and that
  // difference is the only reason the option is worth having.
  assert.equal(durationSeconds("custom"), null);

  const presets = [{ id: "p", label: "سبام", duration: "1h" as const }];
  assert.equal(resolveCommandDuration({ defaultDuration: "permanent", presetReasons: presets }, "سبام"), "1h", "a preset fills in under دائم");
  assert.equal(resolveCommandDuration({ defaultDuration: "custom", presetReasons: presets }, "سبام"), "custom", "and is ignored under مخصص");

  const none = [{ id: "p", label: "سبام", duration: null }];
  assert.equal(resolveCommandDuration({ defaultDuration: "30m", presetReasons: none }, "سبام"), "30m", "the default fills in");
  assert.equal(resolveCommandDuration({ defaultDuration: "30m", presetReasons: presets }, "غير مطابق"), "30m", "an unmatched reason falls back");
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

/** A member with no roles, in channel `c1`. The shape most tests want. */
const member = (overrides: Partial<{ userId: string; roleIds: string[]; channelId: string }> = {}) => ({
  userId: "u1",
  roleIds: [] as string[],
  channelId: "c1",
  ...overrides
});

test("an empty channel list means every channel", () => {
  const verdict = assessCommandScope(scopeConfig(), member());
  assert.deepEqual(verdict, { allowed: true });
});

test("a channel outside the allowed list is refused", () => {
  const config = scopeConfig({ allowedChannelIds: ["c1", "c2"] });
  assert.deepEqual(assessCommandScope(config, member({ channelId: "c1" })), { allowed: true });
  assert.deepEqual(assessCommandScope(config, member({ channelId: "c9" })), { allowed: false, reason: "CHANNEL_NOT_ALLOWED" });
});

test("a denied role is refused even when its tier would allow it", () => {
  const config = scopeConfig({ deniedRoleIds: ["r-bad"] });
  assert.deepEqual(assessCommandScope(config, member({ roleIds: ["r-bad"] })), { allowed: false, reason: "ROLE_DENIED" });
  assert.deepEqual(assessCommandScope(config, member({ roleIds: ["r-ok"] })), { allowed: true });
});

test("a denied member is refused, and is named as such rather than by role", () => {
  // The narrowest statement an operator can make, so it is reported first: being
  // told "one of your roles is excluded" when the operator excluded *you* would
  // send them looking in the wrong place.
  const config = scopeConfig({ deniedUserIds: ["u-bad"], deniedRoleIds: ["r-bad"] });
  assert.deepEqual(assessCommandScope(config, member({ userId: "u-bad", roleIds: ["r-bad"] })), {
    allowed: false,
    reason: "USER_DENIED"
  });
  assert.deepEqual(assessCommandScope(config, member({ userId: "u-ok" })), { allowed: true });
});

test("a deny beats an allow, on people, roles and channels alike", () => {
  // The whole point of a deny list is to carve an exception out of a broad rule.
  const config = scopeConfig({ allowedRoleIds: ["r-bad"], deniedRoleIds: ["r-bad"] });
  assert.deepEqual(assessCommandScope(config, member({ roleIds: ["r-bad"] })), { allowed: false, reason: "ROLE_DENIED" });

  // A member allowed by name and barred by name is barred.
  const byName = scopeConfig({ allowedUserIds: ["u1"], deniedUserIds: ["u1"] });
  assert.deepEqual(assessCommandScope(byName, member({ userId: "u1" })), { allowed: false, reason: "USER_DENIED" });

  const channels = scopeConfig({ allowedChannelIds: ["c1"], deniedChannelIds: ["c1"] });
  assert.deepEqual(assessCommandScope(channels, member({ channelId: "c1" })), { allowed: false, reason: "CHANNEL_DENIED" });
});

test("the allow-lists admit a member, by name or by role", () => {
  const config = scopeConfig({ allowedRoleIds: ["r-helper"], allowedUserIds: ["u-trusted"] });
  assert.equal(isAdmittedByAllowList(config, member({ userId: "u-trusted" })), true, "by name");
  assert.equal(isAdmittedByAllowList(config, member({ roleIds: ["r-helper"] })), true, "by role");
  assert.equal(isAdmittedByAllowList(config, member({ userId: "u-other", roleIds: ["r-other"] })), false, "neither");
});

test("an empty allow-list admits nobody, rather than everybody", () => {
  // The list is an escape hatch *on top of* the tier gate, so empty has to mean
  // "nobody extra" — reading it as "everybody" would open every command.
  assert.equal(isAdmittedByAllowList(scopeConfig(), member()), false);
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
  assert.equal(timeout.category, "penalties");
  assert.equal(timeout.supportsDuration, true);
  assert.equal(timeout.supportsReason, true);
  assert.equal(timeout.supportsPurge, true);

  const status = flags.find(command => command.name === "al-status")!;
  assert.equal(status.category, "core");
  assert.equal(status.supportsReason, false);
  assert.equal(status.supportsDuration, false);
});

test("every declared permission is a real bit with an Arabic name", () => {
  // The badge is the replacement for the tier dropdown, so a command that names
  // a permission the operator cannot read would be a worse control than the one
  // it replaced. Both halves are asserted: the bit exists, and it is named.
  for (const definition of commandRegistry) {
    const bit = definition.requiredPermission;
    if (!bit) continue;
    assert.ok(DISCORD_PERMISSION_BITS[bit] !== undefined, `${definition.name} names a real Discord bit`);
    assert.ok(discordPermissionLabels[bit], `${bit} has an Arabic name`);
  }
});

test("a permission is surfaced on the flag and absent where there is none", () => {
  const flags = commandFlagsFor(new Map());
  assert.equal(flags.find(command => command.name === "ban")!.requiredPermission, "BAN_MEMBERS");
  assert.equal(flags.find(command => command.name === "kick")!.requiredPermission, "KICK_MEMBERS");
  assert.equal(flags.find(command => command.name === "untimeout")!.requiredPermission, "MODERATE_MEMBERS");

  // Absent, not `undefined`: the dashboard reads the absence as "every member
  // may run this", and an explicit undefined key would be a different shape.
  assert.equal("requiredPermission" in flags.find(command => command.name === "help")!, false);
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

/* ------------------------------------------------------------------ *
 * Aliases
 *
 * Discord has no alias mechanism whatsoever. `/باند` exists only because a
 * command *named* `باند` was published. That makes the alias charset the whole
 * contract: one name Discord rejects fails the entire registration request and
 * takes every well-formed command down with it.
 * ------------------------------------------------------------------ */

test("the alias charset accepts Arabic and Thai names", () => {
  // The Arabic case is the reason this is not `\w`: an alias an Arabic-speaking
  // operator types is the normal case here, not the exotic one.
  assert.equal(isUsableAlias("باند"), true);
  assert.equal(isUsableAlias("طرد"), true);
  assert.equal(isUsableAlias("ban"), true);
  assert.equal(isUsableAlias("time-out"), true);
  assert.equal(isUsableAlias("time_out"), true);
  assert.equal(isUsableAlias("x".repeat(32)), true, "32 is Discord's ceiling, inclusive");
});

test("the charset survives characters that are not letters at all", () => {
  // U+0E31 is a Thai combining vowel sign, and it is *not* `\p{L}` — so a
  // `\p{L}`-only class would reject a legal Thai name. The script classes are
  // load-bearing, not decoration.
  assert.equal(isUsableAlias("\u0e31"), true, "a Thai combining mark is not \\p{L} but is still legal");
  assert.equal(isUsableAlias("\u093f"), true, "so is a Devanagari vowel sign");
  assert.equal(/^\p{L}$/u.test("\u0e31"), false, "and \\p{L} alone really would have rejected it");
});

test("the alias charset is spelled the way JavaScript can parse it", () => {
  // Discord documents the pattern as `\p{Devanagari}`, which is Rust's regex
  // crate. A bare script name is a **syntax error** in an ECMAScript regex: it
  // throws while the module is loading, so every importer dies with it and no
  // assertion in this file ever gets the chance to run. ECMAScript needs the
  // explicit `Script=` prefix.
  //
  // Reaching this line at all proves the module parsed, which is precisely the
  // guarantee that was missing: the whole suite failed at import, not on an
  // expectation.
  assert.equal(isUsableAlias("ก"), true);
  assert.equal(isUsableAlias("क"), true);
});

test("the alias charset refuses what Discord refuses", () => {
  assert.equal(isUsableAlias("BAN"), false, "an ASCII uppercase letter is rejected outright");
  assert.equal(isUsableAlias("a b"), false, "no spaces");
  assert.equal(isUsableAlias("x".repeat(33)), false, "33 characters is one too many");
  assert.equal(isUsableAlias(""), false);
  assert.equal(isUsableAlias("  "), false, "whitespace is not a name");
  assert.equal(isUsableAlias("b🎉"), false, "an emoji is not in the charset");
  assert.equal(isUsableAlias(42), false);
  assert.equal(isUsableAlias(null), false);
  assert.equal(isUsableAlias(undefined), false);
});

test("aliases default to none and are normalised on the way in", () => {
  const ban = requireCommand("ban");
  assert.deepEqual(defaultCommandConfig(ban).aliases, [], "no aliases unless asked for");

  const config = normaliseCommandConfig(ban, {
    aliases: ["  باند  ", "BAN", "باند", "", "ban-2", 42]
  });
  assert.deepEqual(config.aliases, ["باند", "ban-2"], "trimmed, validated, deduplicated");
});

test("an alias that shadows a real command is dropped rather than kept", () => {
  // `kick` is a published command. An alias `kick` on `/ban` could never fire,
  // so storing it would be a setting that silently does nothing.
  const config = normaliseCommandConfig(requireCommand("ban"), { aliases: ["kick", "باند"] });
  assert.deepEqual(config.aliases, ["باند"], "the shadowing alias is gone, the usable one stays");
});

test("aliases are capped at the declared maximum", () => {
  const many = Array.from({ length: MAX_ALIASES_PER_COMMAND + 4 }, (_, index) => `a${index}`);
  const config = normaliseCommandConfig(requireCommand("ban"), { aliases: many });
  assert.equal(config.aliases.length, MAX_ALIASES_PER_COMMAND);
  assert.deepEqual(config.aliases, many.slice(0, MAX_ALIASES_PER_COMMAND), "the first ones win");
});

test("a non-array aliases value becomes an empty list rather than throwing", () => {
  for (const value of [null, undefined, "باند", 7, {}]) {
    assert.deepEqual(normaliseCommandConfig(requireCommand("ban"), { aliases: value }).aliases, []);
  }
});

test("the alias map resolves an alias to its canonical command", () => {
  const { map, dropped } = buildAliasMap([
    { name: "ban", aliases: ["باند", "حظر"] },
    { name: "kick", aliases: ["طرد"] }
  ]);
  assert.equal(map.get("باند"), "ban");
  assert.equal(map.get("حظر"), "ban");
  assert.equal(map.get("طرد"), "kick");
  assert.equal(map.has("ban"), false, "a real command is not an alias of itself");
  assert.deepEqual(dropped, []);
});

test("an alias that shadows a published command is reported, not silently dropped", () => {
  const { map, dropped } = buildAliasMap([{ name: "ban", aliases: ["kick"] }]);
  assert.equal(map.size, 0);
  assert.deepEqual(dropped, [{ alias: "kick", command: "ban", reason: "shadows-command" }]);
});

test("the first command to claim an alias keeps it, and the loser is reported", () => {
  const { map, dropped } = buildAliasMap([
    { name: "ban", aliases: ["حظر"] },
    { name: "kick", aliases: ["حظر"] }
  ]);
  assert.equal(map.get("حظر"), "ban", "first claim wins");
  assert.deepEqual(dropped, [{ alias: "حظر", command: "kick", reason: "duplicate" }]);
});

test("a command with no aliases contributes nothing to the map", () => {
  const { map, dropped } = buildAliasMap([{ name: "ban" }, { name: "kick", aliases: [] }]);
  assert.equal(map.size, 0);
  assert.deepEqual(dropped, []);
});

/* ------------------------------------------------------------------ *
 * Delete-on-leave
 * ------------------------------------------------------------------ */

test("delete-on-leave is off unless asked for", () => {
  const ban = requireCommand("ban");
  assert.equal(defaultCommandConfig(ban).deleteResponseOnLeave, false, "off by default");
  assert.equal(normaliseCommandConfig(ban, {}).deleteResponseOnLeave, false);
  assert.equal(normaliseCommandConfig(ban, { deleteResponseOnLeave: true }).deleteResponseOnLeave, true);
});

test("delete-on-leave is refused on a command that has no member to leave", () => {
  // `/clear` acts on a channel. There is no member whose departure could ever
  // trigger the deletion, so honouring the flag would be a switch that does
  // nothing — the exact defect normalisation exists to prevent.
  const clear = requireCommand("clear");
  assert.equal(clear.target, "none");
  assert.equal(normaliseCommandConfig(clear, { deleteResponseOnLeave: true }).deleteResponseOnLeave, false);
});

test("delete-on-leave survives only on member-targeted commands", () => {
  for (const definition of commandRegistry) {
    const config = normaliseCommandConfig(definition, { deleteResponseOnLeave: true });
    assert.equal(
      config.deleteResponseOnLeave,
      definition.target === "member",
      `${definition.name} (target: ${definition.target})`
    );
  }
});
