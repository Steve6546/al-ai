import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { encryptSecret, hashRecoveryCode, DISCORD_PERMISSION_BITS, SESSION_COOKIE_NAME } from "@al-ai/core";
import {
  SECOND_FACTOR_COOKIE_NAME,
  SECOND_FACTOR_MAX_ATTEMPTS,
  SECOND_FACTOR_PENDING_SECONDS,
  attemptsRemaining,
  clearedPendingCookieHeader,
  decodeEnrollment,
  encodeEnrollment,
  enrolledView,
  enrollmentView,
  isTotpShaped,
  matchPendingRecoveryCode,
  newEnrollmentPayload,
  pendingCookieHeader,
  recoveryCodeHash,
  requiresSecondFactor
} from "../server/two-factor.js";
import type { BffEnv } from "../server/env.js";

/**
 * The server half of the second factor, pinned without a database.
 *
 * These are the decisions that a UI test cannot see: who is an admin, what a
 * six-digit code is, how many guesses a stolen pending cookie buys, and
 * whether the enrolment answer can ever carry a secret into an enrolled
 * login. The live routes are exercised separately by `npm run check:2fa`.
 */

const KEY = "a".repeat(64);
const USER = "1111111111111111111";
const OTHER = "2222222222222222222";

const guild = (permissions: bigint, owner = false) => ({ owner, permissions });

test("the platform owner always needs the second factor", () => {
  assert.equal(requiresSecondFactor({ ownerId: USER, discordUserId: USER, guilds: [] }), true);
  assert.equal(requiresSecondFactor({ ownerId: OTHER, discordUserId: USER, guilds: [] }), false);
});

test("a guild owner or an administrator needs it; a plain member does not", () => {
  assert.equal(requiresSecondFactor({ ownerId: null, discordUserId: USER, guilds: [guild(0n, true)] }), true);
  assert.equal(requiresSecondFactor({ ownerId: null, discordUserId: USER, guilds: [guild(DISCORD_PERMISSION_BITS.MANAGE_GUILD)] }), true);
  // Administrator supersedes every other bit: hasPermission() checks it first.
  assert.equal(requiresSecondFactor({ ownerId: null, discordUserId: USER, guilds: [guild(DISCORD_PERMISSION_BITS.ADMINISTRATOR)] }), true);
  assert.equal(requiresSecondFactor({ ownerId: null, discordUserId: USER, guilds: [guild(0n)] }), false);
  assert.equal(requiresSecondFactor({ ownerId: null, discordUserId: USER, guilds: [guild(0n), guild(0n, true)] }), true);
});

test("an unreadable Discord guild list fails closed instead of skipping the check", () => {
  assert.equal(requiresSecondFactor({ ownerId: null, discordUserId: USER, guilds: null }), true);
  assert.equal(requiresSecondFactor({ ownerId: OTHER, discordUserId: USER, guilds: null }), true);
});

test("only an exact six-digit string is a TOTP; anything else is a recovery code", () => {
  assert.equal(isTotpShaped("123456"), true);
  for (const value of ["", "12345", "1234567", "12a456", " 123456", "١٢٣٤٥٦"]) {
    assert.equal(isTotpShaped(value), false, value);
  }
});

test("a wrong code leaves a bounded number of guesses, then none", () => {
  assert.equal(attemptsRemaining(0), SECOND_FACTOR_MAX_ATTEMPTS);
  assert.equal(attemptsRemaining(SECOND_FACTOR_MAX_ATTEMPTS - 1), 1);
  assert.equal(attemptsRemaining(SECOND_FACTOR_MAX_ATTEMPTS), 0);
  assert.equal(attemptsRemaining(99), 0);
});

test("enrolment material round-trips as an envelope that never contains plaintext", () => {
  const payload = newEnrollmentPayload();
  assert.equal(payload.recoveryCodes.length, 10);
  const envelope = encodeEnrollment(payload, KEY);
  assert.ok(!envelope.includes(payload.secret), "the TOTP secret is not in the ciphertext");
  for (const code of payload.recoveryCodes) {
    assert.ok(!envelope.includes(code), "no recovery code is in the ciphertext");
  }
  assert.deepEqual(decodeEnrollment(envelope, KEY), payload);
  assert.throws(() => decodeEnrollment(envelope, "b".repeat(64)), /.*/, "a different key cannot read it");
  assert.throws(() => decodeEnrollment(encryptSecret("{}", KEY), KEY), /Malformed enrolment/);
});

test("the enrolment answer shows the secret once; the enrolled answer never does", () => {
  const payload = newEnrollmentPayload();
  const deadline = "2026-11-05T00:00:00.000Z";
  const first = enrollmentView(payload, "AL AI:ada:lovelace@example", deadline);
  assert.equal(first.enrolled, false);
  assert.equal(first.secret, payload.secret);
  assert.deepEqual(first.recoveryCodes, payload.recoveryCodes);
  assert.equal(first.expiresAt, deadline);
  assert.ok(first.otpauthUri.startsWith("otpauth://totp/"));
  assert.ok(first.otpauthUri.includes(encodeURIComponent("AL AI:ada:lovelace@example")), "the label is percent-encoded");

  const later = enrolledView(deadline);
  assert.equal(later.enrolled, true);
  assert.equal(later.secret, null);
  assert.equal(later.otpauthUri, null);
  assert.deepEqual(later.recoveryCodes, []);
  assert.equal(later.expiresAt, deadline, "the countdown still works for an enrolled admin");
});

test("a recovery code matches only with case/separator normalisation", () => {
  const codes = ["ABCDE-FGHJK", "MNOPQ-RSTUV"];
  assert.equal(matchPendingRecoveryCode("abcde-fghjk", codes), "ABCDE-FGHJK");
  assert.equal(matchPendingRecoveryCode(" ABCDE FGHJK ", codes), "ABCDE-FGHJK");
  assert.equal(matchPendingRecoveryCode("ABCDEFGHJK", codes), "ABCDE-FGHJK");
  assert.equal(matchPendingRecoveryCode("ZZZZZ-ZZZZZ", codes), null);
  assert.equal(matchPendingRecoveryCode("", codes), null);
  assert.equal(matchPendingRecoveryCode("---", codes), null);
});

test("recovery hashes are keyed by SESSION_SECRET and contain no plaintext", () => {
  const env = { sessionSecret: "server-key-A" } as unknown as BffEnv;
  const other = { sessionSecret: "server-key-B" } as unknown as BffEnv;
  const hash = recoveryCodeHash("ABCDE-FGHJK", env);
  assert.equal(hash, hashRecoveryCode("ABCDE-FGHJK", "server-key-A"));
  assert.notEqual(hash, recoveryCodeHash("ABCDE-FGHJK", other));
  assert.ok(!hash.includes("ABCDEFGHJK"));
});

test("the pending cookie is a separate, short-lived, httpOnly cookie", () => {
  assert.notEqual(SECOND_FACTOR_COOKIE_NAME, SESSION_COOKIE_NAME);
  assert.ok(SECOND_FACTOR_COOKIE_NAME.endsWith("_2fa"));
  const issued = pendingCookieHeader("00000000-0000-4000-8000-000000000000");
  for (const attribute of ["HttpOnly", "Path=/", "SameSite=Lax", `Max-Age=${SECOND_FACTOR_PENDING_SECONDS}`]) {
    assert.ok(issued.includes(attribute), issued);
  }
  assert.ok(clearedPendingCookieHeader().includes("Max-Age=0"));
});

/** A drift guard: the login gate must stay ahead of the session it protects. */
test("the OAuth callback decides the second factor before it mints a session", () => {
  const source = readFileSync(resolve(import.meta.dirname, "../server/index.ts"), "utf8");
  const callback = source.slice(
    source.indexOf('app.get("/auth/discord/callback"'),
    source.indexOf('app.post("/auth/logout"')
  );
  assert.ok(callback.includes("requiresSecondFactor("), "the callback asks who needs 2FA");
  assert.ok(callback.includes('"/?auth=2fa_required"'), "an admin is redirected to the pending login");
  assert.ok(callback.includes("issueSession(db, env"), "a non-admin still gets a normal session");
  assert.ok(
    callback.indexOf("requiresSecondFactor(") < callback.indexOf("issueSession(db, env"),
    "the verdict is computed before any session is issued"
  );

  const verify = source.slice(
    source.indexOf('app.post("/api/2fa/verify"'),
    source.indexOf('app.post("/api/2fa/cancel"')
  );
  for (const marker of ["consumeTotpCounter", "consumeRecoveryCode", "issueSession(db, env", "sessionCookieHeader(id)"]) {
    assert.ok(verify.includes(marker), `${marker} is part of a successful verification`);
  }
  assert.ok(
    verify.indexOf("issueSession(db, env") > verify.indexOf("consumeTotpCounter"),
    "a session is minted only after a code was consumed"
  );

  const sessionRoute = source.slice(source.indexOf('app.get("/api/session"'), source.indexOf('app.get("/api/network"'));
  assert.ok(sessionRoute.includes("secondFactor"), "/api/session announces a pending admin login");
});
