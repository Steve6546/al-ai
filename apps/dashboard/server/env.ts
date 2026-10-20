/**
 * BFF environment contract.
 *
 * The dashboard refuses to boot without the secrets it needs, instead of
 * failing later on the first request. KEY_ROTATION_DAYS and
 * AUDIT_RETENTION_DAYS are mandatory in production only: they are operational
 * settings that must never be guessed, but local development stays usable.
 *
 * The reading rules and the "which are missing" and "are we in production"
 * answers come from `@al-ai/core`, shared with the bot. Only the *policy* — the
 * list of required names, and the shape the values are returned in — belongs to
 * the dashboard.
 */

import { isProduction, missingEnv, readEnv } from "@al-ai/core";

const alwaysRequired = [
  "DISCORD_CLIENT_ID",
  "DISCORD_CLIENT_SECRET",
  "DISCORD_REDIRECT_URI",
  "DATABASE_URL",
  "SESSION_SECRET",
  "EVENT_HMAC_SECRET",
  "ENCRYPTION_KEY"
] as const;

const productionRequired = ["KEY_ROTATION_DAYS", "AUDIT_RETENTION_DAYS"] as const;

export type BffEnv = {
  nodeEnv: string;
  isProduction: boolean;
  port: number;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  databaseUrl: string;
  sessionSecret: string;
  eventHmacSecret: string;
  encryptionKey: string;
  botToken: string | null;
  keyRotationDays: number | null;
  auditRetentionDays: number | null;
  /**
   * The platform owner's Discord user id, when configured. Gates the
   * instance-wide surfaces (network reach, the bot's global identity) that do
   * not belong to any single guild. Absent means every owner-gated surface is
   * denied — the deployment runs without a known owner and must not guess one.
   */
  ownerId: string | null;
};

function read(key: string) {
  return readEnv(process.env, key);
}

export function loadEnv(): BffEnv {
  const missing = missingEnv(process.env, alwaysRequired);
  const production = isProduction(process.env);
  if (production) {
    missing.push(...missingEnv(process.env, productionRequired));
  }
  if (missing.length) {
    throw new Error(`AL AI dashboard cannot start. Missing required environment values: ${missing.join(", ")}`);
  }

  const encryptionKey = read("ENCRYPTION_KEY")!;
  if (!/^[0-9a-f]{64}$/i.test(encryptionKey)) {
    throw new Error("ENCRYPTION_KEY must be 64 hex characters (32 bytes) for AES-256-GCM.");
  }
  const sessionSecret = read("SESSION_SECRET")!;
  if (sessionSecret.length < 32) {
    throw new Error("SESSION_SECRET must be at least 32 characters.");
  }

  return {
    nodeEnv: read("NODE_ENV") ?? "development",
    isProduction: production,
    port: Number(read("PORT") ?? 3000),
    clientId: read("DISCORD_CLIENT_ID")!,
    clientSecret: read("DISCORD_CLIENT_SECRET")!,
    redirectUri: read("DISCORD_REDIRECT_URI")!,
    databaseUrl: read("DATABASE_URL")!,
    sessionSecret,
    eventHmacSecret: read("EVENT_HMAC_SECRET")!,
    encryptionKey,
    botToken: read("BOT_TOKEN"),
    keyRotationDays: read("KEY_ROTATION_DAYS") ? Number(read("KEY_ROTATION_DAYS")) : null,
    auditRetentionDays: read("AUDIT_RETENTION_DAYS") ? Number(read("AUDIT_RETENTION_DAYS")) : null,
    ownerId: read("OWNER_ID")
  };
}
