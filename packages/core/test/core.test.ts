import test from "node:test";
import assert from "node:assert/strict";
import {
  allDestinations,
  assertDisjointTierRoles,
  assertUniqueChannelAssignment,
  botStatusDurations,
  canManage,
  decryptSecret,
  DEFAULT_BOT_NICKNAME,
  DEFAULT_CUSTOMIZATION,
  describeVerification,
  durationToMs,
  effectiveBotStatus,
  encryptSecret,
  eventSchema,
  eventsByCategory,
  INTERNAL_DESTINATIONS,
  isStatusWindowExpired,
  isTimedBotStatus,
  layerSignature,
  logDestinations,
  MAX_NICKNAME_LENGTH,
  newNonce,
  normaliseBotIdentity,
  normaliseCustomization,
  normaliseHexColor,
  normaliseIconUrl,
  normaliseNickname,
  normaliseRoleIds,
  normaliseTierRoles,
  requireEvent,
  resolveTier,
  SESSION_COOKIE_OPTIONS,
  SESSION_MAX_AGE_SECONDS,
  signActor,
  validateEvent,
  verifyHmac,
  verifyLayerRequest
} from "../src/index.ts";

/* ---------------- permissions ---------------- */

test("owner can manage admin", () => assert.equal(canManage("owner", "admin"), true));
test("admin cannot manage owner", () => assert.equal(canManage("admin", "owner"), false));
test("admin cannot manage another admin", () => assert.equal(canManage("admin", "admin"), false));
test("moderator cannot manage admin", () => assert.equal(canManage("moderator", "admin"), false));
test("a tier cannot manage its own tier", () => assert.equal(canManage("moderator", "moderator"), false));

/* ---------------- the access model ---------------- */

const noRoles = { adminRoleIds: [], moderatorRoleIds: [] };

test("the guild owner holds the top tier with nothing configured", () =>
  assert.equal(resolveTier({ roleIds: new Set(), isGuildOwner: true }, noRoles), "owner"));

test("an Administrator holds the top tier with nothing configured", () =>
  assert.equal(resolveTier({ roleIds: new Set(), isAdministrator: true }, noRoles), "owner"));

test("a member with no matching role and no Discord grant resolves to nothing", () =>
  assert.equal(resolveTier({ roleIds: new Set(["unrelated"]) }, noRoles), null));

test("the higher of two held tiers wins", () =>
  assert.equal(
    resolveTier({ roleIds: new Set(["r-mod", "r-admin"]) }, { adminRoleIds: ["r-admin"], moderatorRoleIds: ["r-mod"] }),
    "admin"
  ));

test("role IDs that are not snowflakes are dropped, not stored", () =>
  assert.deepEqual(normaliseRoleIds(["1540515175826985080", "not-an-id", "", 42, null]), ["1540515175826985080"]));

test("duplicate role IDs collapse instead of being stored twice", () =>
  assert.deepEqual(normaliseRoleIds(["1540515175826985080", "1540515175826985080"]), ["1540515175826985080"]));

test("a role cannot be both an admin role and a moderator role", () =>
  assert.throws(() => assertDisjointTierRoles({ adminRoleIds: ["1540515175826985080"], moderatorRoleIds: ["1540515175826985080"] })));

test("disjoint role lists are accepted", () =>
  assert.doesNotThrow(() =>
    assertDisjointTierRoles({ adminRoleIds: ["1540515175826985080"], moderatorRoleIds: ["1540515175826985081"] })
  ));

test("normaliseTierRoles tolerates a missing or malformed body", () => {
  assert.deepEqual(normaliseTierRoles(undefined), noRoles);
  assert.deepEqual(normaliseTierRoles({ adminRoleIds: "nope" }), noRoles);
});

/* ---------------- event schema ---------------- */

test("event schema rejects incomplete data", () => assert.throws(() => validateEvent("moderation.ban", { targetId: "1" })));

/**
 * The positive path of `validateEvent`, which had no coverage.
 *
 * The test that used to sit here was named "event schema accepts complete data"
 * but called `requireEvent` — a plain lookup that takes no data at all — and
 * asserted a `category`. So the branch that *returns* the definition was never
 * exercised, and a `validateEvent` that threw unconditionally would have passed
 * every test in this file.
 */
test("event schema accepts data that carries every required field", () => {
  const definition = validateEvent("moderation.ban", { targetId: "1", actorId: "2" });
  assert.equal(definition.id, "moderation.ban");
  assert.equal(definition.category, "moderation-log");

  // A `null` counts as missing, not as a supplied value, so the two spellings
  // of "absent" must both be rejected.
  assert.throws(() => validateEvent("moderation.ban", { targetId: "1", actorId: null }), /actorId/);
  assert.throws(() => validateEvent("moderation.ban", { targetId: "1" }), /actorId/);
});

test("requireEvent looks up a definition and rejects an unknown id", () => {
  assert.equal(requireEvent("moderation.ban").category, "moderation-log");
  assert.throws(() => requireEvent("moderation.explode"), /Unregistered event/);
});
test("unregistered event IDs are rejected", () => assert.throws(() => requireEvent("member.explode")));

test("every event ID is unique and uses the domain.action form", () => {
  const ids = [...eventSchema.keys()];
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, /^[a-z]+(\.[a-z-]+)+$/);
});

test("every destination has at least one registered event", () => {
  // The internal `bot-log` counts too: it carries the security surface.
  for (const destination of allDestinations) {
    assert.ok(eventsByCategory(destination).length > 0, `${destination} has no events`);
  }
});

test("the operator sees five destinations and the internal one is hidden", () => {
  // `bot-log` is delivered to the developer webhook, so it must never appear in
  // the list the dashboard offers channels for.
  assert.equal(logDestinations.length, 5);
  assert.equal(allDestinations.length, 6);
  assert.ok(!logDestinations.includes("bot-log"));
  assert.deepEqual([...INTERNAL_DESTINATIONS], ["bot-log"]);
});

test("the retired role-log destination is gone from the schema", () => {
  assert.ok(!allDestinations.includes("role-log" as never));
  // Its events did not disappear; they moved to server-log.
  const serverEvents = eventsByCategory("server-log");
  for (const id of ["role.create", "role.update", "role.delete"]) {
    assert.ok(serverEvents.includes(id), `${id} travels with server-log`);
  }
});

test("a warning and its removal are both registered moderation events", () => {
  // These are the two the command handler writes itself, because nothing in the
  // gateway reports them: a warning is a record, not a Discord mutation.
  assert.equal(requireEvent("moderation.warn").category, "moderation-log");
  assert.equal(requireEvent("moderation.clearwarns").category, "moderation-log");
  assert.equal(requireEvent("moderation.clearwarns").severity, "warning");
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

/* ---------------- presence durations ---------------- */

test("only the three statuses Discord times are timer-capable", () => {
  // `online` is the exception on purpose: Discord's own client offers no
  // duration sub-menu for it, so treating it as timed would put a countdown
  // beside a state that has no concept of running out.
  assert.equal(isTimedBotStatus("idle"), true);
  assert.equal(isTimedBotStatus("dnd"), true);
  assert.equal(isTimedBotStatus("invisible"), true);
  assert.equal(isTimedBotStatus("online"), false);
  assert.equal(isTimedBotStatus("away"), false);
});

test("each duration converts to the minutes its label promises", () => {
  assert.equal(durationToMs("15m"), 15 * 60_000);
  assert.equal(durationToMs("1h"), 60 * 60_000);
  assert.equal(durationToMs("8h"), 8 * 60 * 60_000);
  assert.equal(durationToMs("24h"), 24 * 60 * 60_000);
  assert.equal(durationToMs("3d"), 3 * 24 * 60 * 60_000);
  // `forever` is null, never 0: zero is a length of time that has already
  // passed, and conflating the two would make "never ends" read as "over".
  assert.equal(durationToMs("forever"), null);
  assert.equal(durationToMs(null), null);
});

test("every duration option has a distinct id and a non-empty label", () => {
  const ids = botStatusDurations.map(duration => duration.id);
  assert.equal(new Set(ids).size, ids.length, "ids must be unique");
  for (const duration of botStatusDurations) {
    assert.ok(duration.label.length > 0, `${duration.id} needs a label`);
  }
});

test("a duration on a status Discord does not time is discarded, not stored", () => {
  // The dangerous half is the expiry: keeping it would leave a clock counting
  // down behind `online` and make a later `dnd` appear already expired.
  const identity = normaliseBotIdentity({
    status: "online",
    statusDuration: "8h",
    statusExpiresAt: "2030-01-01T00:00:00.000Z"
  });
  assert.equal(identity.statusDuration, null);
  assert.equal(identity.statusExpiresAt, null);
});

test("forever stores the choice but no expiry, so the menu can still show it", () => {
  const identity = normaliseBotIdentity({ status: "dnd", statusDuration: "forever", statusExpiresAt: null });
  assert.equal(identity.statusDuration, "forever");
  assert.equal(identity.statusExpiresAt, null);
});

test("a corrupt expiry reads as no window rather than a permanently expired one", () => {
  const identity = normaliseBotIdentity({ status: "dnd", statusDuration: "1h", statusExpiresAt: "not a date" });
  assert.equal(identity.statusDuration, "1h");
  assert.equal(identity.statusExpiresAt, null);
  assert.equal(isStatusWindowExpired(identity, Date.now()), false, "an unparseable clock is not proof of expiry");
});

test("an elapsed window reports the fallback status without rewriting the row", () => {
  const now = Date.parse("2026-09-14T12:00:00.000Z");
  const past = normaliseBotIdentity({
    status: "dnd",
    statusDuration: "1h",
    statusExpiresAt: "2026-09-14T11:00:00.000Z"
  });
  const future = normaliseBotIdentity({
    status: "dnd",
    statusDuration: "1h",
    statusExpiresAt: "2026-09-14T13:00:00.000Z"
  });

  assert.equal(effectiveBotStatus(past, now), "online", "a closed window falls back to online");
  assert.equal(effectiveBotStatus(future, now), "dnd", "an open window keeps the chosen status");
  // The stored choice survives: the screen has to show the operator what they
  // picked, even while the effective status is the fallback.
  assert.equal(past.status, "dnd");
});

test("a status with no duration is never expired", () => {
  const identity = normaliseBotIdentity({ status: "invisible", statusDuration: null, statusExpiresAt: null });
  assert.equal(isStatusWindowExpired(identity, Date.now()), false);
  assert.equal(effectiveBotStatus(identity, Date.now()), "invisible");
});

test("an absent duration normalises to no window rather than throwing", () => {
  const identity = normaliseBotIdentity({ status: "idle" });
  assert.equal(identity.statusDuration, null);
  assert.equal(identity.statusExpiresAt, null);
});
