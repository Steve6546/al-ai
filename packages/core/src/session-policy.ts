/**
 * Dashboard session policy. These values are contractual: the BFF must not
 * issue a cookie that outlives SESSION_MAX_AGE_SECONDS, and it must never
 * relax the httpOnly / sameSite settings below.
 */
export const SESSION_COOKIE_NAME = "al_ai_session";
export const SESSION_MAX_AGE_SECONDS = 24 * 60 * 60;
export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "lax",
  path: "/",
  secure: false // set true behind TLS termination; VPS deploys must enable this
} as const;

/** OAuth scopes are frozen: identify + guilds for login, bot + commands for invites. */
export const LOGIN_SCOPES = ["identify", "guilds"] as const;
export const BOT_INVITE_SCOPES = ["bot", "applications.commands"] as const;

/** Discord's documented thresholds that force a verification review. */
export const VERIFICATION_REVIEW_GUILD_THRESHOLD = 100;
export const VERIFICATION_WARN_USER_THRESHOLD = 8_000;
export const VERIFICATION_REMIND_USER_THRESHOLD = 10_000;

export type VerificationStatus = {
  guildCount: number;
  uniqueUsers: number;
  reviewRequired: boolean;
  warning: string | null;
};

/**
 * The 8,000 / 10,000 figures are *unique-user* thresholds, while the 100 figure is
 * a *guild* threshold. They are not interchangeable: comparing a guild count
 * against the user limits raised a false alarm for many small guilds and, worse,
 * stayed silent for a few very large ones. The two units are therefore kept
 * separate here, and this is the only place that decides them.
 */
export function describeVerification(input: { guildCount: number; uniqueUsers: number }): VerificationStatus {
  const guildCount = Math.max(0, Math.trunc(input.guildCount) || 0);
  const uniqueUsers = Math.max(0, Math.trunc(input.uniqueUsers) || 0);

  const warning =
    uniqueUsers >= VERIFICATION_REMIND_USER_THRESHOLD
      ? "تجاوزت 10,000 مستخدم فريد: تحقق من التوثيق الرسمي فوراً."
      : uniqueUsers >= VERIFICATION_WARN_USER_THRESHOLD
        ? "اقتربت من الحد: تجاوزت 8,000 مستخدم فريد."
        : null;

  return {
    guildCount,
    uniqueUsers,
    reviewRequired: guildCount >= VERIFICATION_REVIEW_GUILD_THRESHOLD,
    warning
  };
}

/** Discord keeps official audit logs for 45 days, so the internal trail is mandatory. */
export const DISCORD_AUDIT_LOG_RETENTION_DAYS = 45;
