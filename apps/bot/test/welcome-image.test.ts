import assert from "node:assert/strict";
import { test } from "node:test";

import { normaliseWelcomeImageConfig } from "@al-ai/core";
import {
  dataUrlToBuffer,
  executeDrawOp,
  planWelcomeImageDraw,
  renderWelcomeImage,
} from "../src/runtime/welcome-image.js";

/** A 1×1 red PNG, as any cropper would hand one over. */
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
  joinDate: "10 أكتوبر 2026"
};

const CONFIG = normaliseWelcomeImageConfig({
  width: 400,
  height: 200,
  background: { type: "color", color: "#0b1020" },
  avatar: { enabled: true, x: 136, y: 20, size: 128, circular: true, strokeColor: "#ffffff", strokeWidth: 4 },
  username: { text: "{username}", x: 200, y: 180, fontSize: 32, color: "#ffffff", weight: "bold", align: "center" },
  customTexts: [{ id: "t1", text: "مرحباً بك في {server}", x: 200, y: 60, fontSize: 20, color: "#ffffff", align: "center" }]
});

test("the plan resolves tokens per layer and drops missing sources", async () => {
  const ops = await planWelcomeImageDraw(CONFIG, { values: VALUES, avatarBuffer: RED_DOT, backgroundBuffer: null });
  // colour fill + avatar + username + one custom text
  assert.equal(ops.length, 4);
  const username = ops.find(op => op.kind === "text" && (op as { text: string }).text === "naxhz");
  assert.ok(username, "the username layer renders the member's real name");
  const custom = ops.find(op => op.kind === "text" && (op as { text: string }).text === "مرحباً بك في Baran");
  assert.ok(custom, "the custom text layer resolves {server}");

  // No avatar bytes → the avatar op vanishes, the card still draws.
  const withoutAvatar = await planWelcomeImageDraw(CONFIG, { values: VALUES, avatarBuffer: null, backgroundBuffer: null });
  assert.equal(withoutAvatar.filter(op => op.kind === "avatar").length, 0);
});

test("the renderer produces an opaque JPEG when the background is filled", async () => {
  const result = await renderWelcomeImage(CONFIG, { values: VALUES, avatarBuffer: RED_DOT, backgroundBuffer: null });
  assert.ok(result, "a filled card always draws");
  assert.equal(result.contentType, "image/jpeg");
  assert.equal(result.extension, "jpg");
  assert.ok(result.buffer.length > 0);
});

test("a transparent background exports PNG, and an empty card is honestly null", async () => {
  const transparent = {
    ...CONFIG,
    background: { type: "transparent" as const, color: null, imageDataUrl: null },
    avatar: { ...CONFIG.avatar, enabled: false },
    customTexts: []
  };
  const result = await renderWelcomeImage(transparent, { values: VALUES, avatarBuffer: RED_DOT, backgroundBuffer: null });
  assert.ok(result);
  assert.equal(result.contentType, "image/png");

  // Nothing enabled and nothing to say: no blank canvas pretending to be art.
  const empty = {
    ...transparent,
    username: { ...transparent.username, text: "" }
  };
  assert.equal(await renderWelcomeImage(empty, { values: VALUES, avatarBuffer: RED_DOT, backgroundBuffer: null }), null);
});

test("data URL decoding is bounded and strict", () => {
  assert.deepEqual(dataUrlToBuffer(`data:image/png;base64,${RED_DOT.toString("base64")}`), RED_DOT);
  assert.equal(dataUrlToBuffer("data:image/png;base64,!!!"), null);
  assert.equal(dataUrlToBuffer(`data:image/png;base64,${"A".repeat(2_000_000)}`), null, "oversized payloads are refused");
});

test("executeDrawOp drives the canvas without throwing on every op kind", async () => {
  const { createCanvas } = await import("@napi-rs/canvas");
  const canvas = createCanvas(64, 64);
  const ctx = canvas.getContext("2d");
  const images = new Map<Buffer, unknown>();
  const ops = await planWelcomeImageDraw(CONFIG, { values: VALUES, avatarBuffer: RED_DOT, backgroundBuffer: null });
  for (const op of ops) executeDrawOp(ctx, canvas, op, images);
  assert.ok(canvas.toBuffer("image/png").length > 0);
});
