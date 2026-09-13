import test, { after } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { commandFlagsFor, defaultCommandConfig, requireCommand } from "@al-ai/core";
import { createDatabase, createPool } from "../server/db.js";

/**
 * Integration tests for the dashboard's guild bookkeeping.
 *
 * These run against the real PostgreSQL instance from `DATABASE_URL` and skip
 * cleanly when there is none, so `npm test` stays usable on a machine without a
 * database while still covering the storage layer wherever one exists.
 *
 * The behaviour under test is a bug that shipped: the guild list wrote
 * `member_count = 0` on every load, wiping the real count the bot had reported.
 * A pure unit test cannot catch that, because the damage happens in SQL.
 */

// The dashboard reads its configuration from `process.env` only, and the test
// runner does not load `.env`. Pull it in here so a developer with a running
// database gets real coverage without extra flags.
const envFile = resolve(import.meta.dirname, "../../../.env");
if (!process.env.DATABASE_URL && existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

const GUILD_ID = "900000000000000001";
const REAL_MEMBER_COUNT = 1234;

const pool = process.env.DATABASE_URL ? createPool(process.env.DATABASE_URL!) : null;
const db = pool ? createDatabase(pool) : null;

let reachable = false;
if (db) {
  try {
    await db.ping();
    reachable = true;
  } catch {
    reachable = false;
  }
}

const skip = reachable ? false : "no reachable database at DATABASE_URL";

after(async () => {
  if (!pool) return;
  // The guild row cascades to every child table.
  await pool.query("DELETE FROM guilds WHERE id = $1", [GUILD_ID]).catch(() => undefined);
  await pool.end().catch(() => undefined);
});

/** Writes the row the way the bot would, so the dashboard has something to protect. */
async function seedBotOwnedGuild() {
  await pool!.query(
    `INSERT INTO guilds (id, name, icon_url, member_count, bot_present, updated_at)
     VALUES ($1, $2, $3, $4, true, now())
     ON CONFLICT (id) DO UPDATE
       SET name = EXCLUDED.name,
           member_count = EXCLUDED.member_count,
           bot_present = true,
           updated_at = now()`,
    [GUILD_ID, "bot-owned", null, REAL_MEMBER_COUNT]
  );
}

test("ensureGuild creates a guild the bot has never seen", { skip }, async () => {
  await pool!.query("DELETE FROM guilds WHERE id = $1", [GUILD_ID]);

  await db!.ensureGuild({ id: GUILD_ID, name: "discovered", iconUrl: "abc" });

  const record = await db!.getGuild(GUILD_ID);
  assert.ok(record, "the row must exist after ensureGuild");
  assert.equal(record.name, "discovered");
  // A guild the bot is not in has no member count to report, and inventing one
  // would be worse than showing nothing.
  assert.equal(record.memberCount, 0);
  assert.equal(record.botPresent, false);
});

test("ensureGuild never overwrites the member count the bot reported", { skip }, async () => {
  await seedBotOwnedGuild();

  await db!.ensureGuild({ id: GUILD_ID, name: "discovered", iconUrl: "abc" });

  const record = await db!.getGuild(GUILD_ID);
  assert.ok(record);
  assert.equal(
    record.memberCount,
    REAL_MEMBER_COUNT,
    "a dashboard load must not reset the bot's member count to zero"
  );
});

test("ensureGuild leaves the bot's own columns untouched", { skip }, async () => {
  await seedBotOwnedGuild();

  await db!.ensureGuild({ id: GUILD_ID, name: "discovered", iconUrl: "abc" });

  const { rows } = await pool!.query<{ name: string; bot_present: boolean }>(
    "SELECT name, bot_present FROM guilds WHERE id = $1",
    [GUILD_ID]
  );
  assert.equal(rows[0]?.name, "bot-owned", "the bot's name must survive a dashboard load");
  assert.equal(rows[0]?.bot_present, true, "bot presence is the bot's to report");
});

test("ensureGuild is idempotent", { skip }, async () => {
  await seedBotOwnedGuild();

  await db!.ensureGuild({ id: GUILD_ID, name: "discovered", iconUrl: "abc" });
  await db!.ensureGuild({ id: GUILD_ID, name: "discovered", iconUrl: "abc" });

  const { rows } = await pool!.query<{ count: string }>("SELECT count(*)::text AS count FROM guilds WHERE id = $1", [
    GUILD_ID
  ]);
  assert.equal(rows[0]?.count, "1");
});

test("the metrics reader sees the bot's member count", { skip }, async () => {
  await seedBotOwnedGuild();

  // The overview reads `members.total` straight off this record; if the count
  // can be zeroed here it shows zero there, which is what went wrong before.
  const record = await db!.getGuild(GUILD_ID);
  assert.equal(record?.memberCount, REAL_MEMBER_COUNT);
});

/* ------------------------------------------------------------------ *
 * Anti-nuke settings
 *
 * The engine strips a moderator's roles, so what is stored here decides whether
 * a real person is punished. These run against the real table, because the
 * CHECK constraints are part of that guarantee.
 * ------------------------------------------------------------------ */

test("a guild with no security row reads as armed at the defaults", { skip }, async () => {
  await pool!.query("DELETE FROM guild_security WHERE guild_id = $1", [GUILD_ID]);
  const config = await db!.getSecurity(GUILD_ID);

  assert.equal(config.enabled, true, "a guild without a saved row is protected, not exposed");
  assert.deepEqual(config.limits, { channelDeletesPerMinute: 3, bansPerMinute: 5, roleChangesPerMinute: 3 });
  assert.equal(config.quarantineRoleId, null);
});

test("security settings survive a round trip", { skip }, async () => {
  await pool!.query("DELETE FROM guild_security WHERE guild_id = $1", [GUILD_ID]);

  const written = {
    enabled: true,
    limits: { channelDeletesPerMinute: 7, bansPerMinute: 12, roleChangesPerMinute: 4 },
    quarantineRoleId: "1540515175826985080"
  };
  await db!.saveSecurity(GUILD_ID, written);
  assert.deepEqual(await db!.getSecurity(GUILD_ID), written);
});

test("saving twice updates rather than duplicating", { skip }, async () => {
  await pool!.query("DELETE FROM guild_security WHERE guild_id = $1", [GUILD_ID]);
  const base = {
    enabled: false,
    limits: { channelDeletesPerMinute: 3, bansPerMinute: 5, roleChangesPerMinute: 3 },
    quarantineRoleId: null
  };

  await db!.saveSecurity(GUILD_ID, base);
  await db!.saveSecurity(GUILD_ID, { ...base, enabled: true });

  const { rows } = await pool!.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM guild_security WHERE guild_id = $1",
    [GUILD_ID]
  );
  assert.equal(rows[0]?.count, "1");
  assert.equal((await db!.getSecurity(GUILD_ID)).enabled, true);
});

test("the database refuses a limit of zero even if code lets one through", { skip }, async () => {
  // The code clamps to >= 1; this proves the table does too, so a direct write
  // cannot create an engine that trips on the first innocent action.
  await seedBotOwnedGuild();
  await assert.rejects(
    pool!.query("INSERT INTO guild_security (guild_id, bans_per_minute) VALUES ($1, 0)", [GUILD_ID]),
    /guild_security_bans_check/
  );
});

/* ------------------------------------------------------------------ *
 * Per-command configuration
 *
 * Every scope and switch on the Commands screen is stored here, and the CHECK
 * constraints are what stop a value the bot cannot honour from being written at
 * all. A pure unit test cannot prove that, because the guarantee lives in SQL.
 * ------------------------------------------------------------------ */

const commandDefaults = defaultCommandConfig(requireCommand("timeout"));

test("a command with no stored row reads back as its registry defaults", { skip }, async () => {
  await seedBotOwnedGuild();
  await pool!.query("DELETE FROM guild_command_flags WHERE guild_id = $1", [GUILD_ID]);

  const flags = await db!.getCommandFlags(GUILD_ID);
  assert.equal(flags.size, 0, "nothing is stored until the operator changes something");
  assert.deepEqual(commandFlagsFor(flags).find(command => command.name === "timeout"), {
    ...commandDefaults,
    category: "moderation",
    description: "إسكات مؤقت",
    minimumTier: "moderator",
    target: "member",
    supportsReason: true,
    supportsPurge: true,
    supportsNotify: true,
    supportsDuration: true
  });
});

test("every new command setting survives a round trip", { skip }, async () => {
  await seedBotOwnedGuild();
  await pool!.query("DELETE FROM guild_command_flags WHERE guild_id = $1", [GUILD_ID]);

  const written = {
    ...commandDefaults,
    enabled: false,
    allowedLevel: "admin" as const,
    allowedRoleIds: ["111111111111111111"],
    deniedRoleIds: ["222222222222222222"],
    allowedChannelIds: ["333333333333333333"],
    deniedChannelIds: ["444444444444444444"],
    cooldownSeconds: 45,
    autoDeleteResponseSeconds: 20,
    requireReason: true,
    defaultDuration: "6h" as const,
    presetReasons: [
      { id: "spam", label: "سبام", duration: "30m" as const },
      { id: "ad", label: "إعلان", duration: null }
    ]
  };
  await db!.saveCommandFlag(GUILD_ID, written);

  const read = await db!.getCommandFlags(GUILD_ID);
  const stored = commandFlagsFor(read).find(command => command.name === "timeout")!;

  for (const [key, value] of Object.entries(written)) {
    assert.deepEqual(stored[key as keyof typeof stored], value, `${key} survived the round trip`);
  }
});

test("saving a command twice updates rather than duplicating", { skip }, async () => {
  await seedBotOwnedGuild();
  await pool!.query("DELETE FROM guild_command_flags WHERE guild_id = $1", [GUILD_ID]);

  await db!.saveCommandFlag(GUILD_ID, commandDefaults);
  await db!.saveCommandFlag(GUILD_ID, { ...commandDefaults, cooldownSeconds: 90 });

  const { rows } = await pool!.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM guild_command_flags WHERE guild_id = $1",
    [GUILD_ID]
  );
  assert.equal(rows[0]?.count, "1");
  assert.equal((await db!.getCommandFlags(GUILD_ID)).get("timeout")?.cooldownSeconds, 90);
});

test("the database refuses a cooldown the code would never send", { skip }, async () => {
  // The code clamps to an hour; the constraint is what makes that a guarantee
  // rather than a habit. 4000 fits the column's own type, so this proves the
  // CHECK is doing the refusing rather than an overflow.
  await seedBotOwnedGuild();
  await assert.rejects(
    pool!.query("INSERT INTO guild_command_flags (guild_id, command, cooldown_seconds) VALUES ($1, 'ban', 4000)", [GUILD_ID]),
    /guild_command_flags_cooldown_check/
  );
});

test("the database refuses a duration the bot could not resolve", { skip }, async () => {
  await seedBotOwnedGuild();
  await assert.rejects(
    pool!.query("INSERT INTO guild_command_flags (guild_id, command, default_duration) VALUES ($1, 'ban', 'forever')", [GUILD_ID]),
    /guild_command_flags_duration_check/
  );
});

test("the database refuses an auto-delete delay beyond the code's ceiling", { skip }, async () => {
  await seedBotOwnedGuild();
  await assert.rejects(
    pool!.query(
      "INSERT INTO guild_command_flags (guild_id, command, auto_delete_response_seconds) VALUES ($1, 'ban', 700)",
      [GUILD_ID]
    ),
    /guild_command_flags_auto_delete_check/
  );
});

test("the legacy allow-list column is gone, so one concept has one column", { skip }, async () => {
  // Two columns meaning "roles allowed to run this command" is how the two sides
  // of the database drift apart. The migration renames the old one; this asserts
  // the rename actually happened rather than the new column being bolted on.
  const { rows } = await pool!.query<{ column_name: string }>(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'guild_command_flags' AND column_name IN ('custom_role_ids', 'allowed_role_ids')"
  );
  assert.deepEqual(rows.map(row => row.column_name), ["allowed_role_ids"]);
});
