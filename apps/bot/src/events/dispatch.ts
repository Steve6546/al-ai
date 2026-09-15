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
  "member.role-add": 2,
  "member.role-remove": 2,
  "moderation.ban": 1,
  "moderation.unban": 1,
  "moderation.kick": 1,
  "moderation.timeout": 1,
  "voice.join": 3,
  "voice.leave": 3,
  "voice.move": 3,
  "voice.state-change": 3,
  "role.create": 2,
  "role.update": 2,
  "role.delete": 2,
  "message.delete": 2,
  "message.edit": 2,
  "message.bulk-delete": 1,
  "server.channel-create": 2,
  "server.channel-update": 2,
  "server.channel-delete": 2,
  "server.invite-create": 2,
  "server.expression-create": 2,
  "server.expression-delete": 2,
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
