import test from "node:test";
import assert from "node:assert/strict";
import { createElement, type ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { ServerOff } from "lucide-react";
import { AppShell } from "../src/components/app-shell";
import { EmptyState } from "../src/components/empty-state";
import { GuildSelector } from "../src/components/guild-selector";
import { InviteBotPanel } from "../src/components/invite-bot";
import { LoginScreen } from "../src/components/login-screen";
import { SaveBar } from "../src/components/save-bar";
import { AuditView } from "../src/views/audit";
import { DashboardView } from "../src/views/dashboard";
import { SecurityView } from "../src/views/security";
import { CommandsView } from "../src/views/settings/commands";
import { CustomizationView, HierarchyWarning } from "../src/views/settings/customization";
import { LogsView } from "../src/views/settings/logs";
import { RolesView } from "../src/views/settings/roles";
import type { Guild, HealthSnapshot, SessionInfo } from "../src/types";

/**
 * Render smoke tests.
 *
 * `vite build` proves every module resolves and every type checks, but it never
 * executes a component. These render each screen once with realistic data, so a
 * crash inside render — the kind that shows the operator a blank page — fails
 * here instead of in the browser.
 *
 * Effects do not run under `renderToString`, so a screen that fetches shows its
 * loading state. That still exercises the render path, the icon imports and the
 * formatting helpers, which is where the blank-page class of bug lives.
 */

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

const absentGuild: Guild = { ...guild, botPresent: false, tier: null, memberCount: null };

const health: HealthSnapshot = {
  status: "healthy",
  dashboard: "online",
  bot: "connected",
  database: "reachable",
  gateway: { eventsLastMinute: 0, ceiling: 120 },
  verification: { guildCount: 1, uniqueUsers: 3, reviewRequired: false, warning: null }
};

const user: SessionInfo["user"] = { id: "1", username: "owner", avatarUrl: null, expiresAt: new Date().toISOString() };

/** Every screen, with the props the shell would give it. */
const screens: [string, () => ReactElement][] = [
  ["LoginScreen", () => createElement(LoginScreen, { notice: null })],
  ["EmptyState", () => createElement(EmptyState, { icon: ServerOff, title: "لا يوجد سيرفر", description: "أضف البوت أولاً.", action: null })],
  ["SaveBar", () => createElement(SaveBar, { onSave: async () => {}, onCancel: () => {} })],
  ["InviteBotPanel", () => createElement(InviteBotPanel, { guild: absentGuild, refreshing: false, onRefresh: () => {} })],
  [
    "GuildSelector",
    () =>
      createElement(GuildSelector, {
        user,
        guilds: [guild, absentGuild],
        health,
        notice: null,
        error: null,
        refreshing: false,
        onRefresh: () => {},
        onSelect: () => {},
        onLogout: () => {}
      })
  ],
  ["DashboardView", () => createElement(DashboardView, { guild })],
  ["DashboardView on a guild without the bot", () => createElement(DashboardView, { guild: absentGuild })],
  ["AuditView", () => createElement(AuditView, { guild })],
  ["SecurityView", () => createElement(SecurityView, { guild })],
  ["CommandsView", () => createElement(CommandsView, { guild })],
  ["RolesView", () => createElement(RolesView, { guild })],
  ["CustomizationView", () => createElement(CustomizationView, { guild })],
  ["LogsView", () => createElement(LogsView, { guild })],
  [
    "AppShell",
    () =>
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
  ]
];

for (const [name, element] of screens) {
  test(`${name} renders without throwing`, () => {
    const html = renderToString(element());
    assert.ok(html.length > 0, "the screen produced markup");
  });
}

/**
 * Looks a screen up by name rather than by array position. An index keeps
 * compiling after a screen is added or removed, and silently starts asserting
 * against a different screen — which is how this test was written before.
 */
function screen(name: string) {
  const found = screens.find(([entry]) => entry === name);
  assert.ok(found, `screen ${name} is registered`);
  return found![1];
}

test("the shell renders the operator's real identity, not a placeholder", () => {
  const html = renderToString(screen("AppShell")());
  assert.match(html, /owner/, "the signed-in username is shown");
  assert.match(html, /سيرفر الاختبار/, "the selected guild name is shown");
});

/**
 * The selector is the first screen after sign-in, so a crash inside it is a
 * blank page in front of every operator. The helpers below it are covered by
 * `guild-selector.test.tsx`; this pins the markup those helpers feed, including
 * the two sections, the search field and both actions.
 */
test("the selector offers the welcome, the search and both guild sections", () => {
  // React splits interpolated text with `<!-- -->` markers, so "مرحباً، {name}!"
  // arrives as three nodes. Strip the markers to assert on the sentence a person
  // actually reads.
  const html = renderToString(screen("GuildSelector")()).replace(/<!-- -->/g, "");

  assert.match(html, /مرحباً، owner! 👑/, "the welcome names the operator");
  assert.match(html, /اختر سيرفراً لإدارة إعدادات البوت/, "the subtitle explains the screen");
  assert.match(html, /ابحث عن سيرفر\.\.\. 🔭/, "the instant search is present");

  assert.match(html, /السيرفرات النشطة/, "guilds with the bot are grouped");
  assert.match(html, /سيرفرات أخرى مؤهلة/, "guilds without the bot are grouped");
  assert.match(html, /نشط/, "a guild with the bot is badged active");
  assert.match(html, /غير مضاف/, "a guild without the bot is badged absent");

  assert.match(html, /إدارة/, "an active guild offers the dashboard");
  assert.match(html, /إضافة البوت/, "an eligible guild offers the invite");

  // A guild the bot has not joined must never advertise a member count it
  // cannot know; "غير محدد" is the honest reading.
  assert.match(html, /42 عضو/, "a known member count is rendered");
  assert.match(html, /غير محدد/, "an unknown member count is not rendered as zero");
});

test("a guild without the bot explains what to do instead of showing settings", () => {
  const html = renderToString(createElement(InviteBotPanel, { guild: absentGuild, refreshing: false, onRefresh: () => {} }));
  assert.match(html, /إضافة AL AI/, "the invite action is offered");
});

/* ------------------------------------------------------------------ *
 * Role-hierarchy advisory
 *
 * The three states have to be distinguishable in the markup, because the
 * difference between "the bot is fine" and "we could not read the roles" is
 * exactly the difference between saying nothing and inventing a warning.
 * ------------------------------------------------------------------ */

const blockedVerdict = {
  botPosition: 3,
  highestManagedPosition: 9,
  blocked: true,
  message: "رتبة AL AI في المرتبة 3، وأعلى رتبة إدارية في المرتبة 9."
};

test("a blocked hierarchy shows the advisory and the bot's standing", () => {
  const html = renderToString(createElement(HierarchyWarning, { verdict: blockedVerdict }));
  assert.match(html, /ترتيب الرتب يمنع البوت من العمل/);
  assert.match(html, /المرتبة 3/, "the bot's own position is shown");
  assert.match(html, /المرتبة 9/, "the role it cannot outrank is shown");
  assert.match(html, /الرتب/, "the fix is described");
});

test("a healthy hierarchy renders nothing", () => {
  const html = renderToString(
    createElement(HierarchyWarning, { verdict: { ...blockedVerdict, blocked: false, message: null } })
  );
  assert.equal(html, "", "no warning when there is nothing to warn about");
});

test("an unreadable hierarchy renders nothing rather than guessing", () => {
  // Null means Discord could not be reached. Showing the advisory here would
  // tell the operator to fix a problem that may not exist.
  assert.equal(renderToString(createElement(HierarchyWarning, { verdict: null })), "");
});
