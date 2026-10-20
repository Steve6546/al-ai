import test from "node:test";
import assert from "node:assert/strict";
import { allowedMentionsFor, createDiscordClient } from "../src/lib/discord.js";

/**
 * The bot's mention policy, checked against Discord's own rules.
 *
 * The rules that matter, from Discord's message documentation:
 *
 * - `allowed_mentions.parse` and `allowed_mentions.users` are **mutually
 *   exclusive** - sending both is a validation error.
 * - `parse: []` suppresses every mention.
 * - `users: [...]` (without `parse`) allows exactly those user ids, and only
 *   those that actually appear in the content.
 * - For a regular message, the default is `parse: ["users", "roles",
 *   "everyone"]` - every mention type is parsed.
 *
 * So the policy has to be stated as a whitelist, not as "users are fine":
 * `parse: ["users"]` would still let *any* user named in untrusted text be
 * notified by the bot.
 */
test("the client notifies nobody unless the message says who may", () => {
  const client = createDiscordClient();
  const allowed = client.options.allowedMentions as { parse?: readonly string[]; users?: readonly string[] } | undefined;

  assert.ok(allowed, "the client must carry an explicit mention policy");
  assert.deepEqual([...(allowed?.parse ?? [])], [], "no mention type is parsed by default");
  assert.equal(allowed?.users, undefined, "the default whitelist is empty, not a list of everyone");
});

test("a message may notify exactly the member it is about", () => {
  const allowed = allowedMentionsFor("111") as { users?: readonly string[]; parse?: readonly string[] };

  assert.deepEqual([...(allowed.users ?? [])], ["111"]);
  assert.equal(allowed.parse, undefined, "parse and users are mutually exclusive - Discord rejects both");
});

test("a message about two members may notify both", () => {
  const allowed = allowedMentionsFor("111", "222") as { users?: readonly string[] };
  assert.deepEqual([...(allowed.users ?? [])], ["111", "222"]);
});

test("a message about nobody notifies nobody", () => {
  const allowed = allowedMentionsFor() as { users?: readonly string[]; parse?: readonly string[] };
  assert.deepEqual([...(allowed.parse ?? [])], []);
  assert.equal(allowed.users, undefined);
});

test("an unknown id does not become a whitelist entry", () => {
  const allowed = allowedMentionsFor(null, undefined, "", "333") as { users?: readonly string[] };
  assert.deepEqual([...(allowed.users ?? [])], ["333"], "only the real id is listed");
});

test("no policy ever allows a role or @everyone", () => {
  const allowed = allowedMentionsFor("111") as { parse?: readonly string[]; users?: readonly string[]; roles?: readonly string[] };
  assert.ok(!(allowed.parse ?? []).includes("everyone"), "@everyone and @here must never be parsed");
  assert.ok(!(allowed.parse ?? []).includes("roles"), "a role mention must never be parsed");
  assert.equal(allowed.roles, undefined, "no role is ever on the whitelist");
});
