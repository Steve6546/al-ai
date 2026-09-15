import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { ActivityType, Events, PermissionFlagsBits } from "discord.js";
import { activityTypeNumbers, BOT_INVITE_PERMISSIONS, DISCORD_PERMISSION_BITS } from "@al-ai/core";

/**
 * discord.js is the source of truth for Discord's own constants.
 *
 * The dashboard cannot import discord.js (GOVERNANCE rule 2 keeps it in one
 * module of the bot, and the BFF must not carry a gateway library), so the few
 * values it needs are restated in `packages/core`. A restated number is a second
 * copy, and a second copy is a second chance for the two to disagree.
 *
 * These tests close that gap: they import *both* sides and assert they are equal,
 * so a value that drifts from the official enum fails the build instead of
 * silently authorising the wrong thing. The check runs here rather than in core
 * because core is the browser-safe package and must not depend on discord.js.
 *
 * This is not hypothetical. The invite once requested MODERATE_MEMBERS where
 * ADMINISTRATOR was meant, and the bot silently could not run most of its own
 * commands — a wrong bit that no test could see.
 */

test("every shared permission bit matches discord.js PermissionFlagsBits", () => {
  const official: Record<keyof typeof DISCORD_PERMISSION_BITS, bigint> = {
    ADMINISTRATOR: PermissionFlagsBits.Administrator,
    MANAGE_GUILD: PermissionFlagsBits.ManageGuild,
    MANAGE_NICKNAMES: PermissionFlagsBits.ManageNicknames,
    CHANGE_NICKNAME: PermissionFlagsBits.ChangeNickname
  };

  for (const [name, expected] of Object.entries(official)) {
    assert.equal(
      DISCORD_PERMISSION_BITS[name as keyof typeof DISCORD_PERMISSION_BITS],
      expected,
      `${name} must equal PermissionFlagsBits.${name}`
    );
  }
});

test("the invite's permissions string is Administrator, as Discord spells it", () => {
  // Discord's OAuth endpoint takes the bitfield as a decimal string.
  assert.equal(BOT_INVITE_PERMISSIONS, String(PermissionFlagsBits.Administrator));
  assert.equal(BOT_INVITE_PERMISSIONS, "8");
});

test("Administrator is a single bit, so testing it first is meaningful", () => {
  // `hasPermission` tests Administrator before anything else because Discord
  // treats a holder as holding every permission. If Administrator ever became a
  // composite value that short-circuit would stop being correct.
  const admin = DISCORD_PERMISSION_BITS.ADMINISTRATOR;
  assert.equal(admin & (admin - 1n), 0n, "Administrator is a power of two");
});

test("every shared activity-type number matches discord.js ActivityType", () => {
  const official: Record<keyof typeof activityTypeNumbers, number> = {
    playing: ActivityType.Playing,
    listening: ActivityType.Listening,
    watching: ActivityType.Watching,
    competing: ActivityType.Competing
  };

  for (const [name, expected] of Object.entries(official)) {
    assert.equal(
      activityTypeNumbers[name as keyof typeof activityTypeNumbers],
      expected,
      `${name} must equal ActivityType.${name}`
    );
  }
});

test("no activity type is mapped to a number Discord does not define", () => {
  const known = new Set(Object.values(ActivityType).filter(value => typeof value === "number"));
  for (const [name, value] of Object.entries(activityTypeNumbers)) {
    assert.ok(known.has(value), `${name} (${value}) is not an ActivityType Discord defines`);
  }
});

/* ------------------------------------------------------------------ *
 * Event names — the same "second copy" problem, in the listener table.
 * ------------------------------------------------------------------ */

/**
 * Every `.ts` file under `dir`, with comments stripped.
 *
 * The scan below looks for `client.on("<name>")`, and this file's own
 * documentation quotes the broken registration to explain it. Without stripping
 * comments the test matches its own explanation — which it did on the first run.
 *
 * It scans the *whole tree* rather than `lib/discord.ts` alone, and that is the
 * repair this test needed: the first version had a hole exactly where the second
 * bug was. `index.ts` registered `client.once("clientReady", ...)` — the bare
 * string — and the scan never looked at `index.ts`, so the startup block that
 * seeds the guild table was invisible to the check that exists to catch it.
 * A test that only guards the file you remembered to point it at is not a guard.
 *
 * The root is pinned across the recursion so each file is keyed by its path from
 * the scan root. Deriving it from the current directory would key every file by
 * its name inside the deepest folder, and a report naming `discord.ts` instead of
 * `lib/discord.ts` is a report nobody can act on.
 */
const botSrcRoot = fileURLToPath(new URL("../src", import.meta.url));

function botSourceFiles(root: string, dir: string = root): string[] {
  return readdirSync(dir).flatMap(entry => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return botSourceFiles(root, full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

const eventScanFiles = botSourceFiles(botSrcRoot).map(path => ({
  relativePath: relative(botSrcRoot, path).replace(/\\/g, "/"),
  code: readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
}));

/**
 * Every `client.on(...)` must name an event discord.js actually emits.
 *
 * This is not a style rule. discord.js looks the name up in its own table and
 * ignores anything it does not find — no throw, no warning, no log line — so a
 * listener under a renamed or misspelled event is *invisible*: the code reads as
 * working, the operator can switch the category on in the dashboard, and nothing
 * is ever emitted.
 *
 * That is what had happened twice. The two emoji handlers were registered as
 * `guildEmojiCreate` / `guildEmojiDelete`, which are the *constant key* spellings
 * — `Events.GuildEmojiCreate` exists, but its **value** is `emojiCreate` — so the
 * `server.expression-create` and `server.expression-delete` events the schema
 * declares, `channels.json` routes, and the logs screen offers were unreachable.
 * The startup listener in `index.ts` had the same shape of mistake: `"clientReady"`
 * is the correct *value*, but writing it as a literal is what let it survive a
 * rename in the library unnoticed.
 *
 * Requiring the `Events.*` form keeps the mistake from returning through a bare
 * literal: a rename in the library then fails the build instead of falling
 * silent at runtime.
 */
test("every client listener names a real discord.js event", () => {
  const known = new Set<string>(Object.values(Events));
  const registrations: { target: string; file: string }[] = [];

  for (const file of eventScanFiles) {
    for (const match of file.code.matchAll(/client\.(?:on|once)\(([^,]+),/g)) {
      registrations.push({ target: match[1]!.trim(), file: file.relativePath });
    }
  }

  assert.ok(registrations.length >= 20, `expected the full listener set, found ${registrations.length}`);

  for (const { target, file } of registrations) {
    assert.match(target, /^Events\.[A-Za-z]+$/, `${file}: "${target}" must be an Events constant, not a bare string`);

    const value = (Events as unknown as Record<string, string>)[target.slice("Events.".length)];
    assert.ok(
      typeof value === "string" && known.has(value),
      `${file}: ${target} is not an event discord.js emits (it resolves to ${String(value)})`
    );
  }
});
