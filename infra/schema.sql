-- AL AI schema. Applied automatically by the postgres container on first boot.

CREATE TABLE IF NOT EXISTS guilds (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  icon_url TEXT,
  member_count INTEGER NOT NULL DEFAULT 0,
  bot_present BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Role mapping. Two configurable lists of Role IDs. There is no `owner` column
-- at all: the owner tier is derived from Discord's own guild ownership and the
-- Administrator permission, so it cannot be misconfigured and a freshly added
-- bot never locks its own owner out.
CREATE TABLE IF NOT EXISTS guild_role_tiers (
  guild_id TEXT PRIMARY KEY REFERENCES guilds(id) ON DELETE CASCADE,
  admin_role_ids JSONB NOT NULL DEFAULT '[]',
  moderator_role_ids JSONB NOT NULL DEFAULT '[]',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Upgrade from the retired four-tier shape. The old single admin/moderator role
-- IDs carry over as one-element lists; owner and head_admin are dropped, because
-- the owner tier is now automatic and head_admin no longer exists.
ALTER TABLE guild_role_tiers ADD COLUMN IF NOT EXISTS admin_role_ids JSONB NOT NULL DEFAULT '[]';
ALTER TABLE guild_role_tiers ADD COLUMN IF NOT EXISTS moderator_role_ids JSONB NOT NULL DEFAULT '[]';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'guild_role_tiers' AND column_name = 'admin_role_id'
  ) THEN
    UPDATE guild_role_tiers
       SET admin_role_ids = to_jsonb(ARRAY[admin_role_id])
     WHERE admin_role_ids = '[]'::jsonb AND admin_role_id IS NOT NULL;

    UPDATE guild_role_tiers
       SET moderator_role_ids = to_jsonb(ARRAY[moderator_role_id])
     WHERE moderator_role_ids = '[]'::jsonb AND moderator_role_id IS NOT NULL;

    ALTER TABLE guild_role_tiers DROP COLUMN admin_role_id;
    ALTER TABLE guild_role_tiers DROP COLUMN moderator_role_id;
    ALTER TABLE guild_role_tiers DROP COLUMN owner_role_id;
    ALTER TABLE guild_role_tiers DROP COLUMN head_admin_role_id;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS guild_customization (
  guild_id TEXT PRIMARY KEY REFERENCES guilds(id) ON DELETE CASCADE,
  -- Per-guild bot nickname, applied by the dashboard over REST.
  nickname TEXT,
  -- Per-guild appearance of the AL AI role: colour plus optional icon. Discord
  -- gives a bot one global avatar, so a per-guild image is expressed through its
  -- role rather than the account.
  role_color TEXT,
  role_icon_url TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Idempotent upgrade for databases created before the role appearance existed.
ALTER TABLE guild_customization ADD COLUMN IF NOT EXISTS role_color TEXT;
ALTER TABLE guild_customization ADD COLUMN IF NOT EXISTS role_icon_url TEXT;
-- The retired design stored a per-guild avatar and banner. Neither is possible:
-- Discord gives an application one global avatar, so the columns held values no
-- code could ever apply. Dropped rather than left dormant, because a column that
-- looks like a feature is worse than no column at all.
ALTER TABLE guild_customization DROP COLUMN IF EXISTS avatar_url;
ALTER TABLE guild_customization DROP COLUMN IF EXISTS banner_url;

-- The global half of the bot's identity: one row, shared by every guild.
--
-- Kept out of `guild_customization` on purpose. An avatar, a banner and a
-- presence are the same everywhere, so storing them per guild would mean N rows
-- holding one setting — the last writer wins and the rest silently disagree with
-- what Discord actually shows. The `id` column plus its CHECK is what makes the
-- single row structural rather than a convention: a second row cannot be
-- inserted, so "the current identity" is never ambiguous.
--
-- The images are base64 data URLs because that is the form Discord accepts. They
-- are cropped in the browser before they get here, so the ceiling below is a
-- guard against a hand-crafted request, not against normal use.
CREATE TABLE IF NOT EXISTS bot_identity (
  id BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
  avatar_data_url TEXT,
  banner_data_url TEXT,
  bio TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'online',
  activity_type TEXT NOT NULL DEFAULT 'playing',
  activity_text TEXT NOT NULL DEFAULT '',
  status_duration TEXT,
  status_expires_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT bot_identity_avatar_size_check CHECK (avatar_data_url IS NULL OR length(avatar_data_url) <= 500000),
  CONSTRAINT bot_identity_banner_size_check CHECK (banner_data_url IS NULL OR length(banner_data_url) <= 500000),
  CONSTRAINT bot_identity_bio_check CHECK (length(bio) <= 400),
  CONSTRAINT bot_identity_status_check CHECK (status IN ('online','idle','dnd','invisible')),
  CONSTRAINT bot_identity_activity_type_check CHECK (activity_type IN ('playing','listening','watching','competing')),
  CONSTRAINT bot_identity_activity_text_check CHECK (length(activity_text) <= 128),
  CONSTRAINT bot_identity_status_duration_check CHECK (status_duration IS NULL OR status_duration IN ('15m','1h','8h','24h','3d','forever'))
);
-- Seed the single row so a read never has to special-case "no identity yet".
INSERT INTO bot_identity (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

-- Added after the table shipped. `online` has no duration in Discord's own
-- client, so a database that predates this column simply has no window stored —
-- which is exactly what the nullable default means. No backfill is needed, and
-- a backfill would be wrong: inventing a duration nobody chose would put a
-- countdown beside a status the operator never gave one to.
ALTER TABLE bot_identity ADD COLUMN IF NOT EXISTS status_duration TEXT;
ALTER TABLE bot_identity ADD COLUMN IF NOT EXISTS status_expires_at TIMESTAMPTZ;
DO $$
BEGIN
  ALTER TABLE bot_identity ADD CONSTRAINT bot_identity_status_duration_check
    CHECK (status_duration IS NULL OR status_duration IN ('15m','1h','8h','24h','3d','forever'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS guild_logging (
  guild_id TEXT PRIMARY KEY REFERENCES guilds(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT false,
  -- 'single' routes everything to global_channel_id; 'granular' gives each
  -- destination its own channel. Must match DEFAULT_LOGGING_MODE in contracts.ts.
  mode TEXT NOT NULL DEFAULT 'single' CHECK (mode IN ('single','granular')),
  global_channel_id TEXT,
  ignored_channel_ids JSONB NOT NULL DEFAULT '[]',
  -- Members holding any of these roles are left out of the logs, as actor or
  -- as subject. Snowflake IDs as strings.
  ignored_role_ids JSONB NOT NULL DEFAULT '[]',
  -- Must match DEFAULT_EMBED_COLOR in packages/core/src/event-schema.ts.
  embed_color TEXT NOT NULL DEFAULT '#3b82f6',
  event_flags JSONB NOT NULL DEFAULT '{}',
  category_channels JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Idempotent upgrade: retire the old violet default everywhere it was stored.
ALTER TABLE guild_logging ALTER COLUMN embed_color SET DEFAULT '#3b82f6';
UPDATE guild_logging SET embed_color = '#3b82f6' WHERE lower(embed_color) = '#7c3aed';
-- Idempotent upgrade for databases created before the mode/ignored-role columns.
ALTER TABLE guild_logging ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'single';
ALTER TABLE guild_logging ADD COLUMN IF NOT EXISTS ignored_role_ids JSONB NOT NULL DEFAULT '[]';
-- The CHECK lives in the CREATE above, which an existing table ignores, so it is
-- re-added by hand. Any value that predates the column is normalised first.
UPDATE guild_logging SET mode = 'single' WHERE mode IS NULL OR mode NOT IN ('single','granular');
ALTER TABLE guild_logging DROP CONSTRAINT IF EXISTS guild_logging_mode_check;
ALTER TABLE guild_logging ADD CONSTRAINT guild_logging_mode_check CHECK (mode IN ('single','granular'));
-- Drop any retired destination that an older dashboard had stored, so the
-- router never reads a channel binding it no longer understands.
UPDATE guild_logging SET category_channels = category_channels - 'role-log'
  WHERE category_channels ? 'role-log';

-- Dashboard sessions. Tokens are stored encrypted, never in plaintext.
CREATE TABLE IF NOT EXISTS oauth_sessions (
  id UUID PRIMARY KEY,
  discord_user_id TEXT NOT NULL,
  discord_username TEXT NOT NULL,
  -- Avatar hash only; the CDN URL is built by the BFF, never stored.
  discord_avatar TEXT,
  access_token_ciphertext TEXT NOT NULL,
  refresh_token_ciphertext TEXT,
  scopes TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
-- Idempotent upgrade for databases created before discord_avatar existed.
ALTER TABLE oauth_sessions ADD COLUMN IF NOT EXISTS discord_avatar TEXT;
CREATE INDEX IF NOT EXISTS oauth_sessions_expires_idx ON oauth_sessions (expires_at);

-- Append-only. Payloads are AES-256-GCM encrypted before they land here.
CREATE TABLE IF NOT EXISTS audit_trail (
  id UUID PRIMARY KEY,
  guild_id TEXT,
  severity TEXT NOT NULL,
  event_id TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  actor_hash TEXT NOT NULL,
  source_layer TEXT NOT NULL,
  payload_ciphertext TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_trail_guild_idx ON audit_trail (guild_id, created_at DESC);

CREATE TABLE IF NOT EXISTS security_nonces (
  nonce TEXT PRIMARY KEY,
  layer TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS security_nonces_expires_idx ON security_nonces (expires_at);

CREATE TABLE IF NOT EXISTS guild_health (
  guild_id TEXT PRIMARY KEY REFERENCES guilds(id) ON DELETE CASCADE,
  bot_present BOOLEAN NOT NULL DEFAULT false,
  gateway_events_last_minute INTEGER NOT NULL DEFAULT 0,
  -- Unique *users* the bot has observed, reported by the bot itself. This is the
  -- unit Discord's 8,000/10,000 verification thresholds are expressed in; a guild
  -- count is a different unit and must never be compared against them.
  unique_users INTEGER NOT NULL DEFAULT 0,
  -- Discord's own gateway heartbeat, reported by the bot. NULL means "the bot
  -- has not told us yet", which is different from 0 and must render differently.
  ping_ms INTEGER,
  state TEXT NOT NULL DEFAULT 'unknown',
  notes TEXT,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Idempotent upgrade for databases created before unique_users existed.
ALTER TABLE guild_health ADD COLUMN IF NOT EXISTS unique_users INTEGER NOT NULL DEFAULT 0;
-- Idempotent upgrade for databases created before the heartbeat column.
ALTER TABLE guild_health ADD COLUMN IF NOT EXISTS ping_ms INTEGER;

-- Constraint-only mirror of `guild_logging.category_channels`. The dashboard
-- writes it in the same transaction as the JSONB row so the database itself
-- rejects two destinations sharing one channel. It is NOT a read source: it has
-- no global-channel row, so routing is always read from `guild_logging`.
CREATE TABLE IF NOT EXISTS guild_log_channels (
  guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  destination TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  PRIMARY KEY (guild_id, destination),
  UNIQUE (guild_id, channel_id)
);
-- `CREATE TABLE IF NOT EXISTS` leaves an existing table's constraints alone, so
-- the allowed-destination list is replaced explicitly. `role-log` was retired in
-- schema version 2; its events moved to `server-log`.
ALTER TABLE guild_log_channels DROP CONSTRAINT IF EXISTS guild_log_channels_destination_check;
-- Rows bound to a destination that no longer exists would violate the new
-- constraint, so they are cleared before it is added.
DELETE FROM guild_log_channels WHERE destination = 'role-log';
ALTER TABLE guild_log_channels ADD CONSTRAINT guild_log_channels_destination_check
  CHECK (destination IN ('member-log','moderation-log','voice-log','message-log','server-log'));

-- Per-command configuration for the dashboard's Commands screen.
CREATE TABLE IF NOT EXISTS guild_command_flags (
  guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  command TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  -- The tier required to run the command in this guild. Overrides the registry
  -- default, which lives in packages/core/src/command-registry.ts.
  minimum_tier TEXT NOT NULL DEFAULT 'moderator',
  -- DM the target when an action is taken against them.
  dm_on_action BOOLEAN NOT NULL DEFAULT false,
  -- Days of the target's recent messages to remove alongside the action. 0–7.
  delete_message_days SMALLINT NOT NULL DEFAULT 0,
  -- Roles allowed to run this command, beyond the tier mapping.
  allowed_role_ids JSONB NOT NULL DEFAULT '[]',
  -- Roles barred from this command even when their tier would allow it. A deny
  -- always beats an allow, which is the only way to carve an exception out of a
  -- broad tier without splitting the tier in two.
  denied_role_ids JSONB NOT NULL DEFAULT '[]',
  -- When allowed_channel_ids is non-empty the command runs only in those
  -- channels; denied_channel_ids is checked first and always wins.
  allowed_channel_ids JSONB NOT NULL DEFAULT '[]',
  denied_channel_ids JSONB NOT NULL DEFAULT '[]',
  -- Members allowed to run this command, beyond the tier mapping and the roles
  -- above. The narrowest escape hatch there is, for the case a role cannot
  -- express: one trusted helper on a server whose roles are otherwise meaningful.
  allowed_user_ids JSONB NOT NULL DEFAULT '[]',
  -- Members barred from this command even when a role or a tier would allow it.
  -- A deny beats every allow, including allowed_user_ids.
  denied_user_ids JSONB NOT NULL DEFAULT '[]',
  -- Seconds a member must wait between two runs of this command. 0 = no wait.
  cooldown_seconds SMALLINT NOT NULL DEFAULT 0,
  -- Seconds before the bot removes its own reply. 0 = keep it. Only the reply is
  -- affected: a slash command leaves no command message for AL AI to delete.
  auto_delete_response_seconds SMALLINT NOT NULL DEFAULT 0,
  -- A reason is mandatory for this guild, overriding the registry's default.
  require_reason BOOLEAN NOT NULL DEFAULT false,
  -- Whether the moderator may type a reason of their own. Only meaningful once
  -- preset_reasons is non-empty: with this off, a reason matching no preset is
  -- refused. Defaults to true because that is what the screen did before the
  -- switch existed — a default that narrowed an existing behaviour would be a
  -- regression wearing a default's clothes.
  allow_custom_reason BOOLEAN NOT NULL DEFAULT true,
  -- The duration applied when the operator supplies none. Only meaningful for a
  -- command that consumes one (Discord's timeout); forced back to 'permanent'
  -- by the shared normaliser for every other command.
  default_duration TEXT NOT NULL DEFAULT 'permanent',
  -- Ready-made reasons offered in Discord, as [{ id, label, duration }].
  preset_reasons JSONB NOT NULL DEFAULT '[]',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, command)
);
-- `custom_role_ids` and `allowed_role_ids` are the same concept, and keeping
-- both would leave two columns meaning "roles allowed to run this command" —
-- exactly the drift this schema avoids elsewhere. PostgreSQL has no
-- `RENAME COLUMN IF EXISTS`, so the rename is guarded by a catalog check.
--
-- ORDER MATTERS: this runs BEFORE the `ADD COLUMN` block below. The other way
-- round the new column already exists by the time the guard is evaluated, the
-- rename is skipped, and every operator's allow-list is stranded in an orphaned
-- column that nothing reads.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'guild_command_flags'
      AND column_name = 'custom_role_ids'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'guild_command_flags'
      AND column_name = 'allowed_role_ids'
  ) THEN
    ALTER TABLE guild_command_flags RENAME COLUMN custom_role_ids TO allowed_role_ids;
  END IF;
END $$;

ALTER TABLE guild_command_flags ADD COLUMN IF NOT EXISTS dm_on_action BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE guild_command_flags ADD COLUMN IF NOT EXISTS delete_message_days SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE guild_command_flags ADD COLUMN IF NOT EXISTS allowed_role_ids JSONB NOT NULL DEFAULT '[]';
ALTER TABLE guild_command_flags ADD COLUMN IF NOT EXISTS denied_role_ids JSONB NOT NULL DEFAULT '[]';
ALTER TABLE guild_command_flags ADD COLUMN IF NOT EXISTS allowed_channel_ids JSONB NOT NULL DEFAULT '[]';
ALTER TABLE guild_command_flags ADD COLUMN IF NOT EXISTS denied_channel_ids JSONB NOT NULL DEFAULT '[]';
ALTER TABLE guild_command_flags ADD COLUMN IF NOT EXISTS allowed_user_ids JSONB NOT NULL DEFAULT '[]';
ALTER TABLE guild_command_flags ADD COLUMN IF NOT EXISTS denied_user_ids JSONB NOT NULL DEFAULT '[]';
ALTER TABLE guild_command_flags ADD COLUMN IF NOT EXISTS cooldown_seconds SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE guild_command_flags ADD COLUMN IF NOT EXISTS auto_delete_response_seconds SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE guild_command_flags ADD COLUMN IF NOT EXISTS require_reason BOOLEAN NOT NULL DEFAULT false;
-- `true`, matching the behaviour the screen already had: the switch narrows an
-- existing freedom rather than restoring one, so off is the deliberate choice.
ALTER TABLE guild_command_flags ADD COLUMN IF NOT EXISTS allow_custom_reason BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE guild_command_flags ADD COLUMN IF NOT EXISTS default_duration TEXT NOT NULL DEFAULT 'permanent';
ALTER TABLE guild_command_flags ADD COLUMN IF NOT EXISTS preset_reasons JSONB NOT NULL DEFAULT '[]';

-- A database that ran an earlier build of this migration holds both columns.
-- Carry the values across before dropping the orphan, so the allow-list survives
-- the upgrade instead of being silently discarded.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'guild_command_flags'
      AND column_name = 'custom_role_ids'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'guild_command_flags'
      AND column_name = 'allowed_role_ids'
  ) THEN
    UPDATE guild_command_flags
       SET allowed_role_ids = custom_role_ids
     WHERE allowed_role_ids = '[]'::jsonb
       AND custom_role_ids <> '[]'::jsonb;
    ALTER TABLE guild_command_flags DROP COLUMN custom_role_ids;
  END IF;
END $$;

-- Discord accepts 0–7 days; anything outside that would be silently clamped by
-- the API, so it is refused here instead.
ALTER TABLE guild_command_flags DROP CONSTRAINT IF EXISTS guild_command_flags_purge_days_check;
ALTER TABLE guild_command_flags ADD CONSTRAINT guild_command_flags_purge_days_check
  CHECK (delete_message_days >= 0 AND delete_message_days <= 7);
ALTER TABLE guild_command_flags DROP CONSTRAINT IF EXISTS guild_command_flags_tier_check;
ALTER TABLE guild_command_flags ADD CONSTRAINT guild_command_flags_tier_check
  CHECK (minimum_tier IN ('owner','admin','moderator'));
-- The bounds mirror MAX_COOLDOWN_SECONDS and MAX_AUTO_DELETE_SECONDS in
-- packages/core/src/command-registry.ts. A stored value outside them would mean
-- the two sides disagree, so it cannot be written at all.
ALTER TABLE guild_command_flags DROP CONSTRAINT IF EXISTS guild_command_flags_cooldown_check;
ALTER TABLE guild_command_flags ADD CONSTRAINT guild_command_flags_cooldown_check
  CHECK (cooldown_seconds >= 0 AND cooldown_seconds <= 3600);
ALTER TABLE guild_command_flags DROP CONSTRAINT IF EXISTS guild_command_flags_auto_delete_check;
ALTER TABLE guild_command_flags ADD CONSTRAINT guild_command_flags_auto_delete_check
  CHECK (auto_delete_response_seconds >= 0 AND auto_delete_response_seconds <= 600);
-- The list mirrors `commandDurations` in core. A value the bot cannot resolve
-- would silently fall back to "permanent" at runtime, so it is refused here.
-- `custom` is a policy rather than a length — "always ask, and ignore a preset's
-- paired duration" — and it is listed because core lists it; the two must agree
-- or a value the dashboard offers would be rejected on write.
ALTER TABLE guild_command_flags DROP CONSTRAINT IF EXISTS guild_command_flags_duration_check;
ALTER TABLE guild_command_flags ADD CONSTRAINT guild_command_flags_duration_check
  CHECK (default_duration IN ('permanent','5m','30m','1h','6h','12h','1d','3d','7d','14d','30d','custom'));

-- `/mute` is retired: a native timeout silences a member everywhere, including
-- voice, and expires on its own. Any stored switch for it is removed so the
-- dashboard cannot offer a command the bot no longer publishes.
DELETE FROM guild_command_flags WHERE command = 'mute';

-- Warnings are a record, not a Discord mutation, so they need somewhere to live.
-- `/warns` reads this table and `/clearwarns` empties a member's rows for a guild.
CREATE TABLE IF NOT EXISTS guild_warnings (
  id UUID PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  moderator_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS guild_warnings_guild_user_idx ON guild_warnings (guild_id, user_id, created_at DESC);

-- Anti-nuke settings, one row per guild.
--
-- The engine ships disarmed: `enabled` defaults to false, because mitigation
-- strips a moderator's roles and that must be the owner's decision, not ours.
-- The limits carry the same defaults the code declares, so a guild with no row
-- behaves exactly like one that saved the defaults.
CREATE TABLE IF NOT EXISTS guild_security (
  guild_id TEXT PRIMARY KEY REFERENCES guilds(id) ON DELETE CASCADE,
  -- Armed by default: a guild is protected from the moment AL AI joins, and the
  -- operator disarms it deliberately if they want to. The column default only
  -- governs rows created from now on, so an existing row that was written while
  -- the engine shipped disarmed keeps its value until the operator changes it —
  -- this file must not silently re-arm a protection somebody switched off.
  enabled BOOLEAN NOT NULL DEFAULT true,
  channel_deletes_per_minute SMALLINT NOT NULL DEFAULT 3,
  bans_per_minute SMALLINT NOT NULL DEFAULT 5,
  role_changes_per_minute SMALLINT NOT NULL DEFAULT 3,
  quarantine_role_id TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The code clamps to the same range. Enforced here too so a direct write
  -- cannot store a limit of 0, which would trip on the first action and read as
  -- "the engine works" while actually blocking all moderation.
  CONSTRAINT guild_security_channel_deletes_check CHECK (channel_deletes_per_minute BETWEEN 1 AND 100),
  CONSTRAINT guild_security_bans_check CHECK (bans_per_minute BETWEEN 1 AND 100),
  CONSTRAINT guild_security_role_changes_check CHECK (role_changes_per_minute BETWEEN 1 AND 100)
);

-- `CREATE TABLE IF NOT EXISTS` leaves an existing column's default alone, so the
-- flip to armed has to be stated again for databases created before it. Changing
-- a default never rewrites rows, which is what keeps this safe to re-run: a guild
-- that has explicitly disarmed the engine stays disarmed.
ALTER TABLE guild_security ALTER COLUMN enabled SET DEFAULT true;

-- Bot tokens are retired (GOVERNANCE rule 19). AL AI runs on exactly one master
-- token held in the server environment; the dashboard never accepts a credential
-- from the browser. The tables are dropped rather than left dormant, because an
-- unused credential store is a liability, not a spare part.
DROP TABLE IF EXISTS bot_token_guilds;
DROP TABLE IF EXISTS bot_tokens;

-- GOVERNANCE rule 10: the audit trail is append-only.
-- This is enforced by the database itself, so no code path can rewrite history.
CREATE OR REPLACE FUNCTION al_ai_audit_is_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_trail is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_trail_append_only ON audit_trail;
CREATE TRIGGER audit_trail_append_only
  BEFORE UPDATE OR DELETE ON audit_trail
  FOR EACH ROW EXECUTE FUNCTION al_ai_audit_is_append_only();

-- TRUNCATE is a statement-level operation, so a FOR EACH ROW trigger never
-- fires for it. Without this second trigger the append-only guarantee has a
-- hole: `TRUNCATE audit_trail` silently erases the whole history.
DROP TRIGGER IF EXISTS audit_trail_no_truncate ON audit_trail;
CREATE TRIGGER audit_trail_no_truncate
  BEFORE TRUNCATE ON audit_trail
  FOR EACH STATEMENT EXECUTE FUNCTION al_ai_audit_is_append_only();

-- Belt and braces: the application role has no business truncating history.
-- (Ignored when the role is the table owner or a superuser.)
REVOKE TRUNCATE ON audit_trail FROM PUBLIC;

