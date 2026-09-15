import { randomUUID } from "node:crypto";
import { encryptSecret, requireEvent, signActor } from "@al-ai/core";
import type { Database } from "./db.js";
import type { BffEnv } from "./env.js";

/**
 * Append-only internal audit trail.
 *
 * Discord keeps official audit logs for 45 days only, so the events recorded
 * here must outlive that window. Payloads are encrypted with AES-256-GCM before
 * they reach the database: the trail records that something happened and who
 * did it, without storing raw user content.
 *
 * The severity is not a parameter. It is declared once per event in
 * `eventSchema`, and this function reads it from there. It used to be supplied
 * by each caller, and all seven call sites passed the same literal `"warning"`
 * — so a security rejection, declared `critical`, was stored as a warning and
 * rendered amber on the activity feed while `countAudit` left it out of its
 * `critical` tally. A caller cannot get this wrong now, because a caller cannot
 * state it: the field is gone from the record type.
 *
 * Unlike the bot's `log-router`, this writes every event it is handed, `info`
 * included. These rows are the record of what an operator changed through the
 * panel, and Discord has no audit entry equivalent to a settings save, so
 * severity classifies the row here — it does not decide whether it exists.
 */
export async function appendAudit(
  db: Database,
  env: BffEnv,
  record: {
    guildId: string | null;
    eventId: string;
    actorId: string;
    correlationId?: string;
    sourceLayer?: string;
    payload: Record<string, unknown>;
  }
) {
  // Throws on an unregistered id rather than storing a row the schema cannot
  // describe. Only the severity is read: the dashboard's payloads are written
  // for the panel's own screens, not for the bot's `requiredFields` contract.
  const { severity } = requireEvent(record.eventId);

  await db.appendAudit({
    id: randomUUID(),
    guildId: record.guildId,
    severity,
    eventId: record.eventId,
    correlationId: record.correlationId ?? randomUUID(),
    actorHash: signActor(record.actorId, env.eventHmacSecret),
    sourceLayer: record.sourceLayer ?? "dashboard-bff",
    payloadCiphertext: encryptSecret(JSON.stringify(record.payload), env.encryptionKey)
  });
}
