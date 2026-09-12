import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CUSTOMIZATION, type CustomizationSettings } from "@al-ai/core";
import { createCustomizationSync, type GuildAppearance } from "../src/runtime/customization-sync.ts";

/**
 * The customization screen writes the bot's per-guild identity to the database,
 * but only the bot can apply it to Discord. These tests cover the decision logic
 * without touching Discord.
 *
 * The important property is not "a nickname is applied" but "the whole
 * appearance is applied, and a change to any one of its three fields is noticed".
 * A sync that only watched the nickname is what let a saved role colour sit in
 * the database with no effect.
 */

const appearance = (patch: Partial<CustomizationSettings> = {}): CustomizationSettings => ({
  ...DEFAULT_CUSTOMIZATION,
  ...patch
});

function harness(appearances: Record<string, GuildAppearance>, failFor: string[] = []) {
  const applied: { guildId: string; appearance: GuildAppearance }[] = [];
  const errors: string[] = [];
  const sync = createCustomizationSync({
    guildIds: () => Object.keys(appearances),
    loadAppearance: async guildId => appearances[guildId] ?? appearance(),
    applyAppearance: async (guildId, value) => {
      if (failFor.includes(guildId)) throw new Error("missing permission");
      applied.push({ guildId, appearance: value });
      return true;
    },
    onError: (guildId, error) => errors.push(`${guildId}:${(error as Error).message}`)
  });
  return { sync, applied, errors };
}

test("a saved nickname is applied to Discord", async () => {
  const { sync, applied } = harness({ g1: appearance({ nickname: "AL AI" }) });
  await sync.run();
  assert.deepEqual(applied, [{ guildId: "g1", appearance: appearance({ nickname: "AL AI" }) }]);
});

test("an unchanged appearance is not re-sent on the next tick", async () => {
  const { sync, applied } = harness({ g1: appearance({ nickname: "AL AI" }) });
  await sync.run();
  await sync.run();
  await sync.run();
  assert.equal(applied.length, 1, "Discord is not spammed with an identical value");
});

test("a changed nickname is applied again", async () => {
  const appearances: Record<string, GuildAppearance> = { g1: appearance({ nickname: "AL AI" }) };
  const applied: string[] = [];
  const sync = createCustomizationSync({
    guildIds: () => ["g1"],
    loadAppearance: async () => appearances.g1,
    applyAppearance: async (_guildId, value) => {
      applied.push(value.nickname);
      return true;
    }
  });

  await sync.run();
  appearances.g1 = appearance({ nickname: "AL AI — الإدارة" });
  await sync.run();
  assert.deepEqual(applied, ["AL AI", "AL AI — الإدارة"]);
});

test("changing only the role colour is still detected as a change", async () => {
  const appearances: Record<string, GuildAppearance> = { g1: appearance({ nickname: "AL AI" }) };
  const applied: string[] = [];
  const sync = createCustomizationSync({
    guildIds: () => ["g1"],
    loadAppearance: async () => appearances.g1,
    applyAppearance: async (_guildId, value) => {
      applied.push(value.roleColor ?? "none");
      return true;
    }
  });

  await sync.run();
  appearances.g1 = appearance({ nickname: "AL AI", roleColor: "#3b82f6" });
  await sync.run();
  await sync.run();

  assert.deepEqual(applied, ["none", "#3b82f6"], "the colour change is applied exactly once");
});

test("changing only the role icon is still detected as a change", async () => {
  const appearances: Record<string, GuildAppearance> = { g1: appearance() };
  const applied: string[] = [];
  const sync = createCustomizationSync({
    guildIds: () => ["g1"],
    loadAppearance: async () => appearances.g1,
    applyAppearance: async (_guildId, value) => {
      applied.push(value.roleIconUrl ?? "none");
      return true;
    }
  });

  await sync.run();
  appearances.g1 = appearance({ roleIconUrl: "https://cdn.example.com/icon.png" });
  await sync.run();

  assert.deepEqual(applied, ["none", "https://cdn.example.com/icon.png"]);
});

test("clearing the nickname is applied as an empty value", async () => {
  const appearances: Record<string, GuildAppearance> = { g1: appearance({ nickname: "AL AI" }) };
  const applied: string[] = [];
  const sync = createCustomizationSync({
    guildIds: () => ["g1"],
    loadAppearance: async () => appearances.g1,
    applyAppearance: async (_guildId, value) => {
      applied.push(value.nickname);
      return true;
    }
  });

  await sync.run();
  appearances.g1 = appearance({ nickname: "" });
  await sync.run();
  assert.deepEqual(applied, ["AL AI", ""]);
});

test("whitespace-only nicknames are treated as cleared", async () => {
  const { sync, applied } = harness({ g1: appearance({ nickname: "   " }) });
  await sync.run();
  assert.deepEqual(applied, [{ guildId: "g1", appearance: appearance({ nickname: "" }) }]);
});

test("a nickname longer than Discord accepts is truncated before it is sent", async () => {
  const { sync, applied } = harness({ g1: appearance({ nickname: "x".repeat(64) }) });
  await sync.run();
  assert.equal(applied[0].appearance.nickname.length, 32);
});

test("a stored value Discord would reject is normalised away, not sent", async () => {
  // A row written before the validation existed must not reach the API.
  const { sync, applied } = harness({
    g1: { nickname: "AL AI", roleColor: "rebeccapurple", roleIconUrl: "http://insecure.example.com/i.png" }
  });
  await sync.run();
  assert.deepEqual(applied[0].appearance, appearance({ nickname: "AL AI" }));
});

test("a failed apply is retried instead of being remembered as done", async () => {
  const applied: string[] = [];
  let attempt = 0;
  const sync = createCustomizationSync({
    guildIds: () => ["g1"],
    loadAppearance: async () => appearance({ nickname: "AL AI" }),
    applyAppearance: async (_guildId, value) => {
      attempt += 1;
      if (attempt === 1) return false; // Discord refused the first try
      applied.push(value.nickname);
      return true;
    }
  });

  await sync.run();
  assert.deepEqual(applied, [], "nothing recorded after a refusal");
  await sync.run();
  assert.deepEqual(applied, ["AL AI"], "the second tick retries");
});

test("a database failure for one guild does not stop the others", async () => {
  const applied: string[] = [];
  const errors: string[] = [];
  const sync = createCustomizationSync({
    guildIds: () => ["bad", "good"],
    loadAppearance: async guildId => {
      if (guildId === "bad") throw new Error("database down");
      return appearance({ nickname: "AL AI" });
    },
    applyAppearance: async (guildId, value) => {
      applied.push(`${guildId}:${value.nickname}`);
      return true;
    },
    onError: (guildId, error) => errors.push(`${guildId}:${(error as Error).message}`)
  });

  await sync.run();
  assert.deepEqual(applied, ["good:AL AI"]);
  assert.deepEqual(errors, ["bad:database down"]);
});

test("an error thrown by Discord is reported and not swallowed", async () => {
  const { sync, errors } = harness({ g1: appearance({ nickname: "AL AI" }) }, ["g1"]);
  await sync.run();
  assert.deepEqual(errors, ["g1:missing permission"]);
  assert.equal(sync.applied("g1"), undefined);
});
