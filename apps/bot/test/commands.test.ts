import test from "node:test";
import assert from "node:assert/strict";
import { commandRegistry, defaultCommandConfig, normaliseCommandConfig, requireCommand } from "@al-ai/core";
import {
  buildAllCommands,
  CLEAR_MAX_COUNT,
  CLEAR_MIN_COUNT,
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
  const published = new Set(buildAllCommands().map(command => (command as { name: string }).name));
  const missing = commandRegistry.filter(command => !published.has(command.name)).map(command => command.name);
  assert.deepEqual(missing, [], "a registry entry with no builder would never be reachable");
});

test("nothing is published that is not in the registry", () => {
  const registered = new Set(commandRegistry.map(command => command.name));
  const extra = buildAllCommands()
    .map(command => (command as { name: string }).name)
    .filter(name => name !== "al-status" && !registered.has(name));
  assert.deepEqual(extra, [], "publishing an unregistered command is a governance violation");
});

test("moderation commands are hidden from everyone by default", () => {
  // Discord-side default permissions are 0; AL AI decides through its own tiers,
  // so a member without an AL AI role must not even see the command.
  for (const command of buildAllCommands()) {
    const name = (command as { name: string }).name;
    if (name === "al-status") continue;
    assert.equal((command as { default_member_permissions?: string }).default_member_permissions, "0", `${name} is hidden by default`);
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

test("a command that demands a reason marks the option required", () => {
  const published = new Map(
    buildAllCommands().map(command => [
      (command as { name: string }).name,
      command as { name: string; options?: { name: string; required?: boolean }[] }
    ])
  );

  for (const definition of commandRegistry) {
    const json = published.get(definition.name);
    const reason = (json?.options ?? []).find(option => option.name === "reason");
    if (definition.requiresReason) {
      assert.equal(reason?.required, true, `${definition.name} marks reason as required`);
    } else if (reason) {
      assert.notEqual(reason.required, true, `${definition.name} does not force a reason`);
    }
  }
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
    customRoleIds: ["123456789012345678", "not-a-role", "12345", "123456789012345678", 42 as unknown as string]
  });
  assert.deepEqual(config.customRoleIds, ["123456789012345678"], "unknown shapes are dropped and duplicates collapsed");
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
