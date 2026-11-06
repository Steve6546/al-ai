/**
 * Re-encrypts every stored ciphertext under a NEW ENCRYPTION_KEY, so the key
 * can actually be rotated without orphaning data.
 *
 * Two constraints shape this script:
 *
 * - **The audit trail is append-only by trigger.** A re-encryption is a bulk
 *   UPDATE, so the run must connect as the OWNER and set
 *   `session_replication_role = replica` — the sanctioned maintenance path.
 *   The application role stays blocked; this script is run by hand.
 * - **Each row commits on its own.** One bad row must not abort a wrapping
 *   transaction and silently roll back the whole run (that exact failure
 *   shipped first: per-row catches kept going inside a doomed transaction and
 *   the final COMMIT restored every row it reported as done).
 *
 *   DATABASE_URL=<owner url> ENCRYPTION_KEY_OLD=<64 hex> ENCRYPTION_KEY_NEW=<64 hex> \
 *     npx tsx scripts/rotate-encryption-key.mts
 *
 * Never prints a plaintext value or a ciphertext. Run while the services are
 * STOPPED, then update ENCRYPTION_KEY in .env and start them.
 */
import { createRequire } from "node:module";
import { decryptSecret, encryptSecret } from "@al-ai/core";

// `pg` belongs to the dashboard workspace, which declares it. Borrowing that
// copy keeps the root package from depending on a driver it never declares -
// and keeps this script on the same driver version the services use.
const require = createRequire(new URL("../apps/dashboard/package.json", import.meta.url));
const { Client } = require("pg") as typeof import("pg");

// Trim is load-bearing: .env values extracted through shell tools can carry a
// trailing \r from CRLF line endings, and a 65-character "64 hex" key fails
// every decrypt while looking identical in logs.
const oldKey = (process.env.ENCRYPTION_KEY_OLD ?? "").trim();
const newKey = (process.env.ENCRYPTION_KEY_NEW ?? "").trim();
if (!/^[0-9a-f]{64}$/i.test(oldKey) || !/^[0-9a-f]{64}$/i.test(newKey)) {
  console.error("rotate-encryption-key: both ENCRYPTION_KEY_OLD and ENCRYPTION_KEY_NEW must be 64 hex chars.");
  process.exit(1);
}
if (oldKey === newKey) {
  console.error("rotate-encryption-key: the two keys are identical; nothing to do.");
  process.exit(1);
}
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("rotate-encryption-key: DATABASE_URL (the owner connection) is not set.");
  process.exit(1);
}

const client = new Client({ connectionString: databaseUrl });
await client.connect();

let reEncrypted = 0;
let undecryptable = 0;

try {
  // Owner-only maintenance window: row triggers on the append-only trail are
  // suspended for THIS connection so the re-encryption UPDATEs can pass. The
  // application role cannot set this parameter (verified by test).
  await client.query("SET session_replication_role = replica");
} catch (error) {
  console.error(
    "rotate-encryption-key: could not open the maintenance window — connect as the table owner.",
    error instanceof Error ? error.message : error
  );
  process.exit(1);
}

/** One row, one transaction: a failure aborts only itself. */

try {
  // OAuth tokens.
  const sessions = await client.query<{ id: string; access_token_ciphertext: string; refresh_token_ciphertext: string | null }>(
    `SELECT id, access_token_ciphertext, refresh_token_ciphertext FROM oauth_sessions`
  );
  for (const row of sessions.rows) {
    try {
      const access = decryptSecret(row.access_token_ciphertext, oldKey);
      const refresh = row.refresh_token_ciphertext ? decryptSecret(row.refresh_token_ciphertext, oldKey) : null;
      const encryptedAccess = encryptSecret(access, newKey);
      const encryptedRefresh = refresh ? encryptSecret(refresh, newKey) : null;
      await client.query(`UPDATE oauth_sessions SET access_token_ciphertext = $1, refresh_token_ciphertext = $2 WHERE id = $3`, [
        encryptedAccess,
        encryptedRefresh,
        row.id
      ]);
      reEncrypted += 1;
    } catch (error) {
      undecryptable += 1;
      console.log(`oauth_sessions row ${row.id}: skipped — ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  console.log(`oauth_sessions: done.`);

  // Audit payloads: append-only, so an unreadable row is left untouched and
  // will render as "unavailable" in the UI — its integrity record remains.
  const audits = await client.query<{ id: string; payload_ciphertext: string }>(
    `SELECT id, payload_ciphertext FROM audit_trail`
  );
  let auditDone = 0;
  for (const row of audits.rows) {
    try {
      const payload = JSON.stringify(decryptSecret(row.payload_ciphertext, oldKey));
      const encrypted = encryptSecret(payload, newKey);
      await client.query(`UPDATE audit_trail SET payload_ciphertext = $1 WHERE id = $2`, [encrypted, row.id]);
      auditDone += 1;
      reEncrypted += 1;
    } catch (error) {
      undecryptable += 1;
      console.log(`audit_trail row ${row.id}: skipped — ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  console.log(`audit_trail: ${auditDone}/${audits.rows.length} payloads re-encrypted.`);

  /**
   * Admin second factor. The confirmed TOTP secret is a ciphertext like any
   * other; a pending login carries two (its OAuth token and, until enrolment is
   * confirmed, the secret + recovery codes shown once). Recovery-code HMACs in
   * `admin_two_factor_recovery` are NOT ciphertext: they are keyed by
   * SESSION_SECRET, so rotating that secret invalidates outstanding recovery
   * codes while the TOTP secret below keeps working.
   *
   * The tables are guarded by to_regclass so this script still runs against a
   * database created before the second factor shipped.
   */
  const hasTwoFactor = await client.query<{ ok: boolean }>(
    `SELECT to_regclass('public.admin_two_factor') IS NOT NULL AS ok`
  );
  if (hasTwoFactor.rows[0]?.ok) {
    const factors = await client.query<{ discord_user_id: string; secret_ciphertext: string }>(
      `SELECT discord_user_id, secret_ciphertext FROM admin_two_factor`
    );
    for (const row of factors.rows) {
      try {
        const secret = decryptSecret(row.secret_ciphertext, oldKey);
        await client.query(`UPDATE admin_two_factor SET secret_ciphertext = $1 WHERE discord_user_id = $2`, [
          encryptSecret(secret, newKey),
          row.discord_user_id
        ]);
        reEncrypted += 1;
      } catch (error) {
        undecryptable += 1;
        console.log(`admin_two_factor row ${row.discord_user_id}: skipped — ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    console.log(`admin_two_factor: done.`);

    const pendings = await client.query<{
      id: string;
      access_token_ciphertext: string;
      enrollment_ciphertext: string | null;
    }>(`SELECT id, access_token_ciphertext, enrollment_ciphertext FROM admin_two_factor_pending`);
    for (const row of pendings.rows) {
      try {
        const token = decryptSecret(row.access_token_ciphertext, oldKey);
        const enrollment = row.enrollment_ciphertext ? decryptSecret(row.enrollment_ciphertext, oldKey) : null;
        await client.query(
          `UPDATE admin_two_factor_pending SET access_token_ciphertext = $1, enrollment_ciphertext = $2 WHERE id = $3`,
          [encryptSecret(token, newKey), enrollment ? encryptSecret(enrollment, newKey) : null, row.id]
        );
        reEncrypted += 1;
      } catch {
        // An unreadable pending login is not worth keeping: it is a five-minute
        // window, and the operator simply signs in again.
        undecryptable += 1;
        await client.query(`DELETE FROM admin_two_factor_pending WHERE id = $1`, [row.id]);
        console.log(`admin_two_factor_pending row ${row.id}: deleted — could not be re-encrypted.`);
      }
    }
    console.log(`admin_two_factor_pending: done.`);

    // A setup row started from the account settings screen. It is short-lived
    // (ten minutes) but still holds a secret, so rotate it rather than leaving
    // a change that would fail to confirm after the key changed.
    const hasSetups = await client.query<{ ok: boolean }>(
      `SELECT to_regclass('public.admin_two_factor_setup') IS NOT NULL AS ok`
    );
    if (hasSetups.rows[0]?.ok) {
      const setups = await client.query<{ discord_user_id: string; enrollment_ciphertext: string }>(
        `SELECT discord_user_id, enrollment_ciphertext FROM admin_two_factor_setup`
      );
      for (const row of setups.rows) {
        try {
          const enrollment = decryptSecret(row.enrollment_ciphertext, oldKey);
          await client.query(
            `UPDATE admin_two_factor_setup SET enrollment_ciphertext = $1 WHERE discord_user_id = $2`,
            [encryptSecret(enrollment, newKey), row.discord_user_id]
          );
          reEncrypted += 1;
        } catch {
          undecryptable += 1;
          await client.query(`DELETE FROM admin_two_factor_setup WHERE discord_user_id = $1`, [
            row.discord_user_id
          ]);
          console.log(`admin_two_factor_setup row ${row.discord_user_id}: deleted — could not be re-encrypted.`);
        }
      }
      console.log(`admin_two_factor_setup: done.`);
    }
  }

  console.log(`rotate-encryption-key: ${reEncrypted} values re-encrypted, ${undecryptable} skipped.`);
} finally {
  await client.end();
}
