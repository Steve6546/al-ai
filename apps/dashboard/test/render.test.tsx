import test from "node:test";
import assert from "node:assert/strict";
import { createElement, type ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { ServerOff } from "lucide-react";
import { commandCategories, commandCategoryLabels, commandFlagsFor, commandRegistry, describeAppearanceResult } from "@al-ai/core/browser";
import { AppShell } from "../src/components/app-shell";
import { ColorPicker, DISCORD_ROLE_SWATCHES, contrastingText, hexToRgb, hsvToRgb, rgbToHex, rgbToHsv } from "../src/components/color-picker";
import { EmptyState } from "../src/components/empty-state";
import { GuildSelector } from "../src/components/guild-selector";
import { InviteBotPanel } from "../src/components/invite-bot";
import { LoginScreen } from "../src/components/login-screen";
import { SaveBar } from "../src/components/save-bar";
import { Toaster } from "../src/components/toaster";
import { AuditView } from "../src/views/audit";
import { DashboardView } from "../src/views/dashboard";
import { SecurityView } from "../src/views/security";
import { CommandsBoard, CommandsView, MemberScopeSelector, PresetReasons, ScopeSelector } from "../src/views/settings/commands";
import { CustomizationView, HierarchyWarning } from "../src/views/settings/customization";
import { BotLivePreview } from "../src/views/settings/bot-preview";
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

/* ------------------------------------------------------------------ *
 * The Commands screen
 *
 * The smoke test above only reaches the loading state, because effects never
 * run under `renderToString`. Everything the operator actually reads — the
 * totals, the search field, the sections and the deep customization card — is
 * therefore asserted on the loaded board directly, with the real registry as
 * the fixture so a command added to core appears here automatically.
 * ------------------------------------------------------------------ */

const commandFlags = commandFlagsFor(new Map());
const commandSections = commandCategories.map(id => ({ id, label: commandCategoryLabels[id], description: "" }));
// The badge text arrives from the server with the commands, because
// `discord-permissions.ts` holds `bigint` values and is deliberately absent from
// the browser surface of core. That the labels themselves are real and Arabic is
// asserted in core's own test; here the question is only whether the card shows
// the one it was handed.
const permissionLabels = { BAN_MEMBERS: "حظر الأعضاء", KICK_MEMBERS: "طرد الأعضاء", MODERATE_MEMBERS: "إسكات الأعضاء" };
const boardProps = {
  commands: commandFlags,
  categories: commandSections,
  roles: [
    { id: "111111111111111111", name: "مشرف", position: 5, managed: false, isDefault: false, color: 0x5865f2 },
    { id: "222222222222222222", name: "مساعد", position: 3, managed: false, isDefault: false, color: 0 }
  ],
  channels: [{ id: "333333333333333333", name: "عام", type: "text" as const }],
  permissionLabels,
  onSave: async () => undefined,
  onSaved: async () => commandFlags
};

test("the commands board drops the totals cards and lifts the filter row to the top", () => {
  const html = renderToString(createElement(CommandsBoard, boardProps)).replace(/<!-- -->/g, "");

  // Asserted by the label text rather than by a component name: the cards were
  // removed by request, and what the operator should stop seeing is the copy.
  for (const label of ["إجمالي الأوامر", "الأوامر المفعلة", "أقسام فيها أوامر"]) {
    assert.equal(html.includes(label), false, `the «${label}» card is gone`);
  }

  assert.match(html, /ابحث عن أمر\.\.\. 🔍/, "the instant search is present");
  assert.match(html, /تفعيل الكل/, "the bulk enable action is offered");
  assert.match(html, /تعطيل الكل/, "the bulk disable action is offered");

  // "Rose to the top" has to mean something in markup, or it is a claim about a
  // screenshot. The content column's own first heading now follows the filter
  // row. The `</h3>` anchor matters: the section *nav* renders the same labels
  // as buttons, and it precedes the column, so a bare label search would match
  // the sidebar and prove nothing.
  const search = html.indexOf("ابحث عن أمر");
  const firstHeading = html.indexOf(">الأوامر الأساسية</h3>");
  assert.ok(search >= 0, "the instant search is present");
  assert.ok(firstHeading > search, "the filter row sits above the first section heading");

  // The status filter, as three pressed-state buttons rather than a dropdown.
  assert.match(html, /aria-label="تصفية حسب الحالة"/, "the status filter is grouped and labelled");
  for (const label of ["الكل", "مفعّل", "معطّل"]) {
    assert.ok(html.includes(`>${label}</button>`), `the ${label} filter is offered`);
  }

  assert.match(html, /الأوامر الأساسية/, "the core section is rendered");
  assert.match(html, /العقوبات/, "the penalties section is rendered");
  assert.match(html, /أدوات الشات/, "the chat-tools section is rendered");
});

test("the section badge reads enabled over total, so an unfinished section is visible", () => {
  const html = renderToString(createElement(CommandsBoard, boardProps)).replace(/<!-- -->/g, "");

  // The figure the operator counts the completed suite against, asserted here so
  // the number on screen and the number in the registry cannot drift apart.
  const penalties = commandFlagsFor(new Map()).filter(command => command.category === "penalties");
  assert.equal(penalties.length, 23, "the penalties section holds the completed suite");
  assert.ok(penalties.every(command => command.enabled), "and every one starts enabled");

  assert.ok(html.includes("23/23"), "the badge reads enabled over total, not the enabled count alone");
});

test("every one of the fourteen sections is offered in the sidebar, empty ones included", () => {
  const html = renderToString(createElement(CommandsBoard, boardProps)).replace(/<!-- -->/g, "");
  for (const category of commandCategories) {
    assert.ok(html.includes(commandCategoryLabels[category]), `${category} is offered in the sidebar`);
  }
  // An empty section must still be reachable: hiding it would make a planned
  // feature look like one that was never intended.
  assert.match(html, /سجلات العقوبات/, "a section with no commands is still listed");
});

test("the permission badge names Discord's requirement, and says so when there is none", () => {
  const html = renderToString(createElement(CommandsBoard, boardProps)).replace(/<!-- -->/g, "");
  assert.match(html, /يتطلب: حظر الأعضاء/, "the ban badge names Ban Members");
  assert.match(html, /يتطلب: طرد الأعضاء/, "the kick badge names Kick Members");
  // `/help` asks for nothing, and a blank badge would read as a missing value.
  assert.match(html, /متاح للجميع/, "a command with no requirement says so");
});

test("every registered command is listed under its own section", () => {
  const html = renderToString(createElement(CommandsBoard, boardProps)).replace(/<!-- -->/g, "");
  for (const command of commandRegistry) {
    assert.match(html, new RegExp(`/${command.name}`), `${command.name} is listed`);
  }
  // `/al-status` used to be answered outside the configuration pipeline, so the
  // dashboard could not honestly offer a switch for it.
  assert.match(html, /\/al-status/, "the status command is configurable");
  assert.match(html, /\/delwarn/, "the newly added commands are configurable too");
});

test("a command's switch is rendered checked or unchecked as stored", () => {
  const disabled = commandFlags.map(command => (command.name === "ban" ? { ...command, enabled: false } : command));
  const html = renderToString(createElement(CommandsBoard, { ...boardProps, commands: disabled }));
  assert.match(html, /aria-label="ban"[^>]*/, "the ban switch is rendered");
  assert.match(html, /data-state="unchecked"/, "a disabled command renders as off");
});

test("no tier selector is offered anywhere on the board", () => {
  // The tier dropdown was the thing this screen was rebuilt to remove: it asked
  // the operator to translate "moderator" into a set of people. The permission
  // badge and the scopes are what replaced it, so a tier control reappearing
  // here would be a silent return to the old model.
  const html = renderToString(createElement(CommandsBoard, boardProps)).replace(/<!-- -->/g, "");
  for (const tier of ["المالك", "مدير", "مشرف"]) {
    assert.ok(!html.includes(`>${tier}</`), `no ${tier} tier control is rendered`);
  }
});

/**
 * The scope selectors are closed popovers, and these assert exactly that.
 *
 * Asserted on the component rather than on the board on purpose: a card's body
 * is not mounted until the card is expanded, so a board-level assertion that
 * "no panel is rendered" would pass because nothing is rendered — a check that
 * succeeds on an empty set is not a check. The board-level version of this lives
 * in `mount.test.tsx`, where the card can actually be opened.
 */
test("a closed scope selector shows its meaning and none of its panel", () => {
  const html = renderToString(
    createElement(ScopeSelector, {
      label: "الرتب المسموحة",
      emptyLabel: "الكل مسموح",
      hint: "تلميح",
      items: boardProps.roles.map(role => ({ id: role.id, name: role.name, color: role.color })),
      selected: [],
      noneLabel: "لا توجد رتب",
      noun: "رتب",
      onChange: () => {}
    })
  ).replace(/<!-- -->/g, "");

  assert.match(html, /aria-label="الرتب المسموحة"/, "the trigger is labelled");
  // An empty allow-list means "everyone", which is a sentence about behaviour.
  // "لا شيء" would read as a restriction, which is the opposite of the truth.
  assert.match(html, /الكل مسموح/, "an empty allow-list says who may run the command");
  assert.doesNotMatch(html, /مسح الاختيار/, "the panel body is not in the document while it is shut");
  assert.doesNotMatch(html, /مشرف/, "nor are the entries it would offer");
});

test("a closed selector summarises what is selected, by name or by count", () => {
  const single = renderToString(
    createElement(ScopeSelector, {
      label: "الرتب المسموحة",
      emptyLabel: "الكل مسموح",
      hint: "تلميح",
      items: boardProps.roles.map(role => ({ id: role.id, name: role.name, color: role.color })),
      selected: ["111111111111111111"],
      noneLabel: "لا توجد رتب",
      noun: "رتب",
      onChange: () => {}
    })
  ).replace(/<!-- -->/g, "");

  // One entry is named. A count of "1" would make the operator open the panel to
  // find out which role they had already chosen.
  assert.match(single, /مشرف/, "a single selection is shown by name");

  const many = renderToString(
    createElement(ScopeSelector, {
      label: "القنوات المسموحة",
      emptyLabel: "الكل مسموح",
      hint: "تلميح",
      items: [{ id: "1", name: "عام" }, { id: "2", name: "إعلانات" }],
      selected: ["1", "2"],
      noneLabel: "لا توجد قنوات",
      noun: "قنوات",
      onChange: () => {}
    })
  ).replace(/<!-- -->/g, "");

  assert.match(many, /2 قنوات/, "more than one is counted rather than listed");
});

test("the member selector names what it holds without opening", () => {
  const memberById = new Map([
    ["111111111111111111", { id: "111111111111111111", name: "أحمد", avatarUrl: null }]
  ]);
  const html = renderToString(
    createElement(MemberScopeSelector, {
      label: "الأشخاص المصرحين",
      emptyLabel: "الكل مسموح",
      hint: "تلميح",
      selected: ["111111111111111111"],
      memberById,
      onChange: () => {}
    })
  ).replace(/<!-- -->/g, "");

  assert.match(html, /أحمد/, "the resolved name is on the trigger, not hidden in the panel");
  assert.match(html, /aria-label="الأشخاص المصرحين"/);
});

test("preset reasons offer a paired duration only where one can be applied", () => {
  const timeout = commandFlags.find(command => command.name === "timeout")!;
  const ban = commandFlags.find(command => command.name === "ban")!;

  const withDuration = renderToString(
    createElement(PresetReasons, {
      command: { ...timeout, presetReasons: [{ id: "p1", label: "سبام", duration: "30m" }] },
      onChange: () => {}
    })
  ).replace(/<!-- -->/g, "");
  assert.match(withDuration, /أسباب جاهزة تظهر في ديسكورد/);
  assert.match(withDuration, /سبام/, "the stored reason is shown");
  // The dropdown's own selected value is rendered by Radix in a portal, which
  // server rendering never mounts — so the control is asserted by its label,
  // which is present exactly when the command can apply a duration.
  assert.match(withDuration, /المدة المقترنة بالسبب/, "a paired duration control is offered");

  // `/ban` keeps the reason but has no duration to pair it with, so the field is
  // absent rather than present and ignored.
  const withoutDuration = renderToString(
    createElement(PresetReasons, {
      command: { ...ban, presetReasons: [{ id: "p1", label: "إعلان", duration: null }] },
      onChange: () => {}
    })
  ).replace(/<!-- -->/g, "");
  assert.match(withoutDuration, /إعلان/);
  assert.doesNotMatch(withoutDuration, /المدة المقترنة بالسبب/, "no duration control where none applies");
});

test("an empty preset list explains that the reason is typed by hand", () => {
  const ban = commandFlags.find(command => command.name === "ban")!;
  const html = renderToString(createElement(PresetReasons, { command: { ...ban, presetReasons: [] }, onChange: () => {} }));
  assert.match(html, /لا توجد أسباب جاهزة/);
});

test("an unresolvable member degrades to the raw id rather than vanishing", () => {
  // A member who has left has no name to show, and the trigger must still render:
  // the scope is stored in our own database and does not depend on Discord.
  const memberById = new Map([
    ["111111111111111111", { id: "111111111111111111", name: "أحمد", avatarUrl: null }]
  ]);
  const html = renderToString(
    createElement(MemberScopeSelector, {
      label: "الأشخاص المصرحين",
      emptyLabel: "الكل مسموح",
      hint: "تلميح",
      selected: ["111111111111111111", "999888777666555444"],
      memberById,
      onChange: () => {}
    })
  ).replace(/<!-- -->/g, "");

  // Two entries, so the trigger counts them rather than naming one. The count is
  // what tells the operator the field is customised without opening it.
  assert.match(html, /2 أعضاء/, "the trigger counts what it holds");
  // The rows themselves — including the removable one and the id field — live in
  // the panel, so they are deliberately absent here. `mount.test.tsx` opens it
  // and asserts them there, which is the only place they exist.
  assert.doesNotMatch(html, /aria-label="إزالة أحمد"/, "the removable row is in the panel, not on the page");
});

/* ------------------------------------------------------------------ *
 * The customization screen's pure pieces
 *
 * `CustomizationView` itself only reaches its loading state under
 * `renderToString`, because effects never run — so the parts that actually
 * decide what the operator sees are rendered directly, with real values.
 * ------------------------------------------------------------------ */

test("the live preview shows the nickname, the role colour and the activity", () => {
  const html = renderToString(
    createElement(BotLivePreview, {
      identity: {
        username: "AL AI",
        avatarDataUrl: null,
        bannerDataUrl: null,
        bio: "يحرس هذا السيرفر",
        status: "online",
        activityType: "watching",
        activityText: "السجلات"
      },
      guild: {
        nickname: "الحارس",
        roleColor: "#e91e63",
        roleIconUrl: null,
        guildName: "سيرفر الاختبار",
        memberCount: 42
      }
    })
  ).replace(/<!-- -->/g, "");

  assert.match(html, /الحارس/, "the per-guild nickname is previewed");
  assert.match(html, /#e91e63/i, "the chosen role colour reaches the preview");
  assert.match(html, /السجلات/, "the activity text is previewed");
  assert.match(html, /يشاهد/, "the activity kind is spelled out, not left as an icon");
  assert.match(html, /يحرس هذا السيرفر/, "the bio is previewed");
});

test("the preview falls back to the account name when no nickname is set", () => {
  const html = renderToString(
    createElement(BotLivePreview, {
      identity: {
        username: "AL AI",
        avatarDataUrl: null,
        bannerDataUrl: null,
        bio: "",
        status: "online",
        activityType: "playing",
        activityText: ""
      },
      guild: { nickname: "   ", roleColor: null, roleIconUrl: null, guildName: "س", memberCount: null }
    })
  ).replace(/<!-- -->/g, "");

  assert.match(html, /AL AI/, "a blank nickname shows the account name instead of an empty row");
  // An empty activity must not render Discord's bare "Playing" with nothing
  // after it, which is what sending a blank activity name would produce.
  assert.doesNotMatch(html, /يلعب/, "no activity line is rendered when there is no activity");
  assert.match(html, /لا يوجد نشاط ظاهر/, "the absence is stated rather than left blank");
});

test("the preview states which fields are global and which are per-guild", () => {
  // This is the part operators get wrong, so it is asserted rather than left to
  // a comment: the scope split has to be visible on the screen.
  const html = renderToString(
    createElement(BotLivePreview, {
      identity: {
        username: "AL AI",
        avatarDataUrl: null,
        bannerDataUrl: null,
        bio: "",
        status: "online",
        activityType: "playing",
        activityText: ""
      },
      guild: { nickname: "", roleColor: null, roleIconUrl: null, guildName: "س", memberCount: null }
    })
  ).replace(/<!-- -->/g, "");

  assert.match(html, /عالمي \(كل السيرفرات\)/, "the global scope is named");
  assert.match(html, /هذا السيرفر فقط/, "the per-guild scope is named");
  assert.match(html, /الصورة الرمزية، البانر، النبذة، الحالة والنشاط/, "the global fields are listed");
  assert.match(html, /الاسم المستعار، ولون وأيقونة رتبة AL AI/, "the per-guild fields are listed");
});

test("an animated-looking avatar value is rendered as a plain image, not a URL string", () => {
  // The avatar is a data URL the operator just cropped, so the preview must use
  // it directly rather than trying to resolve it as a Discord hash.
  const dataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
  const html = renderToString(
    createElement(BotLivePreview, {
      identity: {
        username: "AL AI",
        avatarDataUrl: dataUrl,
        bannerDataUrl: dataUrl,
        bio: "",
        status: "dnd",
        activityType: "playing",
        activityText: ""
      },
      guild: { nickname: "", roleColor: null, roleIconUrl: null, guildName: "س", memberCount: null }
    })
  );

  assert.match(html, /data:image\/png;base64/, "the cropped image is drawn");
  assert.doesNotMatch(html, /لا يوجد بانر/, "a banner that exists is not reported as missing");
});

/* ------------------------------------------------------------------ *
 * The colour picker
 * ------------------------------------------------------------------ */

test("the colour picker offers the swatches, a hue track and a hex field", () => {
  const html = renderToString(createElement(ColorPicker, { value: "#e91e63", onChange: () => {} })).replace(/<!-- -->/g, "");

  assert.match(html, /aria-label="اللون والتشبّع"/, "the saturation/brightness square is present");
  assert.match(html, /aria-label="درجة اللون"/, "the hue track is present");
  assert.match(html, /aria-label="قيمة اللون"/, "the hex field is present");
  assert.match(html, /#e91e63/, "the current value is seeded into the hex field");
  assert.match(html, /#1abc9c/, "the Discord swatches are offered");
  assert.match(html, /aria-label="#e91e63"/, "the selected swatch is identifiable");
});

test("the colour picker offers a way back to Discord's default", () => {
  // Rendered with no label override, so this pins the component's own default
  // wording — the exact string the customization screen shows the operator.
  const bare = renderToString(createElement(ColorPicker, { value: null, onChange: () => {} })).replace(/<!-- -->/g, "");
  assert.match(bare, /بلا لون/, "the clear option is present even when nothing is chosen yet");

  // The label is the screen's, not the component's, so it has to travel through
  // the prop rather than being hardcoded inside the picker.
  const labelled = renderToString(
    createElement(ColorPicker, { value: "#e91e63", onChange: () => {}, unsetLabel: "لون Discord الافتراضي" })
  ).replace(/<!-- -->/g, "");
  assert.match(labelled, /لون Discord الافتراضي/, "an overriding label is honoured");
});

test("a colour converts to the exact hex the BFF accepts", () => {
  // The round trip matters: a hue of 0 with zero saturation is black, and the
  // hue slider must not lose the operator's chosen hue when they drag to an edge.
  assert.equal(rgbToHex({ r: 233, g: 30, b: 99 }), "#e91e63");
  assert.equal(rgbToHex({ r: 0, g: 0, b: 0 }), "#000000");
  // A hand-rounded fixture is misleading here: at 340° the channels land on
  // 30.0000, 97.6667 and 233, and 97.6667 correctly rounds down to 0x62. So the
  // honest expectation is #e91e62 — #e91e63 is not reachable from hue 340 at all
  // (its blue is 99, which needs a different sector). What matters is that the
  // round trip is stable and lossless, which the reverse assertion below pins.
  assert.equal(rgbToHex(hsvToRgb({ h: 340, s: 203 / 233, v: 233 / 255 })), "#e91e62");

  // Hue wraps. 360 is the right edge of the hue track and must be red, not the
  // last sector; a negative hue must behave the same way.
  assert.equal(rgbToHex(hsvToRgb({ h: 360, s: 1, v: 1 })), "#ff0000", "a full turn of hue is red");
  assert.equal(rgbToHex(hsvToRgb({ h: -60, s: 1, v: 1 })), "#ff00ff", "a negative hue wraps");

  const round = rgbToHsv({ r: 233, g: 30, b: 99 });
  // The hue is left unrounded on purpose, so it is close to 340 rather than
  // exactly it. Pinning the exact value would re-introduce the very rounding
  // this test exists to prevent.
  assert.ok(Math.abs(round.h - 340) < 0.5, `the hue lands on the pink band (got ${round.h})`);
  assert.equal(rgbToHex(hsvToRgb(round)), "#e91e63", "a hex survives an HSV round trip unchanged");
  assert.equal(hexToRgb("#E91E63")!.r, 233, "uppercase hex parses");
  assert.equal(hexToRgb("not a colour"), null, "a malformed value is refused rather than guessed");
});

test("every Discord swatch survives the picker's own round trip", () => {
  // This is the failure the operator would see: the picker seeds its HSV state
  // from the chosen hex, and every drag commits `rgbToHex(hsvToRgb(state))`.
  // An off-by-one anywhere in that loop swaps the colour they clicked for a
  // neighbour — a role colour that saves as something nobody chose.
  for (const swatch of DISCORD_ROLE_SWATCHES) {
    const rgb = hexToRgb(swatch)!;
    assert.equal(rgbToHex(hsvToRgb(rgbToHsv(rgb))), swatch, `${swatch} survives HSV unchanged`);
  }
});

test("text on a swatch flips to stay readable", () => {
  assert.equal(contrastingText("#f1c40f"), "#111827", "light backgrounds get dark text");
  assert.equal(contrastingText("#11806a"), "#ffffff", "dark backgrounds get light text");
});

/* ------------------------------------------------------------------ *
 * Toasts
 * ------------------------------------------------------------------ */

test("a failure toast is an alert and a success toast is a status", () => {
  // A screen reader must interrupt for a failure and must not for a success.
  const failure = renderToString(
    createElement(Toaster, {
      toasts: [{ id: "1", tone: "error", title: "فشل الحفظ", description: "الصورة الرمزية: رفض Discord القيمة." }],
      onDismiss: () => {}
    })
  );
  assert.match(failure, /role="alert"/, "a failure interrupts");
  assert.match(failure, /فشل الحفظ/, "the title is shown");
  assert.match(failure, /الصورة الرمزية/, "the specific field is named in the detail");

  const success = renderToString(
    createElement(Toaster, { toasts: [{ id: "2", tone: "success", title: "تم الحفظ" }], onDismiss: () => {} })
  );
  assert.match(success, /role="status"/, "a success does not interrupt");
});

test("an empty toast stack renders nothing", () => {
  assert.equal(renderToString(createElement(Toaster, { toasts: [], onDismiss: () => {} })), "");
});

test("a partial save is described as partial, never as a clean success", () => {
  // The defect this guards: three fields land, the nickname is refused, and the
  // operator walks away believing the whole form took effect.
  const partial = describeAppearanceResult({
    savedAt: new Date().toISOString(),
    applied: ["avatarDataUrl", "bio"],
    failed: [{ field: "nickname", code: "MISSING_PERMISSION", message: "الاسم المستعار: البوت يحتاج صلاحية إدارة الأسماء المستعارة." }]
  });
  assert.equal(partial.ok, false, "a partial save is not reported as ok");
  assert.match(partial.message, /بعض التغييرات/, "the partial nature is stated");
  assert.match(partial.message, /الاسم المستعار/, "the field that failed is named");

  const clean = describeAppearanceResult({ savedAt: new Date().toISOString(), applied: ["nickname"], failed: [] });
  assert.equal(clean.ok, true);
  assert.match(clean.message, /تم حفظ التغييرات وتطبيقها/);

  const nothing = describeAppearanceResult({ savedAt: new Date().toISOString(), applied: [], failed: [] });
  assert.equal(nothing.ok, true);
  assert.match(nothing.message, /لا توجد تغييرات/, "an untouched form does not claim to have saved something");
});

/* ------------------------------------------------------------------ *
 * The unsaved-changes bar
 * ------------------------------------------------------------------ */

test("the save bar warns about unsaved changes and offers both actions", () => {
  const html = renderToString(
    createElement(SaveBar, { onSave: async () => {}, onCancel: () => {} })
  ).replace(/<!-- -->/g, "");

  assert.match(html, /حذارِ/, "the warning is present the moment there is a change");
  assert.match(html, /تغييرات غير محفوظة/, "the warning says what the problem is");
  assert.match(html, /حفظ التغييرات/, "the save action is offered");
  assert.match(html, /إعادة ضبط/, "the revert action is offered");
  assert.match(html, /fixed/, "the bar floats rather than pushing the layout");
});

test("the save bar's labels are overridable per screen", () => {
  // The wording belongs to the screen, not the component: a form that uses
  // "إلغاء" must be able to say so without forking the bar.
  const html = renderToString(
    createElement(SaveBar, {
      onSave: async () => {},
      onCancel: () => {},
      message: "عدّلت شيئاً",
      saveLabel: "خزّن",
      cancelLabel: "تراجع"
    })
  ).replace(/<!-- -->/g, "");

  assert.match(html, /عدّلت شيئاً/);
  assert.match(html, /خزّن/);
  assert.match(html, /تراجع/);
  assert.doesNotMatch(html, /حذارِ/, "an overridden message replaces the default rather than joining it");
});
