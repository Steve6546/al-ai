/**
 * The server half of the admin second factor.
 *
 * `packages/core/src/two-factor.ts` owns the cryptography (RFC 6238, base32,
 * recovery-code hashes); `src/components/two-factor-screen.tsx` owns the UI.
 * This module owns the two things neither of them can: **who must pass the
 * second factor** and **where the short-lived, pre-session login lives** until
 * it does. A pending login is deliberately *not* a session: no cookie that
 * authenticates a route is issued until `POST /api/2fa/verify` succeeds.
 *
 * Every stored credential here is an AES-256-GCM envelope under
 * ENCRYPTION_KEY (the same envelope OAuth tokens use), and recovery codes are
 * stored only as keyed HMACs. Nothing in this module writes a secret to a log,
 * a cookie or an error envelope.
 */

import {
  SESSION_COOKIE_NAME,
  TOTP_DIGITS,
  buildOtpauthUri,
  constantTimeEqual,
  decryptSecret,
  encryptSecret,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  normaliseRecoveryCode
} from "@al-ai/core";
import type { Pool } from "pg";
import { isAdministrable } from "./guild-access.js";
import { policyCookieHeader } from "./session.js";
import type { BffEnv } from "./env.js";

/** Five minutes is enough to open an authenticator and read one code. */
export const SECOND_FACTOR_PENDING_SECONDS = 5 * 60;
/**
 * Changing an authenticator from the security screen is a slower, two-step
 * task: install/open the app, add the key, then type a code back. Ten minutes
 * is the same budget the screen advertises, and the row is deleted the moment
 * the change is confirmed or cancelled.
 */
export const SECOND_FACTOR_SETUP_SECONDS = 10 * 60;
/**
 * Five guesses, then the pending login is destroyed rather than locked: an
 * attacker who stole the pending cookie cannot keep it alive by guessing.
 */
export const SECOND_FACTOR_MAX_ATTEMPTS = 5;
export const SECOND_FACTOR_ISSUER = "AL AI";

/**
 * A separate cookie from the session, built from the same policy. In production
 * it inherits the `__Host-` prefix (Secure, Path=/, no Domain), so a sibling
 * origin cannot plant a pending login for this dashboard.
 */
export const SECOND_FACTOR_COOKIE_NAME = `${SESSION_COOKIE_NAME}_2fa`;

export function pendingCookieHeader(id: string) {
  return policyCookieHeader(SECOND_FACTOR_COOKIE_NAME, id, SECOND_FACTOR_PENDING_SECONDS);
}

export function clearedPendingCookieHeader() {
  return policyCookieHeader(SECOND_FACTOR_COOKIE_NAME, "", 0);
}

/**
 * Which sign-ins must pass the second factor.
 *
 * "Admin" is Discord's own verdict, not a claim from the request: the platform
 * owner (OWNER_ID), or anyone who owns a guild or may administer one. The
 * latter uses `isAdministrable` — the same verdict the guild selector uses —
 * so the login gate and the screens cannot disagree about who is an admin.
 *
 * `guilds === null` means the Discord read failed. That is *not* permission to
 * skip the check: failing closed adds one step to a legitimate sign-in, while
 * failing open would let an outage switch the whole second factor off.
 */
export function requiresSecondFactor(input: {
  ownerId: string | null;
  discordUserId: string;
  guilds: readonly { owner: boolean; permissions: bigint }[] | null;
}): boolean {
  if (input.ownerId && input.ownerId === input.discordUserId) return true;
  if (input.guilds === null) return true;
  return input.guilds.some(guild => guild.owner || isAdministrable(guild.permissions));
}

/** A 6-digit string is a TOTP; anything else is treated as a recovery code. */
export function isTotpShaped(code: string): boolean {
  return code.length === TOTP_DIGITS && /^[0-9]+$/.test(code);
}

export function attemptsRemaining(attempts: number): number {
  return Math.max(0, SECOND_FACTOR_MAX_ATTEMPTS - attempts);
}

/**
 * Recovery codes are HMAC-SHA256 under SESSION_SECRET, never stored plaintext.
 * A rotation of that secret invalidates outstanding recovery codes (their
 * hashes cannot be recomputed without the codes), while the TOTP secret
 * survives a rotation because `rotate-encryption-key.mts` re-encrypts it.
 */
export function recoveryCodeHash(code: string, env: BffEnv): string {
  return hashRecoveryCode(code, env.sessionSecret);
}

/**
 * The enrolment material for one pending login: a fresh TOTP key and ten
 * single-use recovery codes. Kept as one encrypted JSON envelope so a second
 * `GET /api/2fa/enrollment` (the screen has a retry button) reveals the *same*
 * secret and codes instead of silently invalidating what the operator copied.
 */
export type EnrollmentPayload = { secret: string; recoveryCodes: string[] };

export function newEnrollmentPayload(): EnrollmentPayload {
  return { secret: generateTotpSecret(), recoveryCodes: generateRecoveryCodes() };
}

export function encodeEnrollment(payload: EnrollmentPayload, keyHex: string): string {
  return encryptSecret(JSON.stringify(payload), keyHex);
}

export function decodeEnrollment(envelope: string, keyHex: string): EnrollmentPayload {
  const parsed: unknown = JSON.parse(decryptSecret(envelope, keyHex));
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as EnrollmentPayload).secret !== "string" ||
    !Array.isArray((parsed as EnrollmentPayload).recoveryCodes) ||
    !(parsed as EnrollmentPayload).recoveryCodes.every(code => typeof code === "string")
  ) {
    throw new Error("Malformed enrolment envelope.");
  }
  return parsed as EnrollmentPayload;
}

/** The one-time enrolment answer. The label is percent-encoded by core. */
export function enrollmentView(payload: EnrollmentPayload, label: string, expiresAt: string) {
  return {
    enrolled: false,
    secret: payload.secret,
    otpauthUri: buildOtpauthUri({ secret: payload.secret, issuer: SECOND_FACTOR_ISSUER, label }),
    recoveryCodes: payload.recoveryCodes,
    expiresAt
  };
}

export function enrolledView(expiresAt: string) {
  return { enrolled: true, secret: null, otpauthUri: null, recoveryCodes: [] as string[], expiresAt };
}

/**
 * Constant-time match of a submitted recovery code against a plaintext list,
 * used only while enrolment is unconfirmed. Returns the code that matched so
 * the caller can leave it out of the stored (single-use) hashes.
 */
export function matchPendingRecoveryCode(code: string, codes: readonly string[]): string | null {
  const normalised = normaliseRecoveryCode(code);
  if (!normalised) return null;
  for (const candidate of codes) {
    if (constantTimeEqual(normaliseRecoveryCode(candidate), normalised)) return candidate;
  }
  return null;
}

export type PendingLogin = {
  id: string;
  discordUserId: string;
  discordUsername: string;
  discordHandle: string | null;
  discordAvatar: string | null;
  accessTokenCiphertext: string;
  scopes: string;
  enrollmentCiphertext: string | null;
  expiresAt: Date;
  attempts: number;
};

type PendingRow = {
  id: string;
  discord_user_id: string;
  discord_username: string;
  discord_handle: string | null;
  discord_avatar: string | null;
  access_token_ciphertext: string;
  scopes: string;
  enrollment_ciphertext: string | null;
  expires_at: Date;
  attempts: number;
};

function mapPending(row: PendingRow): PendingLogin {
  return {
    id: row.id,
    discordUserId: row.discord_user_id,
    discordUsername: row.discord_username,
    discordHandle: row.discord_handle ?? null,
    discordAvatar: row.discord_avatar ?? null,
    accessTokenCiphertext: row.access_token_ciphertext,
    scopes: row.scopes,
    enrollmentCiphertext: row.enrollment_ciphertext ?? null,
    expiresAt: row.expires_at,
    attempts: row.attempts
  };
}

/**
 * All SQL for the second factor in one place.
 *
 * The two consumption queries are deliberately single atomic statements:
 * `UPDATE ... WHERE last_counter < $n` turns a replayed TOTP into a lost race,
 * and `DELETE ... RETURNING` makes a recovery code single-use even when two
 * requests submit it in the same tick.
 */
export function createSecondFactorStore(pool: Pool) {
  return {
    async isEnrolled(discordUserId: string): Promise<boolean> {
      const { rowCount } = await pool.query(
        `SELECT 1 FROM admin_two_factor WHERE discord_user_id = $1`,
        [discordUserId]
      );
      return (rowCount ?? 0) > 0;
    },

    async createPending(input: Omit<PendingLogin, "attempts">): Promise<void> {
      await pool.query(
        `INSERT INTO admin_two_factor_pending
           (id, discord_user_id, discord_username, discord_handle, discord_avatar,
            access_token_ciphertext, scopes, enrollment_ciphertext, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          input.id,
          input.discordUserId,
          input.discordUsername,
          input.discordHandle,
          input.discordAvatar,
          input.accessTokenCiphertext,
          input.scopes,
          input.enrollmentCiphertext,
          input.expiresAt
        ]
      );
    },

    async getPending(id: string): Promise<PendingLogin | null> {
      const { rows } = await pool.query(
        `SELECT id, discord_user_id, discord_username, discord_handle, discord_avatar,
                access_token_ciphertext, scopes, enrollment_ciphertext, expires_at, attempts
         FROM admin_two_factor_pending WHERE id = $1 AND expires_at > now()`,
        [id]
      );
      return rows[0] ? mapPending(rows[0] as PendingRow) : null;
    },

    async deletePending(id: string): Promise<void> {
      await pool.query(`DELETE FROM admin_two_factor_pending WHERE id = $1`, [id]);
    },

    async purgeExpiredPending(): Promise<number> {
      const { rowCount } = await pool.query(`DELETE FROM admin_two_factor_pending WHERE expires_at <= now()`);
      return rowCount ?? 0;
    },

    /** One atomic attempt counter; `expired` means the row vanished mid-guess. */
    async recordFailedAttempt(id: string): Promise<{ attempts: number; expired: boolean }> {
      const { rows } = await pool.query(
        `UPDATE admin_two_factor_pending SET attempts = attempts + 1
         WHERE id = $1 AND expires_at > now() RETURNING attempts`,
        [id]
      );
      return rows[0]
        ? { attempts: Number(rows[0].attempts), expired: false }
        : { attempts: SECOND_FACTOR_MAX_ATTEMPTS, expired: true };
    },

    /** COALESCE keeps the first secret: a retry must not change what was shown. */
    async ensureEnrollment(id: string, freshEnvelope: string): Promise<string> {
      const { rows } = await pool.query(
        `UPDATE admin_two_factor_pending
         SET enrollment_ciphertext = COALESCE(enrollment_ciphertext, $2)
         WHERE id = $1 AND expires_at > now()
         RETURNING enrollment_ciphertext`,
        [id, freshEnvelope]
      );
      const envelope = rows[0]?.enrollment_ciphertext as string | undefined;
      if (!envelope) throw new Error("Pending login expired.");
      return envelope;
    },

    async credential(discordUserId: string): Promise<{ secretCiphertext: string; lastCounter: number | null } | null> {
      const { rows } = await pool.query(
        `SELECT secret_ciphertext, last_counter FROM admin_two_factor WHERE discord_user_id = $1`,
        [discordUserId]
      );
      if (!rows[0]) return null;
      return {
        secretCiphertext: rows[0].secret_ciphertext as string,
        lastCounter: rows[0].last_counter === null ? null : Number(rows[0].last_counter)
      };
    },

    /**
     * Confirms enrolment in one transaction. Returns false when another
     * verified request already enrolled the account (a benign race), never
     * overwrites an existing TOTP secret, and never leaves half a set of
     * recovery codes behind.
     */
    async confirmEnrollment(input: {
      discordUserId: string;
      secretCiphertext: string;
      recoveryHashes: readonly string[];
      lastCounter: number | null;
    }): Promise<boolean> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const inserted = await client.query(
          `INSERT INTO admin_two_factor (discord_user_id, secret_ciphertext, last_counter)
           VALUES ($1, $2, $3) ON CONFLICT (discord_user_id) DO NOTHING`,
          [input.discordUserId, input.secretCiphertext, input.lastCounter]
        );
        if ((inserted.rowCount ?? 0) === 0) {
          await client.query("ROLLBACK");
          return false;
        }
        for (const hash of input.recoveryHashes) {
          await client.query(
            `INSERT INTO admin_two_factor_recovery (code_hash, discord_user_id)
             VALUES ($1, $2) ON CONFLICT (code_hash) DO NOTHING`,
            [hash, input.discordUserId]
          );
        }
        await client.query("COMMIT");
        return true;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    /** A TOTP code is accepted once: only a strictly newer counter wins. */
    async consumeTotpCounter(discordUserId: string, counter: number): Promise<boolean> {
      const { rowCount } = await pool.query(
        `UPDATE admin_two_factor SET last_counter = $2, updated_at = now()
         WHERE discord_user_id = $1 AND (last_counter IS NULL OR last_counter < $2)`,
        [discordUserId, counter]
      );
      return (rowCount ?? 0) > 0;
    },

    /** DELETE ... RETURNING makes one recovery code impossible to spend twice. */
    async consumeRecoveryCode(discordUserId: string, hash: string): Promise<boolean> {
      const { rowCount } = await pool.query(
        `DELETE FROM admin_two_factor_recovery WHERE code_hash = $1 AND discord_user_id = $2`,
        [hash, discordUserId]
      );
      return (rowCount ?? 0) > 0;
    },

    /* ---------------------------------------------------------------- *
     * Account settings: status, authenticator replacement, recovery
     * codes and disabling. These are a different flow from a login: the
     * operator already has a session, and the route re-verifies a current
     * code before anything is replaced.
     * ---------------------------------------------------------------- */

    async status(discordUserId: string): Promise<{
      enrolled: boolean;
      confirmedAt: string | null;
      recoveryCodesRemaining: number;
    }> {
      const { rows } = await pool.query<{ confirmed_at: Date }>(
        `SELECT confirmed_at FROM admin_two_factor WHERE discord_user_id = $1`,
        [discordUserId]
      );
      if (!rows[0]) return { enrolled: false, confirmedAt: null, recoveryCodesRemaining: 0 };
      const { rows: counts } = await pool.query<{ remaining: string }>(
        `SELECT count(*)::text AS remaining FROM admin_two_factor_recovery WHERE discord_user_id = $1`,
        [discordUserId]
      );
      return {
        enrolled: true,
        confirmedAt: rows[0].confirmed_at.toISOString(),
        recoveryCodesRemaining: Number(counts[0]?.remaining ?? 0)
      };
    },

    /** A new authenticator's material, replacing any earlier unfinished change. */
    async beginSetup(discordUserId: string, envelope: string, expiresAt: Date): Promise<void> {
      await pool.query(
        `INSERT INTO admin_two_factor_setup (discord_user_id, enrollment_ciphertext, expires_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (discord_user_id)
         DO UPDATE SET enrollment_ciphertext = EXCLUDED.enrollment_ciphertext, expires_at = EXCLUDED.expires_at`,
        [discordUserId, envelope, expiresAt]
      );
    },

    async getSetup(discordUserId: string): Promise<{ envelope: string; expiresAt: Date } | null> {
      const { rows } = await pool.query<{ enrollment_ciphertext: string; expires_at: Date }>(
        `SELECT enrollment_ciphertext, expires_at FROM admin_two_factor_setup
         WHERE discord_user_id = $1 AND expires_at > now()`,
        [discordUserId]
      );
      return rows[0]
        ? { envelope: rows[0].enrollment_ciphertext, expiresAt: rows[0].expires_at }
        : null;
    },

    async deleteSetup(discordUserId: string): Promise<void> {
      await pool.query(`DELETE FROM admin_two_factor_setup WHERE discord_user_id = $1`, [discordUserId]);
    },

    /**
     * Replaces the authenticator and the whole recovery-code set atomically.
     * The old codes are deleted in the same transaction, so a half-applied
     * change cannot leave a key paired with codes nobody can read.
     */
    async confirmSetup(input: {
      discordUserId: string;
      secretCiphertext: string;
      recoveryHashes: readonly string[];
      lastCounter: number | null;
    }): Promise<void> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO admin_two_factor (discord_user_id, secret_ciphertext, last_counter, confirmed_at, updated_at)
           VALUES ($1, $2, $3, now(), now())
           ON CONFLICT (discord_user_id)
           DO UPDATE SET secret_ciphertext = EXCLUDED.secret_ciphertext,
                         last_counter = EXCLUDED.last_counter,
                         confirmed_at = now(),
                         updated_at = now()`,
          [input.discordUserId, input.secretCiphertext, input.lastCounter]
        );
        await client.query(`DELETE FROM admin_two_factor_recovery WHERE discord_user_id = $1`, [
          input.discordUserId
        ]);
        for (const hash of input.recoveryHashes) {
          await client.query(
            `INSERT INTO admin_two_factor_recovery (code_hash, discord_user_id)
             VALUES ($1, $2) ON CONFLICT (code_hash) DO NOTHING`,
            [hash, input.discordUserId]
          );
        }
        await client.query(`DELETE FROM admin_two_factor_setup WHERE discord_user_id = $1`, [
          input.discordUserId
        ]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    /** Replaces recovery codes, leaving the existing TOTP secret untouched. */
    async replaceRecoveryCodes(discordUserId: string, hashes: readonly string[]): Promise<void> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(`DELETE FROM admin_two_factor_recovery WHERE discord_user_id = $1`, [
          discordUserId
        ]);
        for (const hash of hashes) {
          await client.query(
            `INSERT INTO admin_two_factor_recovery (code_hash, discord_user_id)
             VALUES ($1, $2) ON CONFLICT (code_hash) DO NOTHING`,
            [hash, discordUserId]
          );
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    /** Removing the credential cascades to its recovery codes. */
    async deleteEnrollment(discordUserId: string): Promise<void> {
      await pool.query(`DELETE FROM admin_two_factor WHERE discord_user_id = $1`, [discordUserId]);
    },

    async purgeExpiredSetups(): Promise<number> {
      const { rowCount } = await pool.query(`DELETE FROM admin_two_factor_setup WHERE expires_at <= now()`);
      return rowCount ?? 0;
    }
  };
}
