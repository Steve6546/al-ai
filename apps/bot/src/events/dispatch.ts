import type { BotEvent } from "../lib/discord.js";
import type { EventPipeline, Priority } from "../runtime/event-pipeline.js";
import { logEvent, type LogRuntime } from "../logging/log-router.js";

/**
 * Maps normalised bot events onto the log router.
 *
 * This module never talks to Discord and never picks a channel: it decides
 * priority and timing only. Routing stays in logEvent().
 */

const priorityOf: Record<BotEvent["type"], Priority> = {
  "client.ready": 4,
  "client.error": 0,
  "guild.joined": 2,
  "member.join": 2,
  "member.leave": 2,
  "member.nickname-change": 2,
  "member.username-change": 2,
  "member.avatar-change": 2,
  "member.boost-add": 2,
  "member.boost-remove": 2,
  "member.suspicious-account": 1,
  "member.role-add": 2,
  "member.role-remove": 2,
  "moderation.ban": 1,
  "moderation.unban": 1,
  "moderation.kick": 1,
  "moderation.timeout": 1,
  // Same priority as the timeout it lifts: both are moderation actions on a
  // member, and an operator reading the log wants them side by side rather than
  // separated by everything Discord happened to report in between.
  "moderation.untimeout": 1,
  "voice.join": 3,
  "voice.leave": 3,
  "voice.move": 3,
  "voice.self-move": 3,
  // A moderator's drag and a moderator's disconnect sit with the moderation
  // actions they are, ahead of the member's own voice churn.
  "voice.disconnect": 1,
  "voice.server-mute": 1,
  "voice.server-unmute": 1,
  "voice.server-deafen": 1,
  "voice.server-undeafen": 1,
  "voice.self-mute": 3,
  "voice.self-unmute": 3,
  "voice.self-deafen": 3,
  "voice.self-undeafen": 3,
  "voice.stream-start": 3,
  "voice.stream-end": 3,
  "voice.camera-on": 3,
  "voice.camera-off": 3,
  "role.create": 2,
  "role.update": 2,
  "role.delete": 2,
  "role.managed-change": 2,
  "message.delete": 2,
  "message.edit": 2,
  "message.bulk-delete": 1,
  "message.delete-attachment": 2,
  "message.pin": 2,
  "message.unpin": 2,
  // Reactions are the highest-volume surface the bot subscribes to. They take
  // the lowest priority so a burst of them never pushes a punishment or a
  // deletion behind itself — and the throttle coalesces a scroll of reacts.
  "message.reaction-add": 3,
  "message.reaction-remove": 3,
  "message.reaction-clear": 3,
  "server.channel-create": 2,
  "server.channel-update": 2,
  "server.channel-delete": 2,
  "server.name-change": 2,
  "server.icon-change": 2,
  "server.settings-change": 2,
  "server.vanity-url-change": 2,
  "server.boost-tier-up": 2,
  "server.boost-tier-down": 2,
  "server.banner-change": 2,
  "server.afk-change": 2,
  "server.system-channel-change": 2,
  "channel.permission-update": 1,
  "thread.create": 2,
  "thread.update": 2,
  "thread.delete": 2,
  "server.invite-create": 2,
  "invite.delete": 2,
  "invite.use": 2,
  "server.expression-create": 2,
  "server.expression-delete": 2,
  "emoji.update": 2,
  "sticker.create": 2,
  "sticker.update": 2,
  "sticker.delete": 2,
  "scheduled-event.create": 2,
  "scheduled-event.delete": 2,
  "scheduled-event.update": 2,
  "scheduled-event.start": 2,
  "scheduled-event.complete": 2,
  "scheduled-event.user-add": 3,
  "scheduled-event.user-remove": 3,
  "bot.join": 2,
  "bot.leave": 2,
  "integration.update": 2,
  "webhook.create": 2,
  "webhook.update": 2,
  "webhook.delete": 2,
  "bot.role-create": 2,
  "bot.role-remove": 2,
  "automod.rule-create": 2,
  "automod.rule-update": 2,
  "automod.rule-delete": 2,
  // An auto-moderation action is a punishment Discord applied, so it travels with
  // the moderation traffic rather than the configuration traffic.
  "automod.block-message": 1,
  "automod.alert": 1,
  "automod.timeout": 1,
  "automod.member-block": 1,
  "stage.create": 2,
  "stage.update": 2,
  "stage.delete": 2,
  "stage.speaker": 3,
  "stage.request-speak": 3,
  "stage.suppress": 3,
  "interaction.status": 4
};

/**
 * Events that carry no guild context and are therefore not routed as logs.
 *
 * `guild.joined` is lifecycle, not an activity: the role the bot creates for
 * itself is what shows up in server-log via Discord's own audit log, so logging
 * the join as well would duplicate it.
 */
const nonLoggable = new Set<BotEvent["type"]>(["client.ready", "client.error", "guild.joined", "interaction.status"]);

export type DispatchDeps = {
  pipeline: EventPipeline;
  runtime: LogRuntime;
  onHealth?: (state: string, gatewayEvents: number) => void;
  /** Called once per guild the bot is added to, before any settings are offered. */
  onGuildJoined?: (guildId: string, name: string) => void;
};

export function createDispatcher({ pipeline, runtime, onHealth, onGuildJoined }: DispatchDeps) {
  pipeline.onThrottled(queued => {
    void logEvent("bot.gateway-throttle", { guildId: "*", actorId: "system", data: { queued, windowMs: 60_000 } }, runtime).catch(() => undefined);
  });

  pipeline.onJobFailed((error, job) => {
    console.error(`AL AI pipeline job failed (${job.key ?? "unkeyed"})`, error);
  });

  return function dispatch(event: BotEvent) {
    if (nonLoggable.has(event.type)) {
      if (event.type === "client.ready") onHealth?.("online", pipeline.stats().eventsLastMinute);
      if (event.type === "guild.joined") onGuildJoined?.(event.guildId, event.name);
      return;
    }

    const { type, guildId, ...data } = event as BotEvent & { guildId: string };
    const actorId = "actorId" in data && typeof data.actorId === "string" ? data.actorId : "system";

    const run = async () => {
      await logEvent(type, { guildId, actorId, data: data as Record<string, unknown> }, runtime);
    };

    // Voice churn is coalesced: a member hopping rooms produces one entry.
    // The window comes from the pipeline, which takes it from config.
    if (type.startsWith("voice.")) {
      pipeline.debounce(3, `voice:${guildId}:${(data as { memberId?: string }).memberId ?? "?"}`, pipeline.voiceDebounceMs, { run, key: type });
      return;
    }

    pipeline.enqueue(priorityOf[type] ?? 2, { run, key: type });
  };
}
