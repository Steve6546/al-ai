import test, { after } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createDatabase, createPool } from "../server/db.js";

/**
 * Integration tests for the invites module's settings storage: the round trip
 * through the database, the milestone list surviving as JSONB, and a missing
 * row reading back as the shipped defaults. These run against the real
 * PostgreSQL instance from `DATABASE_URL` and skip cleanly when there is none
 * — the behaviour under test lives in SQL, where a pure unit test cannot reach.
 */

const envFile = resolve(import.meta.dirname, "../../../.env");
if (!process.env.DATABASE_URL && existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

const GUILD_ID = "900000000000000003";
const ROLE_A = "833333333333333331";
const ROLE_B = "833333333333333332";

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

/** The guild row the invites tables' foreign keys hang off. */
async function seedGuild() {
  await pool!.query(
    `INSERT INTO guilds (id, name, bot_present) VALUES ($1, 'Invites Test', true)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
    [GUILD_ID]
  );
}

test("an unconfigured guild reads back as the shipped defaults", { skip }, async () => {
  await seedGuild();
  const settings = await db!.getInviteSettings(GUILD_ID);
  assert.equal(settings.enabled, false);
  assert.equal(settings.fakeAccountDays, 3);
  assert.equal(settings.keepRolesOnLeave, false);
  assert.deepEqual(settings.milestoneRoles, []);
  assert.ok(settings.joinMessage.includes("{inviter.net}"));
});

test("settings round-trip with the milestone list intact", { skip }, async () => {
  await seedGuild();
  const milestones = [
    { id: "ms-1", net: 5, roleId: ROLE_A },
    { id: "ms-2", net: 25, roleId: ROLE_B }
  ];
  await db!.saveInviteSettings(GUILD_ID, {
    enabled: true,
    fakeAccountDays: 7,
    keepRolesOnLeave: true,
    logSelfInvites: false,
    logJoins: true,
    logLeaves: false,
    logMilestones: true,
    joinMessage: "دخل {user} بـ {invite.code}",
    leaveMessage: "خرج {user} — خصم من {inviter}",
    milestoneMessage: "{inviter} وصل {inviter.net}",
    milestoneRoles: milestones
  });

  const settings = await db!.getInviteSettings(GUILD_ID);
  assert.equal(settings.enabled, true);
  assert.equal(settings.fakeAccountDays, 7);
  assert.equal(settings.keepRolesOnLeave, true);
  assert.equal(settings.logSelfInvites, false);
  assert.equal(settings.logLeaves, false);
  assert.equal(settings.joinMessage, "دخل {user} بـ {invite.code}");
  assert.deepEqual(settings.milestoneRoles, milestones);
});

test("a second save overwrites the row instead of duplicating it", { skip }, async () => {
  await seedGuild();
  await db!.saveInviteSettings(GUILD_ID, {
    enabled: true,
    fakeAccountDays: 3,
    keepRolesOnLeave: false,
    logSelfInvites: true,
    logJoins: true,
    logLeaves: true,
    logMilestones: true,
    joinMessage: "",
    leaveMessage: "",
    milestoneMessage: "",
    milestoneRoles: [{ id: "ms-1", net: 5, roleId: ROLE_A }]
  });
  await db!.saveInviteSettings(GUILD_ID, {
    enabled: false,
    fakeAccountDays: 0,
    keepRolesOnLeave: false,
    logSelfInvites: true,
    logJoins: true,
    logLeaves: true,
    logMilestones: true,
    joinMessage: "",
    leaveMessage: "",
    milestoneMessage: "",
    milestoneRoles: []
  });
  const settings = await db!.getInviteSettings(GUILD_ID);
  assert.equal(settings.enabled, false);
  assert.equal(settings.fakeAccountDays, 0);
  assert.deepEqual(settings.milestoneRoles, []);
});
