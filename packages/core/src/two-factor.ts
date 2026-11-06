import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * RFC 6238 parameters. Authenticator apps (Google, Microsoft, Authy, ...) assume
 * a 6-digit, 30-second, SHA-1 code by default, so changing any of these would
 * silently break enrolment for every user who scans the QR code. They are kept
 * as named exports so the server, the enrolment UI and the tests agree on one
 * set of numbers.
 */
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
/**
 * One step of drift in each direction absorbs a client clock that is slightly
 * ahead or behind. Wider drift would enlarge the window in which a sniffed code
 * is still usable, so this stays at the smallest useful value.
 */
export const TOTP_DRIFT_STEPS = 1;
export const RECOVERY_CODE_COUNT = 10;

/**
 * RFC 4648 base32 alphabet. It deliberately omits 0, 1, 8 and 9 — exactly the
 * glyphs most often confused when a human reads a code aloud — which is why the
 * same alphabet is reused for recovery codes.
 */
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567" as const;
const RECOVERY_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567" as const;
/**
 * Domain separation: a recovery-code hash must never be interchangeable with an
 * HMAC produced for some other purpose (sessions, layer signatures) using the
 * same server key. The fixed prefix is part of the signed message.
 */
const RECOVERY_HASH_DOMAIN = "al-ai:recovery-code:v1:" as const;

/**
 * Encodes bytes as unpadded, uppercase RFC 4648 base32.
 *
 * WHY an arithmetic bit accumulator instead of `<<` / `>>>`: JS bitwise
 * operators coerce operands to signed 32-bit integers, so a buffer that ever
 * holds 32 or more un-emitted bits would have its high bits silently corrupted.
 * A small integer accumulator plus its bit count, combined with multiplication
 * and division by powers of two, stays exact for any input length.
 */
export function base32Encode(input: Uint8Array): string {
  let acc = 0;
  let accBits = 0;
  let output = "";
  for (const byte of input) {
    acc = acc * 256 + byte;
    accBits += 8;
    while (accBits >= 5) {
      accBits -= 5;
      const index = Math.floor(acc / Math.pow(2, accBits)) % 32;
      output += BASE32_ALPHABET[index];
      acc = acc % Math.pow(2, accBits);
    }
  }
  if (accBits > 0) {
    // Zero-fill the remaining low bits so the last symbol is canonical.
    const index = (acc * Math.pow(2, 5 - accBits)) % 32;
    output += BASE32_ALPHABET[index];
  }
  return output;
}

/**
 * Decodes RFC 4648 base32. Lowercase input and trailing `=` padding are
 * tolerated because secrets get retyped by hand and copy-pasted from QR codes.
 * Any other character (including 0/1/8/9, which are not in the alphabet) is a
 * hard error: a truncated or mistyped secret must never be accepted as valid.
 */
export function base32Decode(text: string): Uint8Array {
  const clean = text.toUpperCase().replace(/=+$/, "");
  let acc = 0;
  let accBits = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) throw new Error("Invalid base32 character.");
    acc = acc * 32 + index;
    accBits += 5;
    while (accBits >= 8) {
      accBits -= 8;
      bytes.push(Math.floor(acc / Math.pow(2, accBits)) % 256);
      acc = acc % Math.pow(2, accBits);
    }
  }
  return Uint8Array.from(bytes);
}

/** A fresh 160-bit (20 byte) random secret, base32-encoded into 32 chars. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** RFC 6238 time-step counter: floor(Unix seconds / period). */
function counterAt(timeMs: number, periodSeconds: number): number {
  return Math.floor(timeMs / 1000 / periodSeconds);
}

/**
 * RFC 6238 HOTP/TOTP dynamic truncation for a single time-step counter.
 *
 * WHY arithmetic instead of `<<`: the 31-bit value can set bit 30, which a JS
 * left-shift would interpret as a negative signed 32-bit integer. Multiplying
 * by exact powers of two keeps the intermediate a non-negative, exact double,
 * so the result is correct for every possible truncation offset (0..15).
 */
function totpCodeForCounter(key: Buffer, counter: number, digits: number): string {
  const counterBytes = Buffer.alloc(8);
  counterBytes.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", key).update(counterBytes).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const binary =
    (mac[offset] & 0x7f) * 0x1000000 +
    (mac[offset + 1] & 0xff) * 0x10000 +
    (mac[offset + 2] & 0xff) * 0x100 +
    (mac[offset + 3] & 0xff);
  const otp = binary % Math.pow(10, digits);
  return String(otp).padStart(digits, "0");
}

/** The TOTP code at a given instant for a base32 secret. */
export function totpCodeAt(
  secret: string,
  timeMs: number,
  digits: number = TOTP_DIGITS,
  periodSeconds: number = TOTP_PERIOD_SECONDS
): string {
  const key = Buffer.from(base32Decode(secret));
  return totpCodeForCounter(key, counterAt(timeMs, periodSeconds), digits);
}

/**
 * Verifies a code within +/- `driftSteps` of the current time-step and returns
 * the accepted time-step COUNTER, or null on failure.
 *
 * The counter (not a boolean) is the return value on purpose: the caller stores
 * it and rejects any code whose counter is <= the last accepted one, which is
 * what turns a valid-but-old code into a detected replay instead of a login.
 * Malformed input is rejected without throwing, and comparison is constant-time.
 */
export function verifyTotpCode(
  secret: string,
  code: string,
  nowMs: number,
  options: { digits?: number; periodSeconds?: number; driftSteps?: number } = {}
): number | null {
  const digits = options.digits ?? TOTP_DIGITS;
  const periodSeconds = options.periodSeconds ?? TOTP_PERIOD_SECONDS;
  const driftSteps = options.driftSteps ?? TOTP_DRIFT_STEPS;

  // Wrong length or a non-digit is user error. Reject it before decoding the
  // secret or touching crypto, so the caller never has to catch for garbage.
  if (code.length !== digits || !/^[0-9]+$/.test(code)) return null;

  const key = Buffer.from(base32Decode(secret));
  const center = counterAt(nowMs, periodSeconds);
  for (let step = -driftSteps; step <= driftSteps; step += 1) {
    const candidate = center + step;
    // A step before the Unix epoch has no valid 8-byte big-endian counter.
    if (candidate < 0) continue;
    const expected = totpCodeForCounter(key, candidate, digits);
    if (constantTimeEqual(expected, code)) return candidate;
  }
  return null;
}

/**
 * Builds an otpauth:// URI. Every caller-supplied part is percent-encoded so a
 * label containing spaces, a colon or an `&` cannot inject extra query params
 * into the enrolment URL.
 */
export function buildOtpauthUri(input: { secret: string; issuer: string; label: string }): string {
  const query = [
    `secret=${encodeURIComponent(input.secret)}`,
    `issuer=${encodeURIComponent(input.issuer)}`,
    "algorithm=SHA1",
    `digits=${TOTP_DIGITS}`,
    `period=${TOTP_PERIOD_SECONDS}`
  ].join("&");
  return `otpauth://totp/${encodeURIComponent(input.label)}?${query}`;
}

/**
 * Generates `count` single-use recovery codes, each 10 symbols from the
 * unambiguous A-Z2-7 alphabet formatted as "XXXXX-XXXXX".
 *
 * WHY `randomBytes` and `& 31`: each cryptographically random byte maps to one
 * of 32 symbols with no modulo bias (256 is an exact multiple of 32), giving
 * 50 bits of entropy per code. Math.random would be predictable. A Set
 * guarantees the batch itself contains no duplicates.
 */
export function generateRecoveryCodes(count: number = RECOVERY_CODE_COUNT): string[] {
  const total = Math.max(0, Math.floor(count));
  const codes = new Set<string>();
  while (codes.size < total) {
    const bytes = randomBytes(10);
    let chars = "";
    for (let index = 0; index < 10; index += 1) {
      chars += RECOVERY_ALPHABET[bytes[index] & 31];
    }
    codes.add(`${chars.slice(0, 5)}-${chars.slice(5)}`);
  }
  return [...codes];
}

/** Uppercase and strip everything that is not A-Z or 0-9. */
export function normaliseRecoveryCode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Deterministic, key-dependent HMAC-SHA256 of a recovery code, as lowercase hex.
 * Domain-separated by a fixed prefix and normalised internally, so a code typed
 * with different case or separators hashes identically while a different server
 * key yields a different hash (key rotation invalidates stored hashes safely).
 */
export function hashRecoveryCode(code: string, key: string): string {
  return createHmac("sha256", key)
    .update(RECOVERY_HASH_DOMAIN + normaliseRecoveryCode(code))
    .digest("hex");
}

/**
 * Constant-time string comparison. timingSafeEqual throws on unequal-length
 * buffers, so differing lengths are short-circuited to false (never an
 * exception); equal-length inputs are always compared with timingSafeEqual.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
