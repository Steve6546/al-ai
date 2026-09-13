import { isEventEnabled, type LogDestination } from "@al-ai/core";
import type { GuildLoggingConfig } from "../storage/database.js";

// GOVERNANCE rule 4: the sole place where a log destination is turned into a
// channel ID. Handlers may never name a channel, and IDs are never hard-coded in
// source. This function reads `guild_logging` — the only row that also carries
// the global-channel fallback. The `guild_log_channels` table is a constraint
// mirror used by the dashboard to enforce one-channel-per-destination; it is
// never a read source.

export type ChannelResolution =
  | { channelId: string; reason: "category" | "global" }
  | { channelId: null; reason: "disabled" | "category-muted" | "no-channel" | "ignored" };

/**
 * Resolves the channel one event should be delivered to.
 *
 * `eventId` is optional so a caller that only knows the destination still gets
 * the destination-level answer; passing it lets a single event be muted inside
 * an otherwise live category.
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

  // In single mode the global channel is authoritative and the per-category map
  // is deliberately ignored, so a stale mapping cannot leak an event into a room
  // the operator thought they had left behind.
  const perCategory = config.mode === "granular" ? config.categoryChannels[destination] : undefined;
  const channelId = perCategory ?? config.globalChannelId ?? null;

  if (!channelId) return { channelId: null, reason: "no-channel" };
  if (config.ignoredChannelIds.includes(channelId)) return { channelId: null, reason: "ignored" };

  return { channelId, reason: perCategory ? "category" : "global" };
}
