import pg from "pg";
import type { LoggingSettings, CustomizationSettings } from "@al-ai/core";
import { DEFAULT_CUSTOMIZATION, DEFAULT_EMBED_COLOR, SESSION_MAX_AGE_SECONDS } from "@al-ai/core";

const { Pool } = pg;

export type SessionRecord = {
  id: string;
  discordUserId: string;
  discordUsername: string;
  /** Discord avatar hash; null means the account uses a default avatar. */
  discordAvatar: string | null;
  accessTokenCiphertext: string;
  scopes: string;
  expiresAt: Date;
};

export function createPool(databaseUrl: string) {
  const pool = new Pool({ connectionString: databaseUrl, max: 10, idleTimeoutMillis: 30_000 });
  pool.on("error", error => console.error("AL AI database pool error", error));
  return pool;
}

export type Database = ReturnType<typeof createDatabase>;

export function createDatabase(pool: pg.Pool) {
  return {
    async ping() {
      await pool.query("SELECT 1");
      return true;
    },

    async upsertGuild(guild: { id: string; name: string; iconUrl: string | null; memberCount: number; botPresent: boolean }) {
      await pool.query(
        `INSERT INTO guilds (id, name, icon_url, member_count, bot_present, updated_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (id) DO UPDATE
           SET name = EXCLUDED.name,
               icon_url = EXCLUDED.icon_url,
               member_count = EXCLUDED.member_count,
               bot_present = EXCLUDED.bot_present,
               updated_at = now()`,
        [guild.id, guild.name, guild.iconUrl, guild.memberCount, guild.botPresent]
      );
    },

    async getGuild(guildId: string) {
      const { rows } = await pool.query<{ id: string; name: string; icon_url: string | null; member_count: number; bot_present: boolean }>(
        `SELECT id, name, icon_url, member_count, bot_present FROM guilds WHERE id = $1`,
        [guildId]
      );
      const row = rows[0];
      if (!row) return null;
      return { id: row.id, name: row.name, iconUrl: row.icon_url, memberCount: row.member_count, botPresent: row.bot_present };
    },

    async getTierRoles(guildId: string) {
      const { rows } = await pool.query<{ owner_role_id: string; head_admin_role_id: string; admin_role_id: string; moderator_role_id: string }>(
        `SELECT owner_role_id, head_admin_role_id, admin_role_id, moderator_role_id FROM guild_role_tiers WHERE guild_id = $1`,
        [guildId]
      );
      const row = rows[0];
      if (!row) return null;
      return {
        owner: row.owner_role_id,
        head_admin: row.head_admin_role_id,
        admin: row.admin_role_id,
        moderator: row.moderator_role_id
      } as Record<"owner" | "head_admin" | "admin" | "moderator", string>;
    },

    /**
     * GOVERNANCE rule 3: tiers are bound to configurable Role IDs, never to User
     * IDs. Until this row exists every actor resolves to `null` and the
     * dashboard denies access by default.
     */
    async saveTierRoles(guildId: string, tiers: Record<"owner" | "head_admin" | "admin" | "moderator", string | null>) {
      await pool.query(
        `INSERT INTO guild_role_tiers (guild_id, owner_role_id, head_admin_role_id, admin_role_id, moderator_role_id, updated_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (guild_id) DO UPDATE
           SET owner_role_id = EXCLUDED.owner_role_id,
               head_admin_role_id = EXCLUDED.head_admin_role_id,
               admin_role_id = EXCLUDED.admin_role_id,
               moderator_role_id = EXCLUDED.moderator_role_id,
               updated_at = now()`,
        [guildId, tiers.owner, tiers.head_admin, tiers.admin, tiers.moderator]
      );
    },

    /**
     * The bot's per-guild appearance. Only the three fields the bot can actually
     * apply to Discord are stored — see `CustomizationSettings` in @al-ai/core.
     */
    async getCustomization(guildId: string): Promise<CustomizationSettings> {
      const { rows } = await pool.query<{ nickname: string | null; role_color: string | null; role_icon_url: string | null }>(
        `SELECT nickname, role_color, role_icon_url FROM guild_customization WHERE guild_id = $1`,
        [guildId]
      );
      const row = rows[0];
      // No row means the guild is still on the shipped defaults, not "blank".
      return {
        nickname: row?.nickname ?? DEFAULT_CUSTOMIZATION.nickname,
        roleColor: row?.role_color ?? DEFAULT_CUSTOMIZATION.roleColor,
        roleIconUrl: row?.role_icon_url ?? DEFAULT_CUSTOMIZATION.roleIconUrl
      };
    },

    async saveCustomization(guildId: string, settings: CustomizationSettings) {
      await pool.query(
        `INSERT INTO guild_customization (guild_id, nickname, role_color, role_icon_url, updated_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (guild_id) DO UPDATE
           SET nickname = EXCLUDED.nickname,
               role_color = EXCLUDED.role_color,
               role_icon_url = EXCLUDED.role_icon_url,
               updated_at = now()`,
        [guildId, settings.nickname, settings.roleColor, settings.roleIconUrl]
      );
    },

    async getLogging(guildId: string): Promise<LoggingSettings> {
      const { rows } = await pool.query(
        `SELECT enabled, global_channel_id, ignored_channel_ids, embed_color, event_flags, category_channels
         FROM guild_logging WHERE guild_id = $1`,
        [guildId]
      );
      const row = rows[0];
      if (!row) {
        return { enabled: false, globalChannelId: null, ignoredChannelIds: [], embedColor: DEFAULT_EMBED_COLOR, eventFlags: {}, categoryChannels: {} };
      }
      return {
        enabled: row.enabled,
        globalChannelId: row.global_channel_id,
        ignoredChannelIds: row.ignored_channel_ids ?? [],
        embedColor: row.embed_color,
        eventFlags: row.event_flags ?? {},
        categoryChannels: row.category_channels ?? {}
      };
    },

    async saveLogging(guildId: string, settings: LoggingSettings) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO guild_logging (guild_id, enabled, global_channel_id, ignored_channel_ids, embed_color, event_flags, category_channels, updated_at)
           VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb, $7::jsonb, now())
           ON CONFLICT (guild_id) DO UPDATE
             SET enabled = EXCLUDED.enabled,
                 global_channel_id = EXCLUDED.global_channel_id,
                 ignored_channel_ids = EXCLUDED.ignored_channel_ids,
                 embed_color = EXCLUDED.embed_color,
                 event_flags = EXCLUDED.event_flags,
                 category_channels = EXCLUDED.category_channels,
                 updated_at = now()`,
          [
            guildId,
            settings.enabled,
            settings.globalChannelId,
            JSON.stringify(settings.ignoredChannelIds),
            settings.embedColor,
            JSON.stringify(settings.eventFlags),
            JSON.stringify(settings.categoryChannels)
          ]
        );
        // Mirror the routing table so the one-channel-per-destination rule is
        // enforced by the database, not only by application code.
        await client.query(`DELETE FROM guild_log_channels WHERE guild_id = $1`, [guildId]);
        for (const [destination, channelId] of Object.entries(settings.categoryChannels)) {
          if (!channelId) continue;
          await client.query(`INSERT INTO guild_log_channels (guild_id, destination, channel_id) VALUES ($1, $2, $3)`, [
            guildId,
            destination,
            channelId
          ]);
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async createSession(input: {
      id: string;
      discordUserId: string;
      discordUsername: string;
      discordAvatar?: string | null;
      accessTokenCiphertext: string;
      scopes: string;
    }) {
      const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000);
      await pool.query(
        `INSERT INTO oauth_sessions (id, discord_user_id, discord_username, discord_avatar, access_token_ciphertext, scopes, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          input.id,
          input.discordUserId,
          input.discordUsername,
          input.discordAvatar ?? null,
          input.accessTokenCiphertext,
          input.scopes,
          expiresAt
        ]
      );
      return expiresAt;
    },

    async getSession(id: string): Promise<SessionRecord | null> {
      const { rows } = await pool.query(
        `SELECT id, discord_user_id, discord_username, discord_avatar, access_token_ciphertext, scopes, expires_at
         FROM oauth_sessions WHERE id = $1 AND expires_at > now()`,
        [id]
      );
      const row = rows[0];
      if (!row) return null;
      return {
        id: row.id,
        discordUserId: row.discord_user_id,
        discordUsername: row.discord_username,
        discordAvatar: row.discord_avatar ?? null,
        accessTokenCiphertext: row.access_token_ciphertext,
        scopes: row.scopes,
        expiresAt: row.expires_at
      };
    },

    async touchSession(id: string) {
      await pool.query(`UPDATE oauth_sessions SET last_seen_at = now() WHERE id = $1`, [id]);
    },

    async deleteSession(id: string) {
      await pool.query(`DELETE FROM oauth_sessions WHERE id = $1`, [id]);
    },

    async purgeExpiredSessions() {
      const { rowCount } = await pool.query(`DELETE FROM oauth_sessions WHERE expires_at <= now()`);
      return rowCount ?? 0;
    },

    /**
     * Consumes a nonce. Returns false when the nonce was already used, which
     * the caller must treat as a replay attempt.
     */
    async consumeNonce(nonce: string, layer: string, ttlMs: number) {
      const { rowCount } = await pool.query(
        `INSERT INTO security_nonces (nonce, layer, expires_at) VALUES ($1, $2, $3) ON CONFLICT (nonce) DO NOTHING`,
        [nonce, layer, new Date(Date.now() + ttlMs)]
      );
      return (rowCount ?? 0) > 0;
    },

    async purgeExpiredNonces() {
      const { rowCount } = await pool.query(`DELETE FROM security_nonces WHERE expires_at <= now()`);
      return rowCount ?? 0;
    },

    async appendAudit(record: { id: string; guildId: string | null; severity: string; eventId: string; correlationId: string; actorHash: string; sourceLayer: string; payloadCiphertext: string }) {
      await pool.query(
        `INSERT INTO audit_trail (id, guild_id, severity, event_id, correlation_id, actor_hash, source_layer, payload_ciphertext)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [record.id, record.guildId, record.severity, record.eventId, record.correlationId, record.actorHash, record.sourceLayer, record.payloadCiphertext]
      );
    },

    async upsertHealth(guildId: string, state: string, botPresent: boolean, gatewayEvents: number, uniqueUsers = 0) {
      await pool.query(
        `INSERT INTO guild_health (guild_id, bot_present, gateway_events_last_minute, unique_users, state, checked_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (guild_id) DO UPDATE
           SET bot_present = EXCLUDED.bot_present,
               gateway_events_last_minute = EXCLUDED.gateway_events_last_minute,
               unique_users = EXCLUDED.unique_users,
               state = EXCLUDED.state,
               checked_at = now()`,
        [guildId, botPresent, gatewayEvents, uniqueUsers, state]
      );
    },

    async countGuilds() {
      const { rows } = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM guilds`);
      return Number(rows[0]?.count ?? 0);
    },

    /**
     * Unique users reported by the bot. Every guild row carries the same
     * process-wide figure, so the maximum — not the sum — is the real total.
     */
    async countUniqueUsers() {
      const { rows } = await pool.query<{ count: string }>(
        `SELECT COALESCE(max(unique_users), 0)::text AS count FROM guild_health`
      );
      return Number(rows[0]?.count ?? 0);
    },

    async listGuildIds() {
      const { rows } = await pool.query<{ id: string }>(`SELECT id FROM guilds`);
      return rows.map(row => row.id);
    },

    async getCommandFlags(guildId: string) {
      const { rows } = await pool.query<{ command: string; enabled: boolean }>(
        `SELECT command, enabled FROM guild_command_flags WHERE guild_id = $1`,
        [guildId]
      );
      return new Map(rows.map(row => [row.command, row.enabled]));
    },

    async saveCommandFlag(guildId: string, command: string, enabled: boolean, minimumTier: string) {
      await pool.query(
        `INSERT INTO guild_command_flags (guild_id, command, enabled, minimum_tier, updated_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (guild_id, command) DO UPDATE
           SET enabled = EXCLUDED.enabled, minimum_tier = EXCLUDED.minimum_tier, updated_at = now()`,
        [guildId, command, enabled, minimumTier]
      );
    },

    /**
     * Reads the append-only audit trail. The payload stays encrypted in the
     * database; the caller decrypts it only after re-authorizing the reader.
     */
    async listAudit(guildId: string, limit = 100) {
      const { rows } = await pool.query<{
        id: string;
        severity: string;
        event_id: string;
        correlation_id: string;
        actor_hash: string;
        source_layer: string;
        payload_ciphertext: string;
        created_at: Date;
      }>(
        `SELECT id, severity, event_id, correlation_id, actor_hash, source_layer, payload_ciphertext, created_at
         FROM audit_trail WHERE guild_id = $1 ORDER BY created_at DESC LIMIT $2`,
        [guildId, limit]
      );
      return rows;
    },

    /** Security-domain rows only: the intrusion-detection feed. */
    async listSecurityEvents(guildId: string, limit = 50) {
      const { rows } = await pool.query<{
        id: string;
        event_id: string;
        correlation_id: string;
        source_layer: string;
        payload_ciphertext: string;
        created_at: Date;
      }>(
        `SELECT id, event_id, correlation_id, source_layer, payload_ciphertext, created_at
         FROM audit_trail
         WHERE guild_id = $1 AND event_id LIKE 'security.%'
         ORDER BY created_at DESC LIMIT $2`,
        [guildId, limit]
      );
      return rows;
    },

    async listTokens() {
      const { rows } = await pool.query<{ id: string; label: string; fingerprint: string; created_at: Date; guild_ids: string[] }>(
        `SELECT t.id, t.label, t.fingerprint, t.created_at,
                COALESCE(array_agg(g.guild_id) FILTER (WHERE g.guild_id IS NOT NULL), '{}') AS guild_ids
         FROM bot_tokens t
         LEFT JOIN bot_token_guilds g ON g.token_id = t.id
         GROUP BY t.id
         ORDER BY t.created_at DESC`
      );
      return rows;
    },

    async createToken(input: { id: string; label: string; ciphertext: string; fingerprint: string; guildIds: string[] }) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO bot_tokens (id, label, token_ciphertext, fingerprint) VALUES ($1, $2, $3, $4)`,
          [input.id, input.label, input.ciphertext, input.fingerprint]
        );
        for (const guildId of input.guildIds) {
          await client.query(`INSERT INTO bot_token_guilds (token_id, guild_id) VALUES ($1, $2)`, [input.id, guildId]);
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async deleteToken(id: string) {
      const { rowCount } = await pool.query(`DELETE FROM bot_tokens WHERE id = $1`, [id]);
      return (rowCount ?? 0) > 0;
    },

    async countAudit(guildId: string) {
      const { rows } = await pool.query<{ total: string; critical: string }>(
        `SELECT count(*)::text AS total,
                count(*) FILTER (WHERE severity = 'critical')::text AS critical
         FROM audit_trail WHERE guild_id = $1`,
        [guildId]
      );
      return { total: Number(rows[0]?.total ?? 0), critical: Number(rows[0]?.critical ?? 0) };
    },

    async close() {
      await pool.end();
    }
  };
}
