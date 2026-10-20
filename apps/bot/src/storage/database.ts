import pg from "pg";
import { randomUUID } from "node:crypto";
import {
  DEFAULT_ANTI_NUKE_CONFIG,
  DEFAULT_BOT_PRESENCE,
  DEFAULT_EMBED_COLOR,
  DEFAULT_INVITE_SETTINGS,
  DEFAULT_LEVEL_SETTINGS,
  DEFAULT_LOGGING_MODE,
  DEFAULT_WELCOME_MESSAGE_SETTINGS,
  DEFAULT_WELCOME_SETTINGS,
  EMPTY_INVITE_STATS,
  encryptSecret,
  isLoggingMode,
  isTier,
  normaliseAntiNukeConfig,
  normaliseInviteSettings,
  normaliseLevelSettings,
  normaliseLevelRewardList,
  normaliseLoggingMode,
  normaliseBotPresence,
  normaliseTierRoles,
  normaliseWelcomeMessageSettings,
  normaliseWelcomeSettings,
  type AntiNukeConfig,
  type BotPresenceSettings,
  type CommandConfig,
  type InviteJoinKind,
  type InviteSettings,
  type InviteStats,
  type LevelRoleReward,
  type LevelSettings,
  type LogDestination,
  type LoggingMode,
  type TierRoles,
  type WelcomeMessageSettings,
  type WelcomeSettings
} from "@al-ai/core";

/** One member's invite history row, as the bot's callers read it. */
export type InviteMemberRow = {
  userId: string;
  inviterId: string | null;
  inviteCode: string | null;
  kind: InviteJoinKind;
  counted: boolean;
  accountAgeMs: number | null;
  joinedAt: string;
  leftAt: string | null;
};

const { Pool } = pg;

export type GuildLoggingConfig = {
  enabled: boolean;
  mode: LoggingMode;
  globalChannelId: string | null;
  ignoredChannelIds: string[];
  ignoredRoleIds: string[];
  embedColor: string;
  categoryColors: Partial<Record<LogDestination, string>>;
  eventFlags: Record<string, boolean>;
  categoryChannels: Partial<Record<LogDestination, string>>;
  eventChannels: Record<string, string>;
  eventColors: Record<string, string>;
};

export const emptyLoggingConfig: GuildLoggingConfig = {
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

/**
 * The reversible punishments: the ones that put a member into a state rather
 * than applying an event that is over when it returns.
 *
 * The names match the `kind` values the schema constrains, because `kind` is
 * what selects which inverse command can find a row again — a mismatch here
 * would leave a member punished with nothing that admits to it.
 */
export type MemberStateKind = "mute" | "prison" | "blacklist" | "block" | "down";

/** One row of `guild_member_states`, with the column names mapped to camelCase. */
export type MemberState = {
  id: string;
  guildId: string;
  userId: string;
  kind: MemberStateKind;
  /** The roles the member held before the punishment took any away. */
  roleIds: string[];
  /** `/block` only: the roles this member may not be given. */
  blockedRoleIds: string[];
  moderatorId: string;
  reason: string;
  /** `null` means "until someone reverses it". */
  expiresAt: Date | null;
  createdAt: Date;
};

const MEMBER_STATE_COLUMNS = `
  id,
  guild_id         AS "guildId",
  user_id          AS "userId",
  kind,
  role_ids         AS "roleIds",
  blocked_role_ids AS "blockedRoleIds",
  moderator_id     AS "moderatorId",
  reason,
  expires_at       AS "expiresAt",
  created_at       AS "createdAt"
`;

export type BotDatabase = ReturnType<typeof createBotDatabase>;

export function createBotDatabase(databaseUrl: string) {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 5,
    idleTimeoutMillis: 30_000,
    // Same caps as the dashboard's pool: a hung query must not pin a slot
    // forever, and a forgotten BEGIN must not hold its connection idle.
    connectionTimeoutMillis: 5_000,
    options: "-c statement_timeout=15000 -c idle_in_transaction_session_timeout=10000"
  });
  pool.on("error", error => console.error("AL AI bot database pool error", error));

  return {
    async ping() {
      await pool.query("SELECT 1");
      return true;
    },

    async loadLogging(guildId: string): Promise<GuildLoggingConfig> {
      const { rows } = await pool.query(
        `SELECT enabled, mode, global_channel_id, ignored_channel_ids, ignored_role_ids, embed_color, category_colors, event_flags, category_channels, event_channels, event_colors
         FROM guild_logging WHERE guild_id = $1`,
        [guildId]
      );
      const row = rows[0];
      if (!row) return { ...emptyLoggingConfig };
      return {
        enabled: row.enabled,
        // A row written before the mode existed carries no value, and a row
        // written by the earlier schema carries `single` or `granular`. Both
        // reach `normal`, which keeps what the guild actually configured: the
        // global room is still the fallback every event resolves to.
        mode: normaliseLoggingMode(row.mode),
        globalChannelId: row.global_channel_id,
        ignoredChannelIds: row.ignored_channel_ids ?? [],
        ignoredRoleIds: row.ignored_role_ids ?? [],
        embedColor: row.embed_color,
        // Absent on a row written before the column existed: the destination then
        // inherits `embedColor`, which is the behaviour it had before.
        categoryColors: row.category_colors ?? {},
        eventFlags: row.event_flags ?? {},
        categoryChannels: row.category_channels ?? {},
        eventChannels: row.event_channels ?? {},
        eventColors: row.event_colors ?? {}
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
     * The welcome screen's settings. Read-only from the bot's side — only the
     * dashboard writes them — and normalised through the same helper, so a row
     * the BFF wrote and a row the bot reads cannot disagree about what a
     * half-typed id means. A missing row is simply the feature, off.
     */
    async loadWelcome(guildId: string): Promise<WelcomeSettings> {
      const { rows } = await pool.query<{
        enabled: boolean;
        member_role_id: string | null;
        bot_role_id: string | null;
        delay_seconds: number;
      }>(
        `SELECT enabled, member_role_id, bot_role_id, delay_seconds FROM guild_welcome WHERE guild_id = $1`,
        [guildId]
      );
      const row = rows[0];
      if (!row) return DEFAULT_WELCOME_SETTINGS;
      return normaliseWelcomeSettings({
        enabled: row.enabled,
        memberRoleId: row.member_role_id,
        botRoleId: row.bot_role_id,
        delaySeconds: row.delay_seconds
      });
    },

    /**
     * The bot's presence: the fields that are the same in every guild.
     *
     * This is the one appearance value the dashboard cannot write. A status
     * lives on the gateway connection, so the bot reads it from here and applies
     * it itself; everything a single server can override — nickname, avatar,
     * banner, bio, role appearance — is on `guild_customization` and written by
     * the dashboard over REST.
     */
    async loadBotIdentity(): Promise<BotPresenceSettings> {
      const { rows } = await pool.query<{
        status: string | null;
        activity_type: string | null;
        activity_text: string | null;
        status_duration: string | null;
        status_expires_at: Date | string | null;
      }>(`SELECT status, activity_type, activity_text, status_duration, status_expires_at FROM bot_identity WHERE id = true`);
      const row = rows[0];
      // No row means nothing has been customised yet, so the shipped defaults apply.
      return normaliseBotPresence({
        status: row?.status ?? DEFAULT_BOT_PRESENCE.status,
        activityType: row?.activity_type ?? DEFAULT_BOT_PRESENCE.activityType,
        activityText: row?.activity_text ?? DEFAULT_BOT_PRESENCE.activityText,
        // The window matters to the gateway: it is what makes a timed status
        // end. Omitting these two columns would leave the bot applying `dnd`
        // forever while the dashboard showed a countdown — the duration would
        // save and never apply.
        statusDuration: row?.status_duration ?? DEFAULT_BOT_PRESENCE.statusDuration,
        // `pg` returns a TIMESTAMPTZ as a Date; the contract promises an ISO
        // string, and `normaliseBotPresence` parses only strings.
        statusExpiresAt:
          row?.status_expires_at === null || row?.status_expires_at === undefined
            ? DEFAULT_BOT_PRESENCE.statusExpiresAt
            : new Date(row.status_expires_at).toISOString()
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
      }>(
        `SELECT command, enabled, minimum_tier, dm_on_action, delete_message_days,
                allowed_role_ids, denied_role_ids, allowed_channel_ids, denied_channel_ids,
                allowed_user_ids, denied_user_ids,
                cooldown_seconds, auto_delete_response_seconds, require_reason, allow_custom_reason,
                default_duration, preset_reasons, aliases, delete_response_on_leave
         FROM guild_command_flags WHERE guild_id = $1`,
        [guildId]
      );
      // Every value is passed through raw and cleaned by `normaliseCommandConfig`
      // — the same function the dashboard writes through — so a control the
      // command does not support can never be honoured here even if a row
      // somehow carries it.
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
            deleteResponseOnLeave: row.delete_response_on_leave
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

    /**
     * A member's warnings, newest first. Capped so `/warns` can always render.
     *
     * The `id` tiebreaker is load-bearing: `created_at` defaults to `now()`, the
     * *transaction* timestamp, so two warnings written in one transaction share
     * it exactly. Without a second sort key PostgreSQL may order those two
     * either way, and `/delwarn` resolves the same index in its own statement —
     * so a tie would make the number `/warns` printed point at a different row
     * than the one deleted.
     */
    async listWarnings(guildId: string, userId: string, limit = 10) {
      const { rows } = await pool.query<{ id: string; moderator_id: string; reason: string; created_at: Date }>(
        `SELECT id, moderator_id, reason, created_at
         FROM guild_warnings
         WHERE guild_id = $1 AND user_id = $2
         ORDER BY created_at DESC, id DESC
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

    /**
     * Removes one warning, identified by the number `/warns` prints beside it.
     *
     * `index` is 1-based and counts from the newest, which is the order `/warns`
     * lists them in — so the number the operator read is the number they type.
     * Resolving it inside the statement rather than reading the list first and
     * deleting by id keeps the two from disagreeing: a warning added between the
     * read and the delete would shift every number below it.
     *
     * The tiebreaker on `id` is load-bearing, not decoration. Two warnings can
     * share a `created_at` — `now()` is the transaction timestamp, so a script or
     * a retry can produce a tie — and without a second sort key PostgreSQL is
     * free to order them either way, which would make index 1 mean one row on the
     * list and a different row on the delete.
     *
     * Returns the removed warning's reason, or `null` when the index is past the
     * end so the caller can say "no such warning" rather than "deleted".
     */
    async deleteWarningAt(guildId: string, userId: string, index: number) {
      const offset = Math.max(Math.trunc(index), 1) - 1;
      const { rows } = await pool.query<{ reason: string }>(
        `DELETE FROM guild_warnings
          WHERE id = (
            SELECT id FROM guild_warnings
             WHERE guild_id = $1 AND user_id = $2
             ORDER BY created_at DESC, id DESC
             OFFSET $3 LIMIT 1
          )
          RETURNING reason`,
        [guildId, userId, offset]
      );
      return rows[0]?.reason ?? null;
    },

    /* ---------------- Reversible punishments ---------------- */

    /**
     * Records the state a reversible punishment put a member into.
     *
     * Upsert on `(guild_id, user_id, kind)` rather than an insert: a second
     * `/mute` on an already-muted member must leave exactly one row, so
     * `/unmute` has one thing to undo. Two rows would let an unmute remove the
     * newer one, report success, and leave the member silenced.
     *
     * `roleIds` is the snapshot taken *before* any roles were removed, which is
     * the only record of what to give back — Discord cannot be asked which roles
     * the bot took away, and by the time the inverse runs the member may have
     * gained and lost roles for reasons of their own.
     */
    async setMemberState(state: {
      id: string;
      guildId: string;
      userId: string;
      kind: MemberStateKind;
      roleIds?: readonly string[];
      blockedRoleIds?: readonly string[];
      moderatorId: string;
      reason: string;
      expiresAt?: Date | null;
    }) {
      await pool.query(
        `INSERT INTO guild_member_states
           (id, guild_id, user_id, kind, role_ids, blocked_role_ids, moderator_id, reason, expires_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9)
         ON CONFLICT (guild_id, user_id, kind) DO UPDATE
            SET role_ids = EXCLUDED.role_ids,
                blocked_role_ids = EXCLUDED.blocked_role_ids,
                moderator_id = EXCLUDED.moderator_id,
                reason = EXCLUDED.reason,
                expires_at = EXCLUDED.expires_at,
                -- The punishment restarted, so its clock restarts with it.
                created_at = now()`,
        [
          state.id,
          state.guildId,
          state.userId,
          state.kind,
          JSON.stringify(state.roleIds ?? []),
          JSON.stringify(state.blockedRoleIds ?? []),
          state.moderatorId,
          state.reason,
          state.expiresAt ?? null
        ]
      );
    },

    /** The standing state for one member and kind, or `null`. */
    async getMemberState(guildId: string, userId: string, kind: MemberStateKind) {
      const { rows } = await pool.query<MemberState>(
        `SELECT ${MEMBER_STATE_COLUMNS} FROM guild_member_states
          WHERE guild_id = $1 AND user_id = $2 AND kind = $3`,
        [guildId, userId, kind]
      );
      return rows[0] ?? null;
    },

    /**
     * Removes the state and hands it back, in one statement.
     *
     * `DELETE ... RETURNING` rather than a read followed by a delete. Two
     * moderators running `/unprison` at the same moment would otherwise both
     * read the snapshot and both restore it, and the second restore would re-add
     * roles the first had already dealt with. One statement means exactly one
     * caller receives the snapshot and the other receives `null` — so the
     * outcome is "restored once", not "restored, then restored again".
     */
    async takeMemberState(guildId: string, userId: string, kind: MemberStateKind) {
      const { rows } = await pool.query<MemberState>(
        `DELETE FROM guild_member_states
          WHERE guild_id = $1 AND user_id = $2 AND kind = $3
          RETURNING ${MEMBER_STATE_COLUMNS}`,
        [guildId, userId, kind]
      );
      return rows[0] ?? null;
    },


    /**
     * The states whose expiry has passed. The sweeper's query.
     *
     * Capped because it runs on a timer: a backlog should be worked through over
     * several passes rather than held in memory in one, and the cap makes that
     * bounded rather than a function of how long the bot was down.
     */
    async listDueMemberStates(now: Date, limit = 100) {
      const { rows } = await pool.query<MemberState>(
        `SELECT ${MEMBER_STATE_COLUMNS} FROM guild_member_states
          WHERE expires_at IS NOT NULL AND expires_at <= $1
          ORDER BY expires_at ASC
          LIMIT $2`,
        [now, limit]
      );
      return rows;
    },

    /* ---------------- Guild-wide wipes ---------------- */

    /** Empties a guild's warnings. `/clearallwarns`. */
    async clearAllWarnings(guildId: string) {
      const { rowCount } = await pool.query(`DELETE FROM guild_warnings WHERE guild_id = $1`, [guildId]);
      return rowCount ?? 0;
    },

    /**
     * Empties a guild's punishment record: the warnings *and* the standing
     * states. `/clearallpunishments`.
     *
     * Both, in one statement. Deleting only the warnings would leave the log
     * reading empty while members were still muted, jailed or stripped — a wipe
     * that removed the evidence and left the punishment in place, which is the
     * worst of both.
     *
     * A single statement with data-modifying CTEs is atomic in PostgreSQL, so
     * there is no window where the warnings are gone and the states are not.
     */
    async clearAllPunishments(guildId: string) {
      const { rows } = await pool.query<{ warnings: number; states: number }>(
        `WITH removed_warnings AS (
           DELETE FROM guild_warnings WHERE guild_id = $1 RETURNING 1
         ), removed_states AS (
           DELETE FROM guild_member_states WHERE guild_id = $1 RETURNING 1
         )
         SELECT (SELECT count(*)::int FROM removed_warnings) AS warnings,
                (SELECT count(*)::int FROM removed_states)   AS states`,
        [guildId]
      );
      return rows[0] ?? { warnings: 0, states: 0 };
    },

    /**
     * Every punishment on record for one member, newest first.
     *
     * Warnings and standing states in one list, because `/remove` deletes by the
     * number `/warns`-style listings print — and an operator looking at a member
     * does not think of "a warning" and "a mute" as living in different places.
     * The `kind` travels with each entry so the caller knows which table to
     * delete from and whether the Discord side needs reversing too.
     */
    async listPunishments(guildId: string, userId: string, limit = 25) {
      const { rows } = await pool.query<{
        kind: string;
        id: string;
        reason: string;
        moderatorId: string;
        createdAt: Date;
        expiresAt: Date | null;
      }>(
        `SELECT 'warn' AS kind, id::text AS id, reason,
                moderator_id AS "moderatorId", created_at AS "createdAt",
                NULL::timestamptz AS "expiresAt"
           FROM guild_warnings WHERE guild_id = $1 AND user_id = $2
         UNION ALL
         SELECT kind, id::text, reason,
                moderator_id, created_at, expires_at
           FROM guild_member_states WHERE guild_id = $1 AND user_id = $2
         ORDER BY "createdAt" DESC, id DESC
         LIMIT $3`,
        [guildId, userId, limit]
      );
      return rows;
    },

    /**
     * Removes the punishment at `index` (1-based, newest first) and reports what
     * it was, or `null` when the index is past the end.
     *
     * Resolved inside one statement by `OFFSET` rather than fetched as a list and
     * indexed in JS: the list carried a default limit of 25, so `/remove 26` on a
     * member with thirty punishments was answered "no such punishment" for one
     * that exists. The entry may live in either of two tables, so a single DELETE
     * would have to guess; the id is resolved first and the delete is conditional
     * on it, so a row that disappeared in between removes nothing and says so
     * instead of reporting a success that did not happen.
     */
    async deletePunishmentAt(guildId: string, userId: string, index: number) {
      const position = Math.max(Math.trunc(index), 1);
      const { rows } = await pool.query<{
        kind: string;
        id: string;
        reason: string;
        moderatorId: string;
        createdAt: Date;
        expiresAt: Date | null;
      }>(
        `SELECT kind, id::text AS id, reason,
                moderator_id AS "moderatorId", created_at AS "createdAt",
                expires_at AS "expiresAt"
           FROM (
             SELECT 'warn' AS kind, id, reason, moderator_id, created_at,
                    NULL::timestamptz AS expires_at
               FROM guild_warnings WHERE guild_id = $1 AND user_id = $2
             UNION ALL
             SELECT kind, id, reason, moderator_id, created_at, expires_at
               FROM guild_member_states WHERE guild_id = $1 AND user_id = $2
           ) entries
         ORDER BY "createdAt" DESC, id DESC
         LIMIT 1 OFFSET $3`,
        [guildId, userId, position - 1]
      );
      const target = rows[0];
      if (!target) return null;

      const table = target.kind === "warn" ? "guild_warnings" : "guild_member_states";
      const { rowCount } = await pool.query(
        `DELETE FROM ${table} WHERE id = $1 AND guild_id = $2 AND user_id = $3`,
        [target.id, guildId, userId]
      );
      return rowCount ? target : null;
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

    /* ---------------------------------------------------------------- *
     * Levels system. The bot is the writer of XP rows and the reader of
     * settings; the dashboard owns the settings' write path. Both go through
     * the same core normalisers, so a value cannot mean one thing in the panel
     * and another in the engine.
     * ---------------------------------------------------------------- */

    /** A guild's level settings, or the shipped defaults when it has no row. */
    async loadLevelSettings(guildId: string): Promise<LevelSettings> {
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

    /** The guild's reward rules — text, voice and dual-condition, in one read. */
    async loadLevelRewards(guildId: string): Promise<LevelRoleReward[]> {
      const { rows } = await pool.query<Record<string, unknown>>(
        `SELECT id, kind, level, required_voice_level, role_id, always_keep
         FROM level_role_rewards WHERE guild_id = $1 ORDER BY kind, level, required_voice_level NULLS LAST`,
        [guildId]
      );
      return normaliseLevelRewardList(
        rows.map(row => ({
          id: row.id,
          kind: row.kind,
          level: row.level,
          voiceLevel: row.required_voice_level,
          roleId: row.role_id,
          alwaysKeep: row.always_keep
        }))
      );
    },

    /**
     * Adds text XP and returns the previous *and* new totals from one atomic
     * statement. The `prev` CTE shares the statement's snapshot, so it sees
     * the row exactly as it was before the upsert — a read failure can no
     * longer be mistaken for "0 XP", and a level-up is only ever detected
     * from a previous state the same write itself vouched for.
     */
    async recordTextXp(
      guildId: string,
      userId: string,
      amount: number,
      meta: { displayName?: string | null; avatarHash?: string | null }
    ): Promise<{ previous: { textXp: number; voiceXp: number } | null; current: { textXp: number; voiceXp: number } }> {
      const { rows } = await pool.query<{
        text_xp: number;
        voice_xp: number;
        prev_text_xp: number | null;
        prev_voice_xp: number | null;
      }>(
        `WITH prev AS (
           SELECT text_xp, voice_xp FROM user_guild_levels WHERE guild_id = $1 AND user_id = $2
         ), upsert AS (
           INSERT INTO user_guild_levels (guild_id, user_id, text_xp, display_name, avatar_hash, last_text_xp_at)
           VALUES ($1, $2, $3, $4, $5, now())
           ON CONFLICT (guild_id, user_id) DO UPDATE SET
             text_xp = user_guild_levels.text_xp + $3,
             display_name = COALESCE($4, user_guild_levels.display_name),
             avatar_hash = COALESCE($5, user_guild_levels.avatar_hash),
             last_text_xp_at = now(),
             updated_at = now()
           RETURNING text_xp, voice_xp
         )
         SELECT upsert.text_xp, upsert.voice_xp, prev.text_xp AS prev_text_xp, prev.voice_xp AS prev_voice_xp
         FROM upsert LEFT JOIN prev ON true`,
        [guildId, userId, amount, meta.displayName ?? null, meta.avatarHash ?? null]
      );
      const row = rows[0];
      return {
        previous: row.prev_text_xp === null ? null : { textXp: row.prev_text_xp, voiceXp: row.prev_voice_xp ?? 0 },
        current: { textXp: row.text_xp, voiceXp: row.voice_xp }
      };
    },

    /** Same as `recordTextXp`, on the voice track. */
    async recordVoiceXp(
      guildId: string,
      userId: string,
      amount: number,
      meta: { displayName?: string | null; avatarHash?: string | null }
    ): Promise<{ previous: { textXp: number; voiceXp: number } | null; current: { textXp: number; voiceXp: number } }> {
      const { rows } = await pool.query<{
        text_xp: number;
        voice_xp: number;
        prev_text_xp: number | null;
        prev_voice_xp: number | null;
      }>(
        `WITH prev AS (
           SELECT text_xp, voice_xp FROM user_guild_levels WHERE guild_id = $1 AND user_id = $2
         ), upsert AS (
           INSERT INTO user_guild_levels (guild_id, user_id, voice_xp, display_name, avatar_hash, last_voice_xp_at)
           VALUES ($1, $2, $3, $4, $5, now())
           ON CONFLICT (guild_id, user_id) DO UPDATE SET
             voice_xp = user_guild_levels.voice_xp + $3,
             display_name = COALESCE($4, user_guild_levels.display_name),
             avatar_hash = COALESCE($5, user_guild_levels.avatar_hash),
             last_voice_xp_at = now(),
             updated_at = now()
           RETURNING text_xp, voice_xp
         )
         SELECT upsert.text_xp, upsert.voice_xp, prev.text_xp AS prev_text_xp, prev.voice_xp AS prev_voice_xp
         FROM upsert LEFT JOIN prev ON true`,
        [guildId, userId, amount, meta.displayName ?? null, meta.avatarHash ?? null]
      );
      const row = rows[0];
      return {
        previous: row.prev_text_xp === null ? null : { textXp: row.prev_text_xp, voiceXp: row.prev_voice_xp ?? 0 },
        current: { textXp: row.text_xp, voiceXp: row.voice_xp }
      };
    },

    /**
     * One keyset-paginated page of ranked members, ordered by the stable
     * `user_id` primary key. Keyset — not OFFSET — because XP totals move
     * during a sync: an OFFSET page can skip or repeat members when the sort
     * key changes mid-pass, while `user_id > cursor` is immune.
     */
    async levelRanksPage(
      guildId: string,
      afterUserId: string | null,
      batchSize: number
    ): Promise<{ userId: string; textXp: number; voiceXp: number }[]> {
      const { rows } = await pool.query<{ user_id: string; text_xp: number; voice_xp: number }>(
        `SELECT user_id, text_xp, voice_xp FROM user_guild_levels
         WHERE guild_id = $1 AND (text_xp > 0 OR voice_xp > 0) AND user_id > $2
         ORDER BY user_id
         LIMIT $3`,
        [guildId, afterUserId ?? "", batchSize]
      );
      return rows.map(row => ({ userId: row.user_id, textXp: row.text_xp, voiceXp: row.voice_xp }));
    },

    /** How many ranked members a sync will visit, recorded as the job's total. */
    async countLevelRanks(guildId: string): Promise<number> {
      const { rows } = await pool.query<{ n: string }>(
        `SELECT COUNT(*) AS n FROM user_guild_levels
         WHERE guild_id = $1 AND (text_xp > 0 OR voice_xp > 0)`,
        [guildId]
      );
      return Number(rows[0].n);
    },

    /* ---------------------------------------------------------------- *
     * Sync jobs. The state machine lives in the database, not in the
     * browser or the bot's memory: pending → running → completed | failed,
     * resumable through `cursor` (the last member id processed). A crash
     * mid-pass leaves a `running` row that boot resets to `pending`, and
     * the pass continues from where it stopped.
     * ---------------------------------------------------------------- */

    /**
     * Ensures one open job per guild and returns it. A pending or running job
     * is returned as-is (idempotent double-click); a failed job is resumed
     * from its cursor; a completed job's new request starts a fresh pass.
     */
    async createOrResumeSyncJob(guildId: string): Promise<{
      id: string;
      status: "pending" | "running" | "completed" | "failed";
      cursor: string | null;
      processed: number;
      total: number | null;
    }> {
      const { rows } = await pool.query<{ id: string; status: string; cursor: string | null; processed: number; total: number | null }>(
        `SELECT id, status, cursor, processed, total FROM level_sync_jobs
         WHERE guild_id = $1 AND status IN ('pending','running')
         ORDER BY created_at DESC LIMIT 1`,
        [guildId]
      );
      if (rows[0]) {
        return { id: rows[0].id, status: rows[0].status as "pending" | "running", cursor: rows[0].cursor, processed: rows[0].processed, total: rows[0].total };
      }
      // The most recent failed job is resumed rather than duplicated — the
      // cursor makes "start over" the wrong default after a partial pass.
      const failed = await pool.query<{ id: string; cursor: string | null }>(
        `SELECT id, cursor FROM level_sync_jobs
         WHERE guild_id = $1 AND status = 'failed'
         ORDER BY created_at DESC LIMIT 1`,
        [guildId]
      );
      if (failed.rows[0]) {
        const resumed = await pool.query<{ id: string; status: string; cursor: string | null; processed: number; total: number | null }>(
          `UPDATE level_sync_jobs SET status = 'pending', error = NULL, updated_at = now()
           WHERE id = $1
           RETURNING id, status, cursor, processed, total`,
          [failed.rows[0].id]
        );
        const row = resumed.rows[0];
        return { id: row.id, status: "pending", cursor: row.cursor, processed: row.processed, total: row.total };
      }
      const inserted = await pool.query<{ id: string; status: string; cursor: string | null; processed: number; total: number | null }>(
        `INSERT INTO level_sync_jobs (id, guild_id) VALUES ($1, $2)
         RETURNING id, status, cursor, processed, total`,
        [randomUUID(), guildId]
      );
      const row = inserted.rows[0];
      return { id: row.id, status: "pending", cursor: row.cursor, processed: row.processed, total: row.total };
    },

    /** Open jobs the bot should work on, oldest first. */
    async openSyncJobs(): Promise<{ id: string; guildId: string; cursor: string | null }[]> {
      const { rows } = await pool.query<{ id: string; guild_id: string; cursor: string | null }>(
        `SELECT id, guild_id, cursor FROM level_sync_jobs
         WHERE status = 'pending'
         ORDER BY created_at
         LIMIT 5`
      );
      return rows.map(row => ({ id: row.id, guildId: row.guild_id, cursor: row.cursor }));
    },

    /**
     * Claims a pending job for this pass. The conditional update is the
     * double-run guard: exactly one claimer flips the row out of `pending`,
     * so even two racing bots cannot process the same job concurrently.
     */
    async claimSyncJob(id: string): Promise<boolean> {
      const { rowCount } = await pool.query(
        `UPDATE level_sync_jobs SET status = 'running', started_at = COALESCE(started_at, now()), updated_at = now()
         WHERE id = $1 AND status = 'pending'`,
        [id]
      );
      return rowCount === 1;
    },

    /** Records the job's total before the first batch, so progress is a ratio from the start. */
    async setSyncJobTotal(id: string, total: number) {
      await pool.query(`UPDATE level_sync_jobs SET total = $2, updated_at = now() WHERE id = $1`, [id, total]);
    },

    /** Advances the cursor and counters after one processed batch. */
    async updateSyncJobProgress(
      id: string,
      progress: { cursor: string | null; processed: number; granted: number; removed: number; skipped: number; failed: number }
    ) {
      await pool.query(
        `UPDATE level_sync_jobs SET cursor = $2, processed = $3, granted = $4, removed = $5, skipped = $6, failed = $7, updated_at = now()
         WHERE id = $1`,
        [id, progress.cursor, progress.processed, progress.granted, progress.removed, progress.skipped, progress.failed]
      );
    },

    async completeSyncJob(id: string, counters: { granted: number; removed: number; skipped: number; failed: number }) {
      await pool.query(
        `UPDATE level_sync_jobs
         SET status = 'completed', completed_at = now(), error = NULL,
             granted = $2, removed = $3, skipped = $4, failed = $5, updated_at = now()
         WHERE id = $1`,
        [id, counters.granted, counters.removed, counters.skipped, counters.failed]
      );
    },

    async failSyncJob(id: string, error: string) {
      await pool.query(
        `UPDATE level_sync_jobs SET status = 'failed', completed_at = now(), error = $2, updated_at = now()
         WHERE id = $1`,
        [id, error.slice(0, 500)]
      );
    },

    /** Boot recovery: this deployment runs one bot, so any `running` row it finds is its own crashed pass. */
    async resetStaleSyncJobs(): Promise<number> {
      const { rowCount } = await pool.query(
        `UPDATE level_sync_jobs SET status = 'pending', updated_at = now()
         WHERE status = 'running'`
      );
      return rowCount ?? 0;
    },

    /** Zeroes both XP tracks for one member (the reset-on-leave write). */
    async resetMemberXp(guildId: string, userId: string): Promise<boolean> {
      const { rowCount } = await pool.query(
        `UPDATE user_guild_levels SET text_xp = 0, voice_xp = 0, updated_at = now()
         WHERE guild_id = $1 AND user_id = $2`,
        [guildId, userId]
      );
      return rowCount === 1;
    },

    /* ---------------------------------------------------------------- *
     * Invites (referrals) module. Reads go through the core normaliser so
     * the bot and the dashboard cannot disagree about a stored value; the
     * counters move through atomic CTE upserts so two joins landing at the
     * same moment both survive.
     * ---------------------------------------------------------------- */

    async loadWelcomeMessages(guildId: string): Promise<WelcomeMessageSettings> {
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

    async loadInviteSettings(guildId: string): Promise<InviteSettings> {
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

    /** The member's prior invite row, when this account has joined this guild before. */
    async getInviteMember(guildId: string, userId: string): Promise<InviteMemberRow | null> {
      const { rows } = await pool.query<Record<string, unknown>>(
        `SELECT user_id, inviter_id, invite_code, kind, counted, account_age_ms, joined_at, left_at
         FROM invite_members WHERE guild_id = $1 AND user_id = $2`,
        [guildId, userId]
      );
      const row = rows[0];
      if (!row) return null;
      return {
        userId: String(row.user_id),
        inviterId: row.inviter_id === null ? null : String(row.inviter_id),
        inviteCode: row.invite_code === null ? null : String(row.invite_code),
        kind: String(row.kind) as InviteJoinKind,
        counted: row.counted === true,
        accountAgeMs: row.account_age_ms === null ? null : Number(row.account_age_ms),
        joinedAt: row.joined_at instanceof Date ? row.joined_at.toISOString() : String(row.joined_at),
        leftAt: row.left_at === null || row.left_at === undefined ? null : String(row.left_at)
      };
    },

    /**
     * Records a join and reports whether this account had a prior row — read
     * and written in one statement, so two nearly-simultaneous joins by the
     * same account cannot both read "no prior row" and both count.
     */
    async recordInviteJoin(
      guildId: string,
      userId: string,
      entry: { inviterId: string | null; inviteCode: string | null; kind: InviteJoinKind; counted: boolean; accountAgeMs: number | null }
    ): Promise<boolean> {
      const { rows } = await pool.query<{ prior: boolean }>(
        `WITH prior AS (
           SELECT true AS prior FROM invite_members WHERE guild_id = $1 AND user_id = $2
         ), upsert AS (
           INSERT INTO invite_members (guild_id, user_id, inviter_id, invite_code, kind, counted, account_age_ms, joined_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, now())
           ON CONFLICT (guild_id, user_id) DO UPDATE SET
             inviter_id = EXCLUDED.inviter_id,
             invite_code = EXCLUDED.invite_code,
             kind = EXCLUDED.kind,
             counted = EXCLUDED.counted,
             account_age_ms = EXCLUDED.account_age_ms,
             joined_at = now(),
             left_at = NULL,
             updated_at = now()
           RETURNING user_id
         )
         SELECT prior.prior AS prior FROM upsert LEFT JOIN prior ON true`,
        [guildId, userId, entry.inviterId, entry.inviteCode, entry.kind, entry.counted, entry.accountAgeMs]
      );
      return rows[0]?.prior === true;
    },

    /** Marks a member's row as departed. The row itself stays: the re-join rule reads it. */
    async markInviteMemberLeft(guildId: string, userId: string): Promise<void> {
      await pool.query(
        `UPDATE invite_members SET counted = false, left_at = now(), updated_at = now()
         WHERE guild_id = $1 AND user_id = $2`,
        [guildId, userId]
      );
    },

    async getInviteStats(guildId: string, userId: string): Promise<InviteStats> {
      const { rows } = await pool.query<Record<string, unknown>>(
        `SELECT regular, fakes, rejoins, leaves, bonus FROM invite_stats WHERE guild_id = $1 AND user_id = $2`,
        [guildId, userId]
      );
      const row = rows[0];
      if (!row) return { ...EMPTY_INVITE_STATS };
      return {
        regular: Number(row.regular),
        fakes: Number(row.fakes),
        rejoins: Number(row.rejoins),
        leaves: Number(row.leaves),
        bonus: Number(row.bonus)
      };
    },

    /**
     * Moves the counters for one inviter atomically and returns the row after
     * the move — the caller logs the totals it actually produced, not the ones
     * it hoped for. The row is created on first touch, so a first-time inviter
     * reads back as exactly one.
     */
    async bumpInviteStats(
      guildId: string,
      userId: string,
      delta: { regular?: number; fakes?: number; rejoins?: number; leaves?: number }
    ): Promise<InviteStats> {
      const { rows } = await pool.query<Record<string, unknown>>(
        `INSERT INTO invite_stats (guild_id, user_id, regular, fakes, rejoins, leaves)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (guild_id, user_id) DO UPDATE SET
           regular = invite_stats.regular + $3,
           fakes = invite_stats.fakes + $4,
           rejoins = invite_stats.rejoins + $5,
           leaves = invite_stats.leaves + $6,
           updated_at = now()
         RETURNING regular, fakes, rejoins, leaves, bonus`,
        [guildId, userId, delta.regular ?? 0, delta.fakes ?? 0, delta.rejoins ?? 0, delta.leaves ?? 0]
      );
      const row = rows[0];
      return {
        regular: Number(row.regular),
        fakes: Number(row.fakes),
        rejoins: Number(row.rejoins),
        leaves: Number(row.leaves),
        bonus: Number(row.bonus)
      };
    },

    /**
     * A moderator's manual edit, as a signed bonus move on the same row.
     * `regular` stays the record of what actually happened; the adjustment
     * lives beside it so an audit can always separate history from correction.
     */
    async adjustInviteStats(guildId: string, userId: string, bonusDelta: number): Promise<InviteStats> {
      const { rows } = await pool.query<Record<string, unknown>>(
        `INSERT INTO invite_stats (guild_id, user_id, bonus) VALUES ($1, $2, $3)
         ON CONFLICT (guild_id, user_id) DO UPDATE SET
           bonus = LEAST(100000, GREATEST(-100000, invite_stats.bonus + $3)),
           updated_at = now()
         RETURNING regular, fakes, rejoins, leaves, bonus`,
        [guildId, userId, bonusDelta]
      );
      const row = rows[0];
      return {
        regular: Number(row.regular),
        fakes: Number(row.fakes),
        rejoins: Number(row.rejoins),
        leaves: Number(row.leaves),
        bonus: Number(row.bonus)
      };
    },

    /** The reset half of `/admin-invites reset`: the counters are zeroed, the member history stays. */
    async resetInviteStats(guildId: string, userId: string): Promise<void> {
      await pool.query(`DELETE FROM invite_stats WHERE guild_id = $1 AND user_id = $2`, [guildId, userId]);
    },

    /** One leaderboard page, ranked by net (regular − leaves + bonus). */
    async inviteLeaderboardPage(guildId: string, limit: number, offset: number): Promise<(InviteStats & { userId: string })[]> {
      const { rows } = await pool.query<Record<string, unknown>>(
        `SELECT user_id, regular, fakes, rejoins, leaves, bonus
         FROM invite_stats WHERE guild_id = $1
         ORDER BY (regular - leaves + bonus) DESC, regular DESC, user_id
         LIMIT $2 OFFSET $3`,
        [guildId, limit, offset]
      );
      return rows.map(row => ({
        userId: String(row.user_id),
        regular: Number(row.regular),
        fakes: Number(row.fakes),
        rejoins: Number(row.rejoins),
        leaves: Number(row.leaves),
        bonus: Number(row.bonus)
      }));
    },

    /** How many inviters a leaderboard counts, for the pager's page total. */
    async countInviteStats(guildId: string): Promise<number> {
      const { rows } = await pool.query<{ n: string }>(`SELECT COUNT(*) AS n FROM invite_stats WHERE guild_id = $1`, [guildId]);
      return Number(rows[0].n);
    },

    /** Instance-wide bookkeeping keys written by the bot's minute clock (last tick time, session count). */
    async setSetting(key: string, value: string) {
      await pool.query(
        `INSERT INTO instance_settings (key, value, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [key, value]
      );
    },

    async close() {
      await pool.end();
    }
  };
}
