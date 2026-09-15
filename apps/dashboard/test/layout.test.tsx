import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { AppShell } from "../src/components/app-shell";
import { GuildSelector } from "../src/components/guild-selector";
import { LoginScreen } from "../src/components/login-screen";
import { DashboardView } from "../src/views/dashboard";
import type { Guild, HealthSnapshot, SessionInfo } from "../src/types";

/**
 * The scrolling architecture, pinned.
 *
 * The app has exactly one scrolling element per screen and a frame that never
 * moves. That is not a styling preference — it is the whole reason the sidebar
 * and the header stay put, and every part of it is invisible to the other
 * tests: re-adding `min-h-dvh` to a screen, or dropping the `overflow: hidden`
 * on `#root`, compiles, type-checks, renders, and quietly brings back a page
 * that slides under the pointer while the sidebar rides out of view.
 *
 * So the frame is asserted directly, from two angles:
 *
 *   1. the stylesheet — the document must not be scrollable at all;
 *   2. the rendered markup — one fixed frame, one scrolling region inside it.
 *
 * The stylesheet checks strip comments first. The rules are documented right
 * where they live, and the documentation names the very properties being
 * searched for, so a naive scan would match the prose that explains the rule
 * and pass with the rule deleted.
 */

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");

/** Removes `/* … *\/` blocks so a rule cannot be satisfied by its own comment. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** The declarations inside the first rule whose selector list matches. */
function ruleBody(css: string, selector: RegExp): string {
  const match = css.match(new RegExp(`${selector.source}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `the stylesheet has a rule for ${selector}`);
  return match![1];
}

/* ------------------------------------------------------------------ *
 * 1. The document
 * ------------------------------------------------------------------ */

test("the document is one viewport tall and never scrolls", () => {
  const css = stripComments(read("../src/index.css"));

  const body = ruleBody(css, /html,\s*body,\s*#root/);
  assert.match(body, /height:\s*100[d]?vh/, "the frame is exactly one viewport tall");
  assert.match(body, /overflow:\s*hidden/, "the document itself cannot scroll");

  // `#root` is where React renders, so a height on `body` alone would leave the
  // app free to be as tall as it likes and the frame would be a fiction.
  assert.match(
    css,
    /html,\s*body,\s*#root\s*\{/,
    "#root is included — a height on body alone does not bound the app"
  );
});

/**
 * The regression this whole file exists for.
 *
 * With the document locked, `min-h-dvh` on anything inside it is either clipped
 * (taller than the frame, no way to scroll to the rest) or meaningless. The
 * four screens that used it all relied on the *window* scrolling, which is what
 * the lock removed.
 */
test("no dashboard screen asks the window to scroll", () => {
  const root = new URL("../src/", import.meta.url);
  const offenders: string[] = [];

  const walk = (dir: URL) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, dir);
      if (entry.isDirectory()) walk(child);
      else if (/\.tsx?$/.test(entry.name) && /min-h-dvh/.test(readFileSync(child, "utf8"))) {
        offenders.push(child.pathname);
      }
    }
  };
  walk(root);

  assert.deepEqual(
    offenders,
    [],
    "a `min-h-dvh` element inside a locked document is clipped; use `h-full` and let one region scroll"
  );
});

/* ------------------------------------------------------------------ *
 * 2. The shell
 * ------------------------------------------------------------------ */

const guild: Guild = {
  id: "1540515175826985080",
  name: "سيرفر الاختبار",
  iconUrl: null,
  memberCount: 42,
  tier: "owner",
  botPresent: true,
  canManage: true,
  canManageIdentity: true,
  canManageLogging: true,
  canManageCommands: true,
  canManageTiers: true,
  canInvite: true
};

const health: HealthSnapshot = {
  status: "healthy",
  dashboard: "online",
  bot: "connected",
  database: "reachable",
  gateway: { eventsLastMinute: 0, ceiling: 120 },
  verification: { guildCount: 1, uniqueUsers: 3, reviewRequired: false, warning: null }
};

const user: SessionInfo["user"] = { id: "1", username: "owner", avatarUrl: null, expiresAt: new Date().toISOString() };

/** The classes on the first opening tag with the given name. */
function classesOf(html: string, tag: string): string[] {
  const match = html.match(new RegExp(`<${tag}\\b[^>]*>`));
  assert.ok(match, `the markup contains a <${tag}>`);
  const attribute = match![0].match(/class="([^"]*)"/);
  return attribute ? attribute[1].split(/\s+/) : [];
}

const shellHtml = renderToString(
  createElement(AppShell, {
    guilds: [guild],
    guild,
    selectedGuildId: guild.id,
    onSelectGuild: () => {},
    onBrowseAll: () => {},
    view: "dashboard",
    onView: () => {},
    health,
    user,
    refreshing: false,
    onRefresh: () => {},
    onLogout: () => {},
    children: createElement(DashboardView, { guild })
  })
);

test("the shell is a fixed frame with one scrolling region", () => {
  const root = classesOf(shellHtml, "div");
  assert.ok(root.includes("h-full"), "the frame fills the locked viewport");
  assert.ok(root.includes("grid-rows-[minmax(0,1fr)]"), "the row is stated, so it can also shrink");
  assert.ok(!root.includes("min-h-dvh"), "the frame does not grow past the viewport");

  const header = classesOf(shellHtml, "header");
  assert.ok(header.includes("shrink-0"), "the header keeps its height in the flex column");
  assert.ok(
    !header.includes("sticky"),
    "the header is pinned by its column, not by `sticky` — a sticky header inside a non-scrolling column is decoration"
  );

  const main = classesOf(shellHtml, "main");
  assert.ok(main.includes("flex-1"), "the content region takes the remaining height");
  assert.ok(main.includes("min-h-0"), "…and is allowed to be smaller than its content, which is what makes it scroll");
  assert.ok(main.includes("overflow-y-auto"), "…and it is the thing that scrolls");

  const aside = classesOf(shellHtml, "aside");
  assert.ok(aside.includes("min-h-0"), "the sidebar is bounded by the frame");
  assert.ok(aside.includes("overflow-hidden"), "…and its own nav scrolls inside it");
});

test("exactly one region in the shell scrolls", () => {
  const scrollers = shellHtml.match(/overflow-y-auto/g) ?? [];
  assert.equal(
    scrollers.length,
    1,
    "a second scroll container nests a scrollbar inside a scrollbar; every screen shares the shell's one region"
  );
});

/* ------------------------------------------------------------------ *
 * 3. The screens outside the shell
 * ------------------------------------------------------------------ */

test("the guild selector pins its header and scrolls its own content", () => {
  const html = renderToString(
    createElement(GuildSelector, {
      user,
      guilds: [guild],
      health,
      notice: null,
      error: null,
      refreshing: false,
      onRefresh: () => {},
      onSelect: () => {},
      onLogout: () => {}
    })
  );

  const root = classesOf(html, "div");
  assert.ok(root.includes("h-full"), "the selector fills the locked viewport");
  assert.ok(!root.includes("min-h-dvh"), "…instead of growing past it, which would be clipped");

  const header = classesOf(html, "header");
  assert.ok(header.includes("shrink-0"), "the header keeps its height");
  assert.ok(!header.includes("sticky"), "and is pinned by its column rather than by `sticky`");

  const main = classesOf(html, "main");
  assert.ok(main.includes("flex-1") && main.includes("overflow-y-auto"), "the guild list scrolls below the header");
});

test("the sign-in screen can scroll itself when the card does not fit", () => {
  const html = renderToString(createElement(LoginScreen, { notice: null }));

  const root = classesOf(html, "div");
  assert.ok(root.includes("h-full"), "the screen fills the locked viewport");
  assert.ok(root.includes("overflow-y-auto"), "…and scrolls itself, since the document no longer can");
  assert.ok(
    !root.includes("items-center"),
    "centring is done with `my-auto` on the card: `items-center` pushes the top of an over-tall card out of reach"
  );
});
