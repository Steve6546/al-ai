import { randomUUID } from "node:crypto";
import {
  eventSubjectId,
  INTERNAL_DESTINATIONS,
  isSuppressedByRole,
  signedEvent,
  validateEvent,
  type LogDestination
} from "@al-ai/core";
import { resolveChannel } from "./channel-registry.js";
import type { ConfigCache } from "../storage/config-cache.js";
import type { BotDatabase } from "../storage/database.js";
import type { GuildLoggingConfig } from "../storage/database.js";
import type { LogEnvelope } from "../lib/discord.js";

// GOVERNANCE rule 5: this is the sole log routing point. Handlers may not select
// channels, may not bypass validation, and may not deliver to Discord on their own.
// GOVERNANCE rule 6: one event is written to exactly one destination — the
// category travels as an embed field, never as a second copy in another room.

export type LogRuntime = {
  database: BotDatabase;
  cache: ConfigCache;
  send: (channelId: string, envelope: LogEnvelope, colorOverride?: string) => Promise<boolean>;
  /**
   * Where internal destinations go. Deliberately separate from `send`: a
   * customer's server must never receive AL AI's own errors or security events.
   * Absent means internal destinations are audited but not delivered anywhere.
   */
  sendToDeveloper?: (envelope: LogEnvelope) => Promise<boolean>;
  /**
   * Resolves a member's role IDs, for the operator's role exclusions. Absent
   * means `ignoredRoleIds` is inert rather than wrong.
   */
  resolveMemberRoles?: (guildId: string, userId: string) => Promise<string[]>;
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

  const signature = signedEvent(input.actorId, runtime.hmacSecret, runtime.sourceLayer);
  const envelope: LogEnvelope = {
    ...signature,
    eventId: id,
    category: definition.category,
    severity: definition.severity,
    guildId: input.guildId,
    data: input.data
  };

  // The audit write happens first and unconditionally. It is the internal record
  // of what the bot did, so an operator's log preferences — a muted category, an
  // excluded role, a missing channel — must never be able to suppress it. This is
  // what makes GOVERNANCE rule 12 hold even when logging is switched off.
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

  // An operator can exclude members by role. Both sides count: the member who
  // acted, and the member it happened to. Excluding a bot role should silence
  // what the bots do *and* what is done to them.
  if (await isSuppressedByIgnoredRole(config, input, runtime)) {
    return { eventId: id, destination: definition.category, severity: definition.severity, delivered: false, skipped: "ignored-role" };
  }

  let delivered = false;
  let reason = "no-channel";

  if (INTERNAL_DESTINATIONS.includes(definition.category)) {
    // Never a customer's channel, regardless of what that guild configured.
    delivered = runtime.sendToDeveloper ? await runtime.sendToDeveloper(envelope).catch(() => false) : false;
    reason = delivered ? "developer" : "no-developer-webhook";
  } else {
    const resolution = resolveChannel(config, definition.category, id);
    if (resolution.channelId) {
      // The operator's embed colour is part of the configuration, so it is applied
      // here; without this the setting was saved and silently ignored.
      delivered = await runtime.send(resolution.channelId, envelope, config.embedColor);
    }
    reason = resolution.reason;
  }

  return {
    eventId: id,
    destination: definition.category,
    severity: definition.severity,
    delivered,
    ...(delivered ? {} : { skipped: reason })
  };
}

/**
 * True when either the actor or the subject of this event holds an excluded role.
 * Costs nothing when the guild excluded no roles, which is the common case.
 */
async function isSuppressedByIgnoredRole(
  config: GuildLoggingConfig,
  input: { guildId: string; actorId: string; data: Record<string, unknown> },
  runtime: LogRuntime
): Promise<boolean> {
  if (!config.ignoredRoleIds.length || !runtime.resolveMemberRoles) return false;

  const subjectId = eventSubjectId(input.data);
  // "system" is the bot acting on its own behalf and holds no roles.
  const candidates = [...new Set([input.actorId, subjectId].filter((id): id is string => Boolean(id) && id !== "system"))];

  for (const userId of candidates) {
    const roles = await runtime.resolveMemberRoles(input.guildId, userId).catch(() => []);
    if (isSuppressedByRole(config.ignoredRoleIds, roles)) return true;
  }
  return false;
}
