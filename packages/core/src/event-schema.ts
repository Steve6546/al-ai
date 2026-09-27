export type LogDestination =
  | "member-log"
  | "role-log"
  | "channel-log"
  | "message-log"
  | "voice-log"
  | "moderation-log"
  | "server-log"
  | "invite-log"
  | "expression-log"
  | "event-log"
  | "integration-log"
  | "automod-log"
  | "platform-log"
  | "bot-log";
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
 * The thirteen destinations an operator chooses channels for. Each is one
 * section of the logs dashboard, and each carries the events an operator goes
 * there to read: members, roles, channels, messages, voice, moderation,
 * server, invites, expressions, events, integrations, auto-moderation and the
 * live-stage surface.
 *
 * Event ids are stable identities — they are written into the encrypted audit
 * trail — so a recategorisation moves an event between destinations by changing
 * its `category` and never by renaming it. `moderation.ban` still says
 * `moderation.ban`; it is now found under الأعضاء, because a ban is something
 * that happened to a member.
 */
export const logDestinations: readonly LogDestination[] = [
  "member-log",
  "role-log",
  "channel-log",
  "message-log",
  "voice-log",
  "moderation-log",
  "server-log",
  "invite-log",
  "expression-log",
  "event-log",
  "integration-log",
  "automod-log",
  "platform-log"
] as const;

/**
 * The category the one-click log setup files every channel it creates under.
 *
 * Shared between the BFF — which creates them — and anything that has to
 * recognise the setup afterwards, so the two cannot drift apart. In `normal`
 * mode a channel is named after its destination (`member-log`, …), which is
 * already a valid Discord channel name and the key the channel registry routes
 * by, so the operator can read the routing off the channel list itself. In
 * `detailed` mode a channel is named after one record, with the ID's dots
 * replaced by dashes — see `slugifyEvent` in the BFF.
 */
export const LOG_CATEGORY_NAME = "AL AI";

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
  // member-log — الأعضاء (18), in the operator spec's reading order: the
  // arrivals and the Discord-side punishments first, then the profile changes
  // and boosts, then the record-level entries.
  { id: "member.join", category: "member-log", requiredFields: ["memberId"], severity: "info" },
  { id: "member.leave", category: "member-log", requiredFields: ["memberId"], severity: "info" },
  /* The Discord-side punishments. These used to be the whole of moderation-log;
   * they moved here because they answer "what happened to this member", which is
   * the question الأعضاء exists to answer. The ids are unchanged — the audit
   * trail already holds them under these names. */
  { id: "moderation.ban", category: "member-log", requiredFields: ["targetId", "actorId"], severity: "warning" },
  { id: "moderation.unban", category: "member-log", requiredFields: ["targetId", "actorId"], severity: "warning" },
  { id: "moderation.kick", category: "member-log", requiredFields: ["targetId", "actorId"], severity: "warning" },
  { id: "moderation.prison", category: "member-log", requiredFields: ["targetId", "actorId"], severity: "warning" },
  { id: "moderation.unprison", category: "member-log", requiredFields: ["targetId", "actorId"], severity: "info" },
  { id: "moderation.timeout", category: "member-log", requiredFields: ["targetId", "actorId"], severity: "warning" },
  // The gateway reports a timeout being lifted as well as applied, and it reads
  // the actor from Discord's audit log rather than from the command — so a
  // timeout removed in Discord's own client is logged exactly like one removed
  // through `/untimeout`, once, by the same listener.
  { id: "moderation.untimeout", category: "member-log", requiredFields: ["targetId", "actorId"], severity: "info" },
  { id: "moderation.mute", category: "member-log", requiredFields: ["targetId", "actorId"], severity: "warning" },
  { id: "moderation.unmute", category: "member-log", requiredFields: ["targetId", "actorId"], severity: "info" },
  { id: "member.nickname-change", category: "member-log", requiredFields: ["memberId", "before", "after"], severity: "info" },
  { id: "member.avatar-change", category: "member-log", requiredFields: ["memberId"], severity: "info" },
  { id: "member.username-change", category: "member-log", requiredFields: ["memberId", "before", "after"], severity: "info" },
  { id: "member.boost-add", category: "member-log", requiredFields: ["memberId"], severity: "info" },
  { id: "member.boost-remove", category: "member-log", requiredFields: ["memberId"], severity: "info" },
  { id: "moderation.remove", category: "member-log", requiredFields: ["targetId", "actorId"], severity: "warning" },
  // Raised when a brand-new account reaches the server, or one with no shared
  // history. It is a signal for a human, not a punishment: the member is left
  // untouched and the operator decides.
  { id: "member.suspicious-account", category: "member-log", requiredFields: ["memberId", "reason"], severity: "warning" },

  // role-log — الرتب (6)
  // A role's own life cycle: created, changed, removed, and who gained or lost
  // one. Managed roles — the ones an integration or bot owns — are reported
  // under integration-log instead, so that "a bot did this" and "someone did
  // this" stay separable.
  { id: "role.create", category: "role-log", requiredFields: ["roleId", "actorId"], severity: "info" },
  { id: "role.delete", category: "role-log", requiredFields: ["roleId", "actorId"], severity: "warning" },
  { id: "role.update", category: "role-log", requiredFields: ["roleId", "actorId"], severity: "info" },
  { id: "member.role-add", category: "role-log", requiredFields: ["memberId", "roleId"], severity: "info" },
  { id: "member.role-remove", category: "role-log", requiredFields: ["memberId", "roleId"], severity: "info" },
  { id: "role.managed-change", category: "role-log", requiredFields: ["roleId", "actorId"], severity: "info" },

  // channel-log — القنوات (7)
  { id: "server.channel-create", category: "channel-log", requiredFields: ["channelId", "actorId"], severity: "info" },
  { id: "server.channel-delete", category: "channel-log", requiredFields: ["channelId", "actorId"], severity: "warning" },
  { id: "server.channel-update", category: "channel-log", requiredFields: ["channelId", "actorId"], severity: "info" },
  // Reported alongside `server.channel-update` when the change was to the
  // permission overwrites, because "a channel was edited" and "who can see it
  // changed" are different questions.
  { id: "channel.permission-update", category: "channel-log", requiredFields: ["channelId", "actorId"], severity: "warning" },
  { id: "thread.create", category: "channel-log", requiredFields: ["threadId", "channelId"], severity: "info" },
  { id: "thread.delete", category: "channel-log", requiredFields: ["threadId"], severity: "warning" },
  { id: "thread.update", category: "channel-log", requiredFields: ["threadId"], severity: "info" },

  // message-log — الرسائل (9)
  { id: "message.delete", category: "message-log", requiredFields: ["messageId", "channelId"], severity: "info" },
  // Reported when a deleted message carried attachments. Discord gives no
  // notice for a deleted file, so the names are held in the message cache while
  // the message lives and read back here.
  { id: "message.delete-attachment", category: "message-log", requiredFields: ["messageId", "channelId"], severity: "info" },
  { id: "message.edit", category: "message-log", requiredFields: ["messageId", "channelId"], severity: "info" },
  { id: "message.bulk-delete", category: "message-log", requiredFields: ["channelId", "count"], severity: "warning" },
  { id: "message.pin", category: "message-log", requiredFields: ["channelId", "messageId"], severity: "info" },
  { id: "message.unpin", category: "message-log", requiredFields: ["channelId", "messageId"], severity: "info" },
  { id: "message.reaction-add", category: "message-log", requiredFields: ["messageId", "channelId", "emoji"], severity: "info" },
  { id: "message.reaction-remove", category: "message-log", requiredFields: ["messageId", "channelId", "emoji"], severity: "info" },
  { id: "message.reaction-clear", category: "message-log", requiredFields: ["messageId", "channelId"], severity: "info" },

  // voice-log — الصوت (17)
  { id: "voice.join", category: "voice-log", requiredFields: ["memberId", "toChannelId"], severity: "info" },
  { id: "voice.leave", category: "voice-log", requiredFields: ["memberId", "fromChannelId"], severity: "info" },
  /* A channel change is one of two events, and the gateway cannot tell them
   * apart: a moderator's move and the member's own move raise the identical
   * VoiceStateUpdate. `voice.move` is the moderator's move, attributed by
   * reading the MEMBER_MOVE audit entry Discord writes for it; without that
   * probe every move would read as the member's own. */
  { id: "voice.move", category: "voice-log", requiredFields: ["memberId", "fromChannelId", "toChannelId"], severity: "warning" },
  { id: "voice.self-move", category: "voice-log", requiredFields: ["memberId", "fromChannelId", "toChannelId"], severity: "info" },
  /* The eight mute and deafen transitions, split by who flipped the switch.
   * Discord reports server-side and self-side toggles as one field each, and
   * collapsing them into a single `voice.state-change` made "who muted this
   * person" unreadable — a moderator's mute and a member's own mute need
   * different follow-up, so they are separate events now.
   *
   * Each fires only on the true transition, never on the unchanged state: a
   * member joining a channel already server-muted raises `voice.join` and
   * nothing else. */
  { id: "voice.server-mute", category: "voice-log", requiredFields: ["memberId", "channelId"], severity: "warning" },
  { id: "voice.server-unmute", category: "voice-log", requiredFields: ["memberId", "channelId"], severity: "info" },
  { id: "voice.server-deafen", category: "voice-log", requiredFields: ["memberId", "channelId"], severity: "warning" },
  { id: "voice.server-undeafen", category: "voice-log", requiredFields: ["memberId", "channelId"], severity: "info" },
  { id: "voice.self-mute", category: "voice-log", requiredFields: ["memberId", "channelId"], severity: "info" },
  { id: "voice.self-unmute", category: "voice-log", requiredFields: ["memberId", "channelId"], severity: "info" },
  { id: "voice.self-deafen", category: "voice-log", requiredFields: ["memberId", "channelId"], severity: "info" },
  { id: "voice.self-undeafen", category: "voice-log", requiredFields: ["memberId", "channelId"], severity: "info" },
  /* Screen and camera sharing — self-stream and self-video are the two fields
   * the gateway carries for them, and each transitions independently. */
  { id: "voice.stream-start", category: "voice-log", requiredFields: ["memberId", "channelId"], severity: "info" },
  { id: "voice.stream-end", category: "voice-log", requiredFields: ["memberId", "channelId"], severity: "info" },
  { id: "voice.camera-on", category: "voice-log", requiredFields: ["memberId", "channelId"], severity: "info" },
  { id: "voice.camera-off", category: "voice-log", requiredFields: ["memberId", "channelId"], severity: "info" },
  /* A moderator's disconnect, same attribution problem as the move: Discord
   * writes a MEMBER_DISCONNECT audit entry, which is the only signal that the
   * member did not simply leave. */
  { id: "voice.disconnect", category: "voice-log", requiredFields: ["memberId", "fromChannelId"], severity: "warning" },

  // moderation-log — الإشراف (6)
  /* The moderator's own decisions, per the operator spec: the three warn
   * operations plus the block and blacklist pair. Each writes a row the gateway
   * cannot see, so the command handler is the only thing that can report them,
   * and each names the moderator who decided.
   *
   * Version 5 swapped this section's members for the last time: block and the
   * blacklist pair returned from `bot-log`, while the two server-wide wipes and
   * `down-expired` moved the other way. The IDs are unchanged — only the
   * `category` moved, so stored audit rows and stored event flags keep reading
   * exactly as before.
   *
   * `moderation.unblock` stays internal: the operator list is six wide and does
   * not name it, and lifting a block is the resumption of a normal state rather
   * than a decision worth a section slot. Its audit rows are still written.
   *
   * The role change a punishment causes is reported separately by Discord as
   * `member.role-add`, and that is deliberate rather than duplicated here: this
   * section answers "what did a moderator decide", which the role change alone
   * cannot say — a role can be added by hand, by another bot, or by a join, and
   * only one of those is a punishment. */
  { id: "moderation.warn", category: "moderation-log", requiredFields: ["targetId", "actorId"], severity: "warning" },
  { id: "moderation.delwarn", category: "moderation-log", requiredFields: ["targetId", "actorId"], severity: "warning" },
  { id: "moderation.clearwarns", category: "moderation-log", requiredFields: ["targetId", "actorId"], severity: "warning" },
  { id: "moderation.block", category: "moderation-log", requiredFields: ["targetId", "actorId"], severity: "warning" },
  { id: "moderation.blacklist", category: "moderation-log", requiredFields: ["targetId", "actorId"], severity: "critical" },
  { id: "moderation.unblacklist", category: "moderation-log", requiredFields: ["targetId", "actorId"], severity: "info" },

  // server-log — السيرفر (7)
  // Each comes from `GuildUpdate`, which hands back both the old and the new
  // guild, so before/after is always available. Version 5 split the boost tier
  // by direction — a tier rising and a tier falling are different news — and
  // added the banner, which Discord reports in the same audit entry as the
  // icon. `afk-change` and `system-channel-change` moved to `bot-log`: real
  // events, still emitted, but outside the operator's seven.
  { id: "server.settings-change", category: "server-log", requiredFields: [], severity: "info" },
  { id: "server.name-change", category: "server-log", requiredFields: ["before", "after"], severity: "info" },
  { id: "server.icon-change", category: "server-log", requiredFields: [], severity: "info" },
  { id: "server.banner-change", category: "server-log", requiredFields: [], severity: "info" },
  { id: "server.vanity-url-change", category: "server-log", requiredFields: [], severity: "info" },
  { id: "server.boost-tier-up", category: "server-log", requiredFields: ["before", "after"], severity: "info" },
  { id: "server.boost-tier-down", category: "server-log", requiredFields: ["before", "after"], severity: "warning" },

  // invite-log — الدعوات (3)
  { id: "server.invite-create", category: "invite-log", requiredFields: ["inviteCode", "actorId"], severity: "info" },
  { id: "invite.delete", category: "invite-log", requiredFields: ["inviteCode"], severity: "info" },
  // Reported when a member arrives through a tracked invite: the tracker holds
  // the guild's invites and matches the join against the one whose use count
  // moved. `invite.expire` — a derived guess Discord never announces — was
  // retired in version 5 to make room; its old audit rows keep the raw id.
  { id: "invite.use", category: "invite-log", requiredFields: ["inviteCode", "memberId"], severity: "info" },

  // expression-log — الإيموجي والاستيكرز (6)
  { id: "server.expression-create", category: "expression-log", requiredFields: ["expressionId", "actorId"], severity: "info" },
  { id: "server.expression-delete", category: "expression-log", requiredFields: ["expressionId", "actorId"], severity: "info" },
  { id: "emoji.update", category: "expression-log", requiredFields: ["expressionId"], severity: "info" },
  { id: "sticker.create", category: "expression-log", requiredFields: ["expressionId"], severity: "info" },
  { id: "sticker.delete", category: "expression-log", requiredFields: ["expressionId"], severity: "warning" },
  { id: "sticker.update", category: "expression-log", requiredFields: ["expressionId"], severity: "info" },

  // event-log — الأحداث (7)
  { id: "scheduled-event.create", category: "event-log", requiredFields: ["eventId"], severity: "info" },
  { id: "scheduled-event.delete", category: "event-log", requiredFields: ["eventId"], severity: "warning" },
  { id: "scheduled-event.update", category: "event-log", requiredFields: ["eventId"], severity: "info" },
  { id: "scheduled-event.start", category: "event-log", requiredFields: ["eventId"], severity: "info" },
  { id: "scheduled-event.complete", category: "event-log", requiredFields: ["eventId"], severity: "info" },
  { id: "scheduled-event.user-add", category: "event-log", requiredFields: ["eventId", "memberId"], severity: "info" },
  { id: "scheduled-event.user-remove", category: "event-log", requiredFields: ["eventId", "memberId"], severity: "info" },

  // integration-log — التكاملات (8)
  // The bots and applications attached to the server, plus the webhooks they
  // and the operators create. `bot.join` and `bot.leave` are a member event
  // where the member is a bot, so they live here rather than under الأعضاء.
  { id: "integration.update", category: "integration-log", requiredFields: ["integrationId"], severity: "info" },
  { id: "webhook.create", category: "integration-log", requiredFields: ["webhookId", "channelId"], severity: "info" },
  { id: "webhook.delete", category: "integration-log", requiredFields: ["webhookId", "channelId"], severity: "warning" },
  { id: "webhook.update", category: "integration-log", requiredFields: ["webhookId", "channelId"], severity: "info" },
  { id: "bot.join", category: "integration-log", requiredFields: ["memberId"], severity: "info" },
  { id: "bot.leave", category: "integration-log", requiredFields: ["memberId"], severity: "info" },
  // The two managed-role events. A managed role belongs to an integration, so
  // its arrival and departure are reported here next to the integration that
  // owns it; a *change* to one is still `role.managed-change` under الرتب.
  { id: "bot.role-create", category: "integration-log", requiredFields: ["roleId"], severity: "info" },
  { id: "bot.role-remove", category: "integration-log", requiredFields: ["roleId"], severity: "info" },

  // automod-log — الأوتو مود (7)
  { id: "automod.rule-create", category: "automod-log", requiredFields: ["ruleId"], severity: "info" },
  { id: "automod.rule-delete", category: "automod-log", requiredFields: ["ruleId"], severity: "warning" },
  { id: "automod.rule-update", category: "automod-log", requiredFields: ["ruleId"], severity: "info" },
  // The four outcomes Discord reports when a rule fires — which, taken together,
  // *are* the spam watch: a rule detecting spam or repeats expresses itself as
  // one of these actions. Each names the member and the channel, which is what
  // an operator needs to review a block.
  { id: "automod.alert", category: "automod-log", requiredFields: ["memberId", "channelId"], severity: "warning" },
  { id: "automod.block-message", category: "automod-log", requiredFields: ["memberId", "channelId"], severity: "warning" },
  { id: "automod.timeout", category: "automod-log", requiredFields: ["memberId", "channelId"], severity: "warning" },
  { id: "automod.member-block", category: "automod-log", requiredFields: ["memberId"], severity: "warning" },

  // platform-log — المنصة (6)
  // The live-stage surface: stage channels and the speakers in them.
  { id: "stage.create", category: "platform-log", requiredFields: ["stageId", "channelId"], severity: "info" },
  { id: "stage.delete", category: "platform-log", requiredFields: ["stageId"], severity: "warning" },
  { id: "stage.update", category: "platform-log", requiredFields: ["stageId"], severity: "info" },
  { id: "stage.speaker", category: "platform-log", requiredFields: ["stageId", "memberId"], severity: "info" },
  { id: "stage.suppress", category: "platform-log", requiredFields: ["stageId", "memberId"], severity: "info" },
  { id: "stage.request-speak", category: "platform-log", requiredFields: ["stageId", "memberId"], severity: "info" },

  // bot-log — the internal surface an operator never configures.
  { id: "bot.command-success", category: "bot-log", requiredFields: ["command"], severity: "info" },
  { id: "bot.command-failure", category: "bot-log", requiredFields: ["command", "reason"], severity: "critical" },
  { id: "bot.gateway-throttle", category: "bot-log", requiredFields: ["queued", "windowMs"], severity: "warning" },
  { id: "bot.security-rejection", category: "bot-log", requiredFields: ["action", "reason"], severity: "critical" },
  { id: "bot.health", category: "bot-log", requiredFields: ["state"], severity: "info" },
  /* The state-based punishments. Version 5 moved `block`, `blacklist` and
   * `unblacklist` back to moderation-log, leaving here `unblock` — the one the
   * operator list does not name — plus `down`/`undown`. In exchange the two
   * server-wide wipes and `down-expired` arrived from moderation-log, and
   * `afk-change`/`system-channel-change` arrived from server-log: real events,
   * still emitted and still audited, just outside the operator's sections.
   * IDs are unchanged across every move. */
  { id: "moderation.unblock", category: "bot-log", requiredFields: ["targetId", "actorId"], severity: "info" },
  { id: "moderation.down", category: "bot-log", requiredFields: ["targetId", "actorId"], severity: "critical" },
  { id: "moderation.undown", category: "bot-log", requiredFields: ["targetId", "actorId"], severity: "info" },
  /* The same outcome as `moderation.undown`, reached by a timer instead of a
   * moderator — so it carries no `actorId`. Naming the moderator who applied the
   * punishment would put a person in the log who did not lift it. */
  { id: "moderation.down-expired", category: "bot-log", requiredFields: ["targetId"], severity: "info" },
  // The two server-wide wipes carry no `targetId`: there is no member to name,
  // and inventing one would put a fabricated id in the operator's log.
  { id: "moderation.clearallwarns", category: "bot-log", requiredFields: ["actorId"], severity: "critical" },
  { id: "moderation.clearallpunishments", category: "bot-log", requiredFields: ["actorId"], severity: "critical" },
  // The two guild settings the operator's seven does not carry. Discord reports
  // them in the same GuildUpdate audit entry as the events that stayed.
  { id: "server.afk-change", category: "bot-log", requiredFields: [], severity: "info" },
  { id: "server.system-channel-change", category: "bot-log", requiredFields: [], severity: "info" },

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
  // A domain may itself be hyphenated — `scheduled-event.create` — because the
  // domain is a Discord concept name, not a single word.
  if (!/^[a-z][a-z-]*(\.[a-z-]+)+$/.test(entry.id)) throw new Error(`Event ID must use domain.action form: ${entry.id}`);
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
 * mutes it. This default is single-sourced on purpose. The router and the
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
 * Guards the "one purpose per channel" rule: a channel must not be bound twice,
 * whether the two bindings are both sections, both events, or one of each.
 *
 * A channel shared by a section and one of its own events is harmless to route —
 * the event binding would resolve to the same room — but it is still rejected,
 * because the operator's intent in binding an event on its own is separation. A
 * duplicate that achieves nothing but confusion is not a configuration worth
 * saving, and the error names both claimants so the operator can see which one
 * to clear.
 */
export function assertUniqueChannelAssignment(
  sectionChannels: Partial<Record<LogDestination, string>>,
  eventChannels: Record<string, string> = {}
) {
  const seen = new Map<string, string>();
  for (const [destination, channelId] of Object.entries(sectionChannels) as [LogDestination, string][]) {
    if (!channelId) continue;
    const previous = seen.get(channelId);
    if (previous) throw new Error(`Channel ${channelId} is assigned to both ${previous} and ${destination}.`);
    seen.set(channelId, destination);
  }
  for (const [eventId, channelId] of Object.entries(eventChannels)) {
    if (!channelId) continue;
    const previous = seen.get(channelId);
    if (previous) throw new Error(`Channel ${channelId} is assigned to both ${previous} and ${eventId}.`);
    seen.set(channelId, eventId);
  }
  return true;
}
