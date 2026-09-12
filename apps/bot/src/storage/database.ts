import pg from "pg";
import {
  DEFAULT_CUSTOMIZATION,
  DEFAULT_EMBED_COLOR,
  encryptSecret,
  isTier,
  normaliseCustomization,
  signActor,
  type CustomizationSettings,
  type LogDestination
} from "@al-ai/core";

const { Pool } = pg;

export type GuildLoggingConfig = {
  enabled: boolean;
  globalChannelId: string | null;
  ignoredChannelIds: string[];
  embedColor: string;
  eventFlags: Record<string, boolean>;
  categoryChannels: Partial<Record<LogDestination, string>>;
};

export const emptyLoggingConfig: GuildLoggingConfig = {
  enabled: false,
  globalChannelId: null,
  ignoredChannelIds: [],
  embedColor: DEFAULT_EMBED_COLOR,
  eventFlags: {},
  categoryChannels: {}
};

export type BotDatabase = ReturnType<typeof createBotDatabase>;

export function createBotDatabase(databaseUrl: string) {
  const pool = new Pool({ connectionString: databaseUrl, max: 5, idleTimeoutMillis: 30_000 });
  pool.on("error", error => console.error("AL AI bot database pool error", error));

  return {
    async ping() {
      await pool.query("SELECT 1");
      return true;
    },

    async loadLogging(guildId: string): Promise<GuildLoggingConfig> {
      const { rows } = await pool.query(
        `SELECT enabled, global_channel_id, ignored_channel_ids, embed_color, event_flags, category_channels
         FROM guild_logging WHERE guild_id = $1`,
        [guildId]
      );
      const row = rows[0];
      if (!row) return { ...emptyLoggingConfig };
      return {
        enabled: row.enabled,
        globalChannelId: row.global_channel_id,
        ignoredChannelIds: row.ignored_channel_ids ?? [],
        embedColor: row.embed_color,
        eventFlags: row.event_flags ?? {},
        categoryChannels: row.category_channels ?? {}
      };
    },

    async loadTierRoles(guildId: string) {
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
     * The dashboard's customization screen, read by the customization sync.
     *
     * The shape matches `CustomizationSettings` in @al-ai/core exactly, and the
     * value is normalised here with the same helper the BFF used on write, so the
     * bot can never act on a value the dashboard would have refused.
     */
    async loadCustomization(guildId: string): Promise<CustomizationSettings> {
      const { rows } = await pool.query<{ nickname: string | null; role_color: string | null; role_icon_url: string | null }>(
        `SELECT nickname, role_color, role_icon_url FROM guild_customization WHERE guild_id = $1`,
        [guildId]
      );
      const row = rows[0];
      // No row means the guild still carries the shipped defaults.
      return normaliseCustomization({
        nickname: row?.nickname ?? DEFAULT_CUSTOMIZATION.nickname,
        roleColor: row?.role_color ?? DEFAULT_CUSTOMIZATION.roleColor,
        roleIconUrl: row?.role_icon_url ?? DEFAULT_CUSTOMIZATION.roleIconUrl
      });
    },

    /**
     * The dashboard's General Commands switches, including the per-command
     * minimum tier the operator may have overridden.
     *
     * A command with no row is enabled at its registry tier, matching what the
     * dashboard shows. `minimumTier` is null when no override is stored, so the
     * caller falls back to the registry value.
     */
    async loadCommandFlags(guildId: string) {
      const { rows } = await pool.query<{ command: string; enabled: boolean; minimum_tier: string | null }>(
        `SELECT command, enabled, minimum_tier FROM guild_command_flags WHERE guild_id = $1`,
        [guildId]
      );
      return new Map(
        rows.map(row => [
          row.command,
          { enabled: row.enabled, minimumTier: isTier(row.minimum_tier) ? row.minimum_tier : null }
        ])
      );
    },

    // NOTE: there is deliberately no `resolveChannel` reader here.
    // `guild_log_channels` is a constraint-only mirror: the dashboard writes it
    // inside the same transaction as `guild_logging.category_channels` purely so
    // the database enforces "one channel per destination". Routing is always read
    // from `guild_logging` (see `loadLogging`), because only that row carries the
    // global-channel fallback. Reading the mirror here would silently return null
    // for every guild that relies on the global channel.

    async appendAudit(record: {
      id: string;
      guildId: string;
      severity: string;
      eventId: string;
      correlationId: string;
      actorHash: string;
      sourceLayer: string;
      payload: Record<string, unknown>;
      encryptionKey: string;
    }) {
      await pool.query(
        `INSERT INTO audit_trail (id, guild_id, severity, event_id, correlation_id, actor_hash, source_layer, payload_ciphertext)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          record.id,
          record.guildId,
          record.severity,
          record.eventId,
          record.correlationId,
          record.actorHash,
          record.sourceLayer,
          encryptSecret(JSON.stringify(record.payload), record.encryptionKey)
        ]
      );
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

    hashActor(actorId: string, secret: string) {
      return signActor(actorId, secret);
    },

    /**
     * GOVERNANCE rule 10: single-use nonces for inbound inter-layer calls.
     * Returns true only for the first use; a replay collides on the primary key
     * and returns false.
     */
    async consumeNonce(nonce: string, layer: string, expiresAt: Date) {
      const { rowCount } = await pool.query(
        `INSERT INTO security_nonces (nonce, layer, expires_at) VALUES ($1, $2, $3)
         ON CONFLICT (nonce) DO NOTHING`,
        [nonce, layer, expiresAt]
      );
      return rowCount === 1;
    },

    async pruneNonces() {
      await pool.query(`DELETE FROM security_nonces WHERE expires_at < now()`);
    },

    /**
     * GOVERNANCE rule 13: the watchdog needs a real liveness signal for the audit
     * trail, not an assumption. This proves the trail is reachable and readable.
     */
    async probeAuditTrail() {
      await pool.query(`SELECT 1 FROM audit_trail LIMIT 1`);
      return true;
    },

    async close() {
      await pool.end();
    }
  };
}
