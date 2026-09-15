// Imported first on purpose: see the note in `dom-env.ts`. Reordering this
// below `App` silently breaks Radix portals, which is a confusing way to fail.
import { dom } from "./dom-env.js";
import test from "node:test";
import assert from "node:assert/strict";
import { createElement, StrictMode, type ReactElement } from "react";
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
/**
 * The customization payload, held by reference so a test can lock the role-icon
 * gate and put it back afterwards.
 *
 * The gate matters because the field is *disabled* below boost level 2, and a
 * disabled field that is still sent to the server is what produced the 409: the
 * input was disabled, the picker beside it was not.
 */
const customizationPayload: {
  settings: { nickname: string; roleColor: string; roleIconUrl: string };
  permissions: { key: string; label: string; granted: boolean | null }[];
  hierarchy: { botPosition: number; highestManagedPosition: number; blocked: boolean; message: string | null };
  roleIcon: { locked: boolean; unknown: boolean; reason: string | null };
} = {
  settings: { nickname: "AL uwu", roleColor: "#050572", roleIconUrl: "" },
  permissions: [
    { key: "change_nickname", label: "تغيير الاسم المستعار", granted: true },
    { key: "manage_roles", label: "إدارة الرتب", granted: null }
  ],
  hierarchy: { botPosition: 5, highestManagedPosition: 3, blocked: false, message: null },
  roleIcon: { locked: false, unknown: false, reason: null }
};

const payloads: [RegExp, unknown][] = [
  [/^\/api\/session$/, { authenticated: true, user: { id: "1", username: "owner", avatarUrl: null, expiresAt: new Date().toISOString() } }],
  [/^\/api\/health$/, { status: "healthy", dashboard: "online", bot: "connected", database: "reachable", gateway: { eventsLastMinute: 0, ceiling: 120 }, verification: { guildCount: 1, uniqueUsers: 1, reviewRequired: false, warning: null } }],
  [/^\/api\/guilds$/, { guilds: [guild] }],
  [/^\/api\/guilds\/[^/]+\/customization$/, customizationPayload],
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
    /**
     * At least one real command, in the full `CommandFlag` shape.
     *
     * This list used to be empty, and the screen answers an empty list with its
     * empty state — so the board the operator actually uses was never mounted.
     * The old assertion (`html.length > 1_000`) passed on that empty state, which
     * is exactly the "fake that does not reach the code under test" problem.
     */
    commands: [{
      name: "ban",
      enabled: true,
      allowedLevel: "moderator",
      dmOnAction: false,
      deleteMessageDays: 0,
      allowedRoleIds: [],
      deniedRoleIds: [],
      allowedChannelIds: [],
      deniedChannelIds: [],
      cooldownSeconds: 0,
      autoDeleteResponseSeconds: 0,
      requireReason: false,
      defaultDuration: "permanent",
      presetReasons: [],
      category: "moderation",
      description: "حظر عضو من السيرفر.",
      minimumTier: "moderator",
      target: "member",
      supportsReason: true,
      supportsPurge: true,
      supportsNotify: true,
      supportsDuration: false
    }],
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
  /**
   * The anti-nuke payload, in the shape the route actually returns:
   * `{ config, roles, actions }` — not a flat config.
   *
   * This fixture used to be flat (`{ enabled, windowSeconds, ... }`), which the
   * screen never asked for: it reads `result.config`, so a flat fixture put
   * `undefined` into `saved`, and the panel sat on its loading card forever.
   * The test stayed green because it only checked for the string "جارٍ التحميل"
   * while the stuck card reads "جارٍ تحميل إعدادات الأمان" — a different string.
   * A fake that does not match the contract tests nothing about the screen.
   */
  [/^\/api\/guilds\/[^/]+\/security\/config$/, {
    config: { enabled: true, limits: { channelDeletesPerMinute: 3, bansPerMinute: 5, roleChangesPerMinute: 3 }, quarantineRoleId: null },
    roles: [{ id: "1", name: "AL AI", position: 5, managed: false, isDefault: false, color: 0 }],
    actions: [
      { action: "channel-delete", label: "حذف القنوات", limit: 3 },
      { action: "ban", label: "حظر الأعضاء", limit: 5 },
      { action: "role-change", label: "إنشاء الرتب وحذفها", limit: 3 }
    ]
  }]
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

/**
 * A marker that only the *loaded* screen can render, per view.
 *
 * This replaced a `html.length > 1_000` heuristic plus a single
 * `doesNotMatch(/جارٍ التحميل/)`. Both were too weak to be worth keeping: the
 * length check passes on any fat skeleton, and the loading-string check missed
 * the anti-nuke panel, whose stuck card reads "جارٍ تحميل إعدادات الأمان" — a
 * different string, so the panel could sit dead forever with the test green.
 *
 * A marker is content the view can only produce once its data arrived, which is
 * what makes the assertion mean "the screen loaded" rather than "the screen
 * rendered something".
 */
const loadedMarkers: Record<string, RegExp> = {
  dashboard: /شريط النشاط الأخير/,
  commands: /إجمالي الأوامر/,
  customization: /الهوية العالمية/,
  roles: /المالك/,
  logs: /التسجيل المركزي/,
  audit: /آخر الأحداث/,
  security: /محرّك مضاد التخريب/
};

/** Every "still loading" phrase in the app, so no screen can hide behind one. */
const LOADING_COPY = /جارٍ (التحميل|تحميل)/;

for (const view of views) {
  test(`the ${view} screen mounts and renders its loaded state`, async () => {
    stubFetch();
    const { html, errors } = await mount(`/dashboard/${GUILD_ID}/${view}`);

    assert.deepEqual(fatal(errors), [], `${view} produced no render error`);
    // Content that only exists after the data arrived — not a byte count.
    assert.match(html, loadedMarkers[view]!, `${view} rendered its loaded content, not a skeleton`);
    assert.doesNotMatch(html, LOADING_COPY, `${view} moved past every loading state, not just the first`);
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

/**
 * The two layout defects this screen shipped with, asserted on the *loaded*
 * markup — neither is visible while the screen is still loading, so
 * `renderToString` could never have caught them.
 */
test("the activity kind is the themed Select, not the operating system's", async () => {
  stubFetch();
  const { html } = await mount(`/dashboard/${GUILD_ID}/customization`);

  const start = html.indexOf('role="combobox"');
  assert.ok(start >= 0, "the activity kind renders a combobox, not a native `<select>`");

  /*
   * A window of the markup rather than a parsed tag. The trigger's class list
   * contains a literal `>` — the `[&>span]:line-clamp-1` rule from the shadcn
   * trigger — so matching "up to the first `>`" stops inside the class attribute
   * and every attribute after it looks missing. That is not a hypothetical: it
   * is exactly how this assertion first failed.
   */
  const trigger = html.slice(start, start + 1_500);
  assert.match(trigger, /aria-label="نوع النشاط"/, "…labelled as before, so the field is still reachable");
  assert.match(trigger, /w-60/, "…and narrowed, instead of stretching across the card");

  /*
   * The label is drawn by Radix into the trigger, not typed into the markup:
   * while the menu is closed the options live in a detached `DocumentFragment`
   * and the selected one is portalled into `SelectValue`. So this line is
   * asserting that the wiring works, which is the part that silently breaks —
   * an unwired `<SelectValue />` renders an empty trigger and looks like a
   * placeholder that was never filled in.
   */
  assert.match(html, /يستمع إلى/, "the stored value is spelled out in the trigger, not left blank");
});

test("the live preview stays in view while the settings scroll", async () => {
  stubFetch();
  const { html } = await mount(`/dashboard/${GUILD_ID}/customization`);

  const column = html.match(/<div class="[^"]*lg:sticky[^"]*"/);
  assert.ok(column, "the preview column is sticky");
  assert.match(column![0], /lg:top-6/, "…at the shell's own padding, so it comes to rest at the top of the content");
  assert.match(column![0], /lg:self-start/, "…and does not stretch, which would leave it nowhere to travel");
});

/* ------------------------------------------------------------------ *
 * The error boundary
 * ------------------------------------------------------------------ */

function Boom(): never {
  throw new Error("انفجار متعمّد داخل العرض");
}

/**
 * Fails on the first render and succeeds afterwards.
 *
 * The retry button is the only way back to a working screen without a manual
 * reload, so "the button is present" is not enough — it has to be shown
 * actually recovering. Arming a real failure and then clearing it is what
 * makes the difference between testing the button and testing its label.
 */
let retryArmed = true;

function Flaky(): ReactElement | null {
  if (retryArmed) throw new Error("فشل مقصود قبل إعادة المحاولة");
  return createElement("p", null, "نجحت إعادة المحاولة");
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

test("a failing screen does not take the shell down with it", async () => {
  const { createRoot } = await import("react-dom/client");
  const { act } = await import("react");

  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);

  const originalError = console.error;
  console.error = () => undefined;

  try {
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(
          "div",
          null,
          createElement("p", null, "القائمة الجانبية سليمة"),
          createElement(ErrorBoundary, { resetKey: "a", children: createElement(Boom, null) })
        )
      );
    });

    // This is the claim the component's own comment makes, and it is the whole
    // reason the boundary wraps the screen content rather than the app: an
    // uncaught render error unmounts the entire root, so without containment
    // the sibling beside the failing screen would disappear too and the
    // operator would be stranded with nothing to navigate with.
    assert.match(container.innerHTML, /القائمة الجانبية سليمة/, "the sibling outside the boundary survived");
    assert.match(container.innerHTML, /تعذّر عرض/, "and the failure is still reported");
    assert.match(container.innerHTML, /role="alert"/, "the failure is announced, not merely drawn");
    root.unmount();
  } finally {
    console.error = originalError;
    container.remove();
  }
});

test("the retry button recovers the screen without a page reload", async () => {
  const { createRoot } = await import("react-dom/client");
  const { act } = await import("react");

  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);

  const originalError = console.error;
  console.error = () => undefined;
  retryArmed = true;

  try {
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(ErrorBoundary, { resetKey: "a", scope: "هوية البوت", children: createElement(Flaky, null) })
      );
    });
    assert.match(container.innerHTML, /تعذّر عرض/, "the failure is caught first");

    const button = [...container.querySelectorAll("button")].find(el =>
      el.textContent?.includes("إعادة المحاولة")
    );
    assert.ok(button, "the fallback offers a retry button");

    // The condition that caused the failure is gone by the time the operator
    // clicks — otherwise this would only prove the button can be pressed.
    retryArmed = false;
    await act(async () => {
      (button as HTMLElement).click();
      await new Promise(resolve => setTimeout(resolve, 10));
    });

    assert.match(container.innerHTML, /نجحت إعادة المحاولة/, "the children rendered after retry");
    assert.doesNotMatch(container.innerHTML, /تعذّر عرض/, "the error card is gone");
    root.unmount();
  } finally {
    console.error = originalError;
    retryArmed = true;
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

test("a locked role icon cannot be picked and is left out of the save", async () => {
  const { createRoot } = await import("react-dom/client");
  const { act } = await import("react");

  const gate = customizationPayload.roleIcon;
  customizationPayload.roleIcon = { locked: true, unknown: false, reason: "يتطلب مستوى تعزيز 2" };
  stubFetch();

  // Wrap the stub so the body the screen actually sends can be read. The 409
  // came from this body carrying an icon the server would refuse.
  const stub = (globalThis as unknown as { fetch: (input: unknown, init?: unknown) => Promise<unknown> }).fetch;
  const writes: string[] = [];
  (globalThis as unknown as { fetch: unknown }).fetch = (input: unknown, init?: { method?: string; body?: string }) => {
    if (init?.method === "PUT") writes.push(String(init.body ?? ""));
    return stub(input, init);
  };

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

    // Disabled, not merely discouraged. A live picker let the operator attach an
    // icon the server then refused — and the refusal took the whole form with it.
    const picker = [...container.querySelectorAll("button")].find(el => el.textContent?.includes("اختيار أيقونة"));
    assert.ok(picker, "the role icon picker is rendered");
    assert.equal((picker as HTMLButtonElement).disabled, true, "the locked picker cannot be clicked");

    // Make the form dirty so the save bar appears, then save once. React tracks
    // its own value, so the native setter has to be used for the change to land.
    const nickname = container.querySelector<HTMLInputElement>("#nickname");
    assert.ok(nickname, "the nickname field is rendered");
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")?.set;
      setValue?.call(nickname, "AL محفوظ");
      nickname!.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    for (let i = 0; i < 3; i += 1) {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 15)); });
    }

    const save = [...container.querySelectorAll("button")].find(el => /حفظ/.test(el.textContent ?? ""));
    assert.ok(save, "the save bar appeared once the nickname changed");
    await act(async () => {
      (save as HTMLButtonElement).click();
      await new Promise(resolve => setTimeout(resolve, 60));
    });

    assert.equal(writes.length, 1, "exactly one customization write was sent");
    assert.doesNotMatch(writes[0]!, /roleIconUrl/, "the gated icon was left out of the request");
    assert.match(writes[0]!, /nickname/, "while the nickname it may save was sent");
    assert.deepEqual(fatal(errors), [], "the locked screen produced no render error");

    root.unmount();
  } finally {
    console.error = originalError;
    customizationPayload.roleIcon = gate;
    container.remove();
  }
});
