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
 * The shell's two layouts, pinned by contract.
 *
 * One tree serves a desktop frame (rail + sidebar + content) and a phone layout
 * (drawer + content). The rules that hold on both, and that have been broken
 * before in ways no render-to-string test can see:
 *
 *  - **The server rail is a frame column on desktop, and the drawer's leading
 *    column on a phone.** On a monitor it sits at the frame's edge, always on
 *    screen; below `lg` it is *not* a frame column — a strip that ate a
 *    permanent slice of a 375px content area — but the first column *inside*
 *    the drawer, so opening the menu reveals the servers beside the settings
 *    nav. It is never a permanent strip beside the phone content, and never
 *    missing from the drawer.
 *  - **The appearance switch lives only on the settings screen.** It used to be
 *    a popover in the sidebar and the drawer; it is now a tab in `/settings`, so
 *    the shell must carry *no* appearance trigger at all.
 *
 * What is asserted here is the contract: the frame rail is desktop-only, the
 * drawer carries its own rail plus the settings nav and exactly one account
 * control, and the shell carries no appearance control anywhere.
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

/** Every server-rail element on screen, wherever it lives. */
function railNodes(root: ParentNode = dom.window.document) {
  return [...root.querySelectorAll('nav[aria-label="البوتات"]')];
}

function accountTriggers(root: ParentNode = dom.window.document) {
  return [...root.querySelectorAll("button[data-account-trigger]")];
}

test("the server rail is a desktop frame column and a drawer column on a phone", () => {
  const { container, root } = mountShell();
  try {
    // The frame renders exactly one rail, and it is desktop-only: below `lg`
    // the strip is hidden and the drawer carries its own copy instead.
    const frameRail = railNodes(container).find(rail => !rail.closest('[role="dialog"]'));
    assert.ok(frameRail, "the frame renders a server rail");
    assert.equal(
      railNodes(container).filter(rail => !rail.closest('[role="dialog"]')).length,
      1,
      "the frame renders exactly one server rail"
    );
    assert.equal(frameRail!.closest("aside"), null, "the frame rail is not the desktop sidebar");
    // The frame rail is gated to `lg` — on a phone the drawer owns the list.
    const wrapper = frameRail!.parentElement;
    assert.ok(wrapper, "the frame rail is wrapped by its column");
    assert.match(
      wrapper!.className,
      /\bhidden\b/,
      "the frame rail is hidden below `lg` (the drawer carries it instead)"
    );
    assert.match(wrapper!.className, /lg:flex/, "the frame rail shows again at `lg`");

    // The rail holds every administrable server as a link or button.
    const items = frameRail!.querySelectorAll("a, button");
    assert.ok(items.length >= 2, "the rail carries the server and the browse control");

    // The drawer is the only rail on a phone.
    const drawer = openDrawer(container);
    assert.ok(drawer, "the drawer opens");
    const drawerRails = railNodes(drawer!);
    assert.equal(drawerRails.length, 1, "the drawer carries exactly one server rail");
    assert.ok(
      drawerRails[0].querySelectorAll("a, button").length >= 2,
      "the drawer rail carries the servers and the browse control"
    );
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

test("the shell carries no appearance switch — the settings screen owns it", () => {
  const { container, root } = mountShell();
  try {
    // The appearance control is a tab in `/settings` now. A popover here would
    // be a second source of truth for the theme.
    const appearance = [...container.querySelectorAll("button")].filter(
      button => button.getAttribute("aria-label") === "المظهر"
    );
    assert.equal(appearance.length, 0, "the shell renders no appearance trigger");

    const header = container.querySelector("header");
    assert.ok(header, "the header is rendered");
    assert.equal(
      [...header!.querySelectorAll("button")].filter(b => b.getAttribute("aria-label") === "المظهر").length,
      0,
      "the header carries no appearance switch"
    );

    // One account control on desktop, in the sidebar.
    const sidebar = container.querySelector("aside");
    assert.ok(sidebar, "the desktop sidebar is rendered");
    assert.equal(accountTriggers(sidebar!).length, 1, "the sidebar carries one account control");
    assert.equal(accountTriggers(header!).length, 0, "the header carries no account control");
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

test("the phone drawer carries the server rail, the settings nav and one account control", () => {
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

    // The rail leads the drawer: the server list is inside it, on the phone,
    // beside the settings nav.
    const rails = railNodes(drawer!);
    assert.equal(rails.length, 1, "the drawer carries the server rail");
    assert.equal(accountTriggers(drawer!).length, 1, "the drawer carries exactly one account control");

    // And the header, with the drawer open, still carries no account control.
    const header = container.querySelector("header");
    assert.equal(accountTriggers(header!).length, 0, "the header carries no account control");
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

test("the settings nav groups are collapsible: a heading toggles its rows", () => {
  const { container, root } = mountShell();
  try {
    const drawer = openDrawer(container);
    assert.ok(drawer, "the drawer opens");

    // Both group headings are present and open by default, so every module is
    // reachable without a first click.
    for (const title of ["عام", "إعدادات الأنظمة"]) {
      const heading: HTMLButtonElement | undefined = [...drawer!.querySelectorAll("button")].find(button =>
        (button.textContent ?? "").includes(title)
      );
      assert.ok(heading, `the drawer has a «${title}» group heading`);
      assert.equal(heading.getAttribute("data-state"), "open", `«${title}» starts open`);
    }

    for (const label of ["الأوامر", "رتب الإدارة والمشرفين", "هوية البوت", "المستويات والخبرة"]) {
      assert.ok(
        [...drawer!.querySelectorAll("button")].some(button => (button.textContent ?? "").includes(label)),
        `«${label}» is a row under its group heading`
      );
    }

    // Toggling a heading folds its rows away — the accordion behaviour the
    // request restored. The trigger points at its region through `aria-controls`,
    // so the region's own state is read from the element it names.
    const modulesHeading = [...drawer!.querySelectorAll("button")].find(button =>
      (button.textContent ?? "").includes("إعدادات الأنظمة")
    )!;
    const regionId = modulesHeading.getAttribute("aria-controls");
    const region = regionId ? drawer!.querySelector(`#${CSS.escape(regionId)}`) : null;
    assert.ok(region, "the heading controls a region");
    act(() => {
      modulesHeading.click();
    });
    assert.equal(modulesHeading.getAttribute("data-state"), "closed", "the heading closes its group");
    assert.equal(region!.getAttribute("data-state"), "closed", "the group's rows are folded away");
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

test("a server without the bot is a direct invite link, not a settings route", () => {
  const absent: Guild = { ...guild, id: "222222222222222222", name: "سيرفر بدون البوت", botPresent: false };
  const { container, root } = mountShell([guild, absent]);
  try {
    const rail = railNodes(container)[0];
    assert.ok(rail, "the rail is rendered");
    const invite = [...rail.querySelectorAll("a")].find(anchor =>
      (anchor.getAttribute("href") ?? "").includes("/invite")
    );
    assert.ok(invite, "an uninvited server links straight to the invite flow");
    assert.equal(
      invite!.getAttribute("href"),
      `/api/guilds/${absent.id}/invite`,
      "the invite link targets that server"
    );
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
