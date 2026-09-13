import type { GuildLoggingConfig } from "./database.js";

type Entry<T> = { value: T; expiresAt: number };

/**
 * Short-lived cache in front of a per-guild settings table.
 *
 * Log bursts are common (a raid, a mass role change), and every event must not
 * cost a database round trip. A 30 second TTL keeps dashboard saves effective
 * almost immediately while absorbing the burst.
 *
 * Generic so the same cache serves both the logging config and the anti-nuke
 * config; the default keeps every existing `new ConfigCache(loader)` call as it
 * was.
 */
export class ConfigCache<T = GuildLoggingConfig> {
  private readonly entries = new Map<string, Entry<T>>();

  constructor(
    private readonly loader: (guildId: string) => Promise<T>,
    private readonly ttlMs = 30_000,
    private readonly now: () => number = Date.now
  ) {}

  async get(guildId: string): Promise<T> {
    const cached = this.entries.get(guildId);
    if (cached && cached.expiresAt > this.now()) return cached.value;
    const value = await this.loader(guildId);
    this.entries.set(guildId, { value, expiresAt: this.now() + this.ttlMs });
    return value;
  }

  invalidate(guildId?: string) {
    if (guildId) this.entries.delete(guildId);
    else this.entries.clear();
  }
}
