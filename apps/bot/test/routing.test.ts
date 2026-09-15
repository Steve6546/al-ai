import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { isCategoryEnabled, logDestinations } from "@al-ai/core";
import { resolveChannel } from "../src/logging/channel-registry.ts";
import { check, roleCarrierOf } from "../src/permissions/permission-guard.ts";
import { emptyLoggingConfig, type GuildLoggingConfig } from "../src/storage/database.ts";
import { ConfigCache } from "../src/storage/config-cache.ts";
import { logEvent, type LogRuntime } from "../src/logging/log-router.ts";

const tiers = { adminRoleIds: ["r-admin"], moderatorRoleIds: ["r-mod"] };

/* ---------------- routing ---------------- */

test("logging disabled resolves to no channel", () => {
  assert.deepEqual(resolveChannel({ ...emptyLoggingConfig, enabled: false, globalChannelId: "c1" }, "member-log"), {
    channelId: null,
    reason: "disabled"
  });
});

test("a category channel wins over the global channel in granular mode", () => {
  const config = {
    ...emptyLoggingConfig,
    enabled: true,
    mode: "granular" as const,
    globalChannelId: "global",
    categoryChannels: { "member-log": "members" }
  };
  assert.deepEqual(resolveChannel(config, "member-log"), { channelId: "members", reason: "category" });
  assert.deepEqual(resolveChannel(config, "voice-log"), { channelId: "global", reason: "global" });
});

test("single mode sends every destination to the global channel", () => {
  // The whole point of the mode: an operator who wants one room should not have
  // a stale per-category binding quietly splitting the stream.
  const config = {
    ...emptyLoggingConfig,
    enabled: true,
    mode: "single" as const,
    globalChannelId: "global",
    categoryChannels: { "member-log": "members", "moderation-log": "mod" }
  };
  for (const destination of logDestinations) {
    assert.deepEqual(resolveChannel(config, destination), { channelId: "global", reason: "global" }, destination);
  }
});

test("granular mode without a matching category falls back to the global channel", () => {
  const config = {
    ...emptyLoggingConfig,
    enabled: true,
    mode: "granular" as const,
    globalChannelId: "global",
    categoryChannels: { "member-log": "members" }
  };
  assert.deepEqual(resolveChannel(config, "moderation-log"), { channelId: "global", reason: "global" });
});

test("granular mode without a category or a global channel resolves to nothing", () => {
  const config = {
    ...emptyLoggingConfig,
    enabled: true,
    mode: "granular" as const,
    globalChannelId: null,
    categoryChannels: {}
  };
  assert.deepEqual(resolveChannel(config, "moderation-log"), { channelId: null, reason: "no-channel" });
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
    mode: "granular" as const,
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

/* ---------------- per-event sub-toggles ---------------- */

test("a muted event is skipped while the rest of its category keeps logging", () => {
  // "Log messages, but not edits" — the destination stays on, one event inside
  // it does not.
  const config = {
    ...emptyLoggingConfig,
    enabled: true,
    globalChannelId: "global",
    eventFlags: { "message.edit": false }
  };
  assert.deepEqual(resolveChannel(config, "message-log", "message.edit"), { channelId: null, reason: "category-muted" });
  assert.deepEqual(resolveChannel(config, "message-log", "message.delete"), { channelId: "global", reason: "global" });
});

test("an explicit event flag overrides its category flag in both directions", () => {
  const off = { ...emptyLoggingConfig, enabled: true, globalChannelId: "global", eventFlags: { "message-log": false, "message.delete": true } };
  assert.deepEqual(resolveChannel(off, "message-log", "message.delete"), { channelId: "global", reason: "global" });

  const on = { ...emptyLoggingConfig, enabled: true, globalChannelId: "global", eventFlags: { "message-log": true, "message.delete": false } };
  assert.deepEqual(resolveChannel(on, "message-log", "message.delete"), { channelId: null, reason: "category-muted" });
});

test("a retired destination can no longer be muted or bound", () => {
  // `role-log` is gone from the schema; a stale flag or binding for it is inert.
  const config = {
    ...emptyLoggingConfig,
    enabled: true,
    mode: "granular" as const,
    globalChannelId: "global",
    // Values an older dashboard may have written for the retired destination.
    eventFlags: { "role-log": false } as Record<string, boolean>,
    categoryChannels: { "role-log": "roles" } as GuildLoggingConfig["categoryChannels"]
  };
  assert.deepEqual(resolveChannel(config, "server-log", "role.create"), { channelId: "global", reason: "global" });
});

/* ---------------- ignored roles ---------------- */

test("an ignored role suppresses the event, whichever side of it holds the role", async () => {
  const config = {
    ...emptyLoggingConfig,
    enabled: true,
    globalChannelId: "global",
    ignoredRoleIds: ["r-bot"]
  };
  /** Keyed by user ID so "the actor" and "the subject" can differ. */
  const runtime = (rolesByUser: Record<string, string[]>): LogRuntime => ({
    database: { appendAudit: async () => undefined } as unknown as LogRuntime["database"],
    cache: { get: async () => config } as unknown as ConfigCache,
    send: async () => true,
    hmacSecret: "secret",
    encryptionKey: "0".repeat(64),
    sourceLayer: "bot-runtime",
    resolveMemberRoles: async (_guildId, userId) => rolesByUser[userId] ?? []
  });

  // The actor holds the excluded role.
  const asActor = await logEvent(
    "member.join",
    { guildId: "g1", actorId: "actor", data: { memberId: "subject" } },
    runtime({ actor: ["r-bot"] })
  );
  assert.equal(asActor.delivered, false);
  assert.equal(asActor.skipped, "ignored-role");

  // The subject holds it; the actor does not.
  const asSubject = await logEvent(
    "member.join",
    { guildId: "g1", actorId: "actor", data: { memberId: "subject" } },
    runtime({ subject: ["r-bot"] })
  );
  assert.equal(asSubject.delivered, false);
  assert.equal(asSubject.skipped, "ignored-role");
});

test("a member with no ignored role is logged normally", async () => {
  const config = { ...emptyLoggingConfig, enabled: true, globalChannelId: "global", ignoredRoleIds: ["r-bot"] };
  const runtime: LogRuntime = {
    database: { appendAudit: async () => undefined } as unknown as LogRuntime["database"],
    cache: { get: async () => config } as unknown as ConfigCache,
    send: async () => true,
    hmacSecret: "secret",
    encryptionKey: "0".repeat(64),
    sourceLayer: "bot-runtime",
    resolveMemberRoles: async () => ["r-human"]
  };

  const outcome = await logEvent("member.join", { guildId: "g1", actorId: "actor", data: { memberId: "subject" } }, runtime);
  assert.equal(outcome.delivered, true);
});

test("an audit entry is written even when the event is suppressed by an ignored role", async () => {
  // The trail records what happened; only the notification is suppressed.
  let audited = 0;
  const config = { ...emptyLoggingConfig, enabled: true, globalChannelId: "global", ignoredRoleIds: ["r-bot"] };
  const runtime: LogRuntime = {
    database: { appendAudit: async () => void (audited += 1) } as unknown as LogRuntime["database"],
    cache: { get: async () => config } as unknown as ConfigCache,
    send: async () => true,
    hmacSecret: "secret",
    encryptionKey: "0".repeat(64),
    sourceLayer: "bot-runtime",
    resolveMemberRoles: async () => ["r-bot"]
  };

  const outcome = await logEvent(
    "moderation.ban",
    { guildId: "g1", actorId: "actor", data: { targetId: "subject", actorId: "actor" } },
    runtime
  );
  assert.equal(outcome.delivered, false);
  assert.equal(audited, 1);
});

/* ---------------- internal destinations ---------------- */

test("a bot-log event goes to the developer transport, never to a guild channel", async () => {
  // A customer must not be able to receive AL AI's own errors, and must not be
  // able to mute the security surface either.
  let guildSends = 0;
  let developerSends = 0;
  const runtime: LogRuntime = {
    database: { appendAudit: async () => undefined } as unknown as LogRuntime["database"],
    cache: { get: async () => ({ ...emptyLoggingConfig, enabled: true, globalChannelId: "global" }) } as unknown as ConfigCache,
    send: async () => {
      guildSends += 1;
      return true;
    },
    sendToDeveloper: async () => {
      developerSends += 1;
      return true;
    },
    hmacSecret: "secret",
    encryptionKey: "0".repeat(64),
    sourceLayer: "bot-runtime"
  };

  const outcome = await logEvent("security.hmac-invalid", { guildId: "g1", actorId: "system", data: { layer: "dashboard", reason: "bad-signature" } }, runtime);
  assert.equal(outcome.delivered, true);
  assert.equal(guildSends, 0);
  assert.equal(developerSends, 1);
});

test("a bot-log event still reaches the developer when guild logging is disabled", async () => {
  let developerSends = 0;
  const runtime: LogRuntime = {
    database: { appendAudit: async () => undefined } as unknown as LogRuntime["database"],
    cache: { get: async () => ({ ...emptyLoggingConfig, enabled: false }) } as unknown as ConfigCache,
    send: async () => true,
    sendToDeveloper: async () => {
      developerSends += 1;
      return true;
    },
    hmacSecret: "secret",
    encryptionKey: "0".repeat(64),
    sourceLayer: "bot-runtime"
  };

  const outcome = await logEvent("security.audit-tamper", { guildId: "g1", actorId: "system", data: { attempt: "delete", target: "audit_log" } }, runtime);
  assert.equal(outcome.delivered, true);
  assert.equal(developerSends, 1);
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

test("an admin cannot perform an owner-only action", () => {
  assert.equal(check(roleCarrierOf(["r-admin"]), tiers, "owner").allowed, false);
});

test("a member with no AL AI role is denied", () => {
  assert.deepEqual(check(roleCarrierOf(["random-role"]), tiers, "moderator"), { allowed: false, reason: "NO_TIER" });
});

test("the highest matching tier wins", () => {
  const outcome = check(roleCarrierOf(["r-mod", "r-admin"]), tiers, "admin");
  assert.deepEqual(outcome, { allowed: true, tier: "admin" });
});

test("a guild owner passes without holding any configured role", () => {
  assert.deepEqual(check(roleCarrierOf([], { isGuildOwner: true }), tiers, "owner"), { allowed: true, tier: "owner" });
});

test("an Administrator passes without holding any configured role", () => {
  assert.deepEqual(check(roleCarrierOf([], { isAdministrator: true }), tiers, "owner"), { allowed: true, tier: "owner" });
});

test("an admin passes a moderator-level requirement", () => {
  assert.deepEqual(check(roleCarrierOf(["r-admin"]), tiers, "moderator"), { allowed: true, tier: "admin" });
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

/* ------------------------------------------------------------------ *
 * Schema reachability
 *
 * Every event the schema declares must have something that can actually write
 * it. Without this check a dead declaration is indistinguishable from a working
 * feature: it appears in `event-schema.ts`, it is routed in
 * `config/channels.json`, and a `logEvent` call naming it would succeed — so the
 * entry reads as live while nothing ever produces it.
 *
 * This was not hypothetical. `bot.health` was declared with `state` as a
 * required field, routed to `bot-log`, and given Arabic copy in the dashboard.
 * No code path emitted it. The health surface an operator actually sees is
 * `guild_health` plus the signed push to the dashboard; `onHealth` — the
 * callback whose signature takes `(state, gatewayEvents)` — wrote to
 * `console.log` and discarded its second argument, which is what the missing
 * producer left behind.
 *
 * SCOPE: the whole monorepo, not just the bot. The event schema is shared, and a
 * producer may legitimately live on the other side of a layer boundary —
 * `bot.security-rejection` is written by the dashboard BFF when a request fails
 * the tier check, and then travels through bot-log. Scanning only the bot
 * reported it as dead, which is exactly the false positive that makes a guard
 * worth deleting instead of keeping.
 *
 * The check is textual because driving every emitter would need Discord, a
 * database and a clock. The shapes below are the only ones a producer takes.
 * ------------------------------------------------------------------ */

/**
 * Every `.ts`/`.tsx` file under each root, keyed by a path relative to that root.
 *
 * The root is carried through the recursion. Deriving the relative path from the
 * *current* directory instead collapses every file to its bare filename —
 * `lib/discord.ts` becomes `discord.ts` and `security/intrusion-detector.ts`
 * becomes `intrusion-detector.ts` — so any lookup by subdirectory silently never
 * matches and the scan reports "nothing found" for the files it exists to
 * inspect. That is the same class of failure this whole test is about, and it
 * caught the guard itself on the first run.
 */
function sourceFiles(root: string, dir: string = root): { relativePath: string; source: string }[] {
  return readdirSync(dir).flatMap(entry => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(root, full);
    return full.endsWith(".ts") || full.endsWith(".tsx")
      ? [{ relativePath: relative(root, full).replace(/\\/g, "/"), source: readFileSync(full, "utf8") }]
      : [];
  });
}

test("every declared event has a producer somewhere in the monorepo", async () => {
  const { eventSchema } = await import("@al-ai/core");
  const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
  const source = ["apps/bot/src", "apps/dashboard/server", "apps/dashboard/src"]
    .flatMap(root => sourceFiles(join(repoRoot, root)))
    .map(file => ({
      relativePath: file.relativePath,
      // Comments are stripped so a doc block quoting an event ID cannot stand in
      // for a producer. This test's own comment names both dead events.
      source: file.source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
    }));

  const emitted = new Set<string>();

  for (const file of source) {
    // 1. A literal event ID as logEvent's first argument.
    for (const match of file.source.matchAll(/logEvent\(\s*"([a-z][a-z.-]+)"/g)) emitted.add(match[1]!);

    // 2. `appendAudit({ ..., eventId: "x" })` — the dashboard's equivalent, used
    //    for events the BFF raises on its own side of the boundary.
    for (const match of file.source.matchAll(/eventId:\s*"([a-z][a-z.-]+)"/g)) emitted.add(match[1]!);

    // 3. Gateway events reach logEvent as a `BotEvent["type"]`, listed in the
    //    union in lib/discord.ts. Every member of that union is forwarded.
    if (file.relativePath === "lib/discord.ts") {
      for (const match of file.source.matchAll(/type:\s*"([a-z][a-z.-]+)"/g)) emitted.add(match[1]!);
    }

    // 4. The intrusion detector returns a signal whose `id` is the event ID, and
    //    the runtime passes that straight to logEvent. `bot.security-rejection`
    //    is the detector's equivalent on the dashboard side, raised via appendAudit.
    if (file.relativePath === "security/intrusion-detector.ts") {
      for (const match of file.source.matchAll(/id:\s*"([a-z][a-z.-]+)"/g)) emitted.add(match[1]!);
    }
  }

  const unreachable = [...eventSchema.keys()].filter(id => !emitted.has(id));
  assert.deepEqual(
    unreachable,
    [],
    "declared but never emitted: " + unreachable.join(", ") + " — an event nothing produces is a dead declaration"
  );
});
