import test from "node:test";
import assert from "node:assert/strict";
import { Collection, type Client } from "discord.js";
import {
  applyChannelAction,
  applyModeration,
  CLEAR_MAX_COUNT,
  quarantineMember,
  SLOWMODE_MAX_SECONDS,
  TIMEOUT_MAX_SECONDS
} from "../src/lib/discord.js";

/**
 * The request shape the bot sends to Discord.
 *
 * `applyModeration`, `applyChannelAction` and `quarantineMember` are the calls
 * that actually punish a member, and until now nothing exercised them at all:
 * the adapter tests cover the HTTP transport, and `discord-standards` checks
 * constants against the library, but a wrong clamp, a wrong endpoint or a
 * missing `reason` would have reached production unopposed.
 *
 * There is no live guild here, so the client is a fake that records what it was
 * asked to do. That makes this a *request-shape* test on purpose: it pins the
 * arguments Discord would receive — which is the part a wrong implementation
 * gets wrong — rather than pretending to be an integration test. The shapes are
 * taken from discord.js v14's own signatures (`guild.bans.create`,
 * `member.timeout`, `permissionOverwrites.edit`) so a rename in the library that
 * this drifts from shows up as a type error at build time, not a silent 400.
 */

type Call = { method: string; args: unknown[] };

/** A record of every Discord call a fake client received. */
function recorder() {
  const calls: Call[] = [];
  const record = (method: string) => (...args: unknown[]) => {
    calls.push({ method, args });
    return undefined;
  };
  return { calls, record };
}

/** Builds a guild the given actions can be run against, recording each call. */
function fakeClient(options: {
  channel?: Record<string, unknown>;
  member?: Record<string, unknown>;
  ownerId?: string;
} = {}) {
  const { calls, record } = recorder();
  const everyone = { id: "EVERYONE" };
  const guild = {
    ownerId: options.ownerId ?? "OWNER",
    roles: { everyone },
    bans: {
      create: record("bans.create"),
      remove: record("bans.remove")
    },
    members: {
      fetch: async () => options.member ?? null
    },
    channels: {
      fetch: async () => options.channel ?? null
    }
  };
  const client = { guilds: { fetch: async () => guild } } as unknown as Client;
  return { client, calls, guild };
}

/**
 * A role cache holding the given role ids, built from discord.js's own
 * `Collection`. A plain `Map` would not do: `quarantineMember` calls
 * `.filter()` on this, and a Map has no such method — the first run of this
 * file failed with `member.roles.cache.filter is not a function`, which was
 * the fixture being wrong, not the code.
 */
function roleCache(ids: string[]) {
  const cache = new Collection<string, { id: string }>();
  for (const id of ids) cache.set(id, { id });
  return cache;
}

/* ------------------------------------------------------------------ *
 * Member actions
 * ------------------------------------------------------------------ */

test("a ban carries the reason, and the message window only when asked", async () => {
  const { client, calls } = fakeClient();

  assert.equal(await applyModeration(client, { kind: "ban", guildId: "g", targetId: "t", reason: "سبام" }), true);
  assert.deepEqual(calls[0], {
    method: "bans.create",
    args: ["t", { reason: "سبام" }]
  }, "without deleteMessageSeconds the key must be absent, not zero");

  calls.length = 0;
  await applyModeration(client, { kind: "ban", guildId: "g", targetId: "t", reason: "سبام", deleteMessageSeconds: 86_400 });
  assert.deepEqual(calls[0]!.args[1], { reason: "سبام", deleteMessageSeconds: 86_400 });
});

test("a timeout is clamped into the range Discord accepts", async () => {
  const member = { timeout: (...args: unknown[]) => void 0 };
  const { calls, record } = recorder();
  member.timeout = record("member.timeout");
  const { client } = fakeClient({ member });

  // Below the floor.
  await applyModeration(client, { kind: "timeout", guildId: "g", targetId: "t", minutes: 0, reason: "r" });
  assert.deepEqual(calls[0]!.args, [60_000, "r"], "a sub-minute timeout becomes the 60-second floor");

  calls.length = 0;
  // Above the ceiling.
  await applyModeration(client, { kind: "timeout", guildId: "g", targetId: "t", minutes: TIMEOUT_MAX_SECONDS, reason: "r" });
  assert.deepEqual(calls[0]!.args, [TIMEOUT_MAX_SECONDS * 1_000, "r"], "the ceiling is seconds, converted to ms");
});

test("an unban passes the reason Discord expects as a second argument", async () => {
  const { client, calls } = fakeClient();
  await applyModeration(client, { kind: "unban", guildId: "g", targetId: "t", reason: "استئناف" });
  assert.deepEqual(calls[0], { method: "bans.remove", args: ["t", "استئناف"] });
});

test("a refused action reports false instead of throwing into the event path", async () => {
  const guild = {
    ownerId: "OWNER",
    roles: { everyone: { id: "EVERYONE" } },
    bans: { create: () => { throw new Error("Missing Permissions"); } },
    members: { fetch: async () => null },
    channels: { fetch: async () => null }
  };
  const client = { guilds: { fetch: async () => guild } } as unknown as Client;

  assert.equal(await applyModeration(client, { kind: "ban", guildId: "g", targetId: "t", reason: "r" }), false);
});

test("an unreachable guild is reported, not assumed to have succeeded", async () => {
  const client = { guilds: { fetch: async () => { throw new Error("Unknown Guild"); } } } as unknown as Client;
  assert.equal(await applyModeration(client, { kind: "ban", guildId: "g", targetId: "t", reason: "r" }), false);
});

/* ------------------------------------------------------------------ *
 * Channel actions
 * ------------------------------------------------------------------ */

test("a lock denies SendMessages on @everyone, and an unlock clears it", async () => {
  const edited: unknown[] = [];
  const channel = {
    isTextBased: () => true,
    isDMBased: () => false,
    permissionOverwrites: {
      edit: (...args: unknown[]) => void edited.push(args)
    }
  };
  const { client, guild } = fakeClient({ channel });

  assert.deepEqual(await applyChannelAction(client, { kind: "lock", guildId: "g", channelId: "c", reason: "هدوء" }), { ok: true });
  assert.deepEqual(edited[0], [guild.roles.everyone, { SendMessages: false }, { reason: "هدوء" }]);

  edited.length = 0;
  assert.deepEqual(await applyChannelAction(client, { kind: "unlock", guildId: "g", channelId: "c", reason: "انتهى" }), { ok: true });
  // `null` clears the overwrite; `true` would set it to *allow*, which is a
  // different thing and would override a role rule the operator wanted back.
  assert.deepEqual(edited[0], [guild.roles.everyone, { SendMessages: null }, { reason: "انتهى" }]);
});

test("a clear caps the count at Discord's bulk-delete ceiling", async () => {
  const counts: number[] = [];
  const channel = {
    isTextBased: () => true,
    isDMBased: () => false,
    bulkDelete: async (limit: number) => {
      counts.push(limit);
      return new Map([...Array(Math.max(limit, 0)).keys()].map(key => [key, key]));
    }
  };
  const { client } = fakeClient({ channel });

  const result = await applyChannelAction(client, { kind: "clear", guildId: "g", channelId: "c", count: 5_000 });
  assert.deepEqual(counts, [CLEAR_MAX_COUNT], "an oversized request is clamped to the bulk ceiling, not sent as-is");
  assert.deepEqual(result, { ok: true, removed: CLEAR_MAX_COUNT });
});

test("a slowmode value is clamped into Discord's range", async () => {
  const applied: number[] = [];
  const channel = {
    isTextBased: () => true,
    isDMBased: () => false,
    setRateLimitPerUser: async (seconds: number) => void applied.push(seconds)
  };
  const { client } = fakeClient({ channel });

  await applyChannelAction(client, { kind: "slowmode", guildId: "g", channelId: "c", seconds: -10, reason: "r" });
  assert.deepEqual(applied, [0], "a negative value becomes 0, the fastest Discord allows");

  await applyChannelAction(client, { kind: "slowmode", guildId: "g", channelId: "c", seconds: 99_999, reason: "r" });
  assert.deepEqual(applied, [0, SLOWMODE_MAX_SECONDS], "and an oversized one is capped at six hours");
});

test("a lock on a channel without overwrites is refused with a reason", async () => {
  const channel = { isTextBased: () => true, isDMBased: () => false };
  const { client } = fakeClient({ channel });

  assert.deepEqual(
    await applyChannelAction(client, { kind: "lock", guildId: "g", channelId: "c", reason: "r" }),
    { ok: false, reason: "NOT_A_TEXT_CHANNEL" },
    "a thread has no overwrites of its own, so the refusal is explicit rather than a cast"
  );
});

/* ------------------------------------------------------------------ *
 * Quarantine
 * ------------------------------------------------------------------ */

test("quarantine reduces the member to the quarantine role and reports how much it stripped", async () => {
  const setCalls: string[][] = [];
  const member = {
    roles: {
      cache: roleCache(["EVERYONE", "ROLE_A", "ROLE_B", "QUARANTINE"]),
      set: async (ids: string[]) => void setCalls.push(ids)
    }
  };
  const { client } = fakeClient({ member });

  // Two removable roles: @everyone and the quarantine role itself are not counted.
  assert.equal(await quarantineMember(client, "g", "u", "QUARANTINE"), 2);
  assert.deepEqual(setCalls, [["QUARANTINE"]], "only the quarantine role is set, replacing the rest");
});

test("quarantine refuses the guild owner, and touches no roles", async () => {
  const setCalls: unknown[] = [];
  const member = {
    roles: { cache: roleCache([]), set: async (ids: string[]) => void setCalls.push(ids) }
  };
  const { client } = fakeClient({ member, ownerId: "OWNER" });

  // Discord refuses role changes on the owner; returning null means "no action
  // taken" rather than a silent 0, which would read as "stripped nothing".
  assert.equal(await quarantineMember(client, "g", "OWNER", "QUARANTINE"), null);
  assert.deepEqual(setCalls, [], "the owner is never modified");
});

test("a failed role write reports no mitigation rather than a fake success", async () => {
  const member = {
    roles: {
      cache: roleCache(["ROLE_A"]),
      set: async () => { throw new Error("Missing Permissions"); }
    }
  };
  const { client } = fakeClient({ member });

  assert.equal(await quarantineMember(client, "g", "u", "QUARANTINE"), null);
});
