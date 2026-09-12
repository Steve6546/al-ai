import test from "node:test";
import assert from "node:assert/strict";
import { createElement, type ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { ServerOff } from "lucide-react";
import { AppShell } from "../src/components/app-shell";
import { EmptyState } from "../src/components/empty-state";
import { InviteBotPanel } from "../src/components/invite-bot";
import { LoginScreen } from "../src/components/login-screen";
import { SaveBar } from "../src/components/save-bar";
import { AuditView } from "../src/views/audit";
import { DashboardView } from "../src/views/dashboard";
import { SecurityView } from "../src/views/security";
import { CommandsView } from "../src/views/settings/commands";
import { CustomizationView } from "../src/views/settings/customization";
import { LogsView } from "../src/views/settings/logs";
import { RolesView } from "../src/views/settings/roles";
import { TokensView } from "../src/views/settings/tokens";
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
  canManageIdentity: true,
  canManageLogging: true,
  canManageCommands: true,
  canManageTiers: true,
  canInvite: true
};

const absentGuild: Guild = { ...guild, botPresent: false, tier: null };

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
  ["DashboardView", () => createElement(DashboardView, { guild, health })],
  ["DashboardView without health", () => createElement(DashboardView, { guild: absentGuild, health: null })],
  ["AuditView", () => createElement(AuditView, { guild })],
  ["SecurityView", () => createElement(SecurityView, { guild })],
  ["CommandsView", () => createElement(CommandsView, { guild })],
  ["RolesView", () => createElement(RolesView, { guild })],
  ["CustomizationView", () => createElement(CustomizationView, { guild })],
  ["LogsView", () => createElement(LogsView, { guild })],
  ["TokensView", () => createElement(TokensView, { guilds: [guild] })],
  [
    "AppShell",
    () =>
      createElement(AppShell, {
        guilds: [guild],
        guild,
        selectedGuildId: guild.id,
        onSelectGuild: () => {},
        view: "dashboard",
        onView: () => {},
        health,
        user,
        refreshing: false,
        onRefresh: () => {},
        onLogout: () => {},
        children: createElement(DashboardView, { guild, health })
      })
  ]
];

for (const [name, element] of screens) {
  test(`${name} renders without throwing`, () => {
    const html = renderToString(element());
    assert.ok(html.length > 0, "the screen produced markup");
  });
}

test("the shell renders the operator's real identity, not a placeholder", () => {
  const html = renderToString(screens[13][1]());
  assert.match(html, /owner/, "the signed-in username is shown");
  assert.match(html, /سيرفر الاختبار/, "the selected guild name is shown");
});

test("a guild without the bot explains what to do instead of showing settings", () => {
  const html = renderToString(createElement(InviteBotPanel, { guild: absentGuild, refreshing: false, onRefresh: () => {} }));
  assert.match(html, /إضافة AL AI/, "the invite action is offered");
});
