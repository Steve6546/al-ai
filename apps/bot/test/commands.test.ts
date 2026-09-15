import test from "node:test";
import assert from "node:assert/strict";
import { commandRegistry, defaultCommandConfig, normaliseCommandConfig, requireCommand } from "@al-ai/core";
import {
  buildAllCommands,
  CLEAR_MAX_COUNT,
  CLEAR_MIN_COUNT,
  compareCommandRegistry,
  SLOWMODE_MAX_SECONDS,
  TIMEOUT_MAX_SECONDS,
  TIMEOUT_MIN_SECONDS
} from "../src/lib/discord.ts";
import { checkHierarchy, hierarchyMessages, resolveTier, type HierarchyInput } from "../src/permissions/permission-guard.ts";

/* ------------------------------------------------------------------ *
 * Role hierarchy — required by the directive before any Discord call
 * ------------------------------------------------------------------ */

const base: HierarchyInput = {
  actorId: "actor",
  targetId: "target",
  actorHighestPosition: 10,
  targetHighestPosition: 5,
  botHighestPosition: 20,
  actorIsGuildOwner: false,
  targetIsGuildOwner: false
};

test("a well-ordered action is allowed", () => {
  assert.deepEqual(checkHierarchy(base), { allowed: true });
});

test("nobody can act on themselves", () => {
  const outcome = checkHierarchy({ ...base, targetId: "actor" });
  assert.equal(outcome.allowed, false);
  assert.equal(outcome.allowed === false && outcome.reason, "SELF_TARGET");
});

test("nobody can act on the guild owner", () => {
  const outcome = checkHierarchy({ ...base, targetIsGuildOwner: true });
  assert.equal(outcome.allowed === false && outcome.reason, "TARGET_IS_OWNER");
});

test("an actor must sit strictly above the target", () => {
  const equal = checkHierarchy({ ...base, actorHighestPosition: 5 });
  assert.equal(equal.allowed === false && equal.reason, "ACTOR_NOT_ABOVE_TARGET");

  const below = checkHierarchy({ ...base, actorHighestPosition: 3 });
  assert.equal(below.allowed === false && below.reason, "ACTOR_NOT_ABOVE_TARGET");
});

test("the bot must sit strictly above the target even when the actor is higher", () => {
  const outcome = checkHierarchy({ ...base, botHighestPosition: 5 });
  assert.equal(outcome.allowed === false && outcome.reason, "BOT_NOT_ABOVE_TARGET");
});

test("the guild owner is not restricted by the actor-vs-target rule", () => {
  const outcome = checkHierarchy({ ...base, actorIsGuildOwner: true, actorHighestPosition: 1 });
  assert.deepEqual(outcome, { allowed: true });
});

test("the guild owner is still blocked by the bot's own position", () => {
  const outcome = checkHierarchy({ ...base, actorIsGuildOwner: true, botHighestPosition: 1 });
  assert.equal(outcome.allowed === false && outcome.reason, "BOT_NOT_ABOVE_TARGET");
});

test("every hierarchy reason has operator-facing wording", () => {
  for (const reason of ["SELF_TARGET", "TARGET_IS_OWNER", "ACTOR_NOT_ABOVE_TARGET", "BOT_NOT_ABOVE_TARGET"] as const) {
    assert.equal(typeof hierarchyMessages[reason], "string");
    assert.ok(hierarchyMessages[reason].length > 0, `${reason} has a message`);
  }
});

/* ------------------------------------------------------------------ *
 * Command contract — GOVERNANCE rule 1
 * ------------------------------------------------------------------ */

test("every registered command is actually published to Discord", () => {
  const { missing } = compareCommandRegistry();
  assert.deepEqual(missing, [], "a registry entry with no builder would never be reachable");
});

test("nothing is published that is not in the registry", () => {
  const { extra } = compareCommandRegistry();
  assert.deepEqual(extra, [], "publishing an unregistered command is a governance violation");
});

test("the parity comparison detects a mismatch in both directions", () => {
  // The comparison is the guard, so it gets the same treatment as everything
  // else here: hand it a set that is wrong both ways and confirm it says so.
  // Without this, a comparison that always returned empty lists would satisfy
  // both tests above while guarding nothing.
  const commands = buildAllCommands();
  const doctored = [
    ...commands.filter(command => (command as { name: string }).name !== "ban"),
    { name: "not-a-command" }
  ];

  const { missing, extra } = compareCommandRegistry(doctored);

  assert.deepEqual(missing, ["ban"], "a registered command missing from the published set");
  assert.deepEqual(extra, ["not-a-command"], "a published command absent from the registry");
});

test("commands are hidden from everyone by default, except the informational core four", () => {
  // Discord-side default permissions are 0; AL AI decides through its own tiers,
  // so a member without an AL AI role must not even see a command that punishes
  // somebody. The exceptions are the commands that only ever answer a question:
  // a help command nobody can see is a missing feature rather than a gate, and a
  // new member would have no way to learn what the bot does.
  const visibleByDesign = new Set(["al-status", "help", "commands", "dashboard", "colors"]);

  for (const command of buildAllCommands()) {
    const name = (command as { name: string }).name;
    const permissions = (command as { default_member_permissions?: string }).default_member_permissions;
    if (visibleByDesign.has(name)) {
      assert.equal(permissions, undefined, `${name} stays visible so it can be discovered`);
      continue;
    }
    assert.equal(permissions, "0", `${name} is hidden by default`);
  }
});

test("every informational command is in the core section", () => {
  // Pins the split above to the registry rather than to a list of names: a new
  // command that publishes itself to everyone has to be declared `core`, which
  // is where an operator looks to find out why it is visible.
  for (const name of ["help", "commands", "dashboard", "colors", "al-status"]) {
    assert.equal(requireCommand(name).category, "core", `${name} is a core command`);
  }
});

test("every command that acts on a member accepts a target, and channel commands do not", () => {
  const published = new Map(
    buildAllCommands().map(command => [
      (command as { name: string }).name,
      command as { name: string; options?: { name: string; required?: boolean }[] }
    ])
  );

  for (const definition of commandRegistry) {
    const json = published.get(definition.name);
    assert.ok(json, `${definition.name} is published`);
    const names = (json.options ?? []).map(option => option.name);

    if (definition.target === "member") {
      const hasTarget = names.includes("user") || names.includes("user_id");
      assert.ok(hasTarget, `${definition.name} accepts a member target`);
    } else {
      // A channel command acts on the channel it is typed in. Accepting a user
      // option would suggest it punishes someone, which it does not.
      assert.ok(!names.includes("user"), `${definition.name} takes no member target`);
    }
  }
});

test("the reason option is never hard-required, so the guild's setting decides", () => {
  // Discord freezes `required` at registration time, but the operator can flip
  // «السبب مطلوب» at any moment. A hard-required option would make turning the
  // requirement OFF impossible — a switch that only works in one direction.
  // The bot enforces the requirement instead, from the guild's configuration.
  const published = new Map(
    buildAllCommands().map(command => [
      (command as { name: string }).name,
      command as { name: string; options?: { name: string; required?: boolean; autocomplete?: boolean }[] }
    ])
  );

  for (const definition of commandRegistry) {
    const reason = (published.get(definition.name)?.options ?? []).find(option => option.name === "reason");
    if (!definition.supportsReason) {
      assert.equal(reason, undefined, `${definition.name} publishes no reason option`);
      continue;
    }
    assert.notEqual(reason?.required, true, `${definition.name} leaves the reason optional for Discord`);
    // Autocomplete is how the operator's ready-made reasons reach Discord
    // without re-registering the command.
    assert.equal(reason?.autocomplete, true, `${definition.name} offers preset reasons`);
  }
});

test("the registry's shipped reason requirement is preserved as a default", () => {
  assert.equal(requireCommand("warn").requiresReason, true, "warn still demands a reason by default");
  assert.equal(defaultCommandConfig(requireCommand("warn")).requireReason, true);
  assert.equal(defaultCommandConfig(requireCommand("ban")).requireReason, false);
});

test("/al-status is an ordinary registered command", () => {
  // It used to be answered before the configuration pipeline ran, which made its
  // switch, cooldown and scopes impossible to honour.
  const definition = requireCommand("al-status");
  assert.equal(definition.category, "core");
  assert.equal(definition.target, "none");
  assert.equal(definition.minimumTier, "moderator");
});

test("every command in the registry is published, and every published command is registered", () => {
  // The parity the deploy script enforces at run time, asserted here so a
  // mismatch fails the build rather than the next deployment.
  const registered = commandRegistry.map(command => command.name).sort();
  const published = buildAllCommands()
    .map(command => (command as { name: string }).name)
    .sort();
  assert.deepEqual(published, registered);
});

test("the two new penalty commands publish the options their handlers read", () => {
  const published = new Map(
    buildAllCommands().map(command => [
      (command as { name: string }).name,
      (command as { options?: { name: string; required?: boolean; type: number }[] }).options ?? []
    ])
  );

  // `/delwarn` resolves a warning by the number `/warns` printed, so the option
  // has to exist and has to be required — without it the handler reads `index 0`
  // and deletes nothing while reporting success.
  const delwarn = published.get("delwarn")!;
  assert.equal(delwarn.find(option => option.name === "index")?.required, true);

  // `/setnick` leaves the nickname optional on purpose: absent means "clear it",
  // which is the only useful reading of a rename with no new name.
  const setnick = published.get("setnick")!;
  assert.notEqual(setnick.find(option => option.name === "nickname")?.required, true);
  assert.ok(setnick.some(option => option.name === "nickname"), "the nickname option is published");

  // `/untimeout` takes a target and a reason and nothing else.
  assert.deepEqual(
    published.get("untimeout")!.map(option => option.name).sort(),
    ["reason", "user"]
  );
});

test("the timeout duration stays inside Discord's accepted range", () => {
  const timeout = buildAllCommands().find(command => (command as { name: string }).name === "timeout") as
    | { options: { name: string; min_value?: number; max_value?: number }[] }
    | undefined;
  const minutes = timeout?.options.find(option => option.name === "minutes");
  assert.ok(minutes, "timeout takes a duration");
  assert.equal(minutes!.min_value, 1);
  assert.equal(minutes!.max_value, TIMEOUT_MAX_SECONDS / 60);
  assert.equal(TIMEOUT_MAX_SECONDS, 28 * 24 * 60 * 60, "Discord caps a timeout at 28 days");
  assert.equal(TIMEOUT_MIN_SECONDS, 60);
});

test("the clear and slowmode bounds stay inside what Discord accepts", () => {
  const published = new Map(
    buildAllCommands().map(command => [
      (command as { name: string }).name,
      command as { options: { name: string; min_value?: number; max_value?: number }[] }
    ])
  );

  const count = published.get("clear")!.options.find(option => option.name === "count");
  assert.equal(count?.min_value, CLEAR_MIN_COUNT);
  assert.equal(count?.max_value, CLEAR_MAX_COUNT);
  assert.ok(CLEAR_MAX_COUNT <= 100, "Discord's bulk delete endpoint refuses more than 100");

  const seconds = published.get("slowmode")!.options.find(option => option.name === "seconds");
  assert.equal(seconds?.min_value, 0, "zero switches slowmode off");
  assert.equal(seconds?.max_value, SLOWMODE_MAX_SECONDS);
  assert.equal(SLOWMODE_MAX_SECONDS, 6 * 60 * 60, "Discord caps slowmode at six hours");
});

test("the registry's minimum tiers match the directive", () => {
  const byName = new Map(commandRegistry.map(command => [command.name, command.minimumTier]));
  assert.equal(byName.get("ban"), "admin");
  assert.equal(byName.get("unban"), "admin");
  assert.equal(byName.get("kick"), "admin");
  assert.equal(byName.get("clearwarns"), "admin");
  assert.equal(byName.get("lock"), "admin");
  assert.equal(byName.get("unlock"), "admin");
  assert.equal(byName.get("timeout"), "moderator");
  assert.equal(byName.get("warn"), "moderator");
  assert.equal(byName.get("warns"), "moderator");
  assert.equal(byName.get("clear"), "moderator");
  assert.equal(byName.get("slowmode"), "moderator");
});

test("/mute is retired: a native timeout replaces it", () => {
  // Keeping both would leave two commands that silence a member, and the weaker
  // one would inevitably be the one people reached for.
  assert.equal(commandRegistry.some(command => command.name === "mute"), false);
  assert.equal(buildAllCommands().some(command => (command as { name: string }).name === "mute"), false);
  assert.ok(commandRegistry.some(command => command.name === "timeout"));
});

test("tier resolution prefers the highest tier when several are held", () => {
  const roles = { adminRoleIds: ["r-admin"], moderatorRoleIds: ["r-mod"] };
  assert.equal(resolveTier({ roleIds: new Set(["r-mod", "r-admin"]) }, roles), "admin");
  assert.equal(resolveTier({ roleIds: new Set(["r-mod"]) }, roles), "moderator");
  assert.equal(resolveTier({ roleIds: new Set(["unrelated"]) }, roles), null);
});

test("a guild owner or Administrator holds the top tier without any mapping", () => {
  const none = { adminRoleIds: [], moderatorRoleIds: [] };
  assert.equal(resolveTier({ roleIds: new Set(), isGuildOwner: true }, none), "owner");
  assert.equal(resolveTier({ roleIds: new Set(), isAdministrator: true }, none), "owner");
});

/* ------------------------------------------------------------------ *
 * Per-command configuration
 * ------------------------------------------------------------------ */

test("an untouched command resolves to its registry defaults", () => {
  const definition = requireCommand("ban");
  assert.deepEqual(normaliseCommandConfig(definition, undefined), defaultCommandConfig(definition));
  assert.deepEqual(normaliseCommandConfig(definition, {}), defaultCommandConfig(definition));
});

test("a DM is off until the operator turns it on", () => {
  // Messaging a member is an external action; it should be an opt-in, not a
  // surprise that appears after a punishment.
  for (const definition of commandRegistry) {
    assert.equal(defaultCommandConfig(definition).dmOnAction, false, `${definition.name} defaults to no DM`);
  }
});

test("a control the command does not support is dropped, not stored and ignored", () => {
  // `/warn` has no purge: storing a day count would be a switch that does nothing.
  const warn = normaliseCommandConfig(requireCommand("warn"), { deleteMessageDays: 5, dmOnAction: true });
  assert.equal(warn.deleteMessageDays, 0, "warn keeps no purge setting");
  assert.equal(warn.dmOnAction, true, "warn does support a DM");

  // `/clear` is a channel command with neither control.
  const clear = normaliseCommandConfig(requireCommand("clear"), { deleteMessageDays: 5, dmOnAction: true });
  assert.equal(clear.deleteMessageDays, 0);
  assert.equal(clear.dmOnAction, false);
});

test("the purge window is clamped to what Discord accepts", () => {
  const definition = requireCommand("ban");
  assert.equal(normaliseCommandConfig(definition, { deleteMessageDays: 99 }).deleteMessageDays, 7);
  assert.equal(normaliseCommandConfig(definition, { deleteMessageDays: -3 }).deleteMessageDays, 0);
  assert.equal(normaliseCommandConfig(definition, { deleteMessageDays: 3.7 }).deleteMessageDays, 3);
  assert.equal(normaliseCommandConfig(definition, { deleteMessageDays: Number.NaN }).deleteMessageDays, 0);
});

test("only real snowflake role IDs survive normalisation", () => {
  const definition = requireCommand("warn");
  const config = normaliseCommandConfig(definition, {
    allowedRoleIds: ["123456789012345678", "not-a-role", "12345", "123456789012345678", 42 as unknown as string]
  });
  assert.deepEqual(config.allowedRoleIds, ["123456789012345678"], "unknown shapes are dropped and duplicates collapsed");
});

test("an invalid tier falls back to the registry value rather than being stored", () => {
  const definition = requireCommand("kick");
  const config = normaliseCommandConfig(definition, { allowedLevel: "superuser" as never });
  assert.equal(config.allowedLevel, "admin");
});

test("every command can be configured without throwing", () => {
  for (const definition of commandRegistry) {
    const config = normaliseCommandConfig(definition, { enabled: false, deleteMessageDays: 2, dmOnAction: true });
    assert.equal(config.name, definition.name);
    assert.equal(config.enabled, false);
  }
});
