import test from "node:test";
import assert from "node:assert/strict";
import { describeRoleFailure } from "../src/lib/discord.js";

/**
 * The role-setup warning has to be actionable.
 *
 * `ensureBotRole` used to be reported by printing the raw `DiscordAPIError`,
 * which produced a five-line discord.js stack on every boot for the one
 * condition the operator can actually fix. `describeRoleFailure` is the single
 * place that turns that error into a sentence, so these cases pin the sentence:
 * 50013 must name the missing permission, and anything else must keep Discord's
 * own message and code so an unfamiliar failure stays searchable.
 */

test("50013 names the missing permission and the fix", () => {
  const text = describeRoleFailure(Object.assign(new Error("Missing Permissions"), { code: 50013 }));
  assert.match(text, /50013/);
  assert.match(text, /Manage Roles/);
  assert.match(text, /re-invite/);
});

test("another Discord code keeps the code and Discord's own message", () => {
  const text = describeRoleFailure(Object.assign(new Error("Unknown Guild"), { code: 10004 }));
  assert.match(text, /10004/);
  assert.match(text, /Unknown Guild/);
});

test("a plain Error reports its message without inventing a code", () => {
  const text = describeRoleFailure(new Error("socket hang up"));
  assert.equal(text, "socket hang up");
});

test("a thrown non-error is still reported as text", () => {
  assert.equal(describeRoleFailure("boom"), "boom");
});
