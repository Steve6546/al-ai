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

CREATE TABLE IF NOT EXISTS guild_role_tiers (
  guild_id TEXT PRIMARY KEY REFERENCES guilds(id) ON DELETE CASCADE,
  owner_role_id TEXT NOT NULL,
  head_admin_role_id TEXT NOT NULL,
  admin_role_id TEXT NOT NULL,
  moderator_role_id TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS guild_customization (
  guild_id TEXT PRIMARY KEY REFERENCES guilds(id) ON DELETE CASCADE,
  -- Per-guild bot nickname, applied by the bot's customization sync.
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

CREATE TABLE IF NOT EXISTS guild_logging (
  guild_id TEXT PRIMARY KEY REFERENCES guilds(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT false,
  global_channel_id TEXT,
  ignored_channel_ids JSONB NOT NULL DEFAULT '[]',
  -- Must match DEFAULT_EMBED_COLOR in packages/core/src/event-schema.ts.
  embed_color TEXT NOT NULL DEFAULT '#3b82f6',
  event_flags JSONB NOT NULL DEFAULT '{}',
  category_channels JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Idempotent upgrade: retire the old violet default everywhere it was stored.
ALTER TABLE guild_logging ALTER COLUMN embed_color SET DEFAULT '#3b82f6';
UPDATE guild_logging SET embed_color = '#3b82f6' WHERE lower(embed_color) = '#7c3aed';

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
  state TEXT NOT NULL DEFAULT 'unknown',
  notes TEXT,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Idempotent upgrade for databases created before unique_users existed.
ALTER TABLE guild_health ADD COLUMN IF NOT EXISTS unique_users INTEGER NOT NULL DEFAULT 0;

-- Constraint-only mirror of `guild_logging.category_channels`. The dashboard
-- writes it in the same transaction as the JSONB row so the database itself
-- rejects two destinations sharing one channel. It is NOT a read source: it has
-- no global-channel row, so routing is always read from `guild_logging`.
CREATE TABLE IF NOT EXISTS guild_log_channels (
  guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  destination TEXT NOT NULL CHECK (destination IN ('member-log','moderation-log','voice-log','role-log','message-log','server-log','bot-log')),
  channel_id TEXT NOT NULL,
  PRIMARY KEY (guild_id, destination),
  UNIQUE (guild_id, channel_id)
);

-- Per-command switches for the dashboard's General Commands section.
CREATE TABLE IF NOT EXISTS guild_command_flags (
  guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  command TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  minimum_tier TEXT NOT NULL DEFAULT 'moderator',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, command)
);

-- Multiple bot tokens. Ciphertext only: a stored token is never displayed again,
-- the dashboard shows a masked fingerprint instead.
CREATE TABLE IF NOT EXISTS bot_tokens (
  id UUID PRIMARY KEY,
  label TEXT NOT NULL,
  token_ciphertext TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS bot_token_guilds (
  token_id UUID NOT NULL REFERENCES bot_tokens(id) ON DELETE CASCADE,
  guild_id TEXT NOT NULL,
  PRIMARY KEY (token_id, guild_id)
);

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

