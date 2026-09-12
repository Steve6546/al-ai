import { isCategoryEnabled, type LogDestination } from "@al-ai/core";
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

export function resolveChannel(config: GuildLoggingConfig, destination: LogDestination): ChannelResolution {
  if (!config.enabled) return { channelId: null, reason: "disabled" };
  // Uses the shared default so this can never disagree with the dashboard switch.
  if (!isCategoryEnabled(config.eventFlags, destination)) return { channelId: null, reason: "category-muted" };

  const channelId = config.categoryChannels[destination] ?? config.globalChannelId ?? null;
  if (!channelId) return { channelId: null, reason: "no-channel" };
  if (config.ignoredChannelIds.includes(channelId)) return { channelId: null, reason: "ignored" };

  return { channelId, reason: config.categoryChannels[destination] ? "category" : "global" };
}
