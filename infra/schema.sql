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
  -- Per-guild appearance of the AL AI role: colour plus optional icon.
  role_color TEXT,
  role_icon_url TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Idempotent upgrade for databases created before the role appearance existed.
ALTER TABLE guild_customization ADD COLUMN IF NOT EXISTS role_color TEXT;
ALTER TABLE guild_customization ADD COLUMN IF NOT EXISTS role_icon_url TEXT;
-- The retired design stored a per-guild avatar and banner as *URLs* with no
-- apply path, so they were dropped rather than left dormant.
--
-- Every one of those fields is real now, and so is a per-guild bio. Discord's
-- Modify Current Member (PATCH /guilds/{id}/members/@me) accepts `avatar`,
-- `banner` and `bio` beside `nick`, and that was measured against the live API
-- rather than read off a changelog: a banner data URI came back as a stored
-- `banner` hash on the member object, and a 4000-character bio came back as
-- 400 BASE_TYPE_MAX_LENGTH — a rejection, which is what proves the field is
-- parsed rather than accepted-and-discarded. (An earlier comment here claimed a
-- banner had no member equivalent and would stay retired. That was wrong, and
-- it is why this now says the opposite.)
ALTER TABLE guild_customization DROP COLUMN IF EXISTS avatar_url;
ALTER TABLE guild_customization DROP COLUMN IF EXISTS banner_url;
ALTER TABLE guild_customization ADD COLUMN IF NOT EXISTS avatar_data_url TEXT;
ALTER TABLE guild_customization ADD COLUMN IF NOT EXISTS banner_data_url TEXT;
-- The per-guild bio Discord shows on this member's profile. Unlike the account's
-- "About me" — the application description, which is capped at 190 — this field
-- is capped at 300, which is the number Discord itself returned when the live
-- API refused a longer one.
ALTER TABLE guild_customization ADD COLUMN IF NOT EXISTS bio TEXT NOT NULL DEFAULT '';
-- The per-guild custom profile's master switch: off walks the nickname, the
-- guild avatar, the banner and the bio back to Discord's defaults on the next
-- save.
ALTER TABLE guild_customization ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT true;
-- The ceilings the images used to carry on `bot_identity`. The cropper keeps
-- them small, so these only stop a hand-crafted request from writing megabytes
-- into a text column. Dropped-then-added rather than guarded, which is how every
-- other constraint in this file is made idempotent.
ALTER TABLE guild_customization DROP CONSTRAINT IF EXISTS guild_customization_avatar_size_check;
ALTER TABLE guild_customization ADD CONSTRAINT guild_customization_avatar_size_check
  CHECK (avatar_data_url IS NULL OR length(avatar_data_url) <= 500000);
ALTER TABLE guild_customization DROP CONSTRAINT IF EXISTS guild_customization_banner_size_check;
ALTER TABLE guild_customization ADD CONSTRAINT guild_customization_banner_size_check
  CHECK (banner_data_url IS NULL OR length(banner_data_url) <= 500000);
ALTER TABLE guild_customization DROP CONSTRAINT IF EXISTS guild_customization_bio_check;
ALTER TABLE guild_customization ADD CONSTRAINT guild_customization_bio_check CHECK (length(bio) <= 300);

-- The bot's own row: presence, and nothing else.
--
-- It held the account's avatar, banner and "About me" too, back when those were
-- the only place a bot could show them. They all live on `guild_customization`
-- now, so the columns here are dropped rather than left dormant: a stored
-- setting with no reader is decoration, and two places holding "the bot's
-- picture" is how a screen ends up drawing one of them while the operator edits
-- the other.
--
-- Presence stays, and stays here, because it is the one appearance field with no
-- REST route at all. A status is sent on the gateway connection, so it is the
-- same in every guild the bot is in — the bot reads this row and applies it, and
-- the dashboard only ever writes it.
--
-- The `id` column plus its CHECK is what makes the single row structural rather
-- than a convention: a second row cannot be inserted, so "the current presence"
-- is never ambiguous.
CREATE TABLE IF NOT EXISTS bot_identity (
  id BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
  status TEXT NOT NULL DEFAULT 'online',
  activity_type TEXT NOT NULL DEFAULT 'playing',
  activity_text TEXT NOT NULL DEFAULT '',
  status_duration TEXT,
  status_expires_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT bot_identity_status_check CHECK (status IN ('online','idle','dnd','invisible')),
  CONSTRAINT bot_identity_activity_type_check CHECK (activity_type IN ('playing','listening','watching','competing')),
  CONSTRAINT bot_identity_activity_text_check CHECK (length(activity_text) <= 128),
  CONSTRAINT bot_identity_status_duration_check CHECK (status_duration IS NULL OR status_duration IN ('15m','1h','8h','24h','3d','forever'))
);
-- The account-appearance columns, retired. Dropping a column takes its CHECK
-- with it, so the three size/length constraints above need no separate DROP.
ALTER TABLE bot_identity DROP COLUMN IF EXISTS avatar_data_url;
ALTER TABLE bot_identity DROP COLUMN IF EXISTS banner_data_url;
ALTER TABLE bot_identity DROP COLUMN IF EXISTS bio;
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
  -- 'normal' routes a destination to one channel per section; 'detailed' lets
  -- each individual event carry its own channel. Must match DEFAULT_LOGGING_MODE
  -- in contracts.ts. The resolution never branches on mode though: an event
  -- binding simply wins over the section binding, so a detailed mapping left in
  -- place after a switch back to normal is inert, not a leak.
  mode TEXT NOT NULL DEFAULT 'normal' CHECK (mode IN ('normal','detailed')),
  global_channel_id TEXT,
  ignored_channel_ids JSONB NOT NULL DEFAULT '[]',
  -- Members holding any of these roles are left out of the logs, as actor or
  -- as subject. Snowflake IDs as strings.
  ignored_role_ids JSONB NOT NULL DEFAULT '[]',
  -- Must match DEFAULT_EMBED_COLOR in packages/core/src/event-schema.ts.
  embed_color TEXT NOT NULL DEFAULT '#3b82f6',
  -- Per-destination colour overrides as "#rrggbb". Absent means "inherit
  -- embed_color". See `categoryColors` in packages/core/src/contracts.ts.
  category_colors JSONB NOT NULL DEFAULT '{}',
  event_flags JSONB NOT NULL DEFAULT '{}',
  category_channels JSONB NOT NULL DEFAULT '{}',
  -- Per-event overrides, keyed by event ID. Absent means "inherit the section's
  -- channel/colour". See `eventChannels`/`eventColors` in contracts.ts.
  event_channels JSONB NOT NULL DEFAULT '{}',
  event_colors JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Idempotent upgrade: retire the old violet default everywhere it was stored.
ALTER TABLE guild_logging ALTER COLUMN embed_color SET DEFAULT '#3b82f6';
UPDATE guild_logging SET embed_color = '#3b82f6' WHERE lower(embed_color) = '#7c3aed';
-- Idempotent upgrade for databases created before the category-colour column.
ALTER TABLE guild_logging ADD COLUMN IF NOT EXISTS category_colors JSONB NOT NULL DEFAULT '{}';
-- Idempotent upgrade for databases created before the per-event columns.
ALTER TABLE guild_logging ADD COLUMN IF NOT EXISTS event_channels JSONB NOT NULL DEFAULT '{}';
ALTER TABLE guild_logging ADD COLUMN IF NOT EXISTS event_colors JSONB NOT NULL DEFAULT '{}';
-- Idempotent upgrade for databases created before the mode/ignored-role columns.
-- The NOT NULL on an ADD COLUMN needs a real value for pre-existing rows.
ALTER TABLE guild_logging ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'normal';
ALTER TABLE guild_logging ADD COLUMN IF NOT EXISTS ignored_role_ids JSONB NOT NULL DEFAULT '[]';
-- The CHECK lives in the CREATE above, which an existing table ignores, so it is
-- re-added by hand. It is dropped *first*, before the values are normalised:
-- the version-3 constraint admitted only 'single' and 'granular', so an UPDATE
-- to 'normal' written before the drop would be rejected by the very guard this
-- block is replacing. Both old names become 'normal', which is the behaviour
-- either of them expressed for a guild that had not bound a channel per section.
ALTER TABLE guild_logging DROP CONSTRAINT IF EXISTS guild_logging_mode_check;
UPDATE guild_logging SET mode = 'normal'
  WHERE mode IS NULL OR mode NOT IN ('normal','detailed');
ALTER TABLE guild_logging ADD CONSTRAINT guild_logging_mode_check CHECK (mode IN ('normal','detailed'));
-- No destination is retired in schema version 3: the five version-2 destinations
-- all still exist, and `role-log` — which version 2 stripped here — is live
-- again. The strip statement is deliberately gone rather than left as a no-op,
-- because a guard that cannot fire is indistinguishable from a guard aimed at
-- the wrong destination.

-- Dashboard sessions. Tokens are stored encrypted, never in plaintext.
CREATE TABLE IF NOT EXISTS oauth_sessions (
  id UUID PRIMARY KEY,
  discord_user_id TEXT NOT NULL,
  discord_username TEXT NOT NULL,
  -- The @handle, kept beside the display name: Discord's two names are both
  -- real, the account menu shows both, and a moderator is asked for the handle
  -- more often than for the display name.
  discord_handle TEXT,
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
-- Idempotent upgrade for databases created before the @handle was stored.
ALTER TABLE oauth_sessions ADD COLUMN IF NOT EXISTS discord_handle TEXT;
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
-- the allowed-destination list is replaced explicitly. Schema version 3 expanded
-- the operator surface from five sections to thirteen: `role-log` returns (it
-- was retired in version 2 and its events are back where an operator looks for
-- them), and channel/expression/invite splits moved from `server-log`.
-- Version 4 changed only which events belong to a destination (voice grew to
-- seventeen, moderation shrank to six) — the destinations themselves are
-- unchanged, so this constraint needed no edit.
ALTER TABLE guild_log_channels DROP CONSTRAINT IF EXISTS guild_log_channels_destination_check;
-- Rows bound to a destination that no longer exists would violate the new
-- constraint, so they are cleared before it is added. Every destination from
-- version 2 still exists in version 3, so in practice nothing is deleted here —
-- the statement stays as the guard for a future retirement.
DELETE FROM guild_log_channels
  WHERE destination NOT IN (
    'member-log','role-log','channel-log','message-log','voice-log','moderation-log',
    'server-log','invite-log','expression-log','event-log','integration-log',
    'automod-log','platform-log'
  );
ALTER TABLE guild_log_channels ADD CONSTRAINT guild_log_channels_destination_check
  CHECK (destination IN (
    'member-log','role-log','channel-log','message-log','voice-log','moderation-log',
    'server-log','invite-log','expression-log','event-log','integration-log',
    'automod-log','platform-log'
  ));

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
  -- Extra names this command also answers to in this guild, as ["باند", "حظر"].
  -- Discord has no alias mechanism of its own: an alias only works because the
  -- deploy script registers a second command under that name, so this column is
  -- the whole of the feature's state.
  aliases JSONB NOT NULL DEFAULT '[]',
  -- Remove the bot's own reply once the member it acted on leaves the guild.
  -- Only ever the bot's message; never a human's. Off by default, because it is
  -- the one setting here that deletes something the operator did not ask to be
  -- deleted at the moment they set it up.
  delete_response_on_leave BOOLEAN NOT NULL DEFAULT false,
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
-- Placed here, after the guarded `custom_role_ids` rename above and not before
-- it: an `ADD COLUMN` ahead of that block would run first, the guard's
-- `NOT EXISTS allowed_role_ids` check would then be evaluating a column this
-- very file had just created, and the rename would be skipped in silence —
-- stranding every operator's allow-list in an orphaned column nothing reads.
ALTER TABLE guild_command_flags ADD COLUMN IF NOT EXISTS aliases JSONB NOT NULL DEFAULT '[]';
ALTER TABLE guild_command_flags ADD COLUMN IF NOT EXISTS delete_response_on_leave BOOLEAN NOT NULL DEFAULT false;

-- Role fields owned by the state-based punishment commands. Each lives on the
-- row of the command that applies the role, and its inverse reads it back from
-- there, so an operator never names the same role twice and the two commands
-- cannot disagree about which role is the muted role. ROLE_FIELD_OWNERS in
-- packages/core/src/command-registry.ts is the authority; this is its storage.
--
-- Like `aliases` above, these must stay AFTER the guarded `custom_role_ids`
-- rename for the reason given at the top of that block.
--
-- The two single roles are nullable with no default, so `NULL` means "unset"
-- rather than "unset, but spelled like a value" — the commands that need one
-- refuse to run and say so, instead of applying a mute built on no role.
ALTER TABLE guild_command_flags ADD COLUMN IF NOT EXISTS muted_role_id TEXT;
ALTER TABLE guild_command_flags ADD COLUMN IF NOT EXISTS prison_role_id TEXT;
ALTER TABLE guild_command_flags ADD COLUMN IF NOT EXISTS prison_channel_id TEXT;
ALTER TABLE guild_command_flags ADD COLUMN IF NOT EXISTS blacklist_role_ids JSONB NOT NULL DEFAULT '[]';
-- Empty is meaningful here, not unset: it means every role carrying a
-- permission. See the field's note in the registry.
ALTER TABLE guild_command_flags ADD COLUMN IF NOT EXISTS admin_role_ids_to_strip JSONB NOT NULL DEFAULT '[]';
ALTER TABLE guild_command_flags ADD COLUMN IF NOT EXISTS blockable_role_ids JSONB NOT NULL DEFAULT '[]';

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

-- The state a reversible punishment put a member into, and what is needed to
-- undo it exactly.
--
-- `/prison` and `/down` take roles away. Restoring them by guessing from the
-- member's current roles is not possible: by the time `/unprison` runs, the
-- member may have gained roles legitimately, lost others, or been moved by
-- something else entirely, and no amount of reading Discord tells the bot which
-- roles *it* removed. So the roles are written down at the moment they are taken.
--
-- `/block` is the same table used the other way round: it records a standing
-- decision that must outlive the command, because the thing being prevented —
-- the member receiving a role — happens later, in an event the command is not
-- present for.
--
-- One row per (guild, member, kind): a second `/mute` updates the standing state
-- rather than stacking a second one, so `/unmute` has exactly one thing to undo
-- and cannot leave half a punishment behind.
CREATE TABLE IF NOT EXISTS guild_member_states (
  id UUID PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  -- 'mute' | 'prison' | 'blacklist' | 'block' | 'down'.
  kind TEXT NOT NULL,
  -- The roles the member held when the punishment landed, so the inverse can
  -- restore what was actually taken rather than what the setting says today.
  -- Editing `admin_role_ids_to_strip` after a `/down` must not strand a member
  -- with the roles it no longer lists.
  role_ids JSONB NOT NULL DEFAULT '[]',
  -- `/block` only: the roles this member may not be given.
  blocked_role_ids JSONB NOT NULL DEFAULT '[]',
  moderator_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  -- NULL means "until someone reverses it". `/mute` and `/prison` are states, not
  -- timers; a length on them is `/timeout`, which is why they write NULL here.
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (guild_id, user_id, kind)
);
CREATE INDEX IF NOT EXISTS guild_member_states_guild_kind_idx ON guild_member_states (guild_id, kind);
-- The sweeper asks "what is due?" across every guild, so it needs its own index
-- rather than the one above, which is keyed by guild first.
CREATE INDEX IF NOT EXISTS guild_member_states_expiry_idx ON guild_member_states (expires_at) WHERE expires_at IS NOT NULL;

-- The kind is constrained rather than left as free text. `kind` selects which
-- inverse command can find the row again, so a typo would not fail loudly — it
-- would write a row that no `/unprison` or `/undown` ever looks for, leaving a
-- member punished with nothing in the database that admits to it.
ALTER TABLE guild_member_states DROP CONSTRAINT IF EXISTS guild_member_states_kind_check;
ALTER TABLE guild_member_states ADD CONSTRAINT guild_member_states_kind_check
  CHECK (kind IN ('mute','prison','blacklist','block','down'));

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

-- Auto-role on join: one role for arriving members and a different one for
-- arriving bots, per the operator's welcome screen. Both are nullable — a guild
-- may want one without the other, or neither while keeping the switch armed for
-- later. The BFF validates a saved role against Discord (it exists, is not
-- managed, sits below the bot's highest position) at write time; the bot
-- re-checks the hierarchy at assign time, because ranks move after a setting
-- was written and Discord refuses, rather than errors, the out-of-range grant.
-- (CREATE TABLE IF NOT EXISTS leaves an existing table's columns alone.)
CREATE TABLE IF NOT EXISTS guild_welcome (
  guild_id TEXT PRIMARY KEY REFERENCES guilds(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT false,
  member_role_id TEXT,
  bot_role_id TEXT,
  -- Join-to-grant delay in seconds (0 = immediate), so the operator can let a
  -- member settle — or survive a raid's first wave — before the role lands.
  delay_seconds SMALLINT NOT NULL DEFAULT 0 CONSTRAINT guild_welcome_delay_check CHECK (delay_seconds BETWEEN 0 AND 3600),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- The upgrade for databases that predate `delay_seconds` — and it has to sit
-- *after* the CREATE TABLE above. It used to sit before it, which is invisible
-- on an existing database (the table is already there) and fatal on a fresh one:
-- `ALTER TABLE guild_welcome` answered "relation does not exist", the file
-- aborted on that line, and the table it was about to create was never created
-- at all. This is the ordering trap the project has a rule about, and the
-- from-scratch database is the only check that sees it.
ALTER TABLE guild_welcome ADD COLUMN IF NOT EXISTS delay_seconds SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE guild_welcome DROP CONSTRAINT IF EXISTS guild_welcome_delay_check;
ALTER TABLE guild_welcome ADD CONSTRAINT guild_welcome_delay_check CHECK (delay_seconds BETWEEN 0 AND 3600);

-- Instance-wide deployment settings — switches that belong to this copy of the
-- dashboard rather than to any guild in it (the remote-access reach is the
-- first). A key/value shape keeps future deployment settings from needing one
-- table each, and the value stays a plain string: the reader normalises it, so
-- a garbled row degrades to the safe default instead of failing a boot.
CREATE TABLE IF NOT EXISTS instance_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Levels system. One settings row per guild; a missing row means the feature
-- ships off, so a guild that never opened the screen earns no XP. The numeric
-- bounds mirror the clamps in normaliseLevelSettings (packages/core/src/levels.ts)
-- so the two sides cannot disagree about what a stored value means.
CREATE TABLE IF NOT EXISTS guild_levels (
  guild_id TEXT PRIMARY KEY REFERENCES guilds(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT false,
  text_xp_enabled BOOLEAN NOT NULL DEFAULT true,
  voice_xp_enabled BOOLEAN NOT NULL DEFAULT true,
  -- XP per qualifying event is a random draw inside [*_xp_min, *_xp_max].
  text_xp_min SMALLINT NOT NULL DEFAULT 15 CONSTRAINT guild_levels_text_xp_min_check CHECK (text_xp_min BETWEEN 1 AND 100),
  text_xp_max SMALLINT NOT NULL DEFAULT 25 CONSTRAINT guild_levels_text_xp_max_check CHECK (text_xp_max BETWEEN 1 AND 100),
  voice_xp_min SMALLINT NOT NULL DEFAULT 3 CONSTRAINT guild_levels_voice_xp_min_check CHECK (voice_xp_min BETWEEN 0 AND 100),
  voice_xp_max SMALLINT NOT NULL DEFAULT 3 CONSTRAINT guild_levels_voice_xp_max_check CHECK (voice_xp_max BETWEEN 0 AND 100),
  -- 0 = unlimited up to the hard ceiling (MAX_LEVEL_CAP in core).
  max_level_cap INTEGER NOT NULL DEFAULT 100 CONSTRAINT guild_levels_cap_check CHECK (max_level_cap = 0 OR max_level_cap BETWEEN 10 AND 1000),
  -- Zero a member's XP totals when they leave the guild.
  reset_on_leave BOOLEAN NOT NULL DEFAULT false,
  text_cooldown_seconds INTEGER NOT NULL DEFAULT 120 CONSTRAINT guild_levels_cooldown_check CHECK (text_cooldown_seconds BETWEEN 10 AND 3600),
  voice_min_members INTEGER NOT NULL DEFAULT 2 CONSTRAINT guild_levels_min_members_check CHECK (voice_min_members BETWEEN 1 AND 10),
  ignore_muted BOOLEAN NOT NULL DEFAULT true,
  ignore_deafened BOOLEAN NOT NULL DEFAULT true,
  ignore_afk BOOLEAN NOT NULL DEFAULT true,
  notify_level_up BOOLEAN NOT NULL DEFAULT false,
  -- 'same_channel' answers where the XP was earned; 'custom_channel' uses
  -- notify_channel_id; 'send_dm' mails the member. Mirrors LevelNotifyMode.
  notify_mode TEXT NOT NULL DEFAULT 'same_channel' CONSTRAINT guild_levels_notify_mode_check CHECK (notify_mode IN ('same_channel','custom_channel','send_dm')),
  notify_channel_id TEXT,
  -- Rich embed rank card (avatar + progress) attached to level-up notices.
  rank_card BOOLEAN NOT NULL DEFAULT false,
  text_level_up_message TEXT NOT NULL DEFAULT '🎉 مبروك {user}! وصلت للمستوى **{level}**!',
  voice_level_up_message TEXT NOT NULL DEFAULT '🎤 مبروك {user}! وصلت للمستوى الصوتي **{level}**!',
  role_stacking BOOLEAN NOT NULL DEFAULT false,
  -- XP multiplier rules as [{ id, multiplier }]: roles members carry, and
  -- channels XP is earned inside. Both clamped in the core normaliser.
  role_multipliers JSONB NOT NULL DEFAULT '[]',
  channel_multipliers JSONB NOT NULL DEFAULT '[]',
  ignored_text_channel_ids JSONB NOT NULL DEFAULT '[]',
  ignored_voice_channel_ids JSONB NOT NULL DEFAULT '[]',
  ignored_role_ids JSONB NOT NULL DEFAULT '[]',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- The per-minute fixed rate was replaced by the [min, max] draw above.
ALTER TABLE guild_levels DROP COLUMN IF EXISTS voice_xp_per_minute;
-- CREATE TABLE IF NOT EXISTS leaves an existing table's columns alone, so the
-- new XP fields are added by hand — the same idempotent pattern every upgrade
-- in this file uses.
ALTER TABLE guild_levels ADD COLUMN IF NOT EXISTS text_xp_min SMALLINT;
ALTER TABLE guild_levels ADD COLUMN IF NOT EXISTS text_xp_max SMALLINT;
ALTER TABLE guild_levels ADD COLUMN IF NOT EXISTS voice_xp_min SMALLINT;
ALTER TABLE guild_levels ADD COLUMN IF NOT EXISTS voice_xp_max SMALLINT;
ALTER TABLE guild_levels ADD COLUMN IF NOT EXISTS max_level_cap INTEGER;
ALTER TABLE guild_levels ADD COLUMN IF NOT EXISTS reset_on_leave BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE guild_levels ADD COLUMN IF NOT EXISTS rank_card BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE guild_levels ADD COLUMN IF NOT EXISTS role_multipliers JSONB NOT NULL DEFAULT '[]';
ALTER TABLE guild_levels ADD COLUMN IF NOT EXISTS channel_multipliers JSONB NOT NULL DEFAULT '[]';
-- Backfill the draw ranges, then apply defaults and CHECK guards to every row.
UPDATE guild_levels SET
  text_xp_min = COALESCE(text_xp_min, 15),
  text_xp_max = COALESCE(text_xp_max, 25),
  voice_xp_min = COALESCE(voice_xp_min, 3),
  voice_xp_max = COALESCE(voice_xp_max, 3),
  max_level_cap = COALESCE(max_level_cap, 100);
ALTER TABLE guild_levels ALTER COLUMN text_xp_min SET DEFAULT 15;
ALTER TABLE guild_levels ALTER COLUMN text_xp_max SET DEFAULT 25;
ALTER TABLE guild_levels ALTER COLUMN voice_xp_min SET DEFAULT 3;
ALTER TABLE guild_levels ALTER COLUMN voice_xp_max SET DEFAULT 3;
ALTER TABLE guild_levels ALTER COLUMN max_level_cap SET DEFAULT 100;
ALTER TABLE guild_levels DROP CONSTRAINT IF EXISTS guild_levels_text_xp_min_check;
ALTER TABLE guild_levels ADD CONSTRAINT guild_levels_text_xp_min_check CHECK (text_xp_min BETWEEN 1 AND 100);
ALTER TABLE guild_levels DROP CONSTRAINT IF EXISTS guild_levels_text_xp_max_check;
ALTER TABLE guild_levels ADD CONSTRAINT guild_levels_text_xp_max_check CHECK (text_xp_max BETWEEN 1 AND 100);
ALTER TABLE guild_levels DROP CONSTRAINT IF EXISTS guild_levels_voice_xp_min_check;
ALTER TABLE guild_levels ADD CONSTRAINT guild_levels_voice_xp_min_check CHECK (voice_xp_min BETWEEN 0 AND 100);
ALTER TABLE guild_levels DROP CONSTRAINT IF EXISTS guild_levels_voice_xp_max_check;
ALTER TABLE guild_levels ADD CONSTRAINT guild_levels_voice_xp_max_check CHECK (voice_xp_max BETWEEN 0 AND 100);
ALTER TABLE guild_levels DROP CONSTRAINT IF EXISTS guild_levels_cap_check;
ALTER TABLE guild_levels ADD CONSTRAINT guild_levels_cap_check CHECK (max_level_cap = 0 OR max_level_cap BETWEEN 10 AND 1000);
-- The retired sync flag: requests now live in `level_sync_jobs`, which carry
-- the whole lifecycle (pending → running → completed | failed) rather than a
-- timestamp that was cleared before the work it promised was verified.
ALTER TABLE guild_levels DROP COLUMN IF EXISTS sync_requested_at;

-- Role reward sync, as a persistent job rather than a flag.
--
-- `cursor` is the last member id processed, so the pass is resumable across
-- restarts and batch boundaries without skipping or repeating members: the
-- member read is keyset-paginated on the primary key, which stays stable even
-- while XP totals move mid-pass. Counters are cumulative and updated per
-- batch, so the dashboard's progress reads live state, not a local guess.
CREATE TABLE IF NOT EXISTS level_sync_jobs (
  id UUID PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CONSTRAINT level_sync_jobs_status_check CHECK (status IN ('pending','running','completed','failed')),
  cursor TEXT,
  total INTEGER,
  processed INTEGER NOT NULL DEFAULT 0,
  granted INTEGER NOT NULL DEFAULT 0,
  removed INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS level_sync_jobs_guild_idx ON level_sync_jobs (guild_id, created_at DESC);
CREATE INDEX IF NOT EXISTS level_sync_jobs_open_idx ON level_sync_jobs (created_at) WHERE status = 'pending';

-- One row per member per guild. Levels are always derived from XP through
-- levelFromXp, never stored — a stored level could drift from the formula the
-- screen advertises. `text_xp`/`voice_xp` are the totals; the display names and
-- avatar hashes are the bot's last observation, so the leaderboard renders
-- without a member fetch per row (a member may have left, and a left member
-- keeps their rank — they earned it).
CREATE TABLE IF NOT EXISTS user_guild_levels (
  guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  text_xp INTEGER NOT NULL DEFAULT 0 CONSTRAINT user_guild_levels_text_xp_check CHECK (text_xp >= 0),
  voice_xp INTEGER NOT NULL DEFAULT 0 CONSTRAINT user_guild_levels_voice_xp_check CHECK (voice_xp >= 0),
  display_name TEXT,
  avatar_hash TEXT,
  last_text_xp_at TIMESTAMPTZ,
  last_voice_xp_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, user_id)
);
CREATE INDEX IF NOT EXISTS user_guild_levels_text_rank_idx ON user_guild_levels (guild_id, text_xp DESC);
CREATE INDEX IF NOT EXISTS user_guild_levels_voice_rank_idx ON user_guild_levels (guild_id, voice_xp DESC);
-- Leaderboard exclusion is per member: a hidden member keeps earning XP —
-- only the board hides them, at the operator's request.
ALTER TABLE user_guild_levels ADD COLUMN IF NOT EXISTS leaderboard_hidden BOOLEAN NOT NULL DEFAULT false;

-- Reward levels are bounded by the hard ceiling (MAX_REWARD_LEVEL = 500);
-- a rule above a guild's own cap stays storable but is flagged as a problem
-- in the config detection, since the cap can move at any time.
CREATE TABLE IF NOT EXISTS level_role_rewards (
  id UUID PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CONSTRAINT level_role_rewards_kind_check CHECK (kind IN ('text','voice','dual')),
  level INTEGER NOT NULL CONSTRAINT level_role_rewards_level_check CHECK (level BETWEEN 1 AND 100),
  -- Only meaningful for 'dual'; NULL otherwise.
  required_voice_level INTEGER CONSTRAINT level_role_rewards_voice_level_check CHECK (required_voice_level IS NULL OR required_voice_level BETWEEN 1 AND 100),
  role_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- NULLS NOT DISTINCT, not the plain form: a 'text' row's required_voice_level
  -- is NULL, and the default UNIQUE treats NULLs as pairwise distinct — two
  -- identical text rules would both slip through. PostgreSQL 15+.
  UNIQUE NULLS NOT DISTINCT (guild_id, kind, level, required_voice_level, role_id),
  CONSTRAINT level_role_rewards_dual_shape_check CHECK (
    (kind = 'dual' AND required_voice_level IS NOT NULL)
    OR (kind <> 'dual' AND required_voice_level IS NULL)
  )
);
-- The sync pass and every XP grant ask "which rewards does this member's level
-- reach?" across all kinds at once, so one index serves the whole read.
CREATE INDEX IF NOT EXISTS level_role_rewards_guild_idx ON level_role_rewards (guild_id);
-- Per-rule stacking: a rule marked `always_keep` keeps its role on the member
-- for as long as the rule is satisfied, even without the guild-wide stacking
-- switch — the modal's "alone or keep previous" choice, stored per rule.
ALTER TABLE level_role_rewards ADD COLUMN IF NOT EXISTS always_keep BOOLEAN NOT NULL DEFAULT false;
-- The ceiling moved from 500 to MAX_LEVEL (= 100): an existing database's
-- CHECK still carries the old range, so it is replaced by hand — CREATE TABLE
-- IF NOT EXISTS leaves an existing table's constraints alone.
ALTER TABLE level_role_rewards DROP CONSTRAINT IF EXISTS level_role_rewards_level_check;
ALTER TABLE level_role_rewards ADD CONSTRAINT level_role_rewards_level_check CHECK (level BETWEEN 1 AND 500);
ALTER TABLE level_role_rewards DROP CONSTRAINT IF EXISTS level_role_rewards_voice_level_check;
ALTER TABLE level_role_rewards ADD CONSTRAINT level_role_rewards_voice_level_check CHECK (required_voice_level IS NULL OR required_voice_level BETWEEN 1 AND 500);

-- Invites (referrals) module. One settings row per guild; a missing row means
-- the feature ships off. The bounds mirror the clamps in normaliseInviteSettings
-- (packages/core/src/invites.ts) so the two sides cannot disagree.
CREATE TABLE IF NOT EXISTS guild_invites (
  guild_id TEXT PRIMARY KEY REFERENCES guilds(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT false,
  -- An account younger than this is logged as fake and kept off the net.
  -- 0 keeps every account; the ceiling matches MAX_FAKE_ACCOUNT_DAYS in core.
  fake_account_days SMALLINT NOT NULL DEFAULT 3 CONSTRAINT guild_invites_fake_days_check CHECK (fake_account_days BETWEEN 0 AND 30),
  -- Keep a milestone role once earned, even when the net drops below it.
  keep_roles_on_leave BOOLEAN NOT NULL DEFAULT false,
  log_self_invites BOOLEAN NOT NULL DEFAULT true,
  log_joins BOOLEAN NOT NULL DEFAULT true,
  log_leaves BOOLEAN NOT NULL DEFAULT true,
  log_milestones BOOLEAN NOT NULL DEFAULT true,
  join_message TEXT NOT NULL DEFAULT '👋 انضم {user} إلى السيرفر.
عمر الحساب: {user.age}
صاحب الدعوة: {inviter} — الكود: {invite.code}
دعوات الداعي: {inviter.net} صافي ({inviter.total} كلي، {inviter.leaves} مغادرون، {inviter.fakes} وهميون)',
  leave_message TEXT NOT NULL DEFAULT '🚪 غادر {user} السيرفر.
كان قد دعاه {inviter}.
تم خصم نقطة من الداعي، مجموع دعواته الحالي: {inviter.net}',
  milestone_message TEXT NOT NULL DEFAULT '🎉 وصل {inviter} إلى {inviter.net} إحالة صافية وحصل على رتبة جديدة!',
  -- Milestone rules as [{ id, net, roleId }], clamped in the core normaliser.
  milestone_roles JSONB NOT NULL DEFAULT '[]',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per member per guild: who brought them in, through which code, and
-- how the join was classified. The row survives a leave (left_at fills in,
-- counted flips off) so the re-join rule — a returning member never counts
-- twice — can see the history without a second table.
CREATE TABLE IF NOT EXISTS invite_members (
  guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  inviter_id TEXT,
  invite_code TEXT,
  -- Mirrors InviteJoinKind in core: regular | fake | rejoin | self | vanity | unknown.
  kind TEXT NOT NULL DEFAULT 'unknown' CONSTRAINT invite_members_kind_check CHECK (kind IN ('regular','fake','rejoin','self','vanity','unknown')),
  -- Whether this row's join was counted in the inviter's regular/net. Flips
  -- off when the member leaves so the deduction happens exactly once.
  counted BOOLEAN NOT NULL DEFAULT false,
  account_age_ms BIGINT,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  left_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, user_id)
);
CREATE INDEX IF NOT EXISTS invite_members_inviter_idx ON invite_members (guild_id, inviter_id);

-- The inviter's running counters. regular grows only on counted joins and
-- leaves only on counted departures, so net = regular - leaves + bonus is a
-- pure function of the row. bonus carries the moderators' manual edits
-- (/admin-invites add/remove), which may push the net in either direction.
CREATE TABLE IF NOT EXISTS invite_stats (
  guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  regular INTEGER NOT NULL DEFAULT 0 CONSTRAINT invite_stats_regular_check CHECK (regular >= 0),
  fakes INTEGER NOT NULL DEFAULT 0 CONSTRAINT invite_stats_fakes_check CHECK (fakes >= 0),
  rejoins INTEGER NOT NULL DEFAULT 0 CONSTRAINT invite_stats_rejoins_check CHECK (rejoins >= 0),
  leaves INTEGER NOT NULL DEFAULT 0 CONSTRAINT invite_stats_leaves_check CHECK (leaves >= 0),
  bonus INTEGER NOT NULL DEFAULT 0 CONSTRAINT invite_stats_bonus_check CHECK (bonus BETWEEN -100000 AND 100000),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, user_id)
);
CREATE INDEX IF NOT EXISTS invite_stats_guild_idx ON invite_stats (guild_id, regular DESC);

-- Welcome messages (رسائل الترحيب). One settings row per guild; a missing row
-- means the feature ships off. Distinct from `guild_welcome` (the auto-role):
-- that table grants a role on join, this one speaks. The embed and the canvas
-- config are JSONB blobs normalised through normaliseWelcomeMessageSettings
-- (packages/core/src/welcome-messages.ts) on every read and write, so the BFF
-- and the bot cannot disagree about what a stored value means.
CREATE TABLE IF NOT EXISTS guild_welcome_messages (
  guild_id TEXT PRIMARY KEY REFERENCES guilds(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT false,
  image_enabled BOOLEAN NOT NULL DEFAULT false,
  -- with_message | before_message | separate_channel. Mirrors WelcomeImageMode.
  image_mode TEXT NOT NULL DEFAULT 'with_message' CONSTRAINT guild_welcome_messages_image_mode_check CHECK (image_mode IN ('with_message','before_message','separate_channel')),
  -- Only meaningful when image_mode = 'separate_channel'.
  image_channel_id TEXT,
  -- Where the message itself goes; NULL means unset and the module stays quiet.
  channel_id TEXT,
  -- text | embed. Mirrors WelcomeMessageMode.
  mode TEXT NOT NULL DEFAULT 'embed' CONSTRAINT guild_welcome_messages_mode_check CHECK (mode IN ('text','embed')),
  text TEXT NOT NULL DEFAULT 'أهلاً وسهلاً {user} في {server}! 🎉',
  embed JSONB NOT NULL DEFAULT '{}',
  image_config JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS guild_welcome_messages_channel_idx ON guild_welcome_messages (channel_id);

-- The bot's presence is type + text together: Discord renders nothing for an
-- activity with a blank name, so an empty text makes the whole «نوع النشاط»
-- picker look broken. Fresh deployments start with a real presence; existing
-- rows get the real text only while theirs is empty — an operator's chosen
-- text is never overwritten.
ALTER TABLE bot_identity ALTER COLUMN activity_text SET DEFAULT 'سيرفرات ديسكورد';
UPDATE bot_identity SET activity_text = 'سيرفرات ديسكورد' WHERE id = true AND (activity_text IS NULL OR activity_text = '');

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

-- The application role (`al_ai_app` in this deployment) reads and writes every
-- feature table but owns none of them, so a table created under the owner role
-- needs its grants stated here. Wrapped rather than bare: a database initialised
-- under a different role name must not fail its whole schema pass over a grant.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'al_ai_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO al_ai_app;
  END IF;
END $$;

