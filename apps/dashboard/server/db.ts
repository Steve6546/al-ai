import pg from "pg";
import type { AntiNukeConfig, LoggingSettings, CustomizationSettings, CommandConfig, TierRoles } from "@al-ai/core";
import { DEFAULT_ANTI_NUKE_CONFIG, DEFAULT_BOT_IDENTITY, DEFAULT_CUSTOMIZATION, DEFAULT_EMBED_COLOR, DEFAULT_LOGGING_MODE, isLoggingMode, isTier, normaliseAntiNukeConfig, normaliseBotIdentity, normaliseTierRoles, PUNISHMENT_EVENT_IDS, SESSION_MAX_AGE_SECONDS, type BotIdentitySettings } from "@al-ai/core";

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

    /**
     * Seeds a guild row without touching the columns the bot owns.
     *
     * The dashboard discovers guilds through the operator's OAuth token, but
     * that endpoint returns no member count — so the dashboard has no real
     * value to write. Routing this through `upsertGuild` with a placeholder 0
     * meant every dashboard load overwrote the count the bot had reported,
     * which is why the overview showed "0 members" for a populated server.
     * `DO NOTHING` creates the row only when it is genuinely absent.
     */
    async ensureGuild(guild: { id: string; name: string; iconUrl: string | null }) {
      await pool.query(
        `INSERT INTO guilds (id, name, icon_url, member_count, bot_present, updated_at)
         VALUES ($1, $2, $3, 0, false, now())
         ON CONFLICT (id) DO NOTHING`,
        [guild.id, guild.name, guild.iconUrl]
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

    async getTierRoles(guildId: string): Promise<TierRoles | null> {
      const { rows } = await pool.query<{ admin_role_ids: string[] | null; moderator_role_ids: string[] | null }>(
        `SELECT admin_role_ids, moderator_role_ids FROM guild_role_tiers WHERE guild_id = $1`,
        [guildId]
      );
      const row = rows[0];
      if (!row) return null;
      return normaliseTierRoles({ adminRoleIds: row.admin_role_ids, moderatorRoleIds: row.moderator_role_ids });
    },

    /**
     * GOVERNANCE rule 3: the configurable tiers bind to Role IDs, never to User
     * IDs. `owner` has no row at all — it is derived from Discord's own guild
     * ownership and the Administrator permission, so it cannot be misconfigured
     * and cannot be granted to the wrong role by a stale form.
     */
    async saveTierRoles(guildId: string, roles: TierRoles) {
      await pool.query(
        `INSERT INTO guild_role_tiers (guild_id, admin_role_ids, moderator_role_ids, updated_at)
         VALUES ($1, $2::jsonb, $3::jsonb, now())
         ON CONFLICT (guild_id) DO UPDATE
           SET admin_role_ids = EXCLUDED.admin_role_ids,
               moderator_role_ids = EXCLUDED.moderator_role_ids,
               updated_at = now()`,
        [guildId, JSON.stringify(roles.adminRoleIds), JSON.stringify(roles.moderatorRoleIds)]
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

    /**
     * The global half of the bot's identity — one row, shared by every guild.
     *
     * Read through the same `normaliseBotIdentity` the bot uses, so a row written
     * by an older build cannot mean two different things on the two sides of the
     * database. There is no guild argument because there is no per-guild value:
     * Discord gives an application one avatar, one banner and one presence.
     *
     * The seed row is created by `schema.sql`, but a read must still survive its
     * absence — a database restored from a partial dump would otherwise throw on
     * the first page load instead of showing the defaults.
     */
    async getBotIdentity(): Promise<BotIdentitySettings> {
      const { rows } = await pool.query<{
        avatar_data_url: string | null;
        banner_data_url: string | null;
        bio: string | null;
        status: string | null;
        activity_type: string | null;
        activity_text: string | null;
        status_duration: string | null;
        status_expires_at: Date | string | null;
      }>(`SELECT avatar_data_url, banner_data_url, bio, status, activity_type, activity_text, status_duration, status_expires_at FROM bot_identity WHERE id = true`);
      const row = rows[0];
      return normaliseBotIdentity({
        avatarDataUrl: row?.avatar_data_url ?? DEFAULT_BOT_IDENTITY.avatarDataUrl,
        bannerDataUrl: row?.banner_data_url ?? DEFAULT_BOT_IDENTITY.bannerDataUrl,
        bio: row?.bio ?? DEFAULT_BOT_IDENTITY.bio,
        status: row?.status ?? DEFAULT_BOT_IDENTITY.status,
        activityType: row?.activity_type ?? DEFAULT_BOT_IDENTITY.activityType,
        activityText: row?.activity_text ?? DEFAULT_BOT_IDENTITY.activityText,
        statusDuration: row?.status_duration ?? DEFAULT_BOT_IDENTITY.statusDuration,
        // `pg` hands a TIMESTAMPTZ back as a Date, not a string, and
        // `normaliseBotIdentity` parses only strings. Converting here keeps the
        // contract's "ISO-8601 instant" promise true for every reader instead of
        // letting the driver's choice leak into the shape.
        statusExpiresAt:
          row?.status_expires_at === null || row?.status_expires_at === undefined
            ? DEFAULT_BOT_IDENTITY.statusExpiresAt
            : new Date(row.status_expires_at).toISOString()
      });
    },

    /**
     * Writes the single identity row.
     *
     * Upserted rather than updated, so a database whose seed row was removed
     * heals on the next save instead of silently discarding the operator's work.
     * The `id` column is forced to `true` and its CHECK refuses anything else,
     * which is what keeps "the current identity" unambiguous.
     */
    async saveBotIdentity(settings: BotIdentitySettings) {
      await pool.query(
        `INSERT INTO bot_identity (id, avatar_data_url, banner_data_url, bio, status, activity_type, activity_text, status_duration, status_expires_at, updated_at)
         VALUES (true, $1, $2, $3, $4, $5, $6, $7, $8, now())
         ON CONFLICT (id) DO UPDATE
           SET avatar_data_url = EXCLUDED.avatar_data_url,
               banner_data_url = EXCLUDED.banner_data_url,
               bio = EXCLUDED.bio,
               status = EXCLUDED.status,
               activity_type = EXCLUDED.activity_type,
               activity_text = EXCLUDED.activity_text,
               status_duration = EXCLUDED.status_duration,
               status_expires_at = EXCLUDED.status_expires_at,
               updated_at = now()`,
        [
          settings.avatarDataUrl,
          settings.bannerDataUrl,
          settings.bio,
          settings.status,
          settings.activityType,
          settings.activityText,
          settings.statusDuration,
          settings.statusExpiresAt
        ]
      );
    },

    async getLogging(guildId: string): Promise<LoggingSettings> {
      const { rows } = await pool.query(
        `SELECT enabled, mode, global_channel_id, ignored_channel_ids, ignored_role_ids, embed_color, event_flags, category_channels
         FROM guild_logging WHERE guild_id = $1`,
        [guildId]
      );
      const row = rows[0];
      if (!row) {
        return {
          enabled: false,
          mode: DEFAULT_LOGGING_MODE,
          globalChannelId: null,
          ignoredChannelIds: [],
          ignoredRoleIds: [],
          embedColor: DEFAULT_EMBED_COLOR,
          eventFlags: {},
          categoryChannels: {}
        };
      }
      return {
        enabled: row.enabled,
        // A row written before the mode column existed has no value; the shipped
        // default applies rather than an undefined leaking into the router.
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
     * The anti-nuke settings for a guild.
     *
     * Read through the same `normaliseAntiNukeConfig` the bot uses, so a stored
     * value the dashboard would refuse can never reach the engine — and a guild
     * with no row renders exactly as the bot behaves: disarmed at the defaults.
     */
    async getSecurity(guildId: string): Promise<AntiNukeConfig> {
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

    async saveSecurity(guildId: string, config: AntiNukeConfig) {
      await pool.query(
        `INSERT INTO guild_security (guild_id, enabled, channel_deletes_per_minute, bans_per_minute, role_changes_per_minute, quarantine_role_id, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())
         ON CONFLICT (guild_id) DO UPDATE
           SET enabled = EXCLUDED.enabled,
               channel_deletes_per_minute = EXCLUDED.channel_deletes_per_minute,
               bans_per_minute = EXCLUDED.bans_per_minute,
               role_changes_per_minute = EXCLUDED.role_changes_per_minute,
               quarantine_role_id = EXCLUDED.quarantine_role_id,
               updated_at = now()`,
        [
          guildId,
          config.enabled,
          config.limits.channelDeletesPerMinute,
          config.limits.bansPerMinute,
          config.limits.roleChangesPerMinute,
          config.quarantineRoleId
        ]
      );
    },

    async saveLogging(guildId: string, settings: LoggingSettings) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO guild_logging (guild_id, enabled, mode, global_channel_id, ignored_channel_ids, ignored_role_ids, embed_color, event_flags, category_channels, updated_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8::jsonb, $9::jsonb, now())
           ON CONFLICT (guild_id) DO UPDATE
             SET enabled = EXCLUDED.enabled,
                 mode = EXCLUDED.mode,
                 global_channel_id = EXCLUDED.global_channel_id,
                 ignored_channel_ids = EXCLUDED.ignored_channel_ids,
                 ignored_role_ids = EXCLUDED.ignored_role_ids,
                 embed_color = EXCLUDED.embed_color,
                 event_flags = EXCLUDED.event_flags,
                 category_channels = EXCLUDED.category_channels,
                 updated_at = now()`,
          [
            guildId,
            settings.enabled,
            settings.mode,
            settings.globalChannelId,
            JSON.stringify(settings.ignoredChannelIds),
            JSON.stringify(settings.ignoredRoleIds),
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

    /**
     * The newest heartbeat across every guild, or null when the bot has never
     * reported one.
     *
     * `/api/health` needs this to answer "is the bot actually running?". The
     * answer cannot come from the presence of a token — a configured token says
     * the bot *could* run, not that it is. Only a heartbeat timestamp proves it,
     * and only while that timestamp is still inside the staleness window.
     */
    async latestHeartbeatAt(): Promise<Date | null> {
      const { rows } = await pool.query<{ checked_at: Date | null }>(
        `SELECT max(checked_at) AS checked_at FROM guild_health WHERE bot_present`
      );
      const value = rows[0]?.checked_at ?? null;
      return value ? new Date(value) : null;
    },

    async listGuildIds() {
      const { rows } = await pool.query<{ id: string }>(`SELECT id FROM guilds`);
      return rows.map(row => row.id);
    },

    /**
     * This guild's stored command configuration, keyed by command name.
     *
     * Only the commands the operator has actually touched appear here; the
     * caller fills the gaps with the registry defaults, so an untouched command
     * is described identically by the dashboard and by the bot.
     */
    async getCommandFlags(guildId: string) {
      const { rows } = await pool.query<{
        command: string;
        enabled: boolean;
        minimum_tier: string | null;
        dm_on_action: boolean;
        delete_message_days: number;
        allowed_role_ids: string[] | null;
        denied_role_ids: string[] | null;
        allowed_channel_ids: string[] | null;
        denied_channel_ids: string[] | null;
        cooldown_seconds: number;
        auto_delete_response_seconds: number;
        require_reason: boolean;
        default_duration: string;
        preset_reasons: unknown;
      }>(
        `SELECT command, enabled, minimum_tier, dm_on_action, delete_message_days,
                allowed_role_ids, denied_role_ids, allowed_channel_ids, denied_channel_ids,
                cooldown_seconds, auto_delete_response_seconds, require_reason, default_duration, preset_reasons
         FROM guild_command_flags WHERE guild_id = $1`,
        [guildId]
      );
      // Values are passed through raw and cleaned by `normaliseCommandConfig`,
      // which is the same function the bot reads through — so a row written by an
      // older build cannot mean two different things on the two sides.
      return new Map<string, Partial<CommandConfig>>(
        rows.map(row => [
          row.command,
          {
            name: row.command,
            enabled: row.enabled,
            ...(isTier(row.minimum_tier) ? { allowedLevel: row.minimum_tier } : {}),
            dmOnAction: row.dm_on_action,
            deleteMessageDays: row.delete_message_days,
            allowedRoleIds: row.allowed_role_ids ?? [],
            deniedRoleIds: row.denied_role_ids ?? [],
            allowedChannelIds: row.allowed_channel_ids ?? [],
            deniedChannelIds: row.denied_channel_ids ?? [],
            cooldownSeconds: row.cooldown_seconds,
            autoDeleteResponseSeconds: row.auto_delete_response_seconds,
            requireReason: row.require_reason,
            defaultDuration: row.default_duration as CommandConfig["defaultDuration"],
            presetReasons: Array.isArray(row.preset_reasons) ? (row.preset_reasons as CommandConfig["presetReasons"]) : []
          }
        ])
      );
    },

    async saveCommandFlag(guildId: string, config: CommandConfig) {
      await pool.query(
        `INSERT INTO guild_command_flags (
           guild_id, command, enabled, minimum_tier, dm_on_action, delete_message_days,
           allowed_role_ids, denied_role_ids, allowed_channel_ids, denied_channel_ids,
           cooldown_seconds, auto_delete_response_seconds, require_reason, default_duration, preset_reasons,
           updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11, $12, $13, $14, $15::jsonb, now())
         ON CONFLICT (guild_id, command) DO UPDATE
           SET enabled = EXCLUDED.enabled,
               minimum_tier = EXCLUDED.minimum_tier,
               dm_on_action = EXCLUDED.dm_on_action,
               delete_message_days = EXCLUDED.delete_message_days,
               allowed_role_ids = EXCLUDED.allowed_role_ids,
               denied_role_ids = EXCLUDED.denied_role_ids,
               allowed_channel_ids = EXCLUDED.allowed_channel_ids,
               denied_channel_ids = EXCLUDED.denied_channel_ids,
               cooldown_seconds = EXCLUDED.cooldown_seconds,
               auto_delete_response_seconds = EXCLUDED.auto_delete_response_seconds,
               require_reason = EXCLUDED.require_reason,
               default_duration = EXCLUDED.default_duration,
               preset_reasons = EXCLUDED.preset_reasons,
               updated_at = now()`,
        [
          guildId,
          config.name,
          config.enabled,
          config.allowedLevel,
          config.dmOnAction,
          config.deleteMessageDays,
          JSON.stringify(config.allowedRoleIds),
          JSON.stringify(config.deniedRoleIds),
          JSON.stringify(config.allowedChannelIds),
          JSON.stringify(config.deniedChannelIds),
          config.cooldownSeconds,
          config.autoDeleteResponseSeconds,
          config.requireReason,
          config.defaultDuration,
          JSON.stringify(config.presetReasons)
        ]
      );
    },

    /**
     * The bot's last reported state for one guild, including its gateway ping.
     *
     * `ping_ms` is nullable on purpose: a guild the bot has never reported on
     * returns null rather than 0, so the screen can say "—" instead of "0 ms".
     */
    async getGuildHealth(guildId: string) {
      const { rows } = await pool.query<{
        state: string;
        bot_present: boolean;
        ping_ms: number | null;
        checked_at: Date;
      }>(`SELECT state, bot_present, ping_ms, checked_at FROM guild_health WHERE guild_id = $1`, [guildId]);
      const row = rows[0];
      if (!row) return null;
      return {
        state: row.state,
        botPresent: row.bot_present,
        pingMs: row.ping_ms,
        checkedAt: row.checked_at.toISOString()
      };
    },

    /**
     * Punishment counts over a window, straight from the append-only trail.
     *
     * Counted in SQL rather than by reading rows and tallying in JavaScript, so
     * the number stays correct once the trail is longer than any page size.
     */
    async countPunishmentsSince(guildId: string, since: Date) {
      const { rows } = await pool.query<{ event_id: string; count: string }>(
        `SELECT event_id, count(*)::text AS count
         FROM audit_trail
         WHERE guild_id = $1 AND created_at >= $2 AND event_id = ANY($3::text[])
         GROUP BY event_id`,
        [guildId, since, [...PUNISHMENT_EVENT_IDS]]
      );
      return rows.map(row => ({ eventId: row.event_id, count: Number(row.count) }));
    },

    /** The most recent moderation rows, for the activity feed. */
    async listRecentModeration(guildId: string, limit = 8) {
      const { rows } = await pool.query<{
        id: string;
        event_id: string;
        severity: string;
        payload_ciphertext: string;
        created_at: Date;
      }>(
        `SELECT id, event_id, severity, payload_ciphertext, created_at
         FROM audit_trail
         WHERE guild_id = $1 AND event_id LIKE 'moderation.%'
         ORDER BY created_at DESC
         LIMIT $2`,
        [guildId, limit]
      );
      return rows;
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
