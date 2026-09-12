export type LogDestination = "member-log" | "moderation-log" | "voice-log" | "role-log" | "message-log" | "server-log" | "bot-log";
export type Severity = "info" | "warning" | "critical";
export type EventDefinition = { id: string; category: LogDestination; requiredFields: string[]; severity: Severity };

/**
 * Colour an embed uses until an operator picks one. It is the single source for
 * the dashboard, the bot's logging config and the database default, so the three
 * can never drift apart. Deliberately a neutral blue: the old violet (#7c3aed)
 * belonged to the retired theme.
 */
export const DEFAULT_EMBED_COLOR = "#3b82f6";

/** Embed colours per severity, used when an event does not carry its own. */
export const SEVERITY_EMBED_COLOR: Record<Severity, number> = {
  info: 0x3b82f6,
  warning: 0xf59e0b,
  critical: 0xdc2626
};

/**
 * The seven destinations are fixed. Every Event ID uses the `domain.action`
 * form and must be registered here exactly once.
 */
export const logDestinations: readonly LogDestination[] = [
  "member-log",
  "moderation-log",
  "voice-log",
  "role-log",
  "message-log",
  "server-log",
  "bot-log"
] as const;

const entries: EventDefinition[] = [
  // member-log
  { id: "member.join", category: "member-log", requiredFields: ["memberId"], severity: "info" },
  { id: "member.leave", category: "member-log", requiredFields: ["memberId"], severity: "info" },
  { id: "member.nickname-change", category: "member-log", requiredFields: ["memberId", "before", "after"], severity: "info" },
  { id: "member.role-add", category: "member-log", requiredFields: ["memberId", "roleId"], severity: "info" },
  { id: "member.role-remove", category: "member-log", requiredFields: ["memberId", "roleId"], severity: "info" },

  // moderation-log
  { id: "moderation.ban", category: "moderation-log", requiredFields: ["targetId", "actorId"], severity: "warning" },
  { id: "moderation.unban", category: "moderation-log", requiredFields: ["targetId", "actorId"], severity: "warning" },
  { id: "moderation.kick", category: "moderation-log", requiredFields: ["targetId", "actorId"], severity: "warning" },
  { id: "moderation.timeout", category: "moderation-log", requiredFields: ["targetId", "actorId"], severity: "warning" },
  { id: "moderation.warn", category: "moderation-log", requiredFields: ["targetId", "actorId"], severity: "warning" },

  // voice-log
  { id: "voice.join", category: "voice-log", requiredFields: ["memberId", "toChannelId"], severity: "info" },
  { id: "voice.leave", category: "voice-log", requiredFields: ["memberId", "fromChannelId"], severity: "info" },
  { id: "voice.move", category: "voice-log", requiredFields: ["memberId", "fromChannelId", "toChannelId"], severity: "info" },
  { id: "voice.state-change", category: "voice-log", requiredFields: ["memberId", "channelId", "change"], severity: "info" },

  // role-log
  { id: "role.create", category: "role-log", requiredFields: ["roleId", "actorId"], severity: "info" },
  { id: "role.update", category: "role-log", requiredFields: ["roleId", "actorId"], severity: "info" },
  { id: "role.delete", category: "role-log", requiredFields: ["roleId", "actorId"], severity: "warning" },

  // message-log
  { id: "message.delete", category: "message-log", requiredFields: ["messageId", "channelId"], severity: "info" },
  { id: "message.edit", category: "message-log", requiredFields: ["messageId", "channelId"], severity: "info" },
  { id: "message.bulk-delete", category: "message-log", requiredFields: ["channelId", "count"], severity: "warning" },

  // server-log
  { id: "server.channel-create", category: "server-log", requiredFields: ["channelId", "actorId"], severity: "info" },
  { id: "server.channel-update", category: "server-log", requiredFields: ["channelId", "actorId"], severity: "info" },
  { id: "server.channel-delete", category: "server-log", requiredFields: ["channelId", "actorId"], severity: "warning" },
  { id: "server.invite-create", category: "server-log", requiredFields: ["inviteCode", "actorId"], severity: "info" },
  { id: "server.expression-create", category: "server-log", requiredFields: ["expressionId", "actorId"], severity: "info" },
  { id: "server.expression-delete", category: "server-log", requiredFields: ["expressionId", "actorId"], severity: "info" },

  // bot-log
  { id: "bot.command-success", category: "bot-log", requiredFields: ["command"], severity: "info" },
  { id: "bot.command-failure", category: "bot-log", requiredFields: ["command", "reason"], severity: "critical" },
  { id: "bot.gateway-throttle", category: "bot-log", requiredFields: ["queued", "windowMs"], severity: "warning" },
  { id: "bot.security-rejection", category: "bot-log", requiredFields: ["action", "reason"], severity: "critical" },
  { id: "bot.health", category: "bot-log", requiredFields: ["state"], severity: "info" },

  // security.* — the intrusion-detection surface from the governance contract.
  // Every one of these is critical by definition and is written to bot-log and
  // the append-only audit trail together.
  { id: "security.invalid-role-attempt", category: "bot-log", requiredFields: ["action", "actorId"], severity: "critical" },
  { id: "security.hmac-invalid", category: "bot-log", requiredFields: ["layer", "reason"], severity: "critical" },
  { id: "security.abnormal-request", category: "bot-log", requiredFields: ["endpoint", "pattern"], severity: "critical" },
  { id: "security.revoked-credential", category: "bot-log", requiredFields: ["credentialType", "reason"], severity: "critical" },
  { id: "security.audit-tamper", category: "bot-log", requiredFields: ["attempt", "target"], severity: "critical" },
  { id: "security.watchdog-down", category: "bot-log", requiredFields: ["component", "silentForMs"], severity: "critical" }
];

export const eventSchema = new Map(entries.map(entry => [entry.id, entry]));

if (eventSchema.size !== entries.length) throw new Error("Duplicate AL AI event ID detected.");

for (const entry of entries) {
  if (!/^[a-z]+(\.[a-z-]+)+$/.test(entry.id)) throw new Error(`Event ID must use domain.action form: ${entry.id}`);
  if (!logDestinations.includes(entry.category)) throw new Error(`Event ${entry.id} targets an unknown destination.`);
}

export function requireEvent(id: string): EventDefinition {
  const event = eventSchema.get(id);
  if (!event) throw new Error(`Unregistered event: ${id}`);
  return event;
}

export function validateEvent(id: string, data: Record<string, unknown>) {
  const definition = requireEvent(id);
  const absent = definition.requiredFields.filter(field => data[field] === undefined || data[field] === null);
  if (absent.length) throw new Error(`Missing event fields: ${absent.join(", ")}`);
  return definition;
}

export function eventsByCategory(category: LogDestination) {
  return entries.filter(entry => entry.category === category).map(entry => entry.id);
}

/**
 * GOVERNANCE rule 6 — one destination per event, and a destination is live
 * unless the operator explicitly muted it.
 *
 * This default is single-sourced on purpose. The router and the dashboard must
 * agree: previously the dashboard rendered an unset flag as OFF while the router
 * treated it as ON, so a category could look muted and still be logging.
 */
export const DEFAULT_CATEGORY_ENABLED = true;

export function isCategoryEnabled(eventFlags: Record<string, boolean> | undefined, category: LogDestination) {
  const flag = eventFlags?.[category];
  return flag === undefined ? DEFAULT_CATEGORY_ENABLED : flag;
}

/**
 * Guards the "one destination per event" rule: a resolved routing table must
 * map each destination to at most one channel, and must not reuse a channel
 * across destinations where the operator configured exclusivity.
 */
export function assertUniqueChannelAssignment(channels: Partial<Record<LogDestination, string>>) {
  const seen = new Map<string, LogDestination>();
  for (const [destination, channelId] of Object.entries(channels) as [LogDestination, string][]) {
    if (!channelId) continue;
    const previous = seen.get(channelId);
    if (previous) throw new Error(`Channel ${channelId} is assigned to both ${previous} and ${destination}.`);
    seen.set(channelId, destination);
  }
  return true;
}
