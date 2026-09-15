import test from "node:test";
import assert from "node:assert/strict";
import { eventSchema, requireEvent } from "@al-ai/core";
import { appendAudit } from "../server/audit.js";
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
