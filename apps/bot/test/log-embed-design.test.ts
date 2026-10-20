import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LOG_EVENT_VISUALS,
  eventSchema,
  logVisualFor,
  twemojiThumbnailUrl
} from "@al-ai/core";
import { buildLogEmbeds, type LogEnvelope } from "../src/lib/discord.js";

/** A full envelope, ready for the real builder. */
function envelope(eventId: string, data: Record<string, unknown>): LogEnvelope {
  return {
    correlationId: "corr-12345678",
    timestampUTC: "2026-10-02T12:00:00.000Z",
    actorHash: "hash",
    sourceLayer: "gateway",
    category: "member-log",
    severity: "info",
    guildId: "100000000000000001",
    eventId,
    data
  };
}

test("every one of the 127 event ids carries a full visual identity", () => {
  for (const definition of eventSchema.values()) {
    const visual = LOG_EVENT_VISUALS[definition.id];
    assert.ok(visual, `${definition.id} has a visual`);
    assert.ok(visual.emoji.length >= 1, `${definition.id} has an emoji`);
    assert.ok(visual.title.length >= 3, `${definition.id} has an Arabic title`);
    assert.ok(Number.isInteger(visual.color), `${definition.id} has a numeric colour`);
  }
});

test("the thumbnail URL is a Twemoji PNG Discord can render", () => {
  const url = twemojiThumbnailUrl("🔨");
  assert.match(url, /^https:\/\/cdn\.jsdelivr\.net\/gh\/jdecked\/twemoji@[\d.]+\/assets\/72x72\/1f528\.png$/);
  // A variation selector is dropped, matching Twemoji's own file naming.
  assert.match(twemojiThumbnailUrl("🛡️"), /1f6e1\.png$/);
});

test("a ban embed reads red and punitive, an unban green and restorative", () => {
  assert.equal(logVisualFor("moderation.ban").color, 0xef4444);
  assert.equal(logVisualFor("moderation.unban").color, 0x22c55e);
  assert.equal(logVisualFor("moderation.unban").emoji, "🔓");
});

test("the embed layout carries thumbnail, inline mention fields and a relative timestamp", () => {
  const [json] = buildLogEmbeds(
    envelope("moderation.ban", { targetId: "200000000000000001", actorId: "300000000000000002", reason: "مخالفة القوانين" })
  ).map(embed => embed.toJSON());

  assert.match(json.title as string, /🔨 حظر عضو \| moderation\.ban/);
  assert.match(json.thumbnail!.url, /72x72\/1f528\.png/);
  const byName = (name: string) => json.fields!.find(field => field.name === name);
  assert.match(byName("الطرف المتأثر")!.value, /<@200000000000000001>/);
  assert.match(byName("الطرف المتأثر")!.value, /`200000000000000001`/);
  assert.match(byName("المنفذ")!.value, /<@300000000000000002>/);
  assert.match(byName("السبب")!.value, /مخالفة القوانين/);
  assert.match(byName("الوقت")!.value, /<t:1790942400:R>/);
  assert.equal(json.footer!.text.includes("الأعضاء"), true);
});

test("nickname edits render their old and new values as code blocks", () => {
  const [json] = buildLogEmbeds(
    envelope("member.nickname-change", { memberId: "200000000000000001", before: "القديم", after: "الجديد" })
  ).map(embed => embed.toJSON());
  const before = json.fields!.find(field => field.name === "قبل")!;
  const after = json.fields!.find(field => field.name === "بعد")!;
  assert.match(before.value, /```\nالقديم\n```/);
  assert.match(after.value, /```\nالجديد\n```/);
});

test("channel mentions route through Discord's channel syntax", () => {
  const [json] = buildLogEmbeds(
    envelope("voice.join", { memberId: "200000000000000001", toChannelId: "400000000000000003" })
  ).map(embed => embed.toJSON());
  assert.match(json.fields!.find(field => field.name === "إلى القناة")!.value, /<#400000000000000003>/);
});

test("an oversized payload still paginates instead of being truncated", () => {
  const big: Record<string, unknown> = {};
  for (let index = 0; index < 40; index++) big[`reason-${index}`] = `قيمة ${index}`;
  const pages = buildLogEmbeds(envelope("moderation.warn", big));
  assert.ok(pages.length > 1, "the oversized event split into pages");
});
