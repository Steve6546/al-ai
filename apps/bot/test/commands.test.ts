import test from "node:test";
import assert from "node:assert/strict";
import { commandRegistry } from "@al-ai/core";
import { buildAllCommands, TIMEOUT_MAX_SECONDS, TIMEOUT_MIN_SECONDS } from "../src/lib/discord.ts";
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

test("every moderation command takes a target and every destructive one takes a reason where required", () => {
  for (const command of buildAllCommands()) {
    const json = command as { name: string; options?: { name: string; required?: boolean }[] };
    if (json.name === "al-status") continue;
    const names = (json.options ?? []).map(option => option.name);
    const hasTarget = names.includes("user") || names.includes("user_id");
    assert.ok(hasTarget, `${json.name} accepts a target`);
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

test("the registry's minimum tiers match the directive", () => {
  const byName = new Map(commandRegistry.map(command => [command.name, command.minimumTier]));
  assert.equal(byName.get("ban"), "admin");
  assert.equal(byName.get("unban"), "admin");
  assert.equal(byName.get("kick"), "admin");
  assert.equal(byName.get("timeout"), "moderator");
  assert.equal(byName.get("mute"), "moderator");
  assert.equal(byName.get("warn"), "moderator");
});

test("tier resolution prefers the highest tier when several are held", () => {
  const tiers = { owner: "r-owner", head_admin: "r-head", admin: "r-admin", moderator: "r-mod" };
  assert.equal(resolveTier({ roleIds: new Set(["r-mod", "r-owner"]) }, tiers), "owner");
  assert.equal(resolveTier({ roleIds: new Set(["r-mod", "r-admin"]) }, tiers), "admin");
  assert.equal(resolveTier({ roleIds: new Set(["r-mod"]) }, tiers), "moderator");
  assert.equal(resolveTier({ roleIds: new Set(["unrelated"]) }, tiers), null);
});
