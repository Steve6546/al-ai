// Imported first on purpose: see the note in `dom-env.ts`. Reordering this
// below `App` silently breaks Radix portals, which is a confusing way to fail.
import { dom } from "./dom-env.js";
import test from "node:test";
import assert from "node:assert/strict";
import { createElement, StrictMode } from "react";
import { App } from "../src/App";
import { ErrorBoundary } from "../src/components/error-boundary";
import { TooltipProvider } from "../src/components/ui/tooltip";

/**
 * Client-side mount tests.
 *
 * `render.test.tsx` uses `renderToString`, which never runs effects — so a
 * fetching screen was only ever rendered in its *loading* state, and every
 * screen that fetches was effectively untested past the spinner. That gap is
 * where the black page lived: `CustomizationView` called its `useMemo` after
 * two early returns, so the loading pass ran 15 hooks and the loaded pass ran
 * 16. React answers that with "Rendered more hooks than during the previous
 * render", which does not degrade — it unmounts the tree and leaves the bare
 * page background.
 *
 * These tests mount the real tree in a real DOM, let the stubbed network
 * settle, and assert on the *loaded* render. A hook that runs on only one of
 * the two passes fails here instead of in front of an operator.
 */

const GUILD_ID = "1523473815555018782";

const guild = {
  id: GUILD_ID,
  name: "سيرفر الاختبار",
  iconUrl: null,
  memberCount: 10,
  tier: "owner",
  botPresent: true,
  canManage: true,
  canManageIdentity: true,
  canManageLogging: true,
  canManageCommands: true,
  canManageTiers: true,
  canInvite: true
};

const role = { id: "1", name: "AL AI", position: 5, managed: false, isDefault: false, color: 0 };

/**
 * Every payload the BFF can answer with, by path.
 *
 * The empty strings are deliberate rather than sloppy: `guild_customization`
 * really does hold `''` for `role_icon_url`, and `bot_identity` really does
 * hold `''` for `status_duration` and `status_expires_at` on this machine. A
 * fixture with tidy `null`s would have tested a row that does not exist.
 */
const payloads: [RegExp, unknown][] = [
  [/^\/api\/session$/, { authenticated: true, user: { id: "1", username: "owner", avatarUrl: null, expiresAt: new Date().toISOString() } }],
  [/^\/api\/health$/, { status: "healthy", dashboard: "online", bot: "connected", database: "reachable", gateway: { eventsLastMinute: 0, ceiling: 120 }, verification: { guildCount: 1, uniqueUsers: 1, reviewRequired: false, warning: null } }],
  [/^\/api\/guilds$/, { guilds: [guild] }],
  [/^\/api\/guilds\/[^/]+\/customization$/, {
    settings: { nickname: "AL uwu", roleColor: "#050572", roleIconUrl: "" },
    permissions: [
      { key: "change_nickname", label: "تغيير الاسم المستعار", granted: true },
      { key: "manage_roles", label: "إدارة الرتب", granted: null }
    ],
    hierarchy: { botPosition: 5, highestManagedPosition: 3, blocked: false, message: null },
    roleIcon: { locked: false, unknown: false, reason: null }
  }],
  [/^\/api\/bot\/identity$/, {
    settings: {
      avatarDataUrl: "",
      bannerDataUrl: "",
      bio: "استُعيد",
      status: "idle",
      activityType: "listening",
      activityText: "",
      statusDuration: "",
      statusExpiresAt: ""
    },
    snapshot: null
  }],
  [/^\/api\/guilds\/[^/]+\/commands$/, {
    categories: [{ id: "moderation", label: "أوامر الإدارة", description: "" }],
    commands: [],
    roles: [role],
    channels: [{ id: "2", name: "عام", type: "text" }]
  }],
  [/^\/api\/guilds\/[^/]+\/channels$/, { channels: [{ id: "2", name: "عام", type: "text" }] }],
  [/^\/api\/guilds\/[^/]+\/metrics$/, {
    bot: { online: true, pingMs: 30, lastSeenAt: new Date().toISOString() },
    members: { total: 10, online: null, onlineNote: null },
    punishments24h: { total: 0, ban: 0, kick: 0, timeout: 0, warn: 0 },
    recentActivity: []
  }],
  [/^\/api\/guilds\/[^/]+\/tiers$/, {
    roles: [role],
    configured: { ownerRoleIds: [], adminRoleIds: [], moderatorRoleIds: [] },
    botHighestRolePosition: 10,
    unassignable: [],
    warning: null
  }],
  [/^\/api\/guilds\/[^/]+\/logging$/, {
    settings: { enabled: true, mode: "single", globalChannelId: null, ignoredChannelIds: [], ignoredRoleIds: [], embedColor: "#5865f2", eventFlags: {}, categoryChannels: {} }
  }],
  [/^\/api\/guilds\/[^/]+\/audit$/, { counts: { total: 0, critical: 0 }, entries: [] }],
  [/^\/api\/guilds\/[^/]+\/security$/, { events: [] }],
  [/^\/api\/guilds\/[^/]+\/security\/config$/, { enabled: true, windowSeconds: 10, actionLimit: 3, notifyOwner: true, autoContain: true }]
];

function stubFetch() {
  (globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown) => {
    const raw = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
    const path = raw.split("?")[0]!;
    const match = payloads.find(([pattern]) => pattern.test(path));
    if (!match) return { ok: false, status: 404, headers: new Map(), json: async () => ({ error: "NOT_FOUND" }) };
    return { ok: true, status: 200, headers: new Map(), json: async () => match[1] };
  };
}

/** Mounts the app at a route and returns the rendered markup once settled. */
async function mount(path: string): Promise<{ html: string; errors: string[] }> {
  const { createRoot } = await import("react-dom/client");
  const { act } = await import("react");

  dom.window.history.replaceState({}, "", path);
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);

  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

  try {
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(StrictMode, null, createElement(TooltipProvider, { delayDuration: 200, children: createElement(App, null) }))
      );
    });
    // Let the stubbed fetches resolve and the resulting state changes render.
    for (let i = 0; i < 6; i += 1) {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 15)); });
    }
    // Read the markup *before* unmounting: unmounting clears the container, so
    // measuring afterwards reports an empty tree for every screen.
    const html = container.innerHTML;
    root.unmount();
    return { html, errors };
  } finally {
    console.error = originalError;
    container.remove();
  }
}

/**
 * Errors that mean the tree died. React's "not wrapped in act" notice is
 * excluded on purpose: it is a test-harness remark about scheduling, and
 * treating it as a failure would make this file red for reasons that have
 * nothing to do with what it is guarding.
 */
function fatal(errors: string[]): string[] {
  return errors.filter(
    line =>
      /more hooks than|order of Hooks|Rendered fewer hooks|Cannot read|is not a function|Minified React error/.test(line) &&
      !/not wrapped in act/.test(line)
  );
}

const views = ["dashboard", "commands", "customization", "roles", "logs", "audit", "security"];

for (const view of views) {
  test(`the ${view} screen mounts and renders its loaded state`, async () => {
    stubFetch();
    const { html, errors } = await mount(`/dashboard/${GUILD_ID}/${view}`);

    assert.deepEqual(fatal(errors), [], `${view} produced no render error`);
    // A crashed tree unmounts to nothing, so length is the honest signal: the
    // loading skeleton alone is a few hundred bytes, a loaded screen is not.
    assert.ok(html.length > 1_000, `${view} rendered a loaded screen (got ${html.length} bytes)`);
    assert.doesNotMatch(html, /جارٍ التحميل/, `${view} moved past its loading state`);
  });
}

/**
 * The screen this file exists for. Asserted on its own as well as in the loop
 * above, because "it renders something" is weaker than "it renders the form the
 * operator came here for" — and a loading skeleton satisfies the first.
 */
test("the identity screen renders its fields, not just a spinner", async () => {
  stubFetch();
  const { html } = await mount(`/dashboard/${GUILD_ID}/customization`);

  assert.match(html, /الهوية العالمية/, "the global card is rendered");
  assert.match(html, /هذا السيرفر فقط/, "the per-guild card is rendered");
  assert.match(html, /معاينة حيّة/, "the live preview is rendered");
  assert.match(html, /AL uwu/, "the stored nickname reaches the form");
  assert.match(html, /استُعيد/, "the stored bio reaches the form");
});

/**
 * The preview is the component that reads a stored row field by field, so it is
 * the one that has to tolerate a row with a missing value. `statusDuration: ""`
 * and `statusExpiresAt: ""` are what this machine's database actually holds.
 */
test("the identity screen survives a stored row with empty strings", async () => {
  stubFetch();
  const { html, errors } = await mount(`/dashboard/${GUILD_ID}/customization`);

  assert.deepEqual(fatal(errors), []);
  assert.ok(html.length > 1_000);
});

/* ------------------------------------------------------------------ *
 * The error boundary
 * ------------------------------------------------------------------ */

function Boom(): never {
  throw new Error("انفجار متعمّد داخل العرض");
}

test("a render error shows a readable card instead of a blank page", async () => {
  const { createRoot } = await import("react-dom/client");
  const { act } = await import("react");

  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);

  const originalError = console.error;
  console.error = () => undefined; // React logs the caught error; expected here.

  try {
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(ErrorBoundary, { resetKey: "a", scope: "هوية البوت", children: createElement(Boom, null) }));
    });

    const html = container.innerHTML;
    assert.match(html, /تعذّر عرض/, "the fallback is drawn");
    assert.match(html, /هوية البوت/, "the fallback names the screen that failed");
    assert.match(html, /انفجار متعمّد/, "the underlying message is shown rather than swallowed");
    root.unmount();
  } finally {
    console.error = originalError;
    container.remove();
  }
});

test("changing the reset key releases a latched error", async () => {
  const { createRoot } = await import("react-dom/client");
  const { act } = await import("react");

  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);

  const originalError = console.error;
  console.error = () => undefined;

  try {
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(ErrorBoundary, { resetKey: "a", children: createElement(Boom, null) }));
    });
    assert.match(container.innerHTML, /تعذّر عرض/, "latched on the failure");

    // Without this, navigating away would leave the error card on every screen.
    await act(async () => {
      root.render(createElement(ErrorBoundary, { resetKey: "b", children: createElement("p", null, "شاشة سليمة") }));
    });
    assert.match(container.innerHTML, /شاشة سليمة/, "the boundary recovered on a new key");
    assert.doesNotMatch(container.innerHTML, /تعذّر عرض/, "the latch was released");
    root.unmount();
  } finally {
    console.error = originalError;
    container.remove();
  }
});

/* ------------------------------------------------------------------ *
 * The status menu
 *
 * Reported as part of the crash: "check that `DropdownMenuSub`,
 * `DropdownMenuSubTrigger` and `DropdownMenuSubContent` are imported correctly
 * and work inside the Root without runtime errors". A closed menu proves
 * nothing — Radix mounts the sub-menu's content lazily — so this opens both and
 * asserts the durations are actually there.
 * ------------------------------------------------------------------ */

test("the status menu opens, and its duration sub-menu opens inside it", async () => {
  stubFetch();
  const { createRoot } = await import("react-dom/client");
  const { act } = await import("react");

  dom.window.history.replaceState({}, "", `/dashboard/${GUILD_ID}/customization`);
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);

  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

  try {
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(StrictMode, null, createElement(TooltipProvider, { delayDuration: 200, children: createElement(App, null) }))
      );
    });
    for (let i = 0; i < 6; i += 1) {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 15)); });
    }

    const trigger = dom.window.document.querySelector('[aria-label="حالة البوت"]');
    assert.ok(trigger, "the status trigger is rendered");

    await act(async () => {
      trigger!.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
      await new Promise(resolve => setTimeout(resolve, 30));
    });
    assert.equal(dom.window.document.querySelectorAll('[role="menu"]').length, 1, "the status menu opened");

    // The sub-trigger is found by its own label, not by position, so adding a
    // status to core does not silently retarget this test.
    const subTrigger = [...dom.window.document.querySelectorAll('[role="menuitem"]')].find(item =>
      item.textContent?.includes("لا تُزعجني")
    );
    assert.ok(subTrigger, "the timed status grew a sub-trigger");

    await act(async () => {
      (subTrigger as HTMLElement).click();
      await new Promise(resolve => setTimeout(resolve, 150));
    });

    assert.equal(dom.window.document.querySelectorAll('[role="menu"]').length, 2, "the sub-menu opened");
    const menuText = dom.window.document.body.textContent ?? "";
    for (const label of ["لمدة 15 دقيقة", "لمدة ساعة", "لمدة 8 ساعات", "لمدة 24 ساعة", "لمدة 3 أيام", "دائم"]) {
      assert.ok(menuText.includes(label), `the duration option «${label}» is offered`);
    }
    assert.deepEqual(fatal(errors), [], "opening the menus produced no render error");

    root.unmount();
  } finally {
    console.error = originalError;
    container.remove();
  }
});
