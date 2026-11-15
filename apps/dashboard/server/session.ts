import { randomUUID } from "node:crypto";
import {
  decryptSecret,
  encryptSecret,
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_OPTIONS,
  SESSION_COOKIE_SECURE,
  SESSION_MAX_AGE_SECONDS,
  sessionCookiePolicyFor,
  type SessionCookiePolicy
} from "@al-ai/core";
import type { Database, SessionRecord } from "./db.js";
import type { BffEnv } from "./env.js";

export function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  return Object.fromEntries(
    header.split(";").flatMap(part => {
      const index = part.indexOf("=");
      if (index < 0) return [];
      const key = part.slice(0, index).trim();
      const value = part.slice(index + 1).trim();
      // A stray percent sign makes `decodeURIComponent` throw `URIError`, which
      // would turn one malformed cookie into a 500 on every authenticated route.
      // A value that cannot be decoded is not a value this site set; skip it.
      try {
        return key ? [[key, decodeURIComponent(value)]] : [];
      } catch {
        return [];
      }
    })
  );
}

/**
 * Anything that carries a Host header and, when available, the request's
 * protocol. A FastifyRequest satisfies this; so does a minimal unit-test stub.
 */
export type CookieContext = { headers: Record<string, unknown>; protocol?: string };

/**
 * The cookie shape for *this* request. See `sessionCookiePolicyFor` in core:
 * a plain-HTTP LAN origin cannot hold a `Secure`/`__Host-` cookie, so it gets
 * the unprefixed one. With no context (a synthetic header in a unit test) the
 * process-wide hardened policy is kept, which is what the constants describe.
 */
export function cookiePolicyFor(
  context?: CookieContext,
  /** Explicit so the production branch is testable without reloading the
   * module under a different `NODE_ENV`. */
  production: boolean = SESSION_COOKIE_SECURE
): SessionCookiePolicy {
  if (!context) return { name: SESSION_COOKIE_NAME, secure: SESSION_COOKIE_SECURE };
  const host = typeof context.headers.host === "string" ? context.headers.host : "";
  return sessionCookiePolicyFor({ protocol: context.protocol, host }, production);
}

/** The state/2FA cookies follow their session's name, so a LAN login does not
 * end up writing a `__Host-` cookie the browser will discard. */
export function derivedCookieName(suffix: string, context?: CookieContext, production?: boolean): string {
  return `${cookiePolicyFor(context, production).name}${suffix}`;
}

function serializeCookie(name: string, value: string, maxAge: number, secure: boolean) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${SESSION_COOKIE_OPTIONS.path}`,
    `Max-Age=${maxAge}`,
    SESSION_COOKIE_OPTIONS.httpOnly ? "HttpOnly" : "",
    `SameSite=${SESSION_COOKIE_OPTIONS.sameSite === "lax" ? "Lax" : "Strict"}`,
    secure ? "Secure" : ""
  ];
  return parts.filter(Boolean).join("; ");
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function sessionCookieHeader(sessionId: string, context?: CookieContext) {
  const policy = cookiePolicyFor(context);
  return serializeCookie(policy.name, sessionId, SESSION_MAX_AGE_SECONDS, policy.secure);
}

/**
 * Any other short-lived cookie this site sets, built on the same policy as the
 * session cookie so the two cannot drift on `Secure`, `SameSite` or `HttpOnly`.
 */
export function policyCookieHeader(name: string, value: string, maxAgeSeconds: number, context?: CookieContext) {
  return serializeCookie(name, value, maxAgeSeconds, cookiePolicyFor(context).secure);
}

export function clearedCookieHeader(context?: CookieContext) {
  const policy = cookiePolicyFor(context);
  return serializeCookie(policy.name, "", 0, policy.secure);
}

export async function readSession(db: Database, request: CookieContext): Promise<SessionRecord | null> {
  const cookies = parseCookies(request.headers.cookie as string | undefined);
  const id = cookies[cookiePolicyFor(request).name];
  if (!id || !UUID_PATTERN.test(id)) return null;
  const session = await db.getSession(id);
  if (!session) return null;
  // A credential enrolled after this session was minted does not grandfather
  // the session in. Anything that did not clear the second factor is dead once
  // the account has one, so an older (or stolen) cookie is not a way around
  // 2FA. Deleting it here also stops the row from being probed again.
  if (session.secondFactorRequired && !session.secondFactorSatisfied) {
    await db.deleteSession(id);
    return null;
  }
  await db.touchSession(id);
  return session;
}

/**
 * The session's Discord access token, or null when its ciphertext can no
 * longer be decrypted.
 *
 * A rotation of ENCRYPTION_KEY (or a corrupted row) must look like "please
 * sign in again", not a 500 on every authenticated route: the audit flagged
 * that an undecryptable session used to throw here and take its caller down.
 * Callers treat null exactly like an auth failure — the session is destroyed
 * and the browser is sent back to the login screen.
 */
export function sessionAccessToken(session: SessionRecord, env: BffEnv): string | null {
  try {
    return decryptSecret(session.accessTokenCiphertext, env.encryptionKey);
  } catch {
    return null;
  }
}

export async function issueSession(
  db: Database,
  env: BffEnv,
  input: {
    discordUserId: string;
    discordUsername: string;
    /** The @handle, beside the display name. */
    discordHandle?: string | null;
    discordAvatar?: string | null;
    accessToken: string;
    scopes: string;
    /** A display hint for the security screen; never used for authorisation. */
    userAgent?: string | null;
    /** TRUE only when a TOTP/recovery code was consumed for this very login. */
    secondFactorSatisfied?: boolean;
  }
) {
  const id = randomUUID();
  const expiresAt = await db.createSession({
    id,
    discordUserId: input.discordUserId,
    discordUsername: input.discordUsername,
    discordHandle: input.discordHandle ?? null,
    discordAvatar: input.discordAvatar ?? null,
    accessTokenCiphertext: encryptSecret(input.accessToken, env.encryptionKey),
    scopes: input.scopes,
    userAgent: input.userAgent ?? null,
    secondFactorSatisfied: input.secondFactorSatisfied ?? false
  });
  return { id, expiresAt };
}

export async function destroySession(db: Database, request: CookieContext) {
  const cookies = parseCookies(request.headers.cookie as string | undefined);
  const id = cookies[cookiePolicyFor(request).name];
  if (id && UUID_PATTERN.test(id)) await db.deleteSession(id);
}
