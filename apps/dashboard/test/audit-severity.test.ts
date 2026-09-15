import test, { after } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type pg from "pg";
import { eventSchema, requireEvent } from "@al-ai/core";
import { appendAudit } from "../server/audit.js";
import { createDatabase, createPool } from "../server/db.js";
import type { Database } from "../server/db.js";
import type { BffEnv } from "../server/env.js";

/**
 * The severity of an audit row is declared once, in `eventSchema`.
 *
 * `appendAudit` used to take severity from its caller, and all seven call sites
 * in `server/index.ts` passed the same literal `"warning"`. So the trail stored
 * a security rejection — `bot.security-rejection`, declared `critical` — as a
 * warning, and the panel rendered it in amber on the activity feed while
 * `countAudit` left it out of the `critical` tally. Nothing failed: the write
 * succeeded, the row existed, and the only wrong thing was the classification.
 *
 * These tests pin the classification to the schema, and they are exhaustive on
 * purpose: every registered event is stored at the severity the schema declares
 * for it, so a new call site cannot introduce a second opinion.
 */

const env = { eventHmacSecret: "test-secret", encryptionKey: "a".repeat(64) } as unknown as BffEnv;

/** A stand-in for the database that records what would have been written. */
function recorder() {
  const written: Array<{ severity: string; eventId: string; sourceLayer: string }> = [];
  const db = {
    appendAudit: async (record: { severity: string; eventId: string; sourceLayer: string }) => {
      written.push(record);
    }
  } as unknown as Database;
  return { db, written };
}

test("a panel-side security rejection is stored at its declared severity", async () => {
  const { db, written } = recorder();

  await appendAudit(db, env, {
    guildId: "900000000000000001",
    eventId: "bot.security-rejection",
    actorId: "100000000000000002",
    payload: { action: "POST /api/guilds/900000000000000001/security", reason: "TIER_BELOW_ADMIN" }
  });

  assert.equal(written.length, 1);
  assert.equal(written[0].severity, requireEvent("bot.security-rejection").severity);
});

test("every registered event is stored at the severity the schema declares", async () => {
  for (const id of eventSchema.keys()) {
    const { db, written } = recorder();

    await appendAudit(db, env, {
      guildId: "900000000000000001",
      eventId: id,
      actorId: "100000000000000002",
      payload: {}
    });

    assert.equal(
      written[0]?.severity,
      requireEvent(id).severity,
      `${id} was stored as ${written[0]?.severity} but the schema declares ${requireEvent(id).severity}`
    );
  }
});

test("an unregistered event is refused instead of stored unclassified", async () => {
  const { db, written } = recorder();

  await assert.rejects(
    () =>
      appendAudit(db, env, {
        guildId: "900000000000000001",
        eventId: "bot.not-a-real-event",
        actorId: "100000000000000002",
        payload: {}
      }),
    /Unregistered event/
  );

  assert.equal(written.length, 0);
});

/* ------------------------------------------------------------------ *
 * The storage leg, against the real database.
 *
 * The tests above prove the severity reaches `db.appendAudit`. They cannot see
 * the INSERT, and a wrong column order there would store a right value in a
 * wrong place. `audit_trail` is append-only — the schema refuses UPDATE and
 * DELETE — so a test that wrote a row could never take it back. This runs the
 * real statement inside a transaction and rolls back, leaving the operator's
 * trail exactly as it was found.
 * ------------------------------------------------------------------ */

// The dashboard reads its configuration from `process.env`, and the test runner
// does not load `.env`. Pull it in so a developer with a running database gets
// this coverage without extra flags.
const envFile = resolve(import.meta.dirname, "../../../.env");
if (!process.env.DATABASE_URL && existsSync(envFile)) process.loadEnvFile(envFile);

const pool = process.env.DATABASE_URL ? createPool(process.env.DATABASE_URL) : null;

let reachable = false;
if (pool) {
  try {
    await pool.query("SELECT 1");
    reachable = true;
  } catch {
    reachable = false;
  }
}

if (pool && !reachable) await pool.end().catch(() => undefined);

after(async () => {
  if (pool && reachable) await pool.end();
});

const liveEnv = { eventHmacSecret: "test-secret", encryptionKey: "a".repeat(64) } as unknown as BffEnv;

test(
  "a live write stores the schema severity in audit_trail",
  { skip: reachable ? false : "no reachable database; start the stack to cover the storage leg" },
  async () => {
    const client = await pool!.connect();
    try {
      await client.query("BEGIN");
      // `createDatabase` only ever calls `pool.query`, so a transaction client
      // presented as a pool runs the real statement inside this transaction.
      const txDb = createDatabase({
        query: (text: string, values?: unknown[]) => client.query(text, values)
      } as unknown as pg.Pool);

      await appendAudit(txDb, liveEnv, {
        guildId: "900000000000000001",
        eventId: "bot.security-rejection",
        actorId: "100000000000000002",
        payload: { action: "POST /api/guilds/900000000000000001/security", reason: "TIER_BELOW_ADMIN" }
      });

      const { rows } = await client.query<{ severity: string; event_id: string; source_layer: string }>(
        "SELECT severity, event_id, source_layer FROM audit_trail WHERE guild_id = $1",
        ["900000000000000001"]
      );

      assert.equal(rows.length, 1);
      assert.equal(rows[0].event_id, "bot.security-rejection");
      assert.equal(rows[0].severity, "critical");
      assert.equal(rows[0].source_layer, "dashboard-bff");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  }
);
