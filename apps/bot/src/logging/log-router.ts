import { randomUUID } from "node:crypto";
import { signedEvent, validateEvent, type LogDestination } from "@al-ai/core";
import { resolveChannel } from "./channel-registry.js";
import type { ConfigCache } from "../storage/config-cache.js";
import type { BotDatabase } from "../storage/database.js";
import type { LogEnvelope } from "../lib/discord.js";

// GOVERNANCE rule 5: this is the sole log routing point. Handlers may not select
// channels, may not bypass validation, and may not deliver to Discord on their own.
// GOVERNANCE rule 6: one event is written to exactly one destination — the
// category travels as an embed field, never as a second copy in another room.

export type LogRuntime = {
  database: BotDatabase;
  cache: ConfigCache;
  send: (channelId: string, envelope: LogEnvelope, colorOverride?: string) => Promise<boolean>;
  hmacSecret: string;
  encryptionKey: string;
  sourceLayer: string;
};

export type LogOutcome = {
  eventId: string;
  destination: LogDestination;
  severity: "info" | "warning" | "critical";
  delivered: boolean;
  skipped?: string;
};

/**
 * Validates, signs, routes and (when required) audits a single event.
 * Every handler in the bot calls this and nothing else.
 */
export async function logEvent(
  id: string,
  input: { guildId: string; actorId: string; data: Record<string, unknown> },
  runtime: LogRuntime
): Promise<LogOutcome> {
  const definition = validateEvent(id, input.data);
  const config = await runtime.cache.get(input.guildId);
  const resolution = resolveChannel(config, definition.category);

  const signature = signedEvent(input.actorId, runtime.hmacSecret, runtime.sourceLayer);
  const envelope: LogEnvelope = {
    ...signature,
    eventId: id,
    category: definition.category,
    severity: definition.severity,
    guildId: input.guildId,
    data: input.data
  };

  let delivered = false;
  if (resolution.channelId) {
    // The operator's embed colour is part of the configuration, so it is applied
    // here; without this the setting was saved and silently ignored.
    delivered = await runtime.send(resolution.channelId, envelope, config.embedColor);
  }

  // Discord keeps official audit logs for 45 days only, so warning and critical
  // events are additionally written to the append-only internal trail.
  if (definition.severity !== "info") {
    await runtime.database.appendAudit({
      id: randomUUID(),
      guildId: input.guildId,
      severity: definition.severity,
      eventId: id,
      correlationId: signature.correlationId,
      actorHash: signature.actorHash,
      sourceLayer: runtime.sourceLayer,
      payload: input.data,
      encryptionKey: runtime.encryptionKey
    });
  }

  return {
    eventId: id,
    destination: definition.category,
    severity: definition.severity,
    delivered,
    ...(delivered ? {} : { skipped: resolution.reason })
  };
}
