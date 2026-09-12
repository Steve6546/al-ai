import { randomUUID } from "node:crypto";
import { encryptSecret, signActor } from "@al-ai/core";
import type { Database } from "./db.js";
import type { BffEnv } from "./env.js";

/**
 * Append-only internal audit trail.
 *
 * Discord keeps official audit logs for 45 days only, so warning and critical
 * events must land here. Payloads are encrypted with AES-256-GCM before they
 * reach the database: the trail records that something happened and who did it,
 * without storing raw user content.
 */
export async function appendAudit(
  db: Database,
  env: BffEnv,
  record: {
    guildId: string | null;
    severity: "info" | "warning" | "critical";
    eventId: string;
    actorId: string;
    correlationId?: string;
    sourceLayer?: string;
    payload: Record<string, unknown>;
  }
) {
  await db.appendAudit({
    id: randomUUID(),
    guildId: record.guildId,
    severity: record.severity,
    eventId: record.eventId,
    correlationId: record.correlationId ?? randomUUID(),
    actorHash: signActor(record.actorId, env.eventHmacSecret),
    sourceLayer: record.sourceLayer ?? "dashboard-bff",
    payloadCiphertext: encryptSecret(JSON.stringify(record.payload), env.encryptionKey)
  });
}
