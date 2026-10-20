import pg from "pg";
import { randomUUID } from "node:crypto";
import type { AntiNukeConfig, LoggingSettings, CustomizationSettings, CommandConfig, InviteSettings, LevelRoleReward, LevelRewardKind, LevelSettings, TierRoles } from "@al-ai/core";
import { DEFAULT_ANTI_NUKE_CONFIG, DEFAULT_BOT_PRESENCE, DEFAULT_CUSTOMIZATION, DEFAULT_EMBED_COLOR, DEFAULT_INVITE_SETTINGS, DEFAULT_LEVEL_SETTINGS, DEFAULT_LOGGING_MODE, DEFAULT_WELCOME_MESSAGE_SETTINGS, DEFAULT_WELCOME_SETTINGS, MAX_LEVEL_CAP, isLoggingMode, isTier, levelFromXp, normaliseAntiNukeConfig, normaliseBotPresence, normaliseInviteSettings, normaliseLevelSettings, normaliseLevelReward, normaliseTierRoles, normaliseWelcomeMessageSettings, normaliseWelcomeSettings, PUNISHMENT_EVENT_IDS, SESSION_MAX_AGE_SECONDS, type BotPresenceSettings, type WelcomeMessageSettings, type WelcomeSettings } from "@al-ai/core";

const { Pool } = pg;

export type SessionRecord = {
  id: string;
  discordUserId: string;
  /** The display name Discord shows (the global name when there is one). */
  discordUsername: string;
  /** The @handle, which is a different name and is asked for as often. */
  discordHandle: string | null;
  /** Discord avatar hash; null means the account uses a default avatar. */
  discordAvatar: string | null;
  accessTokenCiphertext: string;
  scopes: string;
  expiresAt: Date;
};

export function createPool(databaseUrl: string) {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    // A hung query used to pin a slot forever — ten wedged queries exhausted
    // the pool and every request then queued on checkout. The statement cap
    // bounds any single query, and the transaction-idle cap catches a BEGIN
    // that never reached COMMIT.
    connectionTimeoutMillis: 5_000,
    options: "-c statement_timeout=15000 -c idle_in_transaction_session_timeout=10000"
  });
  pool.on("error", error => console.error("AL AI database pool error", error));
  return pool;
}

export type Database = ReturnType<typeof createDatabase>;

/** One persistent sync job, mapped from the snake_case row. */
export type LevelSyncJob = {
  id: string;
  guildId: string;
  status: "pending" | "running" | "completed" | "failed";
  cursor: string | null;
  total: number | null;
  processed: number;
  granted: number;
  removed: number;
  skipped: number;
  failed: number;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

type LevelSyncJobRow = {
  id: string;
  guild_id: string;
  status: string;
  cursor: string | null;
  total: number | null;
  processed: number;
  granted: number;
  removed: number;
  skipped: number;
  failed: number;
  error: string | null;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
};

function mapSyncJob(row: LevelSyncJobRow): LevelSyncJob {
  return {
    id: row.id,
    guildId: row.guild_id,
    status: row.status as LevelSyncJob["status"],
    cursor: row.cursor,
    total: row.total,
    processed: row.processed,
    granted: row.granted,
    removed: row.removed,
    skipped: row.skipped,
    failed: row.failed,
    error: row.error,
    createdAt: new Date(row.created_at).toISOString(),
    startedAt: row.started_at ? new Date(row.started_at).toISOString() : null,
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null
  };
}

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
      const { rows } = await pool.query<{
        enabled: boolean;
        nickname: string | null;
        role_color: string | null;
        role_icon_url: string | null;
        avatar_data_url: string | null;
        banner_data_url: string | null;
        bio: string | null;
      }>(
        `SELECT enabled, nickname, role_color, role_icon_url, avatar_data_url, banner_data_url, bio FROM guild_customization WHERE guild_id = $1`,
        [guildId]
      );
      const row = rows[0];
      // No row means the guild is still on the shipped defaults, not "blank".
      return {
        enabled: row?.enabled ?? DEFAULT_CUSTOMIZATION.enabled,
        nickname: row?.nickname ?? DEFAULT_CUSTOMIZATION.nickname,
        roleColor: row?.role_color ?? DEFAULT_CUSTOMIZATION.roleColor,
        roleIconUrl: row?.role_icon_url ?? DEFAULT_CUSTOMIZATION.roleIconUrl,
        avatarDataUrl: row?.avatar_data_url ?? DEFAULT_CUSTOMIZATION.avatarDataUrl,
        bannerDataUrl: row?.banner_data_url ?? DEFAULT_CUSTOMIZATION.bannerDataUrl,
        bio: row?.bio ?? DEFAULT_CUSTOMIZATION.bio
      };
    },

    async saveCustomization(guildId: string, settings: CustomizationSettings) {
      await pool.query(
        `INSERT INTO guild_customization (guild_id, enabled, nickname, role_color, role_icon_url, avatar_data_url, banner_data_url, bio, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
         ON CONFLICT (guild_id) DO UPDATE
           SET enabled = EXCLUDED.enabled,
               nickname = EXCLUDED.nickname,
               role_color = EXCLUDED.role_color,
               role_icon_url = EXCLUDED.role_icon_url,
               avatar_data_url = EXCLUDED.avatar_data_url,
               banner_data_url = EXCLUDED.banner_data_url,
               bio = EXCLUDED.bio,
               updated_at = now()`,
        [
          guildId,
          settings.enabled,
          settings.nickname,
          settings.roleColor,
          settings.roleIconUrl,
          settings.avatarDataUrl,
          settings.bannerDataUrl,
          settings.bio
        ]
      );
    },

    /**
     * The bot's presence — one row, shared by every guild.
     *
     * Read through the same `normaliseBotPresence` the bot uses, so a row written
     * by an older build cannot mean two different things on the two sides of the
     * database. There is no guild argument because there is no per-guild value:
     * Discord sends a status on the gateway connection, so it is one presence for
     * the whole bot. Everything a single server can override lives on
     * `guild_customization` instead.
     *
     * The seed row is created by `schema.sql`, but a read must still survive its
     * absence — a database restored from a partial dump would otherwise throw on
     * the first page load instead of showing the defaults.
     */
    async getBotPresence(): Promise<BotPresenceSettings> {
      const { rows } = await pool.query<{
        status: string | null;
        activity_type: string | null;
        activity_text: string | null;
        status_duration: string | null;
        status_expires_at: Date | string | null;
      }>(`SELECT status, activity_type, activity_text, status_duration, status_expires_at FROM bot_identity WHERE id = true`);
      const row = rows[0];
      return normaliseBotPresence({
        status: row?.status ?? DEFAULT_BOT_PRESENCE.status,
        activityType: row?.activity_type ?? DEFAULT_BOT_PRESENCE.activityType,
        activityText: row?.activity_text ?? DEFAULT_BOT_PRESENCE.activityText,
        statusDuration: row?.status_duration ?? DEFAULT_BOT_PRESENCE.statusDuration,
        // `pg` hands a TIMESTAMPTZ back as a Date, not a string, and
        // `normaliseBotPresence` parses only strings. Converting here keeps the
        // contract's "ISO-8601 instant" promise true for every reader instead of
        // letting the driver's choice leak into the shape.
        statusExpiresAt:
          row?.status_expires_at === null || row?.status_expires_at === undefined
            ? DEFAULT_BOT_PRESENCE.statusExpiresAt
            : new Date(row.status_expires_at).toISOString()
      });
    },

    /**
     * Writes the single presence row.
     *
     * Upserted rather than updated, so a database whose seed row was removed
     * heals on the next save instead of silently discarding the operator's work.
     * The `id` column is forced to `true` and its CHECK refuses anything else,
     * which is what keeps "the current presence" unambiguous.
     */
    async saveBotPresence(settings: BotPresenceSettings) {
      await pool.query(
        `INSERT INTO bot_identity (id, status, activity_type, activity_text, status_duration, status_expires_at, updated_at)
         VALUES (true, $1, $2, $3, $4, $5, now())
         ON CONFLICT (id) DO UPDATE
           SET status = EXCLUDED.status,
               activity_type = EXCLUDED.activity_type,
               activity_text = EXCLUDED.activity_text,
               status_duration = EXCLUDED.status_duration,
               status_expires_at = EXCLUDED.status_expires_at,
               updated_at = now()`,
        [settings.status, settings.activityType, settings.activityText, settings.statusDuration, settings.statusExpiresAt]
      );
    },

    async getLogging(guildId: string): Promise<LoggingSettings> {
      const { rows } = await pool.query(
        `SELECT enabled, mode, global_channel_id, ignored_channel_ids, ignored_role_ids, embed_color, category_colors, event_flags, category_channels, event_channels, event_colors
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
          categoryColors: {},
          eventFlags: {},
          categoryChannels: {},
          eventChannels: {},
          eventColors: {}
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
        // Absent on a row written before the column existed: the destination then
        // inherits `embedColor`, which is the behaviour it had before.
        categoryColors: row.category_colors ?? {},
        eventFlags: row.event_flags ?? {},
        categoryChannels: row.category_channels ?? {},
        // Absent on a row written before version 4: every record then inherits
        // its section's channel and colour, which is what the operator had.
        eventChannels: row.event_channels ?? {},
        eventColors: row.event_colors ?? {}
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

    async getWelcome(guildId: string): Promise<WelcomeSettings> {
      const { rows } = await pool.query<{
        enabled: boolean;
        member_role_id: string | null;
        bot_role_id: string | null;
        delay_seconds: number;
      }>(`SELECT enabled, member_role_id, bot_role_id, delay_seconds FROM guild_welcome WHERE guild_id = $1`, [guildId]);
      const row = rows[0];
      if (!row) return DEFAULT_WELCOME_SETTINGS;
      return normaliseWelcomeSettings({
        enabled: row.enabled,
        memberRoleId: row.member_role_id,
        botRoleId: row.bot_role_id,
        delaySeconds: row.delay_seconds
      });
    },

    async saveWelcome(guildId: string, settings: WelcomeSettings) {
      await pool.query(
        `INSERT INTO guild_welcome (guild_id, enabled, member_role_id, bot_role_id, delay_seconds, updated_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (guild_id) DO UPDATE
           SET enabled = EXCLUDED.enabled,
               member_role_id = EXCLUDED.member_role_id,
               bot_role_id = EXCLUDED.bot_role_id,
               delay_seconds = EXCLUDED.delay_seconds,
               updated_at = now()`,
        [guildId, settings.enabled, settings.memberRoleId, settings.botRoleId, settings.delaySeconds]
      );
    },

    /* ---------------------------------------------------------------- *
     * Levels system. The dashboard owns the settings' and rewards' write
     * path; the bot writes the XP rows. Both sides read through the same
     * core normalisers, so a stored value cannot mean one thing here and
     * another in the engine.
     * ---------------------------------------------------------------- */

    async getLevelSettings(guildId: string): Promise<LevelSettings> {
      const { rows } = await pool.query<Record<string, unknown>>(
        `SELECT enabled, text_xp_enabled, voice_xp_enabled, text_xp_min, text_xp_max, voice_xp_min, voice_xp_max,
                max_level_cap, reset_on_leave, text_cooldown_seconds, voice_min_members, ignore_muted, ignore_deafened,
                ignore_afk, notify_level_up, notify_mode, notify_channel_id, rank_card, text_level_up_message,
                voice_level_up_message, role_stacking, role_multipliers, channel_multipliers,
                ignored_text_channel_ids, ignored_voice_channel_ids, ignored_role_ids
         FROM guild_levels WHERE guild_id = $1`,
        [guildId]
      );
      const row = rows[0];
      if (!row) return { ...DEFAULT_LEVEL_SETTINGS };
      return normaliseLevelSettings({
        enabled: row.enabled,
        textXpEnabled: row.text_xp_enabled,
        voiceXpEnabled: row.voice_xp_enabled,
        textXpMin: row.text_xp_min,
        textXpMax: row.text_xp_max,
        voiceXpMin: row.voice_xp_min,
        voiceXpMax: row.voice_xp_max,
        maxLevelCap: row.max_level_cap,
        resetOnLeave: row.reset_on_leave,
        textCooldownSeconds: row.text_cooldown_seconds,
        voiceMinMembers: row.voice_min_members,
        ignoreMuted: row.ignore_muted,
        ignoreDeafened: row.ignore_deafened,
        ignoreAfk: row.ignore_afk,
        notifyLevelUp: row.notify_level_up,
        notifyMode: row.notify_mode,
        notifyChannelId: row.notify_channel_id,
        rankCardEnabled: row.rank_card,
        textLevelUpMessage: row.text_level_up_message,
        voiceLevelUpMessage: row.voice_level_up_message,
        roleStacking: row.role_stacking,
        roleMultipliers: row.role_multipliers,
        channelMultipliers: row.channel_multipliers,
        ignoredTextChannelIds: row.ignored_text_channel_ids,
        ignoredVoiceChannelIds: row.ignored_voice_channel_ids,
        ignoredRoleIds: row.ignored_role_ids
      });
    },

    async saveLevelSettings(guildId: string, settings: LevelSettings) {
      await pool.query(
        `INSERT INTO guild_levels (guild_id, enabled, text_xp_enabled, voice_xp_enabled, text_xp_min, text_xp_max,
                                   voice_xp_min, voice_xp_max, max_level_cap, reset_on_leave, text_cooldown_seconds,
                                   voice_min_members, ignore_muted, ignore_deafened, ignore_afk,
                                   notify_level_up, notify_mode, notify_channel_id, rank_card, text_level_up_message,
                                   voice_level_up_message, role_stacking, role_multipliers, channel_multipliers,
                                   ignored_text_channel_ids, ignored_voice_channel_ids, ignored_role_ids, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23::jsonb,$24::jsonb,$25::jsonb,$26::jsonb,$27::jsonb, now())
         ON CONFLICT (guild_id) DO UPDATE SET
           enabled = EXCLUDED.enabled,
           text_xp_enabled = EXCLUDED.text_xp_enabled,
           voice_xp_enabled = EXCLUDED.voice_xp_enabled,
           text_xp_min = EXCLUDED.text_xp_min,
           text_xp_max = EXCLUDED.text_xp_max,
           voice_xp_min = EXCLUDED.voice_xp_min,
           voice_xp_max = EXCLUDED.voice_xp_max,
           max_level_cap = EXCLUDED.max_level_cap,
           reset_on_leave = EXCLUDED.reset_on_leave,
           text_cooldown_seconds = EXCLUDED.text_cooldown_seconds,
           voice_min_members = EXCLUDED.voice_min_members,
           ignore_muted = EXCLUDED.ignore_muted,
           ignore_deafened = EXCLUDED.ignore_deafened,
           ignore_afk = EXCLUDED.ignore_afk,
           notify_level_up = EXCLUDED.notify_level_up,
           notify_mode = EXCLUDED.notify_mode,
           notify_channel_id = EXCLUDED.notify_channel_id,
           rank_card = EXCLUDED.rank_card,
           text_level_up_message = EXCLUDED.text_level_up_message,
           voice_level_up_message = EXCLUDED.voice_level_up_message,
           role_stacking = EXCLUDED.role_stacking,
           role_multipliers = EXCLUDED.role_multipliers,
           channel_multipliers = EXCLUDED.channel_multipliers,
           ignored_text_channel_ids = EXCLUDED.ignored_text_channel_ids,
           ignored_voice_channel_ids = EXCLUDED.ignored_voice_channel_ids,
           ignored_role_ids = EXCLUDED.ignored_role_ids,
           updated_at = now()`,
        [
          guildId,
          settings.enabled,
          settings.textXpEnabled,
          settings.voiceXpEnabled,
          settings.textXpMin,
          settings.textXpMax,
          settings.voiceXpMin,
          settings.voiceXpMax,
          settings.maxLevelCap,
          settings.resetOnLeave,
          settings.textCooldownSeconds,
          settings.voiceMinMembers,
          settings.ignoreMuted,
          settings.ignoreDeafened,
          settings.ignoreAfk,
          settings.notifyLevelUp,
          settings.notifyMode,
          settings.notifyChannelId,
          settings.rankCardEnabled,
          settings.textLevelUpMessage,
          settings.voiceLevelUpMessage,
          settings.roleStacking,
          JSON.stringify(settings.roleMultipliers),
          JSON.stringify(settings.channelMultipliers),
          JSON.stringify(settings.ignoredTextChannelIds),
          JSON.stringify(settings.ignoredVoiceChannelIds),
          JSON.stringify(settings.ignoredRoleIds)
        ]
      );
    },

    async getWelcomeMessages(guildId: string): Promise<WelcomeMessageSettings> {
      const { rows } = await pool.query<Record<string, unknown>>(
        `SELECT enabled, image_enabled, image_mode, image_channel_id, channel_id, mode, text, embed, image_config
         FROM guild_welcome_messages WHERE guild_id = $1`,
        [guildId]
      );
      const row = rows[0];
      if (!row) return { ...DEFAULT_WELCOME_MESSAGE_SETTINGS };
      return normaliseWelcomeMessageSettings({
        enabled: row.enabled,
        imageEnabled: row.image_enabled,
        imageMode: row.image_mode,
        imageChannelId: row.image_channel_id,
        channelId: row.channel_id,
        mode: row.mode,
        text: row.text,
        embed: row.embed,
        image: row.image_config
      });
    },

    async saveWelcomeMessages(guildId: string, settings: WelcomeMessageSettings) {
      await pool.query(
        `INSERT INTO guild_welcome_messages (guild_id, enabled, image_enabled, image_mode, image_channel_id,
                                            channel_id, mode, text, embed, image_config, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb, now())
         ON CONFLICT (guild_id) DO UPDATE SET
           enabled = EXCLUDED.enabled,
           image_enabled = EXCLUDED.image_enabled,
           image_mode = EXCLUDED.image_mode,
           image_channel_id = EXCLUDED.image_channel_id,
           channel_id = EXCLUDED.channel_id,
           mode = EXCLUDED.mode,
           text = EXCLUDED.text,
           embed = EXCLUDED.embed,
           image_config = EXCLUDED.image_config,
           updated_at = now()`,
        [
          guildId,
          settings.enabled,
          settings.imageEnabled,
          settings.imageMode,
          settings.imageChannelId,
          settings.channelId,
          settings.mode,
          settings.text,
          JSON.stringify(settings.embed),
          JSON.stringify(settings.image)
        ]
      );
    },

    async getInviteSettings(guildId: string): Promise<InviteSettings> {
      const { rows } = await pool.query<Record<string, unknown>>(
        `SELECT enabled, fake_account_days, keep_roles_on_leave, log_self_invites, log_joins,
                log_leaves, log_milestones, join_message, leave_message, milestone_message, milestone_roles
         FROM guild_invites WHERE guild_id = $1`,
        [guildId]
      );
      const row = rows[0];
      if (!row) return { ...DEFAULT_INVITE_SETTINGS };
      return normaliseInviteSettings({
        enabled: row.enabled,
        fakeAccountDays: row.fake_account_days,
        keepRolesOnLeave: row.keep_roles_on_leave,
        logSelfInvites: row.log_self_invites,
        logJoins: row.log_joins,
        logLeaves: row.log_leaves,
        logMilestones: row.log_milestones,
        joinMessage: row.join_message,
        leaveMessage: row.leave_message,
        milestoneMessage: row.milestone_message,
        milestoneRoles: row.milestone_roles
      });
    },

    async saveInviteSettings(guildId: string, settings: InviteSettings) {
      await pool.query(
        `INSERT INTO guild_invites (guild_id, enabled, fake_account_days, keep_roles_on_leave, log_self_invites,
                                   log_joins, log_leaves, log_milestones, join_message, leave_message,
                                   milestone_message, milestone_roles, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb, now())
         ON CONFLICT (guild_id) DO UPDATE SET
           enabled = EXCLUDED.enabled,
           fake_account_days = EXCLUDED.fake_account_days,
           keep_roles_on_leave = EXCLUDED.keep_roles_on_leave,
           log_self_invites = EXCLUDED.log_self_invites,
           log_joins = EXCLUDED.log_joins,
           log_leaves = EXCLUDED.log_leaves,
           log_milestones = EXCLUDED.log_milestones,
           join_message = EXCLUDED.join_message,
           leave_message = EXCLUDED.leave_message,
           milestone_message = EXCLUDED.milestone_message,
           milestone_roles = EXCLUDED.milestone_roles,
           updated_at = now()`,
        [
          guildId,
          settings.enabled,
          settings.fakeAccountDays,
          settings.keepRolesOnLeave,
          settings.logSelfInvites,
          settings.logJoins,
          settings.logLeaves,
          settings.logMilestones,
          settings.joinMessage,
          settings.leaveMessage,
          settings.milestoneMessage,
          JSON.stringify(settings.milestoneRoles)
        ]
      );
    },

    async listLevelRewards(guildId: string): Promise<LevelRoleReward[]> {
      const { rows } = await pool.query<Record<string, unknown>>(
        `SELECT id, kind, level, required_voice_level, role_id, always_keep
         FROM level_role_rewards WHERE guild_id = $1
         ORDER BY kind, level, required_voice_level NULLS LAST`,
        [guildId]
      );
      return rows
        .map(row =>
          normaliseLevelReward({
            id: row.id,
            kind: row.kind,
            level: row.level,
            voiceLevel: row.required_voice_level,
            roleId: row.role_id,
            alwaysKeep: row.always_keep
          })
        )
        .filter((reward): reward is LevelRoleReward => reward !== null && reward.id !== "");
    },

    /**
     * Inserts one reward rule. A duplicate is refused with `null` — the
     * conflict is a real business answer the route maps to 409, not a
     * silent no-op pretending to be a create.
     */
    async createLevelReward(guildId: string, reward: Omit<LevelRoleReward, "id">): Promise<LevelRoleReward | null> {
      const { rows } = await pool.query<{ id: string; kind: LevelRewardKind; level: number; required_voice_level: number | null; role_id: string }>(
        `INSERT INTO level_role_rewards (id, guild_id, kind, level, required_voice_level, role_id, always_keep)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (guild_id, kind, level, required_voice_level, role_id) DO NOTHING
         RETURNING id, kind, level, required_voice_level, role_id`,
        [randomUUID(), guildId, reward.kind, reward.level, reward.voiceLevel, reward.roleId, reward.alwaysKeep]
      );
      const row = rows[0];
      if (!row) return null;
      return {
        id: row.id,
        kind: row.kind,
        level: row.level,
        voiceLevel: row.required_voice_level,
        roleId: row.role_id,
        alwaysKeep: reward.alwaysKeep
      };
    },

    /**
     * Updates one reward rule. `not_found` and `conflict` are distinct
     * answers — editing a rule into a shape another rule already holds is a
     * business rejection (409), not a missing row (404) and not a 500.
     */
    async updateLevelReward(
      guildId: string,
      rewardId: string,
      reward: Omit<LevelRoleReward, "id">
    ): Promise<{ ok: true } | { ok: false; reason: "not_found" | "conflict" }> {
      try {
        const { rowCount } = await pool.query(
          `UPDATE level_role_rewards SET kind = $3, level = $4, required_voice_level = $5, role_id = $6, always_keep = $7
           WHERE guild_id = $1 AND id = $2`,
          [guildId, rewardId, reward.kind, reward.level, reward.voiceLevel, reward.roleId, reward.alwaysKeep]
        );
        return rowCount === 1 ? { ok: true } : { ok: false, reason: "not_found" };
      } catch (error) {
        if (error instanceof pg.DatabaseError && error.code === "23505") return { ok: false, reason: "conflict" };
        throw error;
      }
    },

    async deleteLevelReward(guildId: string, rewardId: string): Promise<boolean> {
      const { rowCount } = await pool.query(`DELETE FROM level_role_rewards WHERE guild_id = $1 AND id = $2`, [
        guildId,
        rewardId
      ]);
      return rowCount === 1;
    },

    /**
     * Ensures one open sync job for the guild. Idempotent: a pending or
     * running job is returned as-is, a failed job is resumed from its cursor,
     * and only a fresh request after a completed pass starts a new one. The
     * bot's minute clock claims and runs it; nothing here needs the bot to be
     * reachable — the job row is the durable transport.
     */
    async createOrResumeSyncJob(guildId: string): Promise<LevelSyncJob> {
      const existing = await pool.query<LevelSyncJobRow>(
        `SELECT * FROM level_sync_jobs
         WHERE guild_id = $1 AND status IN ('pending','running')
         ORDER BY created_at DESC LIMIT 1`,
        [guildId]
      );
      if (existing.rows[0]) return mapSyncJob(existing.rows[0]);
      const failed = await pool.query<{ id: string }>(
        `SELECT id FROM level_sync_jobs
         WHERE guild_id = $1 AND status = 'failed'
         ORDER BY created_at DESC LIMIT 1`,
        [guildId]
      );
      if (failed.rows[0]) {
        const resumed = await pool.query<LevelSyncJobRow>(
          `UPDATE level_sync_jobs SET status = 'pending', error = NULL, updated_at = now()
           WHERE id = $1 RETURNING *`,
          [failed.rows[0].id]
        );
        return mapSyncJob(resumed.rows[0]);
      }
      const inserted = await pool.query<LevelSyncJobRow>(
        `INSERT INTO level_sync_jobs (id, guild_id) VALUES ($1, $2) RETURNING *`,
        [randomUUID(), guildId]
      );
      return mapSyncJob(inserted.rows[0]);
    },

    /** The guild's most recent sync job, for the progress surface. */
    async latestSyncJob(guildId: string): Promise<LevelSyncJob | null> {
      const { rows } = await pool.query<LevelSyncJobRow>(
        `SELECT * FROM level_sync_jobs WHERE guild_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [guildId]
      );
      return rows[0] ? mapSyncJob(rows[0]) : null;
    },

    /** The signed-in member's own XP totals, for the dual-rule state surface. */
    async memberLevels(guildId: string, userId: string): Promise<{ textXp: number; voiceXp: number } | null> {
      const { rows } = await pool.query<{ text_xp: number; voice_xp: number }>(
        `SELECT text_xp, voice_xp FROM user_guild_levels WHERE guild_id = $1 AND user_id = $2`,
        [guildId, userId]
      );
      return rows[0] ? { textXp: rows[0].text_xp, voiceXp: rows[0].voice_xp } : null;
    },

    /**
     * The levels system status: engine switch, the last time XP actually
     * moved, and the bot's last minute-clock heartbeat written through
     * instance_settings. Every value is read from real state — the card on
     * the screen repeats what the data says, never what it hopes.
     */
    async levelsStatus(guildId: string): Promise<{
      enabled: boolean;
      lastXpWriteAt: string | null;
      lastVoiceTickAt: string | null;
      voiceSessions: number | null;
      sync: LevelSyncJob | null;
    }> {
      const settings = await pool.query<{ enabled: boolean }>(
        `SELECT enabled FROM guild_levels WHERE guild_id = $1`,
        [guildId]
      );
      const activity = await pool.query<{ last_write: Date | null }>(
        `SELECT GREATEST(MAX(last_text_xp_at), MAX(last_voice_xp_at)) AS last_write FROM user_guild_levels WHERE guild_id = $1`,
        [guildId]
      );
      const markers = await pool.query<{ key: string; value: string }>(
        `SELECT key, value FROM instance_settings WHERE key IN ('levels.last_voice_tick_at','levels.voice_sessions')`
      );
      const marker = (key: string) => markers.rows.find(row => row.key === key)?.value ?? null;
      const tickAt = marker("levels.last_voice_tick_at");
      const sessions = marker("levels.voice_sessions");
      const latestJob = await pool.query<LevelSyncJobRow>(
        `SELECT * FROM level_sync_jobs WHERE guild_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [guildId]
      );
      return {
        enabled: settings.rows[0]?.enabled ?? false,
        lastXpWriteAt: activity.rows[0].last_write ? new Date(activity.rows[0].last_write).toISOString() : null,
        lastVoiceTickAt: tickAt ? new Date(tickAt).toISOString() : null,
        voiceSessions: sessions === null ? null : Number(sessions),
        sync: latestJob.rows[0] ? mapSyncJob(latestJob.rows[0]) : null
      };
    },

    /**
     * One leaderboard page plus the stats cards. Levels are derived from XP
     * here through the shared formula, never stored — a stored level would be
     * a second copy of the truth the screen's formula card advertises.
     */
    async levelLeaderboard(
      guildId: string,
      track: "text" | "voice",
      limit: number,
      offset: number
    ): Promise<{
      entries: { userId: string; displayName: string | null; avatarHash: string | null; xp: number }[];
      total: number;
      stats: { highestLevel: number; totalXp: number; rankedMembers: number };
    }> {
      const xpColumn = track === "voice" ? "voice_xp" : "text_xp";
      // A hidden member keeps earning XP. They stay listed with their flag so
      // the operator can un-hide them, but the board's stats stop counting
      // them, and the UI renders their row dimmed.
      const entries = await pool.query<{ user_id: string; display_name: string | null; avatar_hash: string | null; xp: number; leaderboard_hidden: boolean }>(
        `SELECT user_id, display_name, avatar_hash, ${xpColumn} AS xp, leaderboard_hidden FROM user_guild_levels
         WHERE guild_id = $1 AND ${xpColumn} > 0
         ORDER BY ${xpColumn} DESC, user_id ASC
         LIMIT $2 OFFSET $3`,
        [guildId, limit, offset]
      );
      const stats = await pool.query<{
        highest_xp: number | null;
        total_xp: string | number | null;
        ranked_members: string | number;
      }>(
        `SELECT MAX(${xpColumn}) AS highest_xp, SUM(${xpColumn}) AS total_xp, COUNT(*) AS ranked_members
         FROM user_guild_levels WHERE guild_id = $1 AND ${xpColumn} > 0 AND NOT leaderboard_hidden`,
        [guildId]
      );
      const row = stats.rows[0];
      const highestXp = row?.highest_xp ?? 0;
      // Levels on the board derive through the guild's own cap, the same one
      // the bot and the screens use — never through a private default.
      const capRow = await pool.query<{ max_level_cap: number }>(
        `SELECT max_level_cap FROM guild_levels WHERE guild_id = $1`,
        [guildId]
      );
      const capSetting = capRow.rows[0]?.max_level_cap;
      const cap = capSetting === undefined || capSetting === 0 ? MAX_LEVEL_CAP : capSetting;
      return {
        entries: entries.rows.map(entry => ({
          userId: entry.user_id,
          displayName: entry.display_name,
          avatarHash: entry.avatar_hash,
          xp: entry.xp,
          hidden: entry.leaderboard_hidden
        })),
        total: Number(row?.ranked_members ?? 0),
        stats: {
          highestLevel: levelFromXp(highestXp, cap),
          totalXp: Number(row?.total_xp ?? 0),
          rankedMembers: Number(row?.ranked_members ?? 0)
        }
      };
    },

    /**
     * Operator writes on one member, from the leaderboard's admin menu.
     *
     * Setting XP overwrites the totals outright — levels are derived, so the
     * next read speaks the truth. Both writes reconcile reward roles through
     * a sync request, because a raise can earn roles and a reset can strand
     * them; the request lives in the sync job machine, so the bot picks it up
     * within a minute and the operator never has to remember.
     */

    /** Overwrites a member's XP totals. `null` leaves that track untouched. */
    async setMemberXp(
      guildId: string,
      userId: string,
      values: { textXp: number | null; voiceXp: number | null }
    ): Promise<boolean> {
      const { rowCount } = await pool.query(
        `UPDATE user_guild_levels SET
           text_xp = COALESCE($3, text_xp),
           voice_xp = COALESCE($4, voice_xp),
           updated_at = now()
         WHERE guild_id = $1 AND user_id = $2`,
        [guildId, userId, values.textXp, values.voiceXp]
      );
      return rowCount === 1;
    },

    /** Sets (or clears) a member's leaderboard exclusion. */
    async setMemberLeaderboardHidden(guildId: string, userId: string, hidden: boolean): Promise<boolean> {
      const { rowCount } = await pool.query(
        `UPDATE user_guild_levels SET leaderboard_hidden = $3, updated_at = now()
         WHERE guild_id = $1 AND user_id = $2`,
        [guildId, userId, hidden]
      );
      return rowCount === 1;
    },

    /** One instance-wide deployment setting, or null when it was never saved. */
    async getSetting(key: string): Promise<string | null> {
      const { rows } = await pool.query<{ value: string }>(
        `SELECT value FROM instance_settings WHERE key = $1`,
        [key]
      );
      return rows[0]?.value ?? null;
    },

    async setSetting(key: string, value: string) {
      await pool.query(
        `INSERT INTO instance_settings (key, value, updated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (key) DO UPDATE
           SET value = EXCLUDED.value,
               updated_at = now()`,
        [key, value]
      );
    },

    async saveLogging(guildId: string, settings: LoggingSettings) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO guild_logging (guild_id, enabled, mode, global_channel_id, ignored_channel_ids, ignored_role_ids, embed_color, category_colors, event_flags, category_channels, event_channels, event_colors, updated_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb, now())
           ON CONFLICT (guild_id) DO UPDATE
             SET enabled = EXCLUDED.enabled,
                 mode = EXCLUDED.mode,
                 global_channel_id = EXCLUDED.global_channel_id,
                 ignored_channel_ids = EXCLUDED.ignored_channel_ids,
                 ignored_role_ids = EXCLUDED.ignored_role_ids,
                 embed_color = EXCLUDED.embed_color,
                 category_colors = EXCLUDED.category_colors,
                 event_flags = EXCLUDED.event_flags,
                 category_channels = EXCLUDED.category_channels,
                 event_channels = EXCLUDED.event_channels,
                 event_colors = EXCLUDED.event_colors,
                 updated_at = now()`,
          [
            guildId,
            settings.enabled,
            settings.mode,
            settings.globalChannelId,
            JSON.stringify(settings.ignoredChannelIds),
            JSON.stringify(settings.ignoredRoleIds),
            settings.embedColor,
            JSON.stringify(settings.categoryColors),
            JSON.stringify(settings.eventFlags),
            JSON.stringify(settings.categoryChannels),
            JSON.stringify(settings.eventChannels),
            JSON.stringify(settings.eventColors)
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
      /** The @handle, beside the display name. */
      discordHandle?: string | null;
      discordAvatar?: string | null;
      accessTokenCiphertext: string;
      scopes: string;
    }) {
      const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000);
      await pool.query(
        `INSERT INTO oauth_sessions (id, discord_user_id, discord_username, discord_handle, discord_avatar, access_token_ciphertext, scopes, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          input.id,
          input.discordUserId,
          input.discordUsername,
          input.discordHandle ?? null,
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
        `SELECT id, discord_user_id, discord_username, discord_handle, discord_avatar, access_token_ciphertext, scopes, expires_at
         FROM oauth_sessions WHERE id = $1 AND expires_at > now()`,
        [id]
      );
      const row = rows[0];
      if (!row) return null;
      return {
        id: row.id,
        discordUserId: row.discord_user_id,
        discordUsername: row.discord_username,
        discordHandle: row.discord_handle ?? null,
        discordAvatar: row.discord_avatar ?? null,
        accessTokenCiphertext: row.access_token_ciphertext,
        scopes: row.scopes,
        expiresAt: row.expires_at
      };
    },

    async touchSession(id: string) {
      // Nothing reads `last_seen_at`; it is a liveness signal for an operator's
      // own query, not a value a request needs. Writing it on every
      // authenticated request made each one a SELECT *and* an UPDATE, so it is
      // refreshed at most once a minute per session — one statement either way,
      // no extra round trip, and a request inside the window writes nothing.
      await pool.query(
        `UPDATE oauth_sessions SET last_seen_at = now()
          WHERE id = $1 AND last_seen_at < now() - interval '1 minute'`,
        [id]
      );
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
        allowed_user_ids: string[] | null;
        denied_user_ids: string[] | null;
        cooldown_seconds: number;
        auto_delete_response_seconds: number;
        require_reason: boolean;
        allow_custom_reason: boolean;
        default_duration: string;
        preset_reasons: unknown;
        aliases: unknown;
        delete_response_on_leave: boolean;
        muted_role_id: string | null;
        prison_role_id: string | null;
        prison_channel_id: string | null;
        blacklist_role_ids: unknown;
        admin_role_ids_to_strip: unknown;
        blockable_role_ids: unknown;
      }>(
        `SELECT command, enabled, minimum_tier, dm_on_action, delete_message_days,
                allowed_role_ids, denied_role_ids, allowed_channel_ids, denied_channel_ids,
                allowed_user_ids, denied_user_ids,
                cooldown_seconds, auto_delete_response_seconds, require_reason, allow_custom_reason,
                default_duration, preset_reasons, aliases, delete_response_on_leave,
                muted_role_id, prison_role_id, prison_channel_id,
                blacklist_role_ids, admin_role_ids_to_strip, blockable_role_ids
         FROM guild_command_flags WHERE guild_id = $1`,
        [guildId]
      );
      // Values are passed through raw and cleaned by `normaliseCommandConfig`,
      // which is the same function the bot reads through — so a row written by an
      // older build cannot mean two different things on the two sides.
      //
      // The six role fields are read here even for commands that do not own them.
      // That is deliberate: `normaliseCommandConfig` is what decides, and it drops
      // a field onto the wrong row rather than trusting it — so the drop happens
      // in one place instead of being re-implemented as a filter here.
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
            allowedUserIds: row.allowed_user_ids ?? [],
            deniedUserIds: row.denied_user_ids ?? [],
            cooldownSeconds: row.cooldown_seconds,
            autoDeleteResponseSeconds: row.auto_delete_response_seconds,
            requireReason: row.require_reason,
            allowCustomReason: row.allow_custom_reason,
            defaultDuration: row.default_duration as CommandConfig["defaultDuration"],
            presetReasons: Array.isArray(row.preset_reasons) ? (row.preset_reasons as CommandConfig["presetReasons"]) : [],
            aliases: Array.isArray(row.aliases) ? (row.aliases as string[]) : [],
            deleteResponseOnLeave: row.delete_response_on_leave,
            mutedRoleId: row.muted_role_id,
            prisonRoleId: row.prison_role_id,
            prisonChannelId: row.prison_channel_id,
            blacklistRoleIds: Array.isArray(row.blacklist_role_ids) ? (row.blacklist_role_ids as string[]) : [],
            adminRoleIdsToStrip: Array.isArray(row.admin_role_ids_to_strip) ? (row.admin_role_ids_to_strip as string[]) : [],
            blockableRoleIds: Array.isArray(row.blockable_role_ids) ? (row.blockable_role_ids as string[]) : []
          }
        ])
      );
    },

    async saveCommandFlag(guildId: string, config: CommandConfig) {
      await pool.query(
        `INSERT INTO guild_command_flags (
           guild_id, command, enabled, minimum_tier, dm_on_action, delete_message_days,
           allowed_role_ids, denied_role_ids, allowed_channel_ids, denied_channel_ids,
           allowed_user_ids, denied_user_ids,
           cooldown_seconds, auto_delete_response_seconds, require_reason, allow_custom_reason,
           default_duration, preset_reasons, aliases, delete_response_on_leave,
           muted_role_id, prison_role_id, prison_channel_id,
           blacklist_role_ids, admin_role_ids_to_strip, blockable_role_ids,
           updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb,
                 $13, $14, $15, $16, $17, $18::jsonb, $19::jsonb, $20,
                 $21, $22, $23, $24::jsonb, $25::jsonb, $26::jsonb, now())
         ON CONFLICT (guild_id, command) DO UPDATE
           SET enabled = EXCLUDED.enabled,
               minimum_tier = EXCLUDED.minimum_tier,
               dm_on_action = EXCLUDED.dm_on_action,
               delete_message_days = EXCLUDED.delete_message_days,
               allowed_role_ids = EXCLUDED.allowed_role_ids,
               denied_role_ids = EXCLUDED.denied_role_ids,
               allowed_channel_ids = EXCLUDED.allowed_channel_ids,
               denied_channel_ids = EXCLUDED.denied_channel_ids,
               allowed_user_ids = EXCLUDED.allowed_user_ids,
               denied_user_ids = EXCLUDED.denied_user_ids,
               cooldown_seconds = EXCLUDED.cooldown_seconds,
               auto_delete_response_seconds = EXCLUDED.auto_delete_response_seconds,
               require_reason = EXCLUDED.require_reason,
               allow_custom_reason = EXCLUDED.allow_custom_reason,
               default_duration = EXCLUDED.default_duration,
               preset_reasons = EXCLUDED.preset_reasons,
               aliases = EXCLUDED.aliases,
               delete_response_on_leave = EXCLUDED.delete_response_on_leave,
               muted_role_id = EXCLUDED.muted_role_id,
               prison_role_id = EXCLUDED.prison_role_id,
               prison_channel_id = EXCLUDED.prison_channel_id,
               blacklist_role_ids = EXCLUDED.blacklist_role_ids,
               admin_role_ids_to_strip = EXCLUDED.admin_role_ids_to_strip,
               blockable_role_ids = EXCLUDED.blockable_role_ids,
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
          JSON.stringify(config.allowedUserIds),
          JSON.stringify(config.deniedUserIds),
          config.cooldownSeconds,
          config.autoDeleteResponseSeconds,
          config.requireReason,
          config.allowCustomReason,
          config.defaultDuration,
          JSON.stringify(config.presetReasons),
          JSON.stringify(config.aliases),
          config.deleteResponseOnLeave,
          config.mutedRoleId,
          config.prisonRoleId,
          config.prisonChannelId,
          JSON.stringify(config.blacklistRoleIds),
          JSON.stringify(config.adminRoleIdsToStrip),
          JSON.stringify(config.blockableRoleIds)
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
