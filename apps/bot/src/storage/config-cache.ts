import type { GuildLoggingConfig } from "./database.js";

type Entry = { value: GuildLoggingConfig; expiresAt: number };

/**
 * Short-lived cache in front of guild_logging.
 *
 * Log bursts are common (a raid, a mass role change), and every event must not
 * cost a database round trip. A 30 second TTL keeps dashboard saves effective
 * almost immediately while absorbing the burst.
 */
export class ConfigCache {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly loader: (guildId: string) => Promise<GuildLoggingConfig>,
    private readonly ttlMs = 30_000,
    private readonly now: () => number = Date.now
  ) {}

  async get(guildId: string): Promise<GuildLoggingConfig> {
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
