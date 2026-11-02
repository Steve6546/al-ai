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
  for (const op of ops) await executeDrawOp(ctx, canvas, op, images);
  assert.ok(canvas.toBuffer("image/png").length > 0);
});

/**
 * The card must contain the avatar as *pixels*.
 *
 * Every previous assertion here was about bytes: "the buffer is not empty",
 * "drawing does not throw". A card whose avatar layer decoded to nothing passed
 * all of them, and that is exactly what happened — the engine's `new Image()`
 * path reports dimensions and `complete` and then paints transparent black for
 * every format, so no member's face and no picture background ever reached the
 * image the bot sent. This is the test that would have caught it, so it reads
 * the colour back out of the exported file.
 */
test("the avatar is painted into the exported card, not just planned", async () => {
  const { createCanvas, loadImage } = await import("@napi-rs/canvas");
  const card = await renderWelcomeImage(
    normaliseWelcomeImageConfig({
      width: 64,
      height: 64,
      background: { type: "transparent" },
      avatar: { enabled: true, x: 0, y: 0, size: 64, circular: false },
      username: { text: "", x: 0, y: 0, fontSize: 10 },
      customTexts: []
    }),
    { values: VALUES, avatarBuffer: RED_DOT, backgroundBuffer: null }
  );
  assert.ok(card, "a card with an avatar draws");

  const decoded = await loadImage(card.buffer);
  const probe = createCanvas(decoded.width, decoded.height);
  const ctx = probe.getContext("2d");
  ctx.drawImage(decoded, 0, 0);
  const [red, green, blue, alpha] = [...ctx.getImageData(32, 32, 1, 1).data];
  // The 1×1 fixture is a half-alpha red pixel, so the card's alpha is 127 —
  // which is the whole point: before the decode fix it was `0,0,0,0`, an
  // invisible avatar in a perfectly valid-looking PNG.
  assert.ok(
    alpha > 0 && red > 150 && green < 90 && blue < 90,
    `the red avatar must be in the file, got rgba ${[red, green, blue, alpha].join(",")}`
  );
});

test("a picture background is painted too", async () => {
  const { createCanvas, loadImage } = await import("@napi-rs/canvas");
  const card = await renderWelcomeImage(
    normaliseWelcomeImageConfig({
      width: 64,
      height: 64,
      background: { type: "image" },
      avatar: { enabled: false, x: 0, y: 0, size: 32 },
      username: { text: "", x: 0, y: 0, fontSize: 10 },
      customTexts: []
    }),
    { values: VALUES, avatarBuffer: null, backgroundBuffer: RED_DOT }
  );
  assert.ok(card);
  const decoded = await loadImage(card.buffer);
  const probe = createCanvas(decoded.width, decoded.height);
  const ctx = probe.getContext("2d");
  ctx.drawImage(decoded, 0, 0);
  const [red, green, blue] = [...ctx.getImageData(32, 32, 1, 1).data];
  // Composited over a transparent canvas the half-alpha red lands near 122;
  // what matters is that a colour arrived at all.
  assert.ok(red > 100 && green < 60 && blue < 60, `the uploaded background must be drawn, got rgb ${[red, green, blue].join(",")}`);
});
