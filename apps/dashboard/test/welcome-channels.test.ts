import test from "node:test";
import assert from "node:assert/strict";
import { checkWelcomeChannels } from "../server/welcome-channels.js";

/**
 * The rule a welcome message cannot bend: it needs a channel the bot can see.
 *
 * The distinction these tests protect is the one that broke in production: an
 * unreadable channel list must not be reported as a missing channel. The first
 * says "we could not check" (503), the second says "yours is gone" (409), and
 * blaming the operator for a Discord outage is how a save becomes impossible
 * with a message that points at the wrong thing.
 */

const IDS = new Set(["111111111111111111", "222222222222222222"]);

const base = {
  enabled: true,
  channelId: "111111111111111111",
  imageEnabled: false,
  imageMode: "with_message",
  imageChannelId: null
} as const;

test("a disabled module needs no channel at all", () => {
  const verdict = checkWelcomeChannels({ ...base, enabled: false, channelId: null }, IDS, { listReadable: true });
  assert.deepEqual(verdict, { ok: true });
});

test("an armed module with no channel is a field error on the welcome channel", () => {
  const verdict = checkWelcomeChannels({ ...base, channelId: null }, IDS, { listReadable: true });
  assert.equal(verdict.ok, false);
  if (verdict.ok) return;
  assert.equal(verdict.code, "CHANNEL_NOT_FOUND");
  assert.equal(verdict.ok === false && "field" in verdict ? verdict.field : null, "channel");
});

test("a channel Discord no longer has is named as gone, not as unreadable", () => {
  const verdict = checkWelcomeChannels({ ...base, channelId: "999999999999999999" }, IDS, { listReadable: true });
  assert.equal(verdict.ok, false);
  if (verdict.ok) return;
  assert.equal(verdict.code, "CHANNEL_NOT_FOUND");
});

test("an unreadable channel list is 503 material, never 'the channel is gone'", () => {
  // The same settings, the same (empty) ids - only the reason differs, and the
  // verdict must follow the reason rather than the emptiness.
  const verdict = checkWelcomeChannels(base, new Set(), { listReadable: false });
  assert.equal(verdict.ok, false);
  if (verdict.ok) return;
  assert.equal(verdict.code, "CHANNEL_LIST_UNAVAILABLE");
});

test("a readable but empty list still means the chosen channel is gone", () => {
  const verdict = checkWelcomeChannels(base, new Set(), { listReadable: true });
  assert.equal(verdict.ok, false);
  if (verdict.ok) return;
  assert.equal(verdict.code, "CHANNEL_NOT_FOUND");
});

test("a separate image channel is required only in separate-channel mode", () => {
  const separate = checkWelcomeChannels(
    { ...base, imageEnabled: true, imageMode: "separate_channel", imageChannelId: null },
    IDS,
    { listReadable: true }
  );
  assert.equal(separate.ok, false);
  if (!separate.ok) assert.equal(separate.code, "CHANNEL_NOT_FOUND");

  const withMessage = checkWelcomeChannels(
    { ...base, imageEnabled: true, imageMode: "with_message", imageChannelId: null },
    IDS,
    { listReadable: true }
  );
  assert.deepEqual(withMessage, { ok: true }, "the card rides along with the message, so nothing extra is required");

  const resolved = checkWelcomeChannels(
    { ...base, imageEnabled: true, imageMode: "separate_channel", imageChannelId: "222222222222222222" },
    IDS,
    { listReadable: true }
  );
  assert.deepEqual(resolved, { ok: true });
});

test("the image channel is reported as its own field, so the screen can point at it", () => {
  const verdict = checkWelcomeChannels(
    { ...base, imageEnabled: true, imageMode: "separate_channel", imageChannelId: "999999999999999999" },
    IDS,
    { listReadable: true }
  );
  assert.equal(verdict.ok, false);
  if (verdict.ok) return;
  assert.equal(verdict.code, "CHANNEL_NOT_FOUND");
  assert.equal("field" in verdict ? verdict.field : null, "imageChannel");
});
