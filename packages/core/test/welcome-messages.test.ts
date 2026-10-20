import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_WELCOME_MESSAGE_SETTINGS,
  normaliseWelcomeImageConfig,
  normaliseWelcomeMessageSettings,
  renderWelcomeMessage,
  welcomeEmbedReady,
} from "@al-ai/core";

test("tokens fill with real values, and a missing inviter reads as غير معروف", () => {
  const text = renderWelcomeMessage("{user} دخل {server} — عددنا {memberCount}، جاء بـ{inviter} يوم {joinDate}، يا {username} {unknown}", {
    userMention: "<@111>",
    username: "naxhz",
    server: "Baran",
    memberCount: 80,
    inviterMention: "<@222>",
    joinDate: "10 أكتوبر 2026"
  });
  assert.ok(text.includes("<@111>") && text.includes("Baran") && text.includes("80") && text.includes("<@222>") && text.includes("نaxhz".replace("ن", "n")));
  assert.ok(text.includes("{unknown}"), "unknown tokens survive");

  const noInviter = renderWelcomeMessage("جاء بـ{inviter}", {
    userMention: "", username: "", server: "", memberCount: 0, inviterMention: "", joinDate: ""
  });
  assert.equal(noInviter, "جاء بـغير معروف");
});

test("the settings normaliser clamps everything a hand-crafted PUT could try", () => {
  const normalised = normaliseWelcomeMessageSettings({
    enabled: "yes",
    imageEnabled: true,
    imageMode: "teleport",
    imageChannelId: "not-a-snowflake",
    channelId: "<@999>",
    mode: "carrier-pigeon",
    text: "x".repeat(5000),
    embed: {
      title: "t".repeat(400),
      description: "d".repeat(9000),
      color: "rebeccapurple",
      thumbnailMode: "weird",
      imageMode: "upload",
      imageDataUrl: "data:text/html;base64,PHNjcmlwdD4=",
      fields: [{ name: "ok", value: "قيمة", inline: "yes" }, { name: "ناقص", value: "" }]
    },
    image: { width: 99_999, height: -1, quality: 7, background: { type: "color", color: "#ABC" } }
  });

  assert.equal(normalised.enabled, false);
  assert.equal(normalised.imageMode, "with_message", "an unknown send mode falls back");
  assert.equal(normalised.imageChannelId, null, "a non-snowflake channel is unset");
  assert.equal(normalised.channelId, null);
  assert.equal(normalised.mode, "embed");
  assert.ok(normalised.text.length <= 2000);
  assert.ok(normalised.embed.title.length <= 256);
  assert.ok(normalised.embed.description.length <= 4000);
  assert.equal(normalised.embed.color, "#3b82f6", "an invalid colour falls back to the default");
  assert.equal(normalised.embed.thumbnailMode, "member_avatar");
  assert.equal(normalised.embed.imageDataUrl, null, "a non-image data URL is refused");
  assert.equal(normalised.embed.fields.length, 1, "an empty half-field is dropped; inline coerces");
  assert.equal(normalised.embed.fields[0].inline, false);
  assert.equal(normalised.image.width, 2048);
  assert.equal(normalised.image.height, 128);
  assert.ok(normalised.image.quality >= 0.5 && normalised.image.quality <= 1);
  assert.equal(normalised.image.background.color, "#aabbcc", "shorthand hex expands");
});

test("defaults ship the module off and a real greeting in the embed", () => {
  const defaults = { ...DEFAULT_WELCOME_MESSAGE_SETTINGS };
  assert.equal(defaults.enabled, false);
  assert.equal(defaults.mode, "embed");
  assert.ok(defaults.text.includes("{user}") && defaults.text.includes("{server}"));
  assert.ok(welcomeEmbedReady(defaults.embed), "the shipped embed is sendable");
  assert.equal(welcomeEmbedReady({ ...defaults.embed, title: "", description: "", fields: [] }), false);
});

test("the canvas config normaliser keeps a coherent card", () => {
  const config = normaliseWelcomeImageConfig({
    width: 800,
    height: 400,
    background: { type: "color", color: "#0b1020" },
    avatar: { enabled: true, x: 300, y: 40, size: 128, circular: true, strokeColor: "#fff", strokeWidth: 4 },
    username: { text: "{username}", x: 400, y: 350, fontSize: 36, align: "center" },
    customTexts: Array.from({ length: 20 }, (_, index) => ({ id: `t${index}`, text: `نص ${index}` }))
  });
  assert.equal(config.customTexts.length, 8, "custom texts cap at MAX_WELCOME_CUSTOM_TEXTS");
  assert.equal(config.background.color, "#0b1020");
  assert.equal(config.avatar.size, 128);
  assert.equal(config.username.align, "center");
  // A transparent background forces PNG at render time; the config keeps the
  // quality for opaque exports either way.
  assert.ok(config.quality > 0);
});

test("layers cannot escape the canvas: size and positions clamp to the edges", async () => {
  const { clampWelcomeImageConfig, normaliseWelcomeImageConfig } = await import("../src/welcome-messages.js");
  // A stored card whose avatar outgrew a later canvas shrink comes back inside.
  const clamped = clampWelcomeImageConfig({
    ...normaliseWelcomeImageConfig({ width: 400, height: 200 }),
    avatar: { enabled: true, x: 380, y: 190, size: 512, circular: true, strokeColor: null, strokeWidth: 0 }
  });
  assert.ok(clamped.avatar.size <= Math.min(400, 200), "the avatar never outgrows the card");
  assert.ok(clamped.avatar.x + clamped.avatar.size <= clamped.width, "the avatar stays inside horizontally");
  assert.ok(clamped.avatar.y + clamped.avatar.size <= clamped.height, "the avatar stays inside vertically");
  assert.equal(clamped.username.x <= clamped.width, true);

  // The normaliser applies the same pass on the way in, so a crafted PUT
  // cannot park an escapee either.
  const normalised = normaliseWelcomeImageConfig({
    width: 300,
    height: 300,
    avatar: { size: 512, x: 250, y: 250 }
  });
  assert.ok(normalised.avatar.size <= 300);
  assert.ok(normalised.avatar.x + normalised.avatar.size <= 300);
});
