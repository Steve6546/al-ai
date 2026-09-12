import test from "node:test";
import assert from "node:assert/strict";
import { createWatchdog } from "../src/security/watchdog.ts";
import { createIntrusionDetector } from "../src/security/intrusion-detector.ts";
import { APPEND_ONLY_MARKER, guardAuditWrite, isAppendOnlyViolation } from "../src/security/audit-trail.ts";
import { createMessageCache } from "../src/logging/message-cache.ts";

/* ------------------------------------------------------------------ *
 * Watchdog — GOVERNANCE rule 13
 * ------------------------------------------------------------------ */

test("the watchdog stays quiet while a component keeps checking in", () => {
  let now = 0;
  const silences: string[] = [];
  const watchdog = createWatchdog({ now: () => now, onSilent: component => silences.push(component) });

  watchdog.beat("audit-trail");
  now += 1_000;
  watchdog.tick();
  assert.deepEqual(silences, []);
  watchdog.stop();
});

test("the watchdog reports a component that goes silent past the budget", () => {
  let now = 0;
  const silences: { component: string; silentForMs: number }[] = [];
  const watchdog = createWatchdog({
    now: () => now,
    staleAfterMs: 60_000,
    onSilent: (component, silentForMs) => silences.push({ component, silentForMs })
  });

  watchdog.beat("intrusion-detector");
  now += 61_000;
  watchdog.tick();

  assert.equal(silences.length, 1);
  assert.equal(silences[0].component, "intrusion-detector");
  assert.equal(silences[0].silentForMs, 61_000);
  watchdog.stop();
});

test("a silence episode is reported once, not on every tick", () => {
  let now = 0;
  let count = 0;
  const watchdog = createWatchdog({ now: () => now, staleAfterMs: 1_000, onSilent: () => (count += 1) });

  watchdog.beat("audit-trail");
  now += 5_000;
  watchdog.tick();
  watchdog.tick();
  watchdog.tick();
  assert.equal(count, 1, "one episode, one event");

  // A fresh beat starts a new episode.
  watchdog.beat("audit-trail");
  now += 5_000;
  watchdog.tick();
  assert.equal(count, 2);
  watchdog.stop();
});

test("the watchdog snapshot reflects real liveness", () => {
  let now = 0;
  const watchdog = createWatchdog({ now: () => now, staleAfterMs: 1_000, onSilent: () => undefined });
  watchdog.beat("audit-trail");
  now += 2_000;
  const [entry] = watchdog.snapshot();
  assert.equal(entry.healthy, false);
  assert.equal(entry.silentForMs, 2_000);
  watchdog.stop();
});

/* ------------------------------------------------------------------ *
 * Intrusion detector — GOVERNANCE rule 12
 * ------------------------------------------------------------------ */

test("every failed authorization attempt is reported, not just the ones that cross a threshold", () => {
  const detector = createIntrusionDetector();
  const signal = detector.authorizationFailure({ guildId: "g", actorId: "u", action: "ban", reason: "NO_TIER" });
  assert.equal(signal.id, "security.invalid-role-attempt");
  assert.equal(signal.data.action, "ban");
  assert.equal(signal.data.attemptsInWindow, 1);
});

test("repeated authorization failures are counted inside the window and expire outside it", () => {
  let now = 0;
  const detector = createIntrusionDetector({ now: () => now, windowMs: 60_000, authorizationBurst: 3 });

  detector.authorizationFailure({ guildId: "g", actorId: "u", action: "ban", reason: "TIER_TOO_LOW" });
  detector.authorizationFailure({ guildId: "g", actorId: "u", action: "ban", reason: "TIER_TOO_LOW" });
  assert.equal(detector.isAuthorizationBursting("g", "u"), false);

  const third = detector.authorizationFailure({ guildId: "g", actorId: "u", action: "ban", reason: "TIER_TOO_LOW" });
  assert.equal(third.data.attemptsInWindow, 3);
  assert.equal(detector.isAuthorizationBursting("g", "u"), true);

  now += 61_000;
  assert.equal(detector.isAuthorizationBursting("g", "u"), false, "the window slides");
});

test("an invalid HMAC is always reported and named after the layer", () => {
  const detector = createIntrusionDetector();
  const signal = detector.signatureFailure({ layer: "bot", reason: "LAYER_SIGNATURE_INVALID" });
  assert.equal(signal.id, "security.hmac-invalid");
  assert.equal(signal.data.layer, "bot");
});

test("normal traffic stays quiet and only a burst is flagged as abnormal", () => {
  const detector = createIntrusionDetector({ requestBurst: 5 });
  for (let index = 0; index < 5; index += 1) {
    assert.equal(detector.request({ endpoint: "/api/guilds" }), null);
  }
  const signal = detector.request({ endpoint: "/api/guilds" });
  assert.ok(signal);
  assert.equal(signal.id, "security.abnormal-request");
  assert.equal(signal.data.endpoint, "/api/guilds");
});

test("a revoked credential is reported with its type and reason", () => {
  const detector = createIntrusionDetector();
  const signal = detector.revokedCredential({ credentialType: "session", reason: "expired" });
  assert.equal(signal.id, "security.revoked-credential");
  assert.equal(signal.data.credentialType, "session");
});

test("every signal the detector can raise maps to a registered critical event", async () => {
  const { eventSchema } = await import("@al-ai/core");
  const detector = createIntrusionDetector({ requestBurst: 0 });
  const signals = [
    detector.authorizationFailure({ guildId: "g", actorId: "u", action: "a", reason: "r" }),
    detector.signatureFailure({ layer: "l", reason: "r" }),
    detector.request({ endpoint: "/e" })!,
    detector.revokedCredential({ credentialType: "token", reason: "revoked" }),
    detector.auditTamper({ attempt: "UPDATE", target: "audit_trail" }),
    detector.watchdogDown({ component: "audit-trail", silentForMs: 1000 })
  ];

  for (const signal of signals) {
    const definition = eventSchema.get(signal.id);
    assert.ok(definition, `${signal.id} is registered`);
    assert.equal(definition!.severity, "critical", `${signal.id} must be critical`);
  }
});

/* ------------------------------------------------------------------ *
 * Audit-trail guard — GOVERNANCE rule 7
 * ------------------------------------------------------------------ */

test("a rejected mutation is classified as tampering, not as a transient failure", async () => {
  const rejection = new Error(`audit_trail is append-only: UPDATE is not permitted`);
  const outcome = await guardAuditWrite(async () => {
    throw rejection;
  });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false && outcome.tamper, true);
  assert.match(outcome.ok === false && outcome.tamper ? outcome.attempt : "", /UPDATE/);
});

test("a connection failure is not mistaken for tampering", async () => {
  const outcome = await guardAuditWrite(async () => {
    throw new Error("ECONNREFUSED");
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false && outcome.tamper, false);
});

test("a successful write is reported as ok", async () => {
  const outcome = await guardAuditWrite(async () => undefined);
  assert.deepEqual(outcome, { ok: true });
});

test("the append-only marker matches what the database actually raises", () => {
  assert.ok(isAppendOnlyViolation(new Error(`audit_trail is append-only: TRUNCATE is not permitted`)));
  assert.equal(isAppendOnlyViolation(new Error("timeout expired")), false);
  assert.equal(APPEND_ONLY_MARKER, "is append-only");
});

/* ------------------------------------------------------------------ *
 * Message cache — GOVERNANCE rule 17
 * ------------------------------------------------------------------ */

const message = (id: string, channelId = "c1", createdAt = 0) => ({
  id,
  guildId: "g1",
  channelId,
  authorId: "u1",
  content: `body-${id}`,
  createdAt
});

test("a cached message can be recovered after deletion", () => {
  const cache = createMessageCache();
  cache.put(message("m1"));
  assert.equal(cache.get("c1", "m1")?.content, "body-m1");
});

test("entries expire once the TTL passes", () => {
  let now = 0;
  const cache = createMessageCache({ now: () => now, ttlMs: 1_000 });
  cache.put(message("m1"));
  now += 1_001;
  assert.equal(cache.get("c1", "m1"), undefined);
});

test("the cache is bounded per channel, evicting the oldest first", () => {
  const cache = createMessageCache({ maxPerChannel: 3 });
  for (let index = 0; index < 5; index += 1) cache.put(message(`m${index}`));

  assert.equal(cache.size(), 3);
  assert.equal(cache.get("c1", "m0"), undefined, "oldest evicted");
  assert.equal(cache.get("c1", "m4")?.content, "body-m4", "newest kept");
});

test("channels are isolated from one another", () => {
  const cache = createMessageCache();
  cache.put(message("m1", "c1"));
  cache.put(message("m2", "c2"));
  assert.equal(cache.get("c1", "m2"), undefined);
  assert.equal(cache.channelCount(), 2);
});
