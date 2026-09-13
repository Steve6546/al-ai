/**
 * BFF environment contract.
 *
 * The dashboard refuses to boot without the secrets it needs, instead of
 * failing later on the first request. KEY_ROTATION_DAYS and
 * AUDIT_RETENTION_DAYS are mandatory in production only: they are operational
 * settings that must never be guessed, but local development stays usable.
 */

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
};

function read(key: string) {
  const value = process.env[key];
  return value && value.trim().length > 0 ? value.trim() : null;
}

export function loadEnv(): BffEnv {
  const missing: string[] = alwaysRequired.filter(key => !read(key));
  const nodeEnv = read("NODE_ENV") ?? "development";
  const isProduction = nodeEnv === "production";
  if (isProduction) {
    missing.push(...productionRequired.filter(key => !read(key)));
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
    nodeEnv,
    isProduction,
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
    auditRetentionDays: read("AUDIT_RETENTION_DAYS") ? Number(read("AUDIT_RETENTION_DAYS")) : null
  };
}
