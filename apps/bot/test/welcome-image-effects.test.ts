import assert from "node:assert/strict";
import { test } from "node:test";

import { normaliseWelcomeImageConfig } from "@al-ai/core";
import { planWelcomeImageDraw, renderWelcomeImage } from "../src/runtime/welcome-image.js";

/** A 1A-1 red PNG, as any cropper would hand one over. */
const RED_DOT = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

const VALUES = {
  userMention: "<@111>",
  username: "naxhz",
  server: "Baran",
  memberCount: 80,
  inviterMention: "<@222>",
  joinDate: "10 October 2026"
};

test("the normaliser fills the new effect fields, and old configs keep working", () => {
  const modern = normaliseWelcomeImageConfig({
    width: 400,
    height: 200,
    background: { type: "gradient", gradientFrom: "#1d4ed8", gradientTo: "#7c3aed", opacity: 0.5 },
    avatar: { glowColor: "#3b82f6", glowSize: 24 },
    username: { strokeColor: "#000000", strokeWidth: 4, shadowColor: "#000000", shadowSize: 8 }
  });
  assert.equal(modern.background.type, "gradient");
  assert.equal(modern.background.gradientFrom, "#1d4ed8");
  assert.equal(modern.background.opacity, 0.5);
  assert.equal(modern.avatar.glowColor, "#3b82f6");
  assert.equal(modern.avatar.glowSize, 24);
  assert.equal(modern.username.strokeWidth, 4);
  assert.equal(modern.username.shadowSize, 8);

  // A config saved before the fields existed still normalises into a complete
  // one - the stored rows do not have to be migrated by hand.
  const legacy = normaliseWelcomeImageConfig({
    width: 400,
    height: 200,
    background: { type: "color", color: "#0b1020" },
    avatar: { size: 64 },
    username: { text: "{username}" }
  });
  assert.equal(legacy.background.opacity, 1);
  assert.equal(legacy.background.gradientFrom, null);
  assert.equal(legacy.avatar.glowColor, null);
  assert.equal(legacy.avatar.glowSize, 0);
  assert.equal(legacy.username.strokeColor, null);
  assert.equal(legacy.username.strokeWidth, 0);
  assert.equal(legacy.username.shadowColor, null);
  assert.equal(legacy.username.shadowSize, 0);
});

test("the normaliser clamps the new fields to sane bounds", () => {
  const clamped = normaliseWelcomeImageConfig({
    width: 400,
    height: 200,
    background: { opacity: 900 },
    avatar: { glowSize: 9999 },
    username: { strokeWidth: 900, shadowSize: -5 }
  });
  assert.equal(clamped.background.opacity, 1, "the opacity is a fraction, never above one");
  assert.equal(clamped.avatar.glowSize, 128);
  assert.equal(clamped.username.strokeWidth, 16);
  assert.equal(clamped.username.shadowSize, 0);
});

test("a gradient background plans a gradient op with its opacity", async () => {
  const config = normaliseWelcomeImageConfig({
    width: 400,
    height: 200,
    background: { type: "gradient", gradientFrom: "#1d4ed8", gradientTo: "#7c3aed", opacity: 0.4 }
  });
  const ops = await planWelcomeImageDraw(config, { values: VALUES, avatarBuffer: null, backgroundBuffer: null });
  const gradient = ops.find(op => op.kind === "gradient");
  assert.ok(gradient, "the gradient is planned");
  assert.equal(gradient.opacity, 0.4);
  assert.equal(gradient.from, "#1d4ed8");
  assert.equal(gradient.to, "#7c3aed");
});

test("the effects reach the draw plan", async () => {
  const config = normaliseWelcomeImageConfig({
    width: 400,
    height: 200,
    background: { type: "color", color: "#0b1020" },
    avatar: { enabled: true, size: 64, glowColor: "#3b82f6", glowSize: 16 },
    username: { text: "{username}", strokeColor: "#000000", strokeWidth: 3, shadowColor: "#000000", shadowSize: 5 }
  });
  const ops = await planWelcomeImageDraw(config, { values: VALUES, avatarBuffer: RED_DOT, backgroundBuffer: null });
  const avatar = ops.find(op => op.kind === "avatar");
  assert.ok(avatar);
  assert.equal(avatar.glowColor, "#3b82f6");
  assert.equal(avatar.glowSize, 16);
  const text = ops.find(op => op.kind === "text");
  assert.ok(text);
  assert.equal(text.strokeWidth, 3);
  assert.equal(text.shadowSize, 5);
});

test("a card with effects still renders", async () => {
  const config = normaliseWelcomeImageConfig({
    width: 400,
    height: 200,
    background: { type: "gradient", gradientFrom: "#1d4ed8", gradientTo: "#7c3aed" },
    avatar: { enabled: true, size: 64, glowColor: "#3b82f6", glowSize: 16 },
    username: { text: "{username}", strokeColor: "#000000", strokeWidth: 3 }
  });
  const result = await renderWelcomeImage(config, { values: VALUES, avatarBuffer: RED_DOT, backgroundBuffer: null });
  assert.ok(result, "the card draws with its effects");
  assert.ok(result.buffer.length > 0);
});
