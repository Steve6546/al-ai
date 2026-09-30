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
import { Client } from "pg";
import { decryptSecret, encryptSecret } from "@al-ai/core";

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

  console.log(`rotate-encryption-key: ${reEncrypted} values re-encrypted, ${undecryptable} skipped.`);
} finally {
  await client.end();
}
