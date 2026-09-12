import test from "node:test";
import assert from "node:assert/strict";
import { isCategoryEnabled, logDestinations } from "@al-ai/core";
import { resolveChannel } from "../src/logging/channel-registry.ts";
import { check, roleCarrierOf } from "../src/permissions/permission-guard.ts";
import { emptyLoggingConfig } from "../src/storage/database.ts";
import { ConfigCache } from "../src/storage/config-cache.ts";
import { logEvent, type LogRuntime } from "../src/logging/log-router.ts";

const tiers = { owner: "r-owner", head_admin: "r-head", admin: "r-admin", moderator: "r-mod" };

/* ---------------- routing ---------------- */

test("logging disabled resolves to no channel", () => {
  assert.deepEqual(resolveChannel({ ...emptyLoggingConfig, enabled: false, globalChannelId: "c1" }, "member-log"), {
    channelId: null,
    reason: "disabled"
  });
});

test("a category channel wins over the global channel", () => {
  const config = { ...emptyLoggingConfig, enabled: true, globalChannelId: "global", categoryChannels: { "member-log": "members" } };
  assert.deepEqual(resolveChannel(config, "member-log"), { channelId: "members", reason: "category" });
  assert.deepEqual(resolveChannel(config, "voice-log"), { channelId: "global", reason: "global" });
});

test("an ignored channel is never used as a destination", () => {
  const config = { ...emptyLoggingConfig, enabled: true, globalChannelId: "global", ignoredChannelIds: ["global"] };
  assert.deepEqual(resolveChannel(config, "message-log"), { channelId: null, reason: "ignored" });
});

test("a muted category is skipped even when a channel exists", () => {
  const config = { ...emptyLoggingConfig, enabled: true, globalChannelId: "global", eventFlags: { "voice-log": false } };
  assert.deepEqual(resolveChannel(config, "voice-log"), { channelId: null, reason: "category-muted" });
});

test("an event resolves to exactly one channel", () => {
  const config = {
    ...emptyLoggingConfig,
    enabled: true,
    globalChannelId: "global",
    categoryChannels: { "member-log": "members", "moderation-log": "mod" }
  };
  const resolved = resolveChannel(config, "moderation-log");
  assert.equal(resolved.channelId, "mod");
  assert.notEqual(resolved.channelId, config.globalChannelId);
});

test("the global fallback works, which is why routing never reads the mirror table", () => {
  // `guild_log_channels` has no global-channel row. A reader built on that mirror
  // would return null here and silently drop every event routed by fallback, so
  // the JSONB row is the routing source and the mirror is constraint-only.
  const config = { ...emptyLoggingConfig, enabled: true, globalChannelId: "global", categoryChannels: {} };
  assert.deepEqual(resolveChannel(config, "member-log"), { channelId: "global", reason: "global" });
});

/* ---------------- category default agreement ---------------- */

test("an unset category flag means enabled, not muted", () => {
  assert.equal(isCategoryEnabled(undefined, "member-log"), true);
  assert.equal(isCategoryEnabled({}, "member-log"), true);
  assert.equal(isCategoryEnabled({ "member-log": true }, "member-log"), true);
  assert.equal(isCategoryEnabled({ "member-log": false }, "member-log"), false);
});

test("the router and the dashboard agree for every category and every flag state", () => {
  // This is the contract that was broken: the dashboard rendered an unset flag
  // as OFF while the router treated it as ON, so a category could look muted
  // and still be logging.
  const states: (boolean | undefined)[] = [true, false, undefined];

  for (const destination of logDestinations) {
    for (const state of states) {
      const eventFlags = state === undefined ? {} : { [destination]: state };
      const config = { ...emptyLoggingConfig, enabled: true, globalChannelId: "global", eventFlags };
      const resolved = resolveChannel(config, destination);
      const expectedEnabled = isCategoryEnabled(eventFlags, destination);

      assert.equal(
        resolved.channelId !== null,
        expectedEnabled,
        `${destination} with flag=${String(state)}: router says ${resolved.channelId ? "on" : "off"}`
      );
    }
  }
});

test("a muted category is reported as category-muted, not as a missing channel", () => {
  const config = { ...emptyLoggingConfig, enabled: true, globalChannelId: "global", eventFlags: { "voice-log": false } };
  assert.deepEqual(resolveChannel(config, "voice-log"), { channelId: null, reason: "category-muted" });
});

/* ---------------- embed colour ---------------- */

test("the configured embed colour reaches the delivery transport", async () => {
  // Previously embedColor was saved by the dashboard and never passed on, so the
  // operator's colour choice had no effect at all.
  const seen: (string | undefined)[] = [];
  const runtime: LogRuntime = {
    database: { appendAudit: async () => undefined } as unknown as LogRuntime["database"],
    cache: { get: async () => ({ ...emptyLoggingConfig, enabled: true, globalChannelId: "c1", embedColor: "#123456" }) } as unknown as ConfigCache,
    send: async (_channelId, _envelope, colorOverride) => {
      seen.push(colorOverride);
      return true;
    },
    hmacSecret: "secret",
    encryptionKey: "0".repeat(64),
    sourceLayer: "bot-runtime"
  };

  const outcome = await logEvent("member.join", { guildId: "g1", actorId: "u1", data: { memberId: "u1" } }, runtime);
  assert.equal(outcome.delivered, true);
  assert.deepEqual(seen, ["#123456"]);
});

test("an event that cannot be delivered reports why instead of failing silently", async () => {
  const runtime: LogRuntime = {
    database: { appendAudit: async () => undefined } as unknown as LogRuntime["database"],
    cache: { get: async () => ({ ...emptyLoggingConfig, enabled: true, globalChannelId: null }) } as unknown as ConfigCache,
    send: async () => true,
    hmacSecret: "secret",
    encryptionKey: "0".repeat(64),
    sourceLayer: "bot-runtime"
  };

  const outcome = await logEvent("member.join", { guildId: "g1", actorId: "u1", data: { memberId: "u1" } }, runtime);
  assert.equal(outcome.delivered, false);
  assert.equal(outcome.skipped, "no-channel");
});

/* ---------------- permission guard ---------------- */

test("a moderator cannot perform an admin action", () => {
  const outcome = check(roleCarrierOf(["r-mod"]), tiers, "admin");
  assert.deepEqual(outcome, { allowed: false, reason: "TIER_TOO_LOW" });
});

test("an admin cannot act on a head admin", () => {
  assert.equal(check(roleCarrierOf(["r-admin"]), tiers, "head_admin").allowed, false);
});

test("a member with no AL AI role is denied", () => {
  assert.deepEqual(check(roleCarrierOf(["random-role"]), tiers, "moderator"), { allowed: false, reason: "NO_TIER" });
});

test("the highest matching tier wins", () => {
  const outcome = check(roleCarrierOf(["r-mod", "r-owner"]), tiers, "owner");
  assert.deepEqual(outcome, { allowed: true, tier: "owner" });
});

test("a head admin passes an admin-level requirement", () => {
  assert.deepEqual(check(roleCarrierOf(["r-head"]), tiers, "admin"), { allowed: true, tier: "head_admin" });
});

/* ---------------- config cache ---------------- */

test("the config cache serves a hit without reloading", async () => {
  let loads = 0;
  let clock = 0;
  const cache = new ConfigCache(async () => {
    loads += 1;
    return { ...emptyLoggingConfig, enabled: true };
  }, 30_000, () => clock);

  await cache.get("g1");
  await cache.get("g1");
  assert.equal(loads, 1);

  clock += 31_000;
  await cache.get("g1");
  assert.equal(loads, 2);
});

test("invalidating the cache forces a reload", async () => {
  let loads = 0;
  const cache = new ConfigCache(async () => {
    loads += 1;
    return { ...emptyLoggingConfig };
  });
  await cache.get("g1");
  cache.invalidate("g1");
  await cache.get("g1");
  assert.equal(loads, 2);
});
