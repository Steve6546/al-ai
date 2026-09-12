import { randomUUID } from "node:crypto";
import { decryptSecret, encryptSecret, SESSION_COOKIE_NAME, SESSION_COOKIE_OPTIONS, SESSION_MAX_AGE_SECONDS } from "@al-ai/core";
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
      return key ? [[key, decodeURIComponent(value)]] : [];
    })
  );
}

function serializeCookie(name: string, value: string, maxAge: number) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${SESSION_COOKIE_OPTIONS.path}`,
    `Max-Age=${maxAge}`,
    SESSION_COOKIE_OPTIONS.httpOnly ? "HttpOnly" : "",
    `SameSite=${SESSION_COOKIE_OPTIONS.sameSite === "lax" ? "Lax" : "Strict"}`,
    SESSION_COOKIE_OPTIONS.secure ? "Secure" : ""
  ];
  return parts.filter(Boolean).join("; ");
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function sessionCookieHeader(sessionId: string) {
  return serializeCookie(SESSION_COOKIE_NAME, sessionId, SESSION_MAX_AGE_SECONDS);
}

export function clearedCookieHeader() {
  return serializeCookie(SESSION_COOKIE_NAME, "", 0);
}

export async function readSession(db: Database, request: { headers: Record<string, unknown> }): Promise<SessionRecord | null> {
  const cookies = parseCookies(request.headers.cookie as string | undefined);
  const id = cookies[SESSION_COOKIE_NAME];
  if (!id || !UUID_PATTERN.test(id)) return null;
  const session = await db.getSession(id);
  if (!session) return null;
  await db.touchSession(id);
  return session;
}

export function sessionAccessToken(session: SessionRecord, env: BffEnv) {
  return decryptSecret(session.accessTokenCiphertext, env.encryptionKey);
}

export async function issueSession(
  db: Database,
  env: BffEnv,
  input: { discordUserId: string; discordUsername: string; discordAvatar?: string | null; accessToken: string; scopes: string }
) {
  const id = randomUUID();
  const expiresAt = await db.createSession({
    id,
    discordUserId: input.discordUserId,
    discordUsername: input.discordUsername,
    discordAvatar: input.discordAvatar ?? null,
    accessTokenCiphertext: encryptSecret(input.accessToken, env.encryptionKey),
    scopes: input.scopes
  });
  return { id, expiresAt };
}

export async function destroySession(db: Database, request: { headers: Record<string, unknown> }) {
  const cookies = parseCookies(request.headers.cookie as string | undefined);
  const id = cookies[SESSION_COOKIE_NAME];
  if (id && UUID_PATTERN.test(id)) await db.deleteSession(id);
}
