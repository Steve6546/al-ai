import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_BOT_IDENTITY, DEFAULT_CUSTOMIZATION } from "@al-ai/core";
import { changedAppearanceFields, describeAppearanceFailure, type AppearancePlan } from "../server/appearance.js";
import { DiscordApiError } from "../server/discord.js";

/**
 * The appearance writer's decisions, tested without Discord.
 *
 * These are the parts that fail *silently* when they are wrong, which is why
 * they are asserted directly rather than through a call that would need a live
 * token:
 *
 *  - **Sending only what changed.** Re-uploading an unchanged avatar on every
 *    save spends Discord's per-account profile budget on a picture nobody
 *    touched, and the operator only ever sees the resulting 429 — never the
 *    cause. Nothing in the response reveals this, so the rule is pinned here.
 *  - **Saying which field failed.** Discord refuses fields individually. A save
 *    that reports "done" while the nickname was rejected is the defect class
 *    this project treats as a bug, so every message is asserted to name its
 *    field and to be actionable.
 */

/** A plan where nothing changed, to be overridden one field at a time. */
function plan(overrides: {
  customizationBefore?: Partial<typeof DEFAULT_CUSTOMIZATION>;
  customizationAfter?: Partial<typeof DEFAULT_CUSTOMIZATION>;
  identityBefore?: Partial<typeof DEFAULT_BOT_IDENTITY>;
  identityAfter?: Partial<typeof DEFAULT_BOT_IDENTITY>;
}): Omit<AppearancePlan, "token" | "guildId"> {
  return {
    previous: {
      customization: { ...DEFAULT_CUSTOMIZATION, ...overrides.customizationBefore },
      identity: { ...DEFAULT_BOT_IDENTITY, ...overrides.identityBefore }
    },
    next: {
      customization: { ...DEFAULT_CUSTOMIZATION, ...overrides.customizationAfter },
      identity: { ...DEFAULT_BOT_IDENTITY, ...overrides.identityAfter }
    }
  };
}

test("an unchanged appearance sends nothing at all", () => {
  assert.deepEqual(changedAppearanceFields(plan({})), [], "saving an untouched form must cost no Discord calls");
});

test("only the nickname is sent when only the nickname changed", () => {
  assert.deepEqual(changedAppearanceFields(plan({ customizationAfter: { nickname: "الحارس" } })), ["nickname"]);
});

test("an unchanged avatar is never re-uploaded", () => {
  // The exact case the rate limit comes from: the operator edits the nickname on
  // a screen that also shows the avatar, and the avatar is not re-sent.
  const withAvatar = plan({
    identityBefore: { avatarDataUrl: "data:image/png;base64,AAA" },
    identityAfter: { avatarDataUrl: "data:image/png;base64,AAA", bio: "نص جديد" }
  });
  assert.deepEqual(changedAppearanceFields(withAvatar), ["bio"], "an untouched avatar is not in the payload");
});

test("a changed avatar and banner are each reported separately", () => {
  const both = plan({
    identityBefore: { avatarDataUrl: null, bannerDataUrl: null },
    identityAfter: { avatarDataUrl: "data:image/png;base64,AAA", bannerDataUrl: "data:image/png;base64,BBB" }
  });
  assert.deepEqual(changedAppearanceFields(both), ["avatarDataUrl", "bannerDataUrl"]);
});

test("clearing a value counts as a change", () => {
  // `null` means "clear it" and must reach Discord. Treating it as absent would
  // make the clear button a control that saves and changes nothing.
  assert.deepEqual(
    changedAppearanceFields(plan({ customizationBefore: { roleColor: "#ff0000" }, customizationAfter: { roleColor: null } })),
    ["roleColor"]
  );
});

test("the role colour and role icon are reported as two fields", () => {
  // They are written in one PATCH, but the operator still has to see which half
  // of the role appearance was involved — a colour edit must not read as an icon
  // edit, and vice versa.
  const colourOnly = plan({ customizationAfter: { roleColor: "#00ff00" } });
  assert.deepEqual(changedAppearanceFields(colourOnly), ["roleColor"]);

  const iconOnly = plan({ customizationAfter: { roleIconUrl: "data:image/png;base64,AAA" } });
  assert.deepEqual(changedAppearanceFields(iconOnly), ["roleIconUrl"]);

  const both = plan({ customizationAfter: { roleColor: "#00ff00", roleIconUrl: "data:image/png;base64,AAA" } });
  assert.deepEqual(changedAppearanceFields(both), ["roleColor", "roleIconUrl"]);
});

test("a presence-only change sends nothing over REST", () => {
  // The presence is applied by the bot's gateway connection, so nothing here may
  // claim to have written it. A field with two writers would be a field where
  // the two fight.
  const presence = plan({
    identityBefore: { status: "online", activityType: "playing", activityText: "" },
    identityAfter: { status: "dnd", activityType: "watching", activityText: "السجلات" }
  });
  assert.deepEqual(changedAppearanceFields(presence), [], "the gateway write is not this module's job");
});

/* ------------------------------------------------------------------ *
 * Failure messages
 * ------------------------------------------------------------------ */

test("a missing permission names the field and the permission to grant", () => {
  const failure = describeAppearanceFailure("roleColor", new DiscordApiError(403, "/x", ""));
  assert.equal(failure.code, "MISSING_PERMISSION");
  assert.match(failure.message, /لون الرتبة/, "the field is named");
  assert.match(failure.message, /إدارة الرتب/, "the specific permission is named");
});

test("Discord's own 50013 counts as a missing permission, not a generic 400", () => {
  // Discord sometimes answers 50013 inside a 400. Reading only the status would
  // report "the value was rejected", sending the operator to fix a colour that
  // was never the problem.
  const failure = describeAppearanceFailure("nickname", new DiscordApiError(400, "/x", '{"code":50013}'));
  assert.equal(failure.code, "MISSING_PERMISSION");
  assert.match(failure.message, /إدارة الأسماء المستعارة/);
});

test("a rate limit tells the operator how long to wait", () => {
  const failure = describeAppearanceFailure("avatarDataUrl", new DiscordApiError(429, "/x", "", 4.2));
  assert.equal(failure.code, "RATE_LIMITED");
  assert.match(failure.message, /5 ثانية/, "the wait is rounded up, never down");
});

test("a rate limit with no hint does not read as 'wait zero'", () => {
  // `retryAfterSeconds` is null when Discord gave no hint. Rendering that as
  // "بعد 0 ثانية" would invite an immediate retry into the same limit.
  const failure = describeAppearanceFailure("avatarDataUrl", new DiscordApiError(429, "/x", "", null));
  assert.equal(failure.code, "RATE_LIMITED");
  assert.doesNotMatch(failure.message, /0 ثانية/);
  assert.match(failure.message, /أعد المحاولة بعد قليل/);
});

test("a rejected value is reported as a rejection, not as a permission problem", () => {
  const failure = describeAppearanceFailure("bannerDataUrl", new DiscordApiError(400, "/x", ""));
  assert.equal(failure.code, "REJECTED");
  assert.match(failure.message, /البانر/, "the field is named");
  assert.match(failure.message, /الحجم/, "the likely causes are named");
});

test("a dead bot token is reported once, in the operator's terms", () => {
  const failure = describeAppearanceFailure("bio", new DiscordApiError(401, "/x", ""));
  assert.equal(failure.code, "BOT_TOKEN_INVALID");
  assert.match(failure.message, /BOT_TOKEN/, "the value to check is named");
});

test("a network failure is not mistaken for a Discord refusal", () => {
  const failure = describeAppearanceFailure("nickname", new TypeError("fetch failed"));
  assert.equal(failure.code, "UNREACHABLE");
  assert.match(failure.message, /الاسم المستعار/, "the field is still named");
});

test("every failure message names its own field", () => {
  // A generic "تعذّر الحفظ" leaves the operator to guess which of six fields to
  // look at. Each field must be identifiable from the message alone.
  const fields = ["nickname", "avatarDataUrl", "bannerDataUrl", "bio", "roleColor", "roleIconUrl"] as const;
  const labels = ["الاسم المستعار", "الصورة الرمزية", "البانر", "النبذة", "لون الرتبة", "أيقونة الرتبة"];

  for (const [index, field] of fields.entries()) {
    const failure = describeAppearanceFailure(field, new DiscordApiError(400, "/x", ""));
    assert.ok(
      failure.message.includes(labels[index]!),
      `${field}'s message must name it — got: ${failure.message}`
    );
  }
});
