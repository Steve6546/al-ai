import { DEFAULT_EMBED_COLOR, isEventEnabled, type LogDestination } from "@al-ai/core";
import type { GuildLoggingConfig } from "../storage/database.js";

// GOVERNANCE rule 4: the sole place where a log destination is turned into a
// channel ID. Handlers may never name a channel, and IDs are never hard-coded in
// source. This function reads `guild_logging` — the only row that also carries
// the global-channel fallback. The `guild_log_channels` table is a constraint
// mirror used by the dashboard to enforce one-channel-per-destination; it is
// never a read source.

export type ChannelResolution =
  | { channelId: string; reason: "event" | "category" | "global" }
  | { channelId: null; reason: "disabled" | "category-muted" | "no-channel" | "ignored" };

/**
 * Resolves the channel one event should be delivered to.
 *
 * `eventId` is optional so a caller that only knows the destination still gets
 * the destination-level answer; passing it lets a single event be muted inside
 * an otherwise live category, and lets a single event carry its own channel.
 *
 * The order is event, then section, then global, and it does not branch on the
 * mode: `mode` decides only what the one-click setup creates, never how a
 * binding resolves. That keeps an operator's intent intact across a switch — a
 * section channel set in `normal` mode still serves the events that have no
 * binding of their own after a switch to `detailed`.
 */
export function resolveChannel(
  config: GuildLoggingConfig,
  destination: LogDestination,
  eventId?: string
): ChannelResolution {
  if (!config.enabled) return { channelId: null, reason: "disabled" };
  // Uses the shared default so this can never disagree with the dashboard switch.
  if (!isEventEnabled(config.eventFlags, destination, eventId ?? "")) {
    return { channelId: null, reason: "category-muted" };
  }

  const eventChannel = eventId ? config.eventChannels[eventId] : undefined;
  const perCategory = config.categoryChannels[destination];
  const channelId = eventChannel ?? perCategory ?? config.globalChannelId ?? null;

  if (!channelId) return { channelId: null, reason: "no-channel" };
  if (config.ignoredChannelIds.includes(channelId)) return { channelId: null, reason: "ignored" };

  return { channelId, reason: eventChannel ? "event" : perCategory ? "category" : "global" };
}

/**
 * The embed colour one event should be drawn in.
 *
 * Resolution order is the event, then the section, then the global colour, then
 * the shipped default — the same order the dashboard offers the choice in, so a
 * colour the operator picks for one record never silently repaints the whole
 * section. An invalid stored value falls back rather than poisoning the embed:
 * Discord would refuse it and the event would not land at all.
 */
export function resolveEmbedColor(
  config: Pick<GuildLoggingConfig, "embedColor" | "categoryColors" | "eventColors">,
  destination: LogDestination,
  eventId?: string
): string {
  const eventColor = eventId ? config.eventColors[eventId] : undefined;
  if (typeof eventColor === "string" && /^#[0-9a-f]{6}$/i.test(eventColor)) return eventColor.toLowerCase();
  const categoryColor = config.categoryColors?.[destination];
  if (typeof categoryColor === "string" && /^#[0-9a-f]{6}$/i.test(categoryColor)) return categoryColor.toLowerCase();
  if (typeof config.embedColor === "string" && /^#[0-9a-f]{6}$/i.test(config.embedColor)) return config.embedColor.toLowerCase();
  return DEFAULT_EMBED_COLOR;
}
