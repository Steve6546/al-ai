/**
 * GOVERNANCE rule 17 — the message log must be able to answer "what was said?".
 *
 * Discord only includes the full body on `messageCreate`. By the time
 * `messageDelete` fires the content is usually gone, so a short-lived in-memory
 * cache is kept per channel. It is deliberately:
 *   - bounded (cap per channel) and time-limited (TTL), so it cannot grow forever;
 *   - never persisted, so deleted content is not duplicated into storage;
 *   - bot-message aware, so the bot's own logs never feed back into the cache.
 */

export type CachedMessage = {
  id: string;
  guildId: string;
  channelId: string;
  authorId: string;
  content: string;
  /** The message's own timestamp, kept for the log entry. */
  createdAt: number;
};

type Entry = CachedMessage & { /** When this entry entered the cache; drives the TTL. */ cachedAt: number };

export type MessageCacheOptions = {
  maxPerChannel?: number;
  ttlMs?: number;
  now?: () => number;
};

const DEFAULT_MAX_PER_CHANNEL = 200;
const DEFAULT_TTL_MS = 30 * 60 * 1000;

export function createMessageCache(options: MessageCacheOptions = {}) {
  const now = options.now ?? (() => Date.now());
  const maxPerChannel = options.maxPerChannel ?? DEFAULT_MAX_PER_CHANNEL;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;

  /** channelId -> (messageId -> entry). Map preserves insertion order for cheap FIFO eviction. */
  const channels = new Map<string, Map<string, Entry>>();

  function evict(channelId: string) {
    const bucket = channels.get(channelId);
    if (!bucket) return;
    const current = now();

    for (const [id, entry] of bucket) {
      if (current - entry.cachedAt > ttlMs) bucket.delete(id);
    }
    while (bucket.size > maxPerChannel) {
      const oldest = bucket.keys().next().value;
      if (oldest === undefined) break;
      bucket.delete(oldest);
    }
    if (!bucket.size) channels.delete(channelId);
  }

  return {
    put(message: CachedMessage) {
      let bucket = channels.get(message.channelId);
      if (!bucket) {
        bucket = new Map();
        channels.set(message.channelId, bucket);
      }
      bucket.set(message.id, { ...message, cachedAt: now() });
      evict(message.channelId);
    },

    get(channelId: string, messageId: string): CachedMessage | undefined {
      const entry = channels.get(channelId)?.get(messageId);
      if (!entry) return undefined;
      if (now() - entry.cachedAt > ttlMs) {
        channels.get(channelId)?.delete(messageId);
        return undefined;
      }
      const { cachedAt: _cachedAt, ...message } = entry;
      return message;
    },

    size() {
      let total = 0;
      for (const bucket of channels.values()) total += bucket.size;
      return total;
    },

    channelCount() {
      return channels.size;
    },

    clear() {
      channels.clear();
    }
  };
}

export type MessageCache = ReturnType<typeof createMessageCache>;
