import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CUSTOMIZATION } from "@al-ai/core";
import {
  changedAppearanceFields,
  describeAppearanceFailure,
  invalidateGuildMemberProfile,
  readGuildMemberProfile,
  resolveRoleIconWrite,
  type AppearancePlan
} from "../server/appearance.js";
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
  before?: Partial<typeof DEFAULT_CUSTOMIZATION>;
  after?: Partial<typeof DEFAULT_CUSTOMIZATION>;
}): Omit<AppearancePlan, "token" | "guildId"> {
  return {
    previous: { ...DEFAULT_CUSTOMIZATION, ...overrides.before },
    next: { ...DEFAULT_CUSTOMIZATION, ...overrides.after }
  };
}

test("an unchanged appearance sends nothing at all", () => {
  assert.deepEqual(changedAppearanceFields(plan({})), [], "saving an untouched form must cost no Discord calls");
});

test("only the nickname is sent when only the nickname changed", () => {
  assert.deepEqual(changedAppearanceFields(plan({ after: { nickname: "الحارس" } })), ["nickname"]);
});

test("a changed server avatar is reported once, and under its own name", () => {
  // Modify Current Member's `avatar` field is the picture members of THIS server
  // see. It used to share a plan with an account-wide avatar on a different
  // endpoint, and the two had to be told apart; there is one avatar now, and the
  // name it reports is the one the failure message will print.
  const changed = plan({ before: { avatarDataUrl: null }, after: { avatarDataUrl: "data:image/png;base64,AAA" } });
  assert.deepEqual(changedAppearanceFields(changed), ["guildAvatarDataUrl"]);
});

test("an unchanged server avatar is never re-uploaded", () => {
  const untouched = plan({
    before: { avatarDataUrl: "data:image/png;base64,AAA" },
    after: { avatarDataUrl: "data:image/png;base64,AAA", nickname: "جديد" }
  });
  const changed = changedAppearanceFields(untouched);
  assert.ok(!changed.includes("guildAvatarDataUrl"), "an untouched server avatar is not in the payload");
  assert.deepEqual(changed, ["nickname"]);
});

test("an untouched image is not re-sent when another field changes", () => {
  // The exact case the rate limit comes from: the operator edits the bio on a
  // screen that also shows the picture, and the picture is not re-sent.
  const withAvatar = plan({
    before: { avatarDataUrl: "data:image/png;base64,AAA" },
    after: { avatarDataUrl: "data:image/png;base64,AAA", bio: "نص جديد" }
  });
  assert.deepEqual(changedAppearanceFields(withAvatar), ["bio"], "an untouched image is not in the payload");
});

test("a changed avatar and banner are each reported separately", () => {
  const both = plan({
    before: { avatarDataUrl: null, bannerDataUrl: null },
    after: { avatarDataUrl: "data:image/png;base64,AAA", bannerDataUrl: "data:image/png;base64,BBB" }
  });
  assert.deepEqual(changedAppearanceFields(both), ["guildAvatarDataUrl", "bannerDataUrl"]);
});

test("clearing a value counts as a change", () => {
  // `null` means "clear it" and must reach Discord. Treating it as absent would
  // make the clear button a control that saves and changes nothing.
  assert.deepEqual(
    changedAppearanceFields(plan({ before: { roleColor: "#ff0000" }, after: { roleColor: null } })),
    ["roleColor"]
  );
});

test("the role colour and role icon are reported as two fields", () => {
  // They are written in one PATCH, but the operator still has to see which half
  // of the role appearance was involved — a colour edit must not read as an icon
  // edit, and vice versa.
  const colourOnly = plan({ after: { roleColor: "#00ff00" } });
  assert.deepEqual(changedAppearanceFields(colourOnly), ["roleColor"]);

  const iconOnly = plan({ after: { roleIconUrl: "data:image/png;base64,AAA" } });
  assert.deepEqual(changedAppearanceFields(iconOnly), ["roleIconUrl"]);

  const both = plan({ after: { roleColor: "#00ff00", roleIconUrl: "data:image/png;base64,AAA" } });
  assert.deepEqual(changedAppearanceFields(both), ["roleColor", "roleIconUrl"]);
});

test("the plan can only ever report the six per-guild fields", () => {
  // The presence is not in this list and cannot be: a status lives on the bot's
  // gateway connection, the bot owns it, and the presence route never calls this
  // module. The pin is that the *complete* field set is the guild's six — so a
  // later change that quietly reintroduced an account-wide field would fail here
  // rather than ship as a control that writes nothing.
  const everyField = plan({
    before: { nickname: "قديم", roleColor: "#000000", roleIconUrl: null, avatarDataUrl: null, bannerDataUrl: null, bio: "قديم" },
    after: {
      nickname: "جديد",
      roleColor: "#ffffff",
      roleIconUrl: "data:image/png;base64,AAA",
      avatarDataUrl: "data:image/png;base64,BBB",
      bannerDataUrl: "data:image/png;base64,CCC",
      bio: "جديد"
    }
  });
  assert.deepEqual(
    changedAppearanceFields(everyField).sort(),
    ["bannerDataUrl", "bio", "guildAvatarDataUrl", "nickname", "roleColor", "roleIconUrl"].sort()
  );
});

test("turning the profile off clears all four member fields", () => {
  // The master switch is not cosmetic: the writer derives its payload from the
  // same view, so a disabled profile walks the nickname, the avatar, the banner
  // and the bio back through Discord in one call.
  const disabled = plan({
    before: {
      enabled: true,
      nickname: "اسم",
      avatarDataUrl: "data:image/png;base64,AAA",
      bannerDataUrl: "data:image/png;base64,BBB",
      bio: "نبذة"
    },
    after: { enabled: false }
  });
  assert.deepEqual(
    changedAppearanceFields(disabled).sort(),
    ["bannerDataUrl", "bio", "guildAvatarDataUrl", "nickname"].sort()
  );
});

test("re-saving an already-disabled profile sends nothing", () => {
  // The values are still in the form — the operator can switch it back on — but
  // the effective view is already empty, so there is nothing left to clear.
  const twice = plan({
    before: {
      enabled: false,
      nickname: "اسم",
      avatarDataUrl: "data:image/png;base64,AAA",
      bannerDataUrl: "data:image/png;base64,BBB",
      bio: "نبذة"
    },
    after: {
      enabled: false,
      nickname: "اسم",
      avatarDataUrl: "data:image/png;base64,AAA",
      bannerDataUrl: "data:image/png;base64,BBB",
      bio: "نبذة"
    }
  });
  assert.deepEqual(changedAppearanceFields(twice), [], "a disabled profile costs no Discord calls");
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

test("the member fields name Change Nickname, which is the permission they need", () => {
  // The four member fields travel in one Modify Current Member call and all four
  // need the same permission. Naming it per field is what tells the operator
  // that a refused banner is not a Manage Roles problem.
  for (const field of ["guildAvatarDataUrl", "bannerDataUrl", "bio"] as const) {
    const failure = describeAppearanceFailure(field, new DiscordApiError(403, "/x", ""));
    assert.equal(failure.code, "MISSING_PERMISSION");
    assert.match(failure.message, /تغيير الاسم المستعار/, `${field} must name Change Nickname`);
  }
});

test("a rate limit tells the operator how long to wait", () => {
  const failure = describeAppearanceFailure("guildAvatarDataUrl", new DiscordApiError(429, "/x", "", 4.2));
  assert.equal(failure.code, "RATE_LIMITED");
  assert.match(failure.message, /5 ثانية/, "the wait is rounded up, never down");
});

test("a rate limit with no hint does not read as 'wait zero'", () => {
  // `retryAfterSeconds` is null when Discord gave no hint. Rendering that as
  // "بعد 0 ثانية" would invite an immediate retry into the same limit.
  const failure = describeAppearanceFailure("guildAvatarDataUrl", new DiscordApiError(429, "/x", "", null));
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
  // look at. Each field must be identifiable from the message alone — and the
  // list is the same one `changedAppearanceFields` can report, so a renamed
  // field cannot slip past with the wrong label.
  const fields = ["nickname", "guildAvatarDataUrl", "bannerDataUrl", "bio", "roleColor", "roleIconUrl"] as const;
  const labels = ["الاسم المستعار", "صورة السيرفر", "البانر", "النبذة التعريفية", "لون الرتبة", "أيقونة الرتبة"];

  for (const [index, field] of fields.entries()) {
    const failure = describeAppearanceFailure(field, new DiscordApiError(400, "/x", ""));
    assert.ok(
      failure.message.includes(labels[index]!),
      `${field}'s message must name it — got: ${failure.message}`
    );
  }
});

/* ------------------------------------------------------------------ *
 * The member profile read's cache
 *
 * The identity screen reads what Discord serves for the bot in this guild every
 * time it opens, and Discord rate-limits per application rather than per route —
 * so the burst these tests pin is the one that produces the "Discord يحدّ عدد
 * الطلبات" bar. The cache is the fix, and it is invisible in the response:
 * without a test, a later refactor could delete it and the only symptom would be
 * a 429 an operator sees.
 * ------------------------------------------------------------------ */

const TOKEN = "token";
const GUILD = "111";
const BOT = "222";

/** Counts Discord calls and answers the two endpoints the member read needs. */
function stubDiscord() {
  const calls: string[] = [];
  (globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown) => {
    const url = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
    const path = url.replace("https://discord.com/api/v10", "");
    calls.push(path);
    const body = path === "/users/@me"
      ? { username: "AL AI", avatar: "accounthash", banner: "accountbanner" }
      : { nick: "AL هنا", avatar: "guildhash", banner: "guildbanner", user: { username: "AL AI", avatar: "accounthash" } };
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  return calls;
}

test.beforeEach(() => {
  // Module-level state: without this the first test would answer every later one
  // from its own cache and the counts below would all read zero.
  invalidateGuildMemberProfile(TOKEN, GUILD);
  invalidateGuildMemberProfile(TOKEN, "999");
});

test("the member read costs two Discord calls and returns the guild's own values", async () => {
  const calls = stubDiscord();
  const profile = await readGuildMemberProfile(TOKEN, GUILD, BOT);

  assert.equal(profile?.nickname, "AL هنا");
  assert.equal(profile?.avatar, "guildhash", "this server's avatar, not the account's");
  assert.equal(profile?.banner, "guildbanner");
  assert.deepEqual(calls.sort(), [`/guilds/${GUILD}/members/${BOT}`, "/users/@me"].sort());
});

test("a second read inside the TTL costs nothing", async () => {
  const calls = stubDiscord();
  await readGuildMemberProfile(TOKEN, GUILD, BOT);
  const before = calls.length;

  await readGuildMemberProfile(TOKEN, GUILD, BOT);

  assert.equal(calls.length, before, "the cached profile was served from memory");
});

test("concurrent reads share one request rather than racing", async () => {
  // This is the property that actually kills the burst — a TTL alone does not.
  // Two screens opening in the same tick both find an empty cache, so without
  // coalescing they both reach Discord.
  const calls = stubDiscord();
  await Promise.all([readGuildMemberProfile(TOKEN, GUILD, BOT), readGuildMemberProfile(TOKEN, GUILD, BOT)]);

  assert.equal(calls.length, 2, "one member read and one account read, not two of each");
});

test("one guild's profile is never served for another", async () => {
  // The cache is keyed by guild as well as by token. Keyed on the token alone it
  // would answer with another server's nickname, which looks exactly like a
  // correct answer — the worst kind of wrong.
  const calls = stubDiscord();
  const first = await readGuildMemberProfile(TOKEN, GUILD, BOT);
  const second = await readGuildMemberProfile(TOKEN, "999", BOT);

  assert.equal(calls.length, 4, "the second guild is a separate read, not a cache hit");
  assert.equal(first?.nickname, "AL هنا");
  assert.equal(second?.nickname, "AL هنا", "the stub answers the same for both, but the key is what proves it");
  assert.ok(calls.includes(`/guilds/999/members/${BOT}`), "the second guild was actually asked about");
});

test("a save drops the memoised profile for that guild", async () => {
  // Without the invalidation the preview would keep showing the old picture for
  // a minute after a save that succeeded.
  const calls = stubDiscord();
  await readGuildMemberProfile(TOKEN, GUILD, BOT);
  invalidateGuildMemberProfile(TOKEN, GUILD);
  await readGuildMemberProfile(TOKEN, GUILD, BOT);

  assert.equal(calls.length, 4, "the read ran again after the write");
});

test("losing the account read does not cost the guild's own values", async () => {
  // `/users/@me` is advisory: it supplies the fallback picture, and the guild's
  // override is the answer to the question being asked. A Discord hiccup on one
  // of the two must not blank the other.
  const calls: string[] = [];
  (globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown) => {
    const url = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
    const path = url.replace("https://discord.com/api/v10", "");
    calls.push(path);
    if (path === "/users/@me") throw new TypeError("fetch failed");
    return new Response(
      JSON.stringify({ nick: "AL هنا", avatar: "guildhash", banner: "guildbanner", user: { username: "AL AI", avatar: "accounthash" } }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  const profile = await readGuildMemberProfile(TOKEN, GUILD, BOT);

  assert.equal(profile?.nickname, "AL هنا");
  assert.equal(profile?.avatar, "guildhash");
  assert.equal(profile?.accountAvatar, "accounthash", "the fallback still arrives, from the member's own user object");
  assert.equal(profile?.accountBanner, null, "and the missing half degrades to null rather than failing the read");
});

test("a failed read with an emptied cache answers null rather than guessing", async () => {
  const calls = stubDiscord();
  await readGuildMemberProfile(TOKEN, GUILD, BOT);

  (globalThis as unknown as { fetch: unknown }).fetch = async () => {
    calls.push("failed");
    throw new TypeError("fetch failed");
  };
  // Invalidating drops the entry, so there is genuinely nothing to fall back
  // on. The honest answer is null — a preview that invents a profile is worse
  // than one that says it could not read it. (The "serve the stale value"
  // branch of `TtlCache.resolve` needs an *expired* entry to reach, which this
  // file cannot produce without waiting out the minute-long TTL.)
  invalidateGuildMemberProfile(TOKEN, GUILD);

  assert.equal(await readGuildMemberProfile(TOKEN, GUILD, BOT), null, "no cached value means no answer, not a guess");
});

test("a read that fails with nothing cached answers null rather than throwing", async () => {
  (globalThis as unknown as { fetch: unknown }).fetch = async () => {
    throw new TypeError("fetch failed");
  };
  assert.equal(await readGuildMemberProfile(TOKEN, GUILD, BOT), null);
});

/* ------------------------------------------------------------------ *
 * The role icon gate
 *
 * The screen disables this field below boost level 2, so the field is
 * *omitted* from the request — which makes "absent" the normal case, not an
 * edge one. Reading it as null would wipe a stored icon, and answering 409
 * would fail the whole form over one control the operator cannot touch. Both
 * were live defects; both are decided here.
 * ------------------------------------------------------------------ */

const ICON = "data:image/png;base64,AAAA";

test("an omitted role icon leaves the stored one alone", () => {
  // Not "clears it": the screen omits the field whenever the guild is below
  // boost level 2, so treating absent as null would delete the icon on the next
  // unrelated save.
  const result = resolveRoleIconWrite({ sent: false, value: null, stored: ICON, locked: true, reason: "مقفلة" });
  assert.equal(result.value, ICON, "the stored icon survived a save that never mentioned it");
  assert.equal(result.deferred, null, "nothing was attempted, so nothing is reported");
});

test("a locked role icon is dropped and reported rather than failing the request", () => {
  const result = resolveRoleIconWrite({ sent: true, value: "data:image/png;base64,BBBB", stored: ICON, locked: true, reason: "يتطلب مستوى تعزيز 2" });
  assert.equal(result.value, ICON, "the stored icon is kept, not the refused one");
  assert.equal(result.deferred?.code, "ROLE_ICON_REQUIRES_BOOST");
  assert.match(result.deferred?.message ?? "", /تعزيز/, "the operator is told why");
});

test("re-sending the stored icon while locked is a no-op, not a refusal", () => {
  // Otherwise the operator is stranded: the field is disabled, so they could
  // neither change it nor clear it, and every unrelated save would report a
  // failure for a field they never touched.
  const result = resolveRoleIconWrite({ sent: true, value: ICON, stored: ICON, locked: true, reason: "مقفلة" });
  assert.equal(result.value, ICON);
  assert.equal(result.deferred, null, "an unchanged value is not a refused change");
});

test("an unlocked role icon stores what was sent, and null clears it", () => {
  const set = resolveRoleIconWrite({ sent: true, value: "data:image/png;base64,CCCC", stored: null, locked: false, reason: null });
  assert.equal(set.value, "data:image/png;base64,CCCC");
  assert.equal(set.deferred, null);

  // An explicit null is a real instruction, unlike an absent field — this is how
  // the operator removes an icon.
  const cleared = resolveRoleIconWrite({ sent: true, value: null, stored: ICON, locked: false, reason: null });
  assert.equal(cleared.value, null, "an explicit null clears it");
  assert.equal(cleared.deferred, null);
});

test("a locked write with no reason still explains itself", () => {
  // The reason comes from a Discord read that can fail; the message must not
  // come out empty when it does.
  const result = resolveRoleIconWrite({ sent: true, value: ICON, stored: null, locked: true, reason: null });
  assert.equal(result.value, null);
  assert.ok(result.deferred, "the refusal is still reported");
  assert.ok((result.deferred?.message ?? "").length > 0, "and it is never a blank sentence");
});
