import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

export type SignedEvent = { correlationId: string; timestampUTC: string; actorHash: string; sourceLayer: string };

/** Maximum accepted clock skew for any inter-layer signed request. */
export const LAYER_SIGNATURE_TTL_MS = 5 * 60 * 1000;

export function signActor(actorId: string, secret: string) {
  return createHmac("sha256", secret).update(actorId).digest("hex");
}

export function signedEvent(actorId: string, secret: string, sourceLayer: string): SignedEvent {
  return { correlationId: randomUUID(), timestampUTC: new Date().toISOString(), actorHash: signActor(actorId, secret), sourceLayer };
}

export function verifyHmac(payload: string, signature: string, secret: string) {
  const expected = createHmac("sha256", secret).update(payload).digest("hex");
  return safeEqual(signature, expected);
}

export function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function encryptionKey(keyHex: string) {
  const key = Buffer.from(keyHex, "hex");
  if (key.length !== 32) throw new Error("ENCRYPTION_KEY must be 32 bytes of hex (64 characters).");
  return key;
}

/**
 * AES-256-GCM envelope. Output format: v1.<iv>.<authTag>.<ciphertext>, all base64.
 * Used for OAuth tokens at rest and for audit-trail payloads.
 */
export function encryptSecret(plaintext: string, keyHex: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(keyHex), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), ciphertext.toString("base64")].join(".");
}

export function decryptSecret(envelope: string, keyHex: string) {
  const [version, iv, tag, ciphertext] = envelope.split(".");
  if (version !== "v1" || !iv || !tag || !ciphertext) throw new Error("Malformed secret envelope.");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(keyHex), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]).toString("utf8");
}

/** Single-use nonce. Uniqueness is enforced by the security_nonces table. */
export function newNonce() {
  return randomBytes(24).toString("base64url");
}

export function layerSignature(nonce: string, timestamp: string, body: string, secret: string) {
  return createHmac("sha256", secret).update(`${nonce}.${timestamp}.${body}`).digest("hex");
}

export type LayerRequest = { nonce: string; timestamp: string; signature: string; body: string };

/**
 * Verifies a request that travelled between AL AI layers.
 * Rejects unknown nonces, expired timestamps, and tampered bodies.
 * The caller owns nonce consumption so replay protection stays auditable.
 */
export function verifyLayerRequest(
  request: LayerRequest,
  secret: string,
  consume: (nonce: string) => boolean | Promise<boolean>,
  now = Date.now()
) {
  const issued = Date.parse(request.timestamp);
  if (Number.isNaN(issued) || Math.abs(now - issued) > LAYER_SIGNATURE_TTL_MS) throw new Error("LAYER_SIGNATURE_EXPIRED");
  if (!verifyHmac(`${request.nonce}.${request.timestamp}.${request.body}`, request.signature, secret)) throw new Error("LAYER_SIGNATURE_INVALID");
  return Promise.resolve(consume(request.nonce)).then(consumed => {
    if (!consumed) throw new Error("LAYER_NONCE_REPLAYED");
    return true;
  });
}
