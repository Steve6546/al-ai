export type LogDestination = "member-log" | "moderation-log" | "voice-log" | "message-log" | "server-log" | "bot-log";
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
 * The five destinations an operator chooses channels for. `role-log` was retired:
 * a role being created or renamed is a change to the server's structure, so those
 * events now travel with `server-log` rather than filling a sixth room of their
 * own. A member gaining or losing a role was always `member-log`.
 */
export const logDestinations: readonly LogDestination[] = [
  "member-log",
  "moderation-log",
  "voice-log",
  "message-log",
  "server-log"
] as const;

/**
 * Destinations the operator never configures.
 *
 * `bot-log` carries the `security.*` events and the bot's own failures. It is
 * delivered to the developer webhook instead of a customer's server, so an
 * operator cannot mute the security surface by leaving a channel unset — and a
 * customer never receives AL AI's internal errors.
 */
export const INTERNAL_DESTINATIONS: readonly LogDestination[] = ["bot-log"] as const;

/** Every destination, operator-visible and internal alike. */
export const allDestinations: readonly LogDestination[] = [...logDestinations, ...INTERNAL_DESTINATIONS] as const;

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
  // A warning is a record rather than a Discord mutation, so nothing in the
  // gateway reports it — the command handler writes both of these itself.
  { id: "moderation.clearwarns", category: "moderation-log", requiredFields: ["targetId", "actorId"], severity: "warning" },

  // voice-log
  { id: "voice.join", category: "voice-log", requiredFields: ["memberId", "toChannelId"], severity: "info" },
  { id: "voice.leave", category: "voice-log", requiredFields: ["memberId", "fromChannelId"], severity: "info" },
  { id: "voice.move", category: "voice-log", requiredFields: ["memberId", "fromChannelId", "toChannelId"], severity: "info" },
  { id: "voice.state-change", category: "voice-log", requiredFields: ["memberId", "channelId", "change"], severity: "info" },

  // role-log retired: a role's creation or rename is a change to the server's
  // structure, so these travel with server-log. A member gaining or losing a
  // role stays in member-log, where the operator looks for it.
  { id: "role.create", category: "server-log", requiredFields: ["roleId", "actorId"], severity: "info" },
  { id: "role.update", category: "server-log", requiredFields: ["roleId", "actorId"], severity: "info" },
  { id: "role.delete", category: "server-log", requiredFields: ["roleId", "actorId"], severity: "warning" },

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
  { id: "security.watchdog-down", category: "bot-log", requiredFields: ["component", "silentForMs"], severity: "critical" },
  // Raised when the anti-nuke engine stops a burst of destructive actions. It
  // carries the actor, what they were doing, and how far past the limit they
  // went, so the incident can be reconstructed from the trail alone.
  { id: "security.nuke-prevented", category: "bot-log", requiredFields: ["actorId", "action", "count", "limit"], severity: "critical" }
];

export const eventSchema = new Map(entries.map(entry => [entry.id, entry]));

if (eventSchema.size !== entries.length) throw new Error("Duplicate AL AI event ID detected.");

for (const entry of entries) {
  if (!/^[a-z]+(\.[a-z-]+)+$/.test(entry.id)) throw new Error(`Event ID must use domain.action form: ${entry.id}`);
  if (!allDestinations.includes(entry.category)) throw new Error(`Event ${entry.id} targets an unknown destination.`);
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

export const DEFAULT_CATEGORY_ENABLED = true;

/**
 * GOVERNANCE rule 6 — a destination is live unless the operator explicitly
 * muted it. This default is single-sourced on purpose. The router and the
 * dashboard must agree: previously the dashboard rendered an unset flag as OFF
 * while the router treated it as ON, so a category could look muted and still
 * be logging.
 */
export function isCategoryEnabled(eventFlags: Record<string, boolean> | undefined, category: LogDestination) {
  const flag = eventFlags?.[category];
  return flag === undefined ? DEFAULT_CATEGORY_ENABLED : flag;
}

/**
 * The per-event switch layered over the per-category one.
 *
 * A destination can be on while one kind of event inside it is off — "log
 * messages, but not edits", or "log members, but not nickname churn". The
 * lookup order is event, then category, then the shipped default, so a flag
 * stored by an older version of the dashboard keeps meaning exactly what it
 * meant before.
 */
export function isEventEnabled(
  eventFlags: Record<string, boolean> | undefined,
  category: LogDestination,
  eventId: string
) {
  const eventFlag = eventFlags?.[eventId];
  if (eventFlag !== undefined) return eventFlag;
  return isCategoryEnabled(eventFlags, category);
}

/**
 * The member an event is *about*, as opposed to the one who caused it. Used to
 * decide whether an ignored role applies to either side.
 */
const SUBJECT_FIELDS = ["memberId", "targetId", "userId"] as const;

export function eventSubjectId(data: Record<string, unknown>): string | null {
  for (const field of SUBJECT_FIELDS) {
    const value = data[field];
    if (typeof value === "string" && value) return value;
  }
  return null;
}

/**
 * True when the event should be suppressed because someone involved holds a role
 * the operator excluded. Either the actor or the subject triggers it: an operator
 * excluding a bot role means "stop telling me what the bots do", and that has to
 * cover both the bot acting and the bot being acted upon.
 */
export function isSuppressedByRole(
  ignoredRoleIds: readonly string[] | undefined,
  involvedRoleIds: readonly string[]
): boolean {
  if (!ignoredRoleIds?.length) return false;
  return involvedRoleIds.some(roleId => ignoredRoleIds.includes(roleId));
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
