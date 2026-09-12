/**
 * GOVERNANCE rule 7 — the audit trail is append-only, and the attempt to break
 * that is itself the security event.
 *
 * The guarantee lives in the database (triggers reject UPDATE, DELETE and
 * TRUNCATE). This module exists so the bot can tell the difference between
 * "the write failed because the database is down" and "the write failed because
 * someone tried to rewrite history" — the second one is `security.audit-tamper`.
 */

/** Marker raised by `al_ai_audit_is_append_only()` in infra/schema.sql. */
export const APPEND_ONLY_MARKER = "is append-only";

export function isAppendOnlyViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.includes(APPEND_ONLY_MARKER);
}

export type AuditWriteOutcome =
  | { ok: true }
  | { ok: false; tamper: true; attempt: string }
  | { ok: false; tamper: false; error: unknown };

/**
 * Runs an audit write and classifies the failure.
 * A rejected mutation is never swallowed: it is returned as a tamper outcome so
 * the caller can raise `security.audit-tamper`.
 */
export async function guardAuditWrite(write: () => Promise<unknown>): Promise<AuditWriteOutcome> {
  try {
    await write();
    return { ok: true };
  } catch (error) {
    if (isAppendOnlyViolation(error)) {
      return { ok: false, tamper: true, attempt: String(error instanceof Error ? error.message : error) };
    }
    return { ok: false, tamper: false, error };
  }
}

/** Raised when the audit trail has been touched by something other than an append. */
export class AuditTamperError extends Error {
  constructor(public readonly attempt: string) {
    super(`audit_trail was tampered with: ${attempt}`);
    this.name = "AuditTamperError";
  }
}
