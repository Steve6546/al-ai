import test from "node:test";
import assert from "node:assert/strict";
import {
  BOT_HEARTBEAT_STALE_MS,
  deriveBotStatus,
  EMPTY_PUNISHMENT_COUNTS,
  isHeartbeatFresh,
  punishmentKindOf,
  PUNISHMENT_EVENT_IDS,
  summarisePunishments,
  widgetOnlineNote,
  type BotHeartbeat
} from "../src/contracts.js";

/**
 * The overview screen's arithmetic.
 *
 * These three functions are the whole of the dashboard's interpretation layer:
 * they decide what counts as a punishment, whether a heartbeat still means the
 * bot is running, and what to say when Discord will not report live members.
 * Getting any of them wrong produces a screen that looks fine and lies, which
 * is exactly the failure this screen was rebuilt to remove.
 */

const NOW = Date.parse("2026-09-13T18:00:00.000Z");

const heartbeat = (overrides: Partial<BotHeartbeat> = {}): BotHeartbeat => ({
  botPresent: true,
  pingMs: 42,
  checkedAt: new Date(NOW - 1_000).toISOString(),
  ...overrides
});

/* ------------------------------------------------------------------ *
 * Punishment classification
 * ------------------------------------------------------------------ */

test("every declared punishment event maps to a counter", () => {
  const kinds = PUNISHMENT_EVENT_IDS.map(punishmentKindOf);
  assert.deepEqual(kinds, ["ban", "kick", "timeout", "warn"]);
});

test("an unban is not a punishment", () => {
  // An unban releases someone. Counting it would make the screen report a
  // punishment for an act of leniency.
  assert.equal(punishmentKindOf("moderation.unban"), null);
});

test("unrelated and unknown events are not punishments", () => {
  for (const eventId of ["member.join", "bot.command-success", "security.watchdog-down", "", "moderation"]) {
    assert.equal(punishmentKindOf(eventId), null, `${eventId} must not classify as a punishment`);
  }
});

/* ------------------------------------------------------------------ *
 * Aggregation
 * ------------------------------------------------------------------ */

test("an empty trail produces zeroed counters, not undefined ones", () => {
  assert.deepEqual(summarisePunishments([]), EMPTY_PUNISHMENT_COUNTS);
});

test("tallies are summed per kind and totalled", () => {
  const counts = summarisePunishments([
    { eventId: "moderation.ban", count: 2 },
    { eventId: "moderation.kick", count: 1 },
    { eventId: "moderation.warn", count: 5 }
  ]);
  assert.deepEqual(counts, { ban: 2, kick: 1, timeout: 0, warn: 5, total: 8 });
});

test("non-punishment rows never inflate the total", () => {
  // The SQL is a LIKE/count over the trail; if a future event ID starts with
  // "moderation." it will arrive here. It must be dropped, not counted.
  const counts = summarisePunishments([
    { eventId: "moderation.ban", count: 1 },
    { eventId: "moderation.unban", count: 99 },
    { eventId: "security.nuke-prevented", count: 7 }
  ]);
  assert.equal(counts.total, 1);
  assert.equal(counts.ban, 1);
});

test("summarising does not mutate the shared empty template", () => {
  const before = { ...EMPTY_PUNISHMENT_COUNTS };
  summarisePunishments([{ eventId: "moderation.ban", count: 3 }]);
  assert.deepEqual(EMPTY_PUNISHMENT_COUNTS, before, "the exported constant must stay pristine");
});

/* ------------------------------------------------------------------ *
 * Bot liveness
 * ------------------------------------------------------------------ */

test("no heartbeat at all reads as offline with no ping", () => {
  assert.deepEqual(deriveBotStatus(null, NOW), { online: false, pingMs: null, lastSeenAt: null });
});

test("a fresh heartbeat from a present bot is online with its real ping", () => {
  const status = deriveBotStatus(heartbeat(), NOW);
  assert.equal(status.online, true);
  assert.equal(status.pingMs, 42);
});

test("a stale heartbeat is offline and its ping is withheld", () => {
  // The regression that matters: a row outlives the process that wrote it.
  // Reporting online, or a ping, from a stale row describes a bot that is gone.
  const stale = heartbeat({ checkedAt: new Date(NOW - BOT_HEARTBEAT_STALE_MS - 1).toISOString() });
  const status = deriveBotStatus(stale, NOW);
  assert.equal(status.online, false);
  assert.equal(status.pingMs, null);
  assert.equal(status.lastSeenAt, stale.checkedAt, "the timestamp is still reported so the screen can say why");
});

test("a heartbeat just inside the window is still live", () => {
  const almost = heartbeat({ checkedAt: new Date(NOW - BOT_HEARTBEAT_STALE_MS + 1).toISOString() });
  assert.equal(deriveBotStatus(almost, NOW).online, true);
});

test("a heartbeat exactly at the window is already stale", () => {
  // The comparison is strict, so the rule is "fresher than three minutes", not
  // "three minutes or fresher". The boundary is pinned on `isHeartbeatFresh`,
  // which is the single implementation: `/api/health` calls it directly and
  // `deriveBotStatus` calls it here, so there is no second copy left to drift.
  const edge = heartbeat({ checkedAt: new Date(NOW - BOT_HEARTBEAT_STALE_MS).toISOString() });
  assert.equal(deriveBotStatus(edge, NOW).online, false);
});

test("a fresh heartbeat that says the bot is absent is offline", () => {
  // The bot wrote this row as it shut down. Freshness alone must not resurrect it.
  const status = deriveBotStatus(heartbeat({ botPresent: false }), NOW);
  assert.equal(status.online, false);
});

test("a ping of null survives as null rather than becoming zero", () => {
  const status = deriveBotStatus(heartbeat({ pingMs: null }), NOW);
  assert.equal(status.online, true);
  assert.equal(status.pingMs, null, "0 ms would read as an impossibly fast gateway");
});

/* ------------------------------------------------------------------ *
 * The staleness rule on its own
 *
 * It is exported because two callers need it without the rest of
 * `deriveBotStatus`: the overview derives a guild's status from a heartbeat
 * row, while `/api/health` holds only a timestamp and asks the narrower
 * question. Both must answer it identically, so the rule is tested where it is
 * defined rather than through one of its callers.
 * ------------------------------------------------------------------ */

test("a heartbeat with no timestamp is never fresh", () => {
  assert.equal(isHeartbeatFresh(null, NOW), false);
});

test("freshness is strict exactly at the boundary", () => {
  assert.equal(isHeartbeatFresh(new Date(NOW - BOT_HEARTBEAT_STALE_MS).toISOString(), NOW), false);
  assert.equal(isHeartbeatFresh(new Date(NOW - BOT_HEARTBEAT_STALE_MS + 1).toISOString(), NOW), true);
});

/* ------------------------------------------------------------------ *
 * Live-member note
 * ------------------------------------------------------------------ */

test("a real online count needs no note", () => {
  assert.equal(widgetOnlineNote({ online: 12 }), null);
});

test("a disabled widget explains how to enable it", () => {
  const note = widgetOnlineNote({ online: null, reason: "widget-disabled" });
  assert.match(note ?? "", /Server Widget/);
});

test("an unreachable widget says so without blaming the operator", () => {
  const note = widgetOnlineNote({ online: null, reason: "unavailable" });
  assert.ok(note);
  assert.doesNotMatch(note, /Server Widget/, "a transport failure is not a settings problem");
});

test("a missing reason falls back to the unreachable wording", () => {
  assert.equal(widgetOnlineNote({ online: null }), widgetOnlineNote({ online: null, reason: "unavailable" }));
});
