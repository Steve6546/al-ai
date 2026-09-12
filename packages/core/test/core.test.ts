import test from "node:test";
import assert from "node:assert/strict";
import {
  assertUniqueChannelAssignment,
  canManage,
  decryptSecret,
  DEFAULT_BOT_NICKNAME,
  DEFAULT_CUSTOMIZATION,
  describeVerification,
  encryptSecret,
  eventSchema,
  eventsByCategory,
  layerSignature,
  logDestinations,
  MAX_NICKNAME_LENGTH,
  newNonce,
  normaliseCustomization,
  normaliseHexColor,
  normaliseIconUrl,
  normaliseNickname,
  requireEvent,
  SESSION_COOKIE_OPTIONS,
  SESSION_MAX_AGE_SECONDS,
  signActor,
  validateEvent,
  verifyHmac,
  verifyLayerRequest
} from "../src/index.ts";

/* ---------------- permissions ---------------- */

test("admin cannot manage head admin", () => assert.equal(canManage("admin", "head_admin"), false));
test("owner can manage admin", () => assert.equal(canManage("owner", "admin"), true));
test("a tier cannot manage its own tier", () => assert.equal(canManage("moderator", "moderator"), false));
test("head admin cannot manage owner", () => assert.equal(canManage("head_admin", "owner"), false));

/* ---------------- event schema ---------------- */

test("event schema rejects incomplete data", () => assert.throws(() => validateEvent("moderation.ban", { targetId: "1" })));
test("event schema accepts complete data", () => assert.equal(requireEvent("moderation.ban").category, "moderation-log"));
test("unregistered event IDs are rejected", () => assert.throws(() => requireEvent("member.explode")));

test("every event ID is unique and uses the domain.action form", () => {
  const ids = [...eventSchema.keys()];
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, /^[a-z]+(\.[a-z-]+)+$/);
});

test("all seven destinations have at least one registered event", () => {
  for (const destination of logDestinations) {
    assert.ok(eventsByCategory(destination).length > 0, `${destination} has no events`);
  }
});

test("duplicate channel assignment across destinations is rejected", () => {
  assert.throws(() => assertUniqueChannelAssignment({ "member-log": "c1", "voice-log": "c1" }));
});

test("distinct channel assignment is accepted", () => {
  assert.equal(assertUniqueChannelAssignment({ "member-log": "c1", "voice-log": "c2" }), true);
});

/* ---------------- secrets ---------------- */

const KEY = "a".repeat(64);

test("secret encryption round-trips", () => {
  const plaintext = "discord-access-token-value";
  assert.equal(decryptSecret(encryptSecret(plaintext, KEY), KEY), plaintext);
});

test("encryption uses a fresh IV per call", () => {
  assert.notEqual(encryptSecret("same", KEY), encryptSecret("same", KEY));
});

test("tampered ciphertext is rejected", () => {
  const envelope = encryptSecret("sensitive", KEY);
  const parts = envelope.split(".");
  parts[3] = Buffer.from("tampered").toString("base64");
  assert.throws(() => decryptSecret(parts.join("."), KEY));
});

test("a malformed encryption key is rejected", () => {
  assert.throws(() => encryptSecret("x", "tooshort"));
});

/* ---------------- hmac + nonce ---------------- */

test("hmac verification accepts a valid signature and rejects a wrong one", () => {
  const payload = "layer-payload";
  const signature = signActor(payload, KEY);
  assert.equal(verifyHmac(payload, signature, KEY), true);
  assert.equal(verifyHmac("other-payload", signature, KEY), false);
});

test("a fresh layer request is accepted and its nonce is consumed once", async () => {
  const used = new Set<string>();
  const consume = (nonce: string) => (used.has(nonce) ? false : (used.add(nonce), true));
  const nonce = newNonce();
  const timestamp = new Date().toISOString();
  const body = JSON.stringify({ guildId: "1" });
  const signature = layerSignature(nonce, timestamp, body, KEY);
  assert.equal(await verifyLayerRequest({ nonce, timestamp, signature, body }, KEY, consume), true);
  await assert.rejects(() => verifyLayerRequest({ nonce, timestamp, signature, body }, KEY, consume), /LAYER_NONCE_REPLAYED/);
});

test("an expired layer request is rejected", () => {
  const nonce = newNonce();
  const old = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const body = "{}";
  const signature = layerSignature(nonce, old, body, KEY);
  assert.throws(
    () => verifyLayerRequest({ nonce, timestamp: old, signature, body }, KEY, () => true),
    /LAYER_SIGNATURE_EXPIRED/
  );
});

test("a tampered layer body is rejected", () => {
  const nonce = newNonce();
  const timestamp = new Date().toISOString();
  const signature = layerSignature(nonce, timestamp, "{}", KEY);
  assert.throws(
    () => verifyLayerRequest({ nonce, timestamp, signature, body: '{"evil":true}' }, KEY, () => true),
    /LAYER_SIGNATURE_INVALID/
  );
});

/* ---------------- session policy ---------------- */

test("session policy is httpOnly, lax, and capped at 24 hours", () => {
  assert.equal(SESSION_MAX_AGE_SECONDS, 86_400);
  assert.equal(SESSION_COOKIE_OPTIONS.httpOnly, true);
  assert.equal(SESSION_COOKIE_OPTIONS.sameSite, "lax");
});

/* ---------------- verification thresholds ---------------- */

test("many tiny guilds do not trigger the unique-user warning", () => {
  // The bug this guards: 500 guilds was compared against a 10,000 *user* limit.
  const status = describeVerification({ guildCount: 500, uniqueUsers: 900 });
  assert.equal(status.warning, null);
  assert.equal(status.reviewRequired, true, "500 guilds does trigger the guild-based review");
});

test("few very large guilds do trigger the unique-user warning", () => {
  const status = describeVerification({ guildCount: 3, uniqueUsers: 9_500 });
  assert.notEqual(status.warning, null);
  assert.equal(status.reviewRequired, false, "3 guilds never triggers the guild-based review");
});

test("the warning escalates exactly at the documented unique-user thresholds", () => {
  assert.equal(describeVerification({ guildCount: 1, uniqueUsers: 7_999 }).warning, null);
  assert.notEqual(describeVerification({ guildCount: 1, uniqueUsers: 8_000 }).warning, null);
  assert.match(describeVerification({ guildCount: 1, uniqueUsers: 10_000 }).warning ?? "", /10,000/);
});

test("verification counts are never negative or fractional", () => {
  const status = describeVerification({ guildCount: -5, uniqueUsers: 12.7 });
  assert.equal(status.guildCount, 0);
  assert.equal(status.uniqueUsers, 12);
});

/* ---------------- bot appearance (GOVERNANCE rule 18) ---------------- */

/**
 * The dashboard validates on write and the bot normalises on read using these
 * same helpers. If they disagree with each other, a value can be accepted by one
 * side and reinterpreted by the other — which is how a "saved" setting becomes a
 * setting with no effect.
 */

test("the shipped appearance only describes what Discord can apply per guild", () => {
  assert.deepEqual(Object.keys(DEFAULT_CUSTOMIZATION).sort(), ["nickname", "roleColor", "roleIconUrl"]);
  assert.equal(DEFAULT_CUSTOMIZATION.nickname, DEFAULT_BOT_NICKNAME);
  assert.equal(DEFAULT_CUSTOMIZATION.roleColor, null);
  assert.equal(DEFAULT_CUSTOMIZATION.roleIconUrl, null);
});

test("a nickname is trimmed and capped at Discord's limit", () => {
  assert.equal(normaliseNickname("  AL AI  "), "AL AI");
  assert.equal(normaliseNickname("x".repeat(100)).length, MAX_NICKNAME_LENGTH);
  assert.equal(normaliseNickname(undefined), "");
  assert.equal(normaliseNickname(42), "");
});

test("whitespace-only nicknames collapse to one spelling of cleared", () => {
  assert.equal(normaliseNickname("   "), "");
  assert.equal(normaliseNickname("\t\n "), "");
});

test("a hex colour is accepted in both forms and normalised to lowercase #rrggbb", () => {
  assert.equal(normaliseHexColor("#3B82F6"), "#3b82f6");
  assert.equal(normaliseHexColor("  #3b82f6 "), "#3b82f6");
  assert.equal(normaliseHexColor("#abc"), "#aabbcc", "shorthand expands");
});

test("anything that is not a hex colour is refused rather than stored", () => {
  for (const bad of ["rebeccapurple", "#12345", "#gggggg", "3b82f6", "", null, 7]) {
    assert.equal(normaliseHexColor(bad), null, `${JSON.stringify(bad)} must be refused`);
  }
});

test("only an absolute https image URL is accepted as a role icon", () => {
  assert.equal(normaliseIconUrl("https://cdn.example.com/i.png"), "https://cdn.example.com/i.png");
  for (const bad of ["http://cdn.example.com/i.png", "/relative.png", "javascript:alert(1)", "not a url", "", null]) {
    assert.equal(normaliseIconUrl(bad), null, `${JSON.stringify(bad)} must be refused`);
  }
});

test("normalising a whole appearance never invents a value the operator did not set", () => {
  assert.deepEqual(normaliseCustomization(null), { nickname: "", roleColor: null, roleIconUrl: null });
  assert.deepEqual(
    normaliseCustomization({ nickname: "  AL AI  ", roleColor: "#ABC", roleIconUrl: "http://insecure/i.png" }),
    { nickname: "AL AI", roleColor: "#aabbcc", roleIconUrl: null }
  );
});

test("normalising is idempotent, so a second pass cannot change a value", () => {
  const once = normaliseCustomization({ nickname: " AL AI ", roleColor: "#ABC", roleIconUrl: "https://x.example/i.png" });
  assert.deepEqual(normaliseCustomization(once), once);
});
