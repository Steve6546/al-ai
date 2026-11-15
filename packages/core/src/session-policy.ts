/**
 * Dashboard session policy. These values are contractual: the BFF must not
 * issue a cookie that outlives SESSION_MAX_AGE_SECONDS, and it must never
 * relax the httpOnly / sameSite settings below.
 */
/**
 * The `__Host-` prefix is browser-enforced: a cookie so named is refused
 * unless it is Secure, Path=/, and carries no Domain attribute — exactly the
 * shape production sets below. That makes session fixation by a
 * sibling-origin cookie structurally impossible rather than policy. Production
 * carries the prefixed name; development (plain HTTP, where the prefix would
 * be refused for lacking Secure) keeps the unprefixed one, so a dev server
 * stays usable without weakening the hardened deployment. Renaming logs every
 * operator out exactly once; the value is a fresh UUID per sign-in.
 */
export const SESSION_COOKIE_NAME =
  process.env.NODE_ENV === "production" ? "__Host-al_ai_session" : "al_ai_session";
/** The hardened name. Only ever issued where the browser can honour `Secure`. */
export const SESSION_COOKIE_NAME_HARDENED = "__Host-al_ai_session";
/** The plain-HTTP name, used on a LAN address (see `sessionCookiePolicyFor`). */
export const SESSION_COOKIE_NAME_PLAIN = "al_ai_session";
/** Both names a request may legitimately carry. Used by the CSRF and throttle
 * guards, which must recognise a credential before they know which origin
 * issued it. */
export const SESSION_COOKIE_NAMES = [SESSION_COOKIE_NAME_HARDENED, SESSION_COOKIE_NAME_PLAIN] as const;
export const SESSION_MAX_AGE_SECONDS = 24 * 60 * 60;
/**
 * `Secure` follows the environment rather than a flag that has to be remembered:
 * a session id must never cross cleartext HTTP, and the only deployment with any
 * business sending one is production, which sits behind TLS termination (a tunnel) or talks from localhost, where browsers honor Secure
 * cookies on plain HTTP. `NODE_ENV=production` is therefore a hard requirement
 * for any deployment the network screen exposes beyond loopback — development
 * stays plain HTTP on localhost, where the flag would otherwise stop the
 * cookie from being sent at all.
 */
export const SESSION_COOKIE_SECURE = process.env.NODE_ENV === "production";
export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "lax",
  path: "/",
  secure: SESSION_COOKIE_SECURE
} as const;

/**
 * Browsers treat `http://localhost` and `http://127.0.0.1` as trustworthy
 * origins and accept a `Secure` cookie there, but they **refuse** one on
 * `http://192.168.1.195:3000`. The `__Host-` prefix is stricter still: a
 * cookie so named is rejected unless it is Secure, Path=/ and carries no
 * Domain. So a production dashboard bound to 0.0.0.0 would hand a phone on
 * the router a `Set-Cookie` the browser silently discards — the login appears
 * to succeed, every API call answers 401, and nothing in a server log is
 * wrong.
 *
 * The name and the flag therefore follow the *request*, not just `NODE_ENV`:
 * a trustworthy transport keeps the hardened `__Host-` cookie, and a plain
 * HTTP LAN origin gets the unprefixed one without `Secure`. `SameSite=Lax`
 * and `HttpOnly` are identical in both cases. A LAN visitor is already on a
 * cleartext local network; claiming `Secure` there buys nothing and costs the
 * entire session.
 */
const TRUSTWORTHY_HTTP_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Strip a port and IPv6 brackets from a Host header value. */
export function cookieHostname(host: string | null | undefined): string {
  const value = (host ?? "").trim().toLowerCase();
  if (value.startsWith("[")) return value.slice(0, value.indexOf("]") + 1);
  const colon = value.lastIndexOf(":");
  return colon > 0 && /^\d+$/.test(value.slice(colon + 1)) ? value.slice(0, colon) : value;
}

export type CookieTransport = {
  /** Fastify's `request.protocol` — already gated by loopback-only trustProxy. */
  protocol?: string | null;
  /** The request's Host header. */
  host?: string | null;
};

export type SessionCookiePolicy = { name: string; secure: boolean };

export function sessionCookiePolicyFor(
  transport: CookieTransport,
  /** Explicit so the production branch is testable without reloading the
   * module under a different `NODE_ENV`. Defaults to this process's policy. */
  production: boolean = SESSION_COOKIE_SECURE
): SessionCookiePolicy {
  const https = (transport.protocol ?? "").toLowerCase() === "https";
  const trustworthy = https || TRUSTWORTHY_HTTP_HOSTNAMES.has(cookieHostname(transport.host));
  const hardened = production && trustworthy;
  return {
    name: hardened ? SESSION_COOKIE_NAME_HARDENED : SESSION_COOKIE_NAME_PLAIN,
    secure: hardened
  };
}

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
