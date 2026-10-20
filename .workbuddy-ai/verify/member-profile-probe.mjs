/**
 * Can a BOT hold a per-guild profile — bio, banner, avatar?
 *
 * The types say `PATCH /guilds/{id}/members/@me` accepts `nick`, `avatar`,
 * `banner` and `bio`. Types describe what the endpoint *parses*, not what
 * Discord *stores* for a bot account, and this project has already been burned
 * by that difference: `PATCH /users/@me {bio}` answers 200 and silently ignores
 * the field. A 200 is therefore not evidence of anything here.
 *
 * So this probe measures instead of assuming, three ways:
 *
 *   1. `banner` and `avatar` come back in the member payload, so a write can be
 *      read back — a non-null hash is proof Discord stored it.
 *   2. `bio` is write-only (it is not on the member object), so it cannot be
 *      read back. The substitute is a *rejection* test: if Discord parses the
 *      field it validates its length, so an over-long bio must 400. A 200 for a
 *      4000-character bio would mean the field is being ignored.
 *   3. Everything is restored to the baseline it was read at, so the run leaves
 *      the guild exactly as it found it.
 *
 * Usage: node .workbuddy-ai/verify/member-profile-probe.mjs <guildId>
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

const env = Object.fromEntries(
  readFileSync(resolve(REPO, ".env"), "utf8")
    .split(/\r?\n/)
    .filter(line => /^[A-Z_]+\s*=/.test(line))
    .map(line => {
      const at = line.indexOf("=");
      return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
    })
);

const TOKEN = env.BOT_TOKEN;
const BOT_ID = env.DISCORD_CLIENT_ID;
const guildId = process.argv[2];

if (!TOKEN || !BOT_ID) {
  console.error("BOT_TOKEN and DISCORD_CLIENT_ID must both be set in .env");
  process.exit(2);
}
if (!guildId) {
  console.error("usage: node member-profile-probe.mjs <guildId>");
  process.exit(2);
}

const API = "https://discord.com/api/v10";

async function call(method, path, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bot ${TOKEN}`,
      "content-type": "application/json",
      "user-agent": "AL AI member-profile probe"
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let parsed = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }
  return { status: response.status, body: parsed };
}

const MEMBER = `/guilds/${guildId}/members/${BOT_ID}`;

console.log(`guild ${guildId} · bot ${BOT_ID}\n`);

/* ---- 1. baseline, read from the member object ---- */
const before = await call("GET", MEMBER);
console.log(`GET  member                     -> ${before.status}`);
if (before.status !== 200) {
  console.log(JSON.stringify(before.body, null, 2));
  process.exit(1);
}
const baseline = {
  nick: before.body.nick ?? null,
  avatar: before.body.avatar ?? null,
  banner: before.body.banner ?? null
};
console.log(`  nick   = ${JSON.stringify(baseline.nick)}`);
console.log(`  avatar = ${JSON.stringify(baseline.avatar)}`);
console.log(`  banner = ${JSON.stringify(baseline.banner)}`);
console.log(`  bio on the member object? ${Object.prototype.hasOwnProperty.call(before.body, "bio") ? "yes" : "NO — write-only"}`);

/* ---- 2. is `bio` parsed at all? an over-long value must be rejected ---- */
const tooLong = await call("PATCH", `/guilds/${guildId}/members/@me`, { bio: "x".repeat(4000) });
console.log(`\nPATCH bio=4000 chars            -> ${tooLong.status}`);
console.log(`  ${JSON.stringify(tooLong.body)?.slice(0, 400)}`);
console.log(
  tooLong.status === 400
    ? "  => the field is PARSED (Discord validated its length)"
    : "  => 2xx means the field was accepted-and-ignored, or has no length limit"
);

/* ---- 3. a normal bio ---- */
const ok = await call("PATCH", `/guilds/${guildId}/members/@me`, { bio: "AL AI — نبذة هذا السيرفر" });
console.log(`\nPATCH bio=<valid>               -> ${ok.status}`);
console.log(`  ${JSON.stringify(ok.body)?.slice(0, 400)}`);

/* ---- 4. banner: write then read back ---- */
const PNG_1x1 =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const banner = await call("PATCH", `/guilds/${guildId}/members/@me`, { banner: PNG_1x1 });
console.log(`\nPATCH banner=<1x1 png>          -> ${banner.status}`);
console.log(`  ${JSON.stringify(banner.body)?.slice(0, 400)}`);

const afterBanner = await call("GET", MEMBER);
console.log(`GET  member (after banner)      -> ${afterBanner.status}`);
console.log(`  banner = ${JSON.stringify(afterBanner.body.banner ?? null)}`);
console.log(
  afterBanner.body.banner
    ? "  => Discord STORED a per-guild banner hash"
    : "  => no banner hash came back (rejected, or 1x1 was too small)"
);

/* ---- 5. restore exactly what was read at the baseline ---- */
const restore = await call("PATCH", `/guilds/${guildId}/members/@me`, {
  nick: baseline.nick,
  avatar: baseline.avatar,
  banner: baseline.banner,
  bio: null
});
console.log(`\nPATCH restore                   -> ${restore.status}`);

const final = await call("GET", MEMBER);
console.log(`GET  member (final)             -> ${final.status}`);
console.log(`  nick   = ${JSON.stringify(final.body.nick ?? null)}  (was ${JSON.stringify(baseline.nick)})`);
console.log(`  avatar = ${JSON.stringify(final.body.avatar ?? null)}  (was ${JSON.stringify(baseline.avatar)})`);
console.log(`  banner = ${JSON.stringify(final.body.banner ?? null)}  (was ${JSON.stringify(baseline.banner)})`);
