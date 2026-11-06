import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  TOTP_PERIOD_SECONDS,
  TOTP_DIGITS,
  TOTP_DRIFT_STEPS,
  RECOVERY_CODE_COUNT,
  base32Encode,
  base32Decode,
  generateTotpSecret,
  totpCodeAt,
  verifyTotpCode,
  buildOtpauthUri,
  generateRecoveryCodes,
  normaliseRecoveryCode,
  hashRecoveryCode,
  constantTimeEqual
} from "../src/two-factor.js";

/**
 * Two-factor authentication is a place where "looks right" is worthless: a
 * wrong truncation, a signed 32-bit shift, or a Math.random secret all produce
 * codes that look plausible and are completely broken. These tests pin the
 * behaviour to RFC 6238's published SHA-1 vectors and to the security
 * properties (replay counter, constant-time compare, keyed recovery hashes)
 * the server actually relies on.
 */

// RFC 6238 Appendix B: the SHA-1 secret is the ASCII bytes of
// "12345678901234567890" (20 bytes). buildOtpauthUri / generateTotpSecret both
// work in base32, so the vector secret is expressed through base32Encode here.
const VECTOR_SECRET = base32Encode(Buffer.from("12345678901234567890", "ascii"));

test("RFC 6238 SHA-1 reference vectors, 8 digits", () => {
  const vectors: ReadonlyArray<readonly [number, string]> = [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"]
  ];
  for (const [seconds, expected] of vectors) {
    assert.equal(
      totpCodeAt(VECTOR_SECRET, seconds * 1000, 8),
      expected,
      `T=${seconds}s must produce ${expected}`
    );
  }
});

test("the default 6-digit code at T=59 is the last 6 digits of the 8-digit value", () => {
  assert.equal(totpCodeAt(VECTOR_SECRET, 59 * 1000), "287082");
  assert.equal(totpCodeAt(VECTOR_SECRET, 59 * 1000, 6), "287082");
  assert.equal(totpCodeAt(VECTOR_SECRET, 59 * 1000, 8).slice(-6), "287082");
});

test("verifyTotpCode accepts the current and +/-1 step codes and returns their counters", () => {
  const secret = generateTotpSecret();
  // Align NOW_MS to a step boundary so counters are exact, predictable integers.
  const NOW_MS = 1_000_000 * TOTP_PERIOD_SECONDS * 1000;
  const center = Math.floor(NOW_MS / 1000 / TOTP_PERIOD_SECONDS);

  const current = totpCodeAt(secret, NOW_MS);
  const past = totpCodeAt(secret, NOW_MS - TOTP_PERIOD_SECONDS * 1000);
  const future = totpCodeAt(secret, NOW_MS + TOTP_PERIOD_SECONDS * 1000);

  assert.equal(verifyTotpCode(secret, current, NOW_MS), center, "current step's counter");
  assert.equal(verifyTotpCode(secret, past, NOW_MS), center - 1, "-1 drift returns the past counter");
  assert.equal(verifyTotpCode(secret, future, NOW_MS), center + 1, "+1 drift returns the future counter");
});

test("verifyTotpCode rejects out-of-range and malformed codes", () => {
  const secret = generateTotpSecret();
  const NOW_MS = 1_000_000 * TOTP_PERIOD_SECONDS * 1000;

  // Two steps out of the +/-1 window: with driftSteps=1 this must be null.
  const twoStepsAgo = totpCodeAt(secret, NOW_MS - 2 * TOTP_PERIOD_SECONDS * 1000);
  assert.equal(verifyTotpCode(secret, twoStepsAgo, NOW_MS), null, "two steps out of range");
  const twoStepsAhead = totpCodeAt(secret, NOW_MS + 2 * TOTP_PERIOD_SECONDS * 1000);
  assert.equal(verifyTotpCode(secret, twoStepsAhead, NOW_MS), null, "two steps ahead is out of range");

  assert.equal(verifyTotpCode(secret, "12345", NOW_MS), null, "a 5-digit code");
  assert.equal(verifyTotpCode(secret, "12a456", NOW_MS), null, "a non-digit code");
  assert.equal(verifyTotpCode(secret, "", NOW_MS), null, "an empty string");
  assert.equal(verifyTotpCode(secret, "1234567", NOW_MS), null, "a 7-digit code");
  assert.equal(verifyTotpCode(secret, " 123456", NOW_MS), null, "leading whitespace");
});

test("verifyTotpCode honours a custom driftSteps window", () => {
  const secret = generateTotpSecret();
  const NOW_MS = 1_000_000 * TOTP_PERIOD_SECONDS * 1000;
  const center = Math.floor(NOW_MS / 1000 / TOTP_PERIOD_SECONDS);
  const twoStepsAhead = totpCodeAt(secret, NOW_MS + 2 * TOTP_PERIOD_SECONDS * 1000);

  assert.equal(verifyTotpCode(secret, twoStepsAhead, NOW_MS), null, "rejected by the default drift");
  assert.equal(
    verifyTotpCode(secret, twoStepsAhead, NOW_MS, { driftSteps: 2 }),
    center + 2,
    "accepted when drift is widened to 2"
  );
  assert.equal(TOTP_DRIFT_STEPS, 1, "the default drift stays at one step");
});

test("the returned counter increases with time and works as a replay guard", () => {
  const secret = generateTotpSecret();
  const NOW_MS = 1_000_000 * TOTP_PERIOD_SECONDS * 1000;

  const first = verifyTotpCode(secret, totpCodeAt(secret, NOW_MS), NOW_MS);
  const second = verifyTotpCode(secret, totpCodeAt(secret, NOW_MS), NOW_MS);
  assert.equal(first, second, "two calls at the same instant agree");
  assert.ok(first !== null && first >= 0, "the counter is a non-negative integer");

  const LATER_MS = NOW_MS + TOTP_PERIOD_SECONDS * 1000;
  const later = verifyTotpCode(secret, totpCodeAt(secret, LATER_MS), LATER_MS);
  assert.ok(later !== null && first !== null && later > first, "a later step yields a strictly larger counter");

  // Replay: re-submitting the older (valid) code must report the OLD counter,
  // which the server compares against its last accepted counter and rejects.
  const replayOld = verifyTotpCode(secret, totpCodeAt(secret, NOW_MS), LATER_MS);
  assert.ok(replayOld !== null && later !== null && replayOld <= later, "an old code reports a non-increasing counter");
});

test("base32 encode/decode round-trips random buffers of many lengths", () => {
  for (let length = 0; length <= 64; length += 1) {
    const bytes = randomBytes(length);
    const encoded = base32Encode(bytes);
    // No padding, uppercase only.
    assert.match(encoded, /^[A-Z2-7]*$/, `length ${length} is unpadded uppercase base32`);
    const decoded = base32Decode(encoded);
    assert.equal(
      Buffer.from(decoded).toString("hex"),
      bytes.toString("hex"),
      `length ${length} round-trips exactly`
    );
  }
});

test("base32 encode of a known secret yields the RFC 6238 vector secret", () => {
  assert.equal(VECTOR_SECRET, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  assert.equal(Buffer.from(base32Decode(VECTOR_SECRET)).toString("ascii"), "12345678901234567890");
});

test("base32Decode tolerates lowercase and padding but throws on invalid characters", () => {
  const encoded = base32Encode(Buffer.from("hello world", "utf8"));
  assert.equal(Buffer.from(base32Decode(encoded.toLowerCase())).toString("utf8"), "hello world");
  assert.equal(Buffer.from(base32Decode(encoded + "====")).toString("utf8"), "hello world");

  assert.throws(() => base32Decode("GEZD!NBV"), /base32/, "an invalid punctuation character");
  assert.throws(() => base32Decode("GEZD0NBV"), /base32/, "0 is not in the alphabet");
  assert.throws(() => base32Decode("GEZD1NBV"), /base32/, "1 is not in the alphabet");
  assert.throws(() => base32Decode("GEZD8NBV"), /base32/, "8 is not in the alphabet");
  assert.throws(() => base32Decode("GEZD9NBV"), /base32/, "9 is not in the alphabet");
});

test("generateTotpSecret returns a fresh 32-char base32 secret that decodes to 20 bytes", () => {
  const a = generateTotpSecret();
  const b = generateTotpSecret();
  assert.match(a, /^[A-Z2-7]{32}$/, "32 uppercase base32 chars, no padding");
  assert.equal(a.length, 32);
  assert.equal(base32Decode(a).length, 20, "decodes to 160 bits / 20 bytes");
  assert.notEqual(a, b, "two secrets differ (random, not constant)");
});

test("buildOtpauthUri URL-encodes all parts and carries the fixed parameters", () => {
  const secret = generateTotpSecret();
  const uri = buildOtpauthUri({ secret, issuer: "Acme & Co", label: "ada:lovelace@example" });

  assert.ok(uri.startsWith("otpauth://totp/"), "correct scheme and type");
  assert.ok(uri.includes(encodeURIComponent("ada:lovelace@example")), "label is percent-encoded");
  assert.ok(uri.includes(`issuer=${encodeURIComponent("Acme & Co")}`), "issuer is percent-encoded");
  assert.ok(uri.includes(`secret=${encodeURIComponent(secret)}`), "secret is present and encoded");
  assert.ok(uri.includes("secret=" + secret), "secret itself is URL-safe base32");
  assert.ok(uri.includes("algorithm=SHA1"), "SHA1 is declared");
  assert.ok(uri.includes(`digits=${TOTP_DIGITS}`), "digits=6");
  assert.ok(uri.includes(`period=${TOTP_PERIOD_SECONDS}`), "period=30");
  // The raw "@" and the raw "&" of the issuer must not leak into the query.
  assert.ok(!uri.includes("@example"), "the label's @ was encoded");
  assert.ok(!uri.includes("Acme & Co"), "the issuer's & was encoded");
});

test("generateRecoveryCodes: count, format, and uniqueness across a large sample", () => {
  const batch = generateRecoveryCodes();
  assert.equal(batch.length, RECOVERY_CODE_COUNT, "default count is RECOVERY_CODE_COUNT");
  for (const code of batch) {
    assert.match(code, /^[A-Z2-7]{5}-[A-Z2-7]{5}$/, "unambiguous A-Z2-7 alphabet, XXXXX-XXXXX");
  }

  const sample = generateRecoveryCodes(500);
  assert.equal(sample.length, 500, "honours a custom count");
  assert.equal(new Set(sample).size, 500, "no duplicates across a large sample");
  assert.equal(generateRecoveryCodes(0).length, 0, "a zero count yields an empty array");
});

test("normaliseRecoveryCode uppercases and strips everything except A-Z0-9", () => {
  assert.equal(normaliseRecoveryCode("abcde-fghjk"), "ABCDEFGHJK");
  assert.equal(normaliseRecoveryCode(" A B C D E - F G H J K "), "ABCDEFGHJK");
  assert.equal(normaliseRecoveryCode("ABCDEFGHJK"), "ABCDEFGHJK");
  assert.equal(normaliseRecoveryCode("a.b/c_d!e"), "ABCDE");
});

test("hashRecoveryCode is deterministic, key- and code-dependent, and normalises", () => {
  const key = "server-key-A";
  const otherKey = "server-key-B";

  const h1 = hashRecoveryCode("abcde-fghjk", key);
  const h2 = hashRecoveryCode("ABCDEFGHJK", key);
  assert.match(h1, /^[0-9a-f]{64}$/, "lowercase hex SHA-256 HMAC");
  assert.equal(h1, h2, "case and separators normalise to the same hash");

  assert.equal(hashRecoveryCode("ABCDEFGHJK", key), h1, "deterministic for the same code+key");
  assert.notEqual(hashRecoveryCode("ABCDEFGHJK", otherKey), h1, "a different key changes the hash");
  assert.notEqual(hashRecoveryCode("ABCDEFGHJZ", key), h1, "a different code changes the hash");

  // Never returns (or contains) the plaintext code.
  assert.ok(!h1.includes("ABCDEFGHJK"), "the plaintext is not in the hash");
  for (const code of generateRecoveryCodes(50)) {
    const hash = hashRecoveryCode(code, key);
    assert.ok(!hash.includes(normaliseRecoveryCode(code)), "no plaintext in any hash");
    assert.ok(!hash.includes(code), "no formatted plaintext in any hash");
  }
});

test("constantTimeEqual: true/false cases including different lengths", () => {
  assert.equal(constantTimeEqual("secret", "secret"), true);
  assert.equal(constantTimeEqual("", ""), true);
  assert.equal(constantTimeEqual("123456", "123456"), true);
  assert.equal(constantTimeEqual("secret", "secreT"), false);
  assert.equal(constantTimeEqual("123456", "123457"), false);
  assert.equal(constantTimeEqual("short", "much-longer"), false, "different lengths are false, no throw");
  assert.equal(constantTimeEqual("", "x"), false);
  assert.doesNotThrow(() => constantTimeEqual("a", "abcdefgh"), "unequal lengths must not throw");
});
