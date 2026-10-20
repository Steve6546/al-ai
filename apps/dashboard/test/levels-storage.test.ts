import test, { after } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createDatabase, createPool } from "../server/db.js";

/**
 * Integration tests for the levels system's storage: settings round trips,
 * reward conflicts, the sync job state machine and the leaderboard's
 * pagination. These run against the real PostgreSQL instance from
 * `DATABASE_URL` and skip cleanly when there is none — the behaviour under
 * test lives in SQL (unique indexes with NULLs, CHECK constraints, keyset
 * pagination), where a pure unit test cannot reach.
 */

const envFile = resolve(import.meta.dirname, "../../../.env");
if (!process.env.DATABASE_URL && existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

const GUILD_ID = "900000000000000002";
const ROLE_A = "811111111111111111";
const ROLE_B = "822222222222222222";

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

/** The guild row the levels tables' foreign keys hang off. */
async function seedGuild() {
  await pool!.query(
    `INSERT INTO guilds (id, name, bot_present) VALUES ($1, 'Levels Test', true)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
    [GUILD_ID]
  );
}

test("settings round-trip through the database with their ignore lists intact", { skip }, async () => {
  await seedGuild();
  await db!.saveLevelSettings(GUILD_ID, {
    enabled: true,
    textXpEnabled: true,
    voiceXpEnabled: false,
    textXpMin: 10,
    textXpMax: 20,
    voiceXpMin: 2,
    voiceXpMax: 7,
    maxLevelCap: 50,
    resetOnLeave: true,
    textCooldownSeconds: 45,
    voiceMinMembers: 3,
    ignoreMuted: false,
    ignoreDeafened: true,
    ignoreAfk: false,
    notifyLevelUp: true,
    notifyMode: "custom_channel",
    notifyChannelId: "933333333333333333",
    rankCardEnabled: true,
    textLevelUpMessage: "أهلاً {user} في {level}",
    voiceLevelUpMessage: "صوتي {level}",
    roleStacking: true,
    roleMultipliers: [{ id: "822222222222222222", multiplier: 2 }],
    channelMultipliers: [{ id: "911111111111111111", multiplier: 1.5 }],
    ignoredTextChannelIds: ["911111111111111111", "912222222222222222"],
    ignoredVoiceChannelIds: ["913333333333333333"],
    ignoredRoleIds: ["822222222222222222"]
  });
  const loaded = await db!.getLevelSettings(GUILD_ID);
  assert.equal(loaded.enabled, true);
  assert.equal(loaded.textCooldownSeconds, 45);
  assert.equal(loaded.textXpMin, 10);
  assert.equal(loaded.textXpMax, 20);
  assert.equal(loaded.voiceXpMax, 7);
  assert.equal(loaded.maxLevelCap, 50);
  assert.equal(loaded.resetOnLeave, true);
  assert.equal(loaded.rankCardEnabled, true);
  assert.deepEqual(loaded.roleMultipliers, [{ id: "822222222222222222", multiplier: 2 }]);
  assert.deepEqual(loaded.channelMultipliers, [{ id: "911111111111111111", multiplier: 1.5 }]);
  assert.equal(loaded.voiceMinMembers, 3);
  assert.equal(loaded.notifyChannelId, "933333333333333333");
  assert.deepEqual(loaded.ignoredTextChannelIds, ["911111111111111111", "912222222222222222"]);
  assert.deepEqual(loaded.ignoredRoleIds, ["822222222222222222"]);
  // A guild with no row reads as the shipped defaults, never as a partial row.
  await pool!.query("DELETE FROM guild_levels WHERE guild_id = $1", [GUILD_ID]);
  const fresh = await db!.getLevelSettings(GUILD_ID);
  assert.equal(fresh.enabled, false);
  assert.equal(fresh.textCooldownSeconds, 120);
});

test("reward creation refuses an exact duplicate instead of writing a second row", { skip }, async () => {
  await seedGuild();
  const created = await db!.createLevelReward(GUILD_ID, { kind: "text", level: 5, voiceLevel: null, roleId: ROLE_A, alwaysKeep: false });
  assert.ok(created);
  // The same rule again: a conflict answer, and still exactly one row.
  const duplicate = await db!.createLevelReward(GUILD_ID, { kind: "text", level: 5, voiceLevel: null, roleId: ROLE_A, alwaysKeep: false });
  assert.equal(duplicate, null);
  const { rows } = await pool!.query(`SELECT COUNT(*)::int AS n FROM level_role_rewards WHERE guild_id = $1 AND kind = 'text'`, [GUILD_ID]);
  assert.equal(rows[0].n, 1);
  // A different role at the same level is a different rule.
  const second = await db!.createLevelReward(GUILD_ID, { kind: "text", level: 5, voiceLevel: null, roleId: ROLE_B, alwaysKeep: false });
  assert.ok(second);
});

test("updating a reward into another rule's shape is a conflict, not a 500", { skip }, async () => {
  await seedGuild();
  const a = await db!.createLevelReward(GUILD_ID, { kind: "voice", level: 3, voiceLevel: null, roleId: ROLE_A, alwaysKeep: false });
  const b = await db!.createLevelReward(GUILD_ID, { kind: "voice", level: 8, voiceLevel: null, roleId: ROLE_B, alwaysKeep: false });
  assert.ok(a && b);
  // Editing B onto A's exact shape (same kind, level AND role) conflicts...
  const clash = await db!.updateLevelReward(GUILD_ID, b!.id, { kind: "voice", level: 3, voiceLevel: null, roleId: ROLE_A, alwaysKeep: false });
  assert.deepEqual(clash, { ok: false, reason: "conflict" });
  // ...while a free shape updates cleanly, and a missing row is its own answer.
  const free = await db!.updateLevelReward(GUILD_ID, b!.id, { kind: "voice", level: 9, voiceLevel: null, roleId: ROLE_B, alwaysKeep: false });
  assert.deepEqual(free, { ok: true });
  const missing = await db!.updateLevelReward(GUILD_ID, "00000000-0000-0000-0000-000000000000", { kind: "text", level: 1, voiceLevel: null, roleId: ROLE_A, alwaysKeep: false });
  assert.deepEqual(missing, { ok: false, reason: "not_found" });
});

test("the sync job machine: create, idempotent re-request, claim, progress, completion", { skip }, async () => {
  await seedGuild();
  const first = await db!.createOrResumeSyncJob(GUILD_ID);
  assert.equal(first.status, "pending");
  // A double-click finds the same open job — no second one appears.
  const again = await db!.createOrResumeSyncJob(GUILD_ID);
  assert.equal(again.id, first.id);
  // Claim (the bot's side is raw SQL from here), progress, complete.
  await pool!.query(`UPDATE level_sync_jobs SET status = 'running', total = 10 WHERE id = $1`, [first.id]);
  await pool!.query(
    `UPDATE level_sync_jobs SET cursor = 'u50', processed = 50, granted = 2, removed = 1 WHERE id = $1`,
    [first.id]
  );
  const latest = await db!.latestSyncJob(GUILD_ID);
  assert.equal(latest?.status, "running");
  assert.equal(latest?.processed, 50);
  await pool!.query(
    `UPDATE level_sync_jobs SET status = 'completed', completed_at = now() WHERE id = $1`,
    [first.id]
  );
  // After completion, a new request opens a NEW job rather than reusing it.
  const fresh = await db!.createOrResumeSyncJob(GUILD_ID);
  assert.notEqual(fresh.id, first.id);
  assert.equal(fresh.status, "pending");
});

test("a failed sync job is resumed from its cursor, never silently duplicated", { skip }, async () => {
  await seedGuild();
  // Clear the machine test's open job, then seed one fresh and fail it.
  await pool!.query(`DELETE FROM level_sync_jobs WHERE guild_id = $1`, [GUILD_ID]);
  const job = await db!.createOrResumeSyncJob(GUILD_ID);
  await pool!.query(
    `UPDATE level_sync_jobs SET status = 'failed', error = 'Discord burst', cursor = 'u99', processed = 99 WHERE id = $1`,
    [job.id]
  );
  const resumed = await db!.createOrResumeSyncJob(GUILD_ID);
  // Same row, back to pending, cursor kept for the continuation.
  assert.equal(resumed.id, job.id);
  assert.equal(resumed.status, "pending");
  assert.equal(resumed.cursor, "u99");
  assert.equal(resumed.processed, 99);
});

test("the leaderboard paginates with a deterministic tiebreak", { skip }, async () => {
  await seedGuild();
  // Two members with the SAME XP: the tiebreak on user_id must make the
  // ordering stable across pages.
  await pool!.query(
    `INSERT INTO user_guild_levels (guild_id, user_id, text_xp, display_name)
     VALUES ($1, 'u000000000000000002', 625, 'ثاني'),
            ($1, 'u000000000000000001', 625, 'أول')
     ON CONFLICT (guild_id, user_id) DO NOTHING`,
    [GUILD_ID]
  );
  const page1 = await db!.levelLeaderboard(GUILD_ID, "text", 1, 0);
  assert.equal(page1.total, 2);
  assert.equal(page1.entries[0]!.userId, "u000000000000000001");
  assert.equal(page1.stats.highestLevel, 1);
  assert.equal(page1.stats.rankedMembers, 2);
  const page2 = await db!.levelLeaderboard(GUILD_ID, "text", 1, 1);
  assert.equal(page2.entries[0]!.userId, "u000000000000000002");
  // The levels come from the formula, not storage: 625 XP is exactly level 1.
  assert.equal(page1.entries[0]!.xp, 625);
});

test("deleting the guild cascades every levels table", { skip }, async () => {
  await seedGuild();
  await db!.createLevelReward(GUILD_ID, { kind: "text", level: 1, voiceLevel: null, roleId: ROLE_A, alwaysKeep: false });
  await pool!.query(
    `INSERT INTO user_guild_levels (guild_id, user_id, text_xp) VALUES ($1, 'u1', 625)`,
    [GUILD_ID]
  );
  await pool!.query("DELETE FROM guilds WHERE id = $1", [GUILD_ID]);
  const rewards = await pool!.query(`SELECT COUNT(*)::int AS n FROM level_role_rewards WHERE guild_id = $1`, [GUILD_ID]);
  const members = await pool!.query(`SELECT COUNT(*)::int AS n FROM user_guild_levels WHERE guild_id = $1`, [GUILD_ID]);
  const jobs = await pool!.query(`SELECT COUNT(*)::int AS n FROM level_sync_jobs WHERE guild_id = $1`, [GUILD_ID]);
  assert.equal(rewards.rows[0].n, 0);
  assert.equal(members.rows[0].n, 0);
  assert.equal(jobs.rows[0].n, 0);
});
