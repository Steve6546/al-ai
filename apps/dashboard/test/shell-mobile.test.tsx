// Imported first on purpose: see the note in `dom-env.ts`. Reordering this
// below the component imports silently breaks Radix portals.
import { dom } from "./dom-env.js";
import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { AppShell } from "@/components/app-shell";
import type { Guild, HealthSnapshot, SessionInfo } from "@/types";

/**
 * One control per screen, on every screen size.
 *
 * The shell serves two layouts from one tree: a desktop frame (rail + sidebar
 * + content) and a phone layout (header + drawer). The two drifted apart in
 * exactly the way this file exists to prevent:
 *
 *  - the theme switch ended up as a `lg:hidden` header button, so the *desktop*
 *    lost its only appearance control while the phone showed two of them;
 *  - the drawer's server list was unbounded, so a long list pushed the settings
 *    nav out of the viewport where it could not be reached or scrolled to.
 *
 * Neither is visible to a render-to-string test: the classes are all present
 * and the markup is all there. What is asserted here is the *contract* — one
 * appearance control per layout, one account control per layout, the settings
 * nav present in the drawer, and the server list bounded so it cannot crowd the
 * nav off the screen.
 */

const guild: Guild = {
  id: "111111111111111111",
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
  canInvite: true,
  canAdminInstance: true
};

const user: SessionInfo["user"] = {
  id: "1",
  username: "owner",
  avatarUrl: null,
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  isPlatformOwner: true
};

const health: HealthSnapshot = {
  status: "healthy",
  dashboard: "online",
  bot: "connected",
  database: "reachable",
  verification: { guildCount: 1, uniqueUsers: 42, reviewRequired: false, warning: null },
  gateway: { eventsLastMinute: 0, ceiling: 120 }
};

/** The shell, mounted for real so Radix portals (the drawer) actually appear. */
function mountShell(guilds: Guild[] = [guild]) {
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      createElement(AppShell, {
        guilds,
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
        children: createElement("div", null, "المحتوى")
      })
    );
  });
  return { container, root };
}

/** The drawer's trigger is the header button labelled "القائمة". */
function openDrawer(container: HTMLElement) {
  const trigger = [...container.querySelectorAll("button")].find(
    button => button.getAttribute("aria-label") === "القائمة"
  );
  assert.ok(trigger, "the header carries the drawer trigger");
  act(() => {
    (trigger as HTMLElement).click();
  });
  return dom.window.document.querySelector('[role="dialog"]') as HTMLElement | null;
}

/** Every appearance trigger on screen, whether the sidebar or the drawer owns it. */
function appearanceTriggers(root: ParentNode = dom.window.document) {
  return [...root.querySelectorAll("button")].filter(
    button => button.getAttribute("aria-label") === "المظهر"
  );
}

function accountTriggers(root: ParentNode = dom.window.document) {
  return [...root.querySelectorAll("button[data-account-trigger]")];
}

test("the desktop sidebar owns the appearance switch, and nothing else does", () => {
  const { container, root } = mountShell();
  try {
    // The sidebar is the only element that is a desktop-only column; its
    // appearance switch must exist there, because the header's used to be
    // `lg:hidden` and left the desktop with none at all.
    const sidebar = container.querySelector("aside");
    assert.ok(sidebar, "the desktop sidebar is rendered");
    const inSidebar = appearanceTriggers(sidebar);
    assert.equal(inSidebar.length, 1, "the sidebar carries exactly one appearance switch");

    // The header must not carry a second one: the phone header button was the
    // duplicate. `lg:hidden` on it is a CSS statement the test cannot evaluate,
    // so the rule is "the header does not render one at all".
    const header = container.querySelector("header");
    assert.ok(header, "the header is rendered");
    assert.equal(appearanceTriggers(header).length, 0, "the header carries no appearance switch");

    // One account control on desktop, in the sidebar.
    assert.equal(accountTriggers(sidebar).length, 1, "the sidebar carries one account control");
    assert.equal(accountTriggers(header).length, 0, "the header carries no account control");
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

test("the phone drawer carries the settings nav and one of each control", () => {
  const { container, root } = mountShell();
  try {
    const drawer = openDrawer(container);
    assert.ok(drawer, "the drawer opens");

    // The settings nav is the whole point of the drawer: every screen a phone
    // user came to reach has to be inside it.
    for (const label of ["لوحة التحكم", "رسائل الترحيب", "الحماية", "سجلات البوت"]) {
      assert.ok(
        [...drawer!.querySelectorAll("button")].some(button => (button.textContent ?? "").includes(label)),
        `the drawer offers «${label}»`
      );
    }

    assert.equal(appearanceTriggers(drawer!).length, 1, "the drawer carries exactly one appearance switch");
    assert.equal(accountTriggers(drawer!).length, 1, "the drawer carries exactly one account control");

    // And the header, with the drawer open, still carries none of either.
    const header = container.querySelector("header");
    assert.equal(appearanceTriggers(header!).length, 0, "the header carries no appearance switch");
    assert.equal(accountTriggers(header!).length, 0, "the header carries no account control");
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

test("the drawer's server list is bounded so it cannot crowd out the settings nav", () => {
  // A long list is what triggers the regression; three servers never did.
  const many: Guild[] = Array.from({ length: 14 }, (_, index) => ({
    ...guild,
    id: `1111111111111111${String(index).padStart(2, "0")}`,
    name: `سيرفر رقم ${index + 1}`,
    botPresent: index % 3 !== 0
  }));

  const { container, root } = mountShell(many);
  try {
    const drawer = openDrawer(container);
    assert.ok(drawer, "the drawer opens");

    // The server list lives in a scroll area with a viewport-height cap. jsdom
    // has no layout, so the assertion is on the class that carries the cap —
    // the value the browser turns into a height. Without it the list is
    // unbounded and the settings nav is pushed off the viewport.
    const serverNav = drawer!.querySelector('nav[aria-label="البوتات"]');
    assert.ok(serverNav, "the drawer carries the server list");
    // The ScrollArea's cap lives on the Root; the viewport is its child. The
    // cap is what the browser turns into a height.
    const viewport = serverNav!.querySelector("[data-radix-scroll-area-viewport]");
    assert.ok(viewport, "the server list is inside a scroll area");
    const scroller = viewport!.parentElement;
    assert.ok(scroller, "the scroll area has a root element");
    assert.match(
      scroller!.className,
      /max-h-\[/,
      "the server list is capped: an uncapped list pushes the settings nav below the viewport"
    );

    // The settings nav itself is the flex child that takes the rest.
    const settingsScroll = [...drawer!.querySelectorAll("[data-radix-scroll-area-viewport]")].find(
      viewport => !viewport.closest('nav[aria-label="البوتات"]')
    );
    assert.ok(settingsScroll, "the settings nav has its own scroll region");
    const settingsRoot = settingsScroll!.closest(".flex-1");
    assert.ok(settingsRoot, "the settings nav grows into the space the server list does not take");
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
