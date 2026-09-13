import pg from "pg";
import {
  DEFAULT_ANTI_NUKE_CONFIG,
  DEFAULT_CUSTOMIZATION,
  DEFAULT_EMBED_COLOR,
  DEFAULT_LOGGING_MODE,
  encryptSecret,
  isLoggingMode,
  isTier,
  normaliseAntiNukeConfig,
  normaliseCustomization,
  normaliseTierRoles,
  signActor,
  type AntiNukeConfig,
  type CommandConfig,
  type CustomizationSettings,
  type LogDestination,
  type LoggingMode,
  type TierRoles
} from "@al-ai/core";

const { Pool } = pg;

export type GuildLoggingConfig = {
  enabled: boolean;
  mode: LoggingMode;
  globalChannelId: string | null;
  ignoredChannelIds: string[];
  ignoredRoleIds: string[];
  embedColor: string;
  eventFlags: Record<string, boolean>;
  categoryChannels: Partial<Record<LogDestination, string>>;
};

export const emptyLoggingConfig: GuildLoggingConfig = {
  enabled: false,
  mode: DEFAULT_LOGGING_MODE,
  globalChannelId: null,
  ignoredChannelIds: [],
  ignoredRoleIds: [],
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
        `SELECT enabled, mode, global_channel_id, ignored_channel_ids, ignored_role_ids, embed_color, event_flags, category_channels
         FROM guild_logging WHERE guild_id = $1`,
        [guildId]
      );
      const row = rows[0];
      if (!row) return { ...emptyLoggingConfig };
      return {
        enabled: row.enabled,
        // A row written before the mode existed carries no value; falling back to
        // the shared default keeps an old guild behaving exactly as it did.
        mode: isLoggingMode(row.mode) ? row.mode : DEFAULT_LOGGING_MODE,
        globalChannelId: row.global_channel_id,
        ignoredChannelIds: row.ignored_channel_ids ?? [],
        ignoredRoleIds: row.ignored_role_ids ?? [],
        embedColor: row.embed_color,
        eventFlags: row.event_flags ?? {},
        categoryChannels: row.category_channels ?? {}
      };
    },

    /**
     * The guild's role mapping. Two role-ID lists, normalised with the same
     * helper the BFF used on write so the two sides cannot disagree.
     *
     * Returns null only when the guild has no row at all. That is no longer a
     * lockout: the owner tier is automatic, so a guild that never configured
     * anything still works for its owner and Administrators.
     */
    async loadTierRoles(guildId: string): Promise<TierRoles | null> {
      const { rows } = await pool.query<{ admin_role_ids: string[] | null; moderator_role_ids: string[] | null }>(
        `SELECT admin_role_ids, moderator_role_ids FROM guild_role_tiers WHERE guild_id = $1`,
        [guildId]
      );
      const row = rows[0];
      if (!row) return null;
      return normaliseTierRoles({ adminRoleIds: row.admin_role_ids, moderatorRoleIds: row.moderator_role_ids });
    },

    /**
     * The anti-nuke settings for a guild.
     *
     * A guild with no row is disarmed at the shipped defaults, exactly as the
     * dashboard renders it — the two sides read the same `normaliseAntiNukeConfig`,
     * so a value can never mean one thing in the panel and another in the bot.
     */
    async loadSecurity(guildId: string): Promise<AntiNukeConfig> {
      const { rows } = await pool.query<{
        enabled: boolean;
        channel_deletes_per_minute: number;
        bans_per_minute: number;
        role_changes_per_minute: number;
        quarantine_role_id: string | null;
      }>(
        `SELECT enabled, channel_deletes_per_minute, bans_per_minute, role_changes_per_minute, quarantine_role_id
         FROM guild_security WHERE guild_id = $1`,
        [guildId]
      );
      const row = rows[0];
      if (!row) return DEFAULT_ANTI_NUKE_CONFIG;
      return normaliseAntiNukeConfig({
        enabled: row.enabled,
        quarantineRoleId: row.quarantine_role_id,
        limits: {
          channelDeletesPerMinute: row.channel_deletes_per_minute,
          bansPerMinute: row.bans_per_minute,
          roleChangesPerMinute: row.role_changes_per_minute
        }
      });
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
     * The dashboard's General Commands configuration.
     *
     * A command with no row is enabled at its registry defaults, matching what
     * the dashboard shows. Only the keys the guild actually stored are returned,
     * so `normaliseCommandConfig` can fill the rest — this is what keeps the
     * bot and the dashboard from disagreeing about an untouched command.
     */
    async loadCommandFlags(guildId: string) {
      const { rows } = await pool.query<{
        command: string;
        enabled: boolean;
        minimum_tier: string | null;
        dm_on_action: boolean;
        delete_message_days: number;
        custom_role_ids: string[] | null;
      }>(
        `SELECT command, enabled, minimum_tier, dm_on_action, delete_message_days, custom_role_ids
         FROM guild_command_flags WHERE guild_id = $1`,
        [guildId]
      );
      return new Map<string, Partial<CommandConfig>>(
        rows.map(row => [
          row.command,
          {
            name: row.command,
            enabled: row.enabled,
            ...(isTier(row.minimum_tier) ? { allowedLevel: row.minimum_tier } : {}),
            dmOnAction: row.dm_on_action,
            deleteMessageDays: row.delete_message_days,
            customRoleIds: row.custom_role_ids ?? []
          }
        ])
      );
    },

    /* ---------------- Warnings ---------------- */

    /** Records one warning. `/warn` is a record, not a Discord mutation. */
    async addWarning(record: { id: string; guildId: string; userId: string; moderatorId: string; reason: string }) {
      await pool.query(
        `INSERT INTO guild_warnings (id, guild_id, user_id, moderator_id, reason)
         VALUES ($1, $2, $3, $4, $5)`,
        [record.id, record.guildId, record.userId, record.moderatorId, record.reason]
      );
    },

    /** A member's warnings, newest first. Capped so `/warns` can always render. */
    async listWarnings(guildId: string, userId: string, limit = 10) {
      const { rows } = await pool.query<{ id: string; moderator_id: string; reason: string; created_at: Date }>(
        `SELECT id, moderator_id, reason, created_at
         FROM guild_warnings
         WHERE guild_id = $1 AND user_id = $2
         ORDER BY created_at DESC
         LIMIT $3`,
        [guildId, userId, limit]
      );
      return rows.map(row => ({
        id: row.id,
        moderatorId: row.moderator_id,
        reason: row.reason,
        createdAt: row.created_at.toISOString()
      }));
    },

    /** How many warnings a member holds. Used in the `/warn` confirmation. */
    async countWarnings(guildId: string, userId: string) {
      const { rows } = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM guild_warnings WHERE guild_id = $1 AND user_id = $2`,
        [guildId, userId]
      );
      return Number(rows[0]?.count ?? 0);
    },

    /** Empties a member's warnings. Returns how many rows were removed. */
    async clearWarnings(guildId: string, userId: string) {
      const { rowCount } = await pool.query(
        `DELETE FROM guild_warnings WHERE guild_id = $1 AND user_id = $2`,
        [guildId, userId]
      );
      return rowCount ?? 0;
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

    async upsertHealth(
      guildId: string,
      state: string,
      botPresent: boolean,
      gatewayEvents: number,
      uniqueUsers = 0,
      pingMs: number | null = null
    ) {
      await pool.query(
        `INSERT INTO guild_health (guild_id, bot_present, gateway_events_last_minute, unique_users, ping_ms, state, checked_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())
         ON CONFLICT (guild_id) DO UPDATE
           SET bot_present = EXCLUDED.bot_present,
               gateway_events_last_minute = EXCLUDED.gateway_events_last_minute,
               unique_users = EXCLUDED.unique_users,
               ping_ms = EXCLUDED.ping_ms,
               state = EXCLUDED.state,
               checked_at = now()`,
        [guildId, botPresent, gatewayEvents, uniqueUsers, pingMs, state]
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
