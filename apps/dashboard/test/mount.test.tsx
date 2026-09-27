// Imported first on purpose: see the note in `dom-env.ts`. Reordering this
// below `App` silently breaks Radix portals, which is a confusing way to fail.
import { dom } from "./dom-env.js";
import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement, StrictMode, type ReactElement } from "react";
import { MotionGlobalConfig } from "framer-motion";
import { commandFlagsFor } from "@al-ai/core/browser";
import { App } from "../src/App";
import { ErrorBoundary } from "../src/components/error-boundary";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { logCategories } from "../src/types";
import type { LoggingSettings } from "../src/types";
import { eventHints, eventIcons } from "../src/views/settings/logs";

// The accordion's fold runs on framer-motion's frame loop, which never advances
// in this fake DOM — an exit that takes 220ms in a browser would hold its node
// forever here. Skipping animations makes every enter and exit land in the same
// flush, so the tests assert the state machine rather than the tween.
MotionGlobalConfig.skipAnimations = true;

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
    categories: [
      { id: "penalties", label: "العقوبات", description: "" },
      // `/clear` lives here. Without this entry the board never renders it —
      // `CommandsBoard` walks the sections it was given — so the "absent where it
      // should be absent" half of the leave-retraction test would have been
      // asserting on a command that was not on the page at all.
      { id: "channel-management", label: "إدارة القنوات", description: "" }
    ],
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
      allowedUserIds: [],
      deniedUserIds: [],
      cooldownSeconds: 0,
      autoDeleteResponseSeconds: 0,
      requireReason: false,
      allowCustomReason: true,
      defaultDuration: "permanent",
      presetReasons: [],
      // The two fields the alias work added. `aliases` is not decoration here:
      // the client asserts it is an array before the screen is allowed to
      // render, so a fixture without it makes the view answer with its error
      // card — and this test then fails on a missing marker rather than on the
      // contract it actually broke.
      aliases: [],
      deleteResponseOnLeave: false,
      // The six role fields the punishment suite added. Not decoration either:
      // the board's change diff reads the three lists as arrays, so a fixture
      // without them throws before the screen renders — a failure that reads
      // like a layout problem rather than the contract it actually broke.
      mutedRoleId: null,
      prisonRoleId: null,
      prisonChannelId: null,
      blacklistRoleIds: [],
      adminRoleIdsToStrip: [],
      blockableRoleIds: [],
      category: "penalties",
      description: "حظر عضو من السيرفر.",
      minimumTier: "moderator",
      target: "member",
      supportsReason: true,
      supportsPurge: true,
      supportsNotify: true,
      supportsDuration: false,
      requiredPermission: "BAN_MEMBERS"
    }, {
      /**
       * A command that acts on a channel, not a member.
       *
       * Here so the leave-retraction control can be asserted in both
       * directions: present on `/ban`, absent on `/clear`. Asserting only the
       * present case would pass just as well if the control were rendered on
       * every command, which is the defect core's normalisation exists to stop.
       */
      name: "clear",
      enabled: true,
      allowedLevel: "moderator",
      dmOnAction: false,
      deleteMessageDays: 0,
      allowedRoleIds: [],
      deniedRoleIds: [],
      allowedChannelIds: [],
      deniedChannelIds: [],
      allowedUserIds: [],
      deniedUserIds: [],
      cooldownSeconds: 0,
      autoDeleteResponseSeconds: 0,
      requireReason: false,
      allowCustomReason: true,
      defaultDuration: "permanent",
      presetReasons: [],
      aliases: [],
      deleteResponseOnLeave: false,
      mutedRoleId: null,
      prisonRoleId: null,
      prisonChannelId: null,
      blacklistRoleIds: [],
      adminRoleIdsToStrip: [],
      blockableRoleIds: [],
      category: "channel-management",
      description: "حذف رسائل من القناة.",
      minimumTier: "moderator",
      target: "none",
      supportsReason: false,
      supportsPurge: true,
      supportsNotify: false,
      supportsDuration: false,
      requiredPermission: "MANAGE_MESSAGES"
    }],
    roles: [role],
    channels: [{ id: "2", name: "عام", type: "text" }],
    permissionLabels: { BAN_MEMBERS: "حظر الأعضاء" }
  }],
  // Only reached when a stored scope names a member. Empty scopes mean this is
  // never called, which is the common case in this fixture.
  [/^\/api\/guilds\/[^/]+\/members\?/, { members: [] }],
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
    settings: { enabled: true, mode: "normal", globalChannelId: null, ignoredChannelIds: [], ignoredRoleIds: [], embedColor: "#5865f2", categoryColors: {}, eventFlags: {}, categoryChannels: {}, eventChannels: {}, eventColors: {} }
  }],
  [/^\/api\/guilds\/[^/]+\/audit$/, { counts: { total: 0, critical: 0 }, entries: [] }],
  [/^\/api\/guilds\/[^/]+\/security$/, { events: [] }],
  [/^\/api\/guilds\/[^/]+\/welcome$/, {
    settings: { enabled: false, memberRoleId: null, botRoleId: null },
    roles: [role]
  }],
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

/**
 * Mounts the app at a route and returns the rendered markup once settled.
 *
 * `interact` runs against the live document after the data has settled and
 * before anything is read or unmounted. It exists because a portalled panel —
 * every scope selector on the commands screen is one — is rendered into
 * `document.body`, not into the container this function returns the markup of.
 * Asserting on a popover therefore has to happen from inside the document while
 * the tree is still mounted, which is exactly what this hook is for.
 */
async function mount(path: string): Promise<{ html: string; errors: string[]; result: undefined }>;
async function mount<T>(
  path: string,
  interact: (document: Document) => T | Promise<T>
): Promise<{ html: string; errors: string[]; result: T }>;
async function mount<T = undefined>(
  path: string,
  interact?: (document: Document) => T | Promise<T>
): Promise<{ html: string; errors: string[]; result: T | undefined }> {
  const { createRoot } = await import("react-dom/client");

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
    // Interaction happens here, while the tree is mounted and its portals exist.
    // `act` wraps it so the state change it causes is flushed before the markup
    // is read — without that the assertion reads the pre-click render.
    let result: T | undefined;
    if (interact) {
      await act(async () => {
        result = await interact(dom.window.document);
      });
    }
    // Read the markup *before* unmounting: unmounting clears the container, so
    // measuring afterwards reports an empty tree for every screen.
    const html = container.innerHTML;
    root.unmount();
    return { html, errors, result };
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

const views = ["dashboard", "commands", "customization", "welcome", "roles", "logs", "audit", "security"];

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
  // Was `/إجمالي الأوامر/`, one of the three totals cards. Those were removed by
  // request, so the marker moved to the section label — which is stronger anyway:
  // the old one was a static string that any render of the board would produce,
  // while this one can only appear once `categories` came back from the API.
  commands: /العقوبات/,
  customization: /الهوية العالمية/,
  welcome: /رتبة تلقائية/,
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

/* ------------------------------------------------------------------ *
 * The commands screen's rebuilt card
 *
 * Everything here needs a mounted tree. The six scope selectors are portalled
 * popovers, so their panels exist only after a real click, and a card's body is
 * not mounted at all until the card is expanded — which is why the closed-state
 * assertions in `render.test.tsx` are made on the components directly.
 * ------------------------------------------------------------------ */

/**
 * Opens a Radix trigger and waits for what it renders.
 *
 * Radix records the pointer type on `pointerdown` and toggles on `click`, so a
 * bare `.click()` is not enough — this is the same two-step the dropdown tests
 * above use.
 *
 * The `act` yield is not optional: React flushes the click's state change only
 * when the enclosing `act` scope yields, so a query made in the same tick reads
 * the tree as it was *before* the click. Without it the card looks like it never
 * opened, and the failure reads as a missing control rather than as a missing
 * await.
 */
async function openTrigger(element: Element) {
  element.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
  (element as HTMLElement).click();
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 20));
  });
}

/** The open panel for one scope field. Portalled, so it is not in the container. */
function panelFor(doc: Document, label: string): HTMLElement | null {
  return doc.querySelector<HTMLElement>(`[role="dialog"][aria-label="${label}"]`);
}

/** Replaces an input's value the way React notices, then fires the event. */
function typeInto(doc: Document, input: HTMLInputElement, value: string) {
  const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")?.set;
  setValue?.call(input, value);
  input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
}

const SCOPE_LABELS = [
  "الرتب المسموحة",
  "الرتب الممنوعة",
  "الأشخاص المصرحين",
  "الأشخاص الممنوعين",
  "القنوات المسموحة",
  "القنوات الممنوعة"
];

/** Lets React flush a state change made inside an `interact` callback. */
async function settle(ms = 20) {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, ms));
  });
}

test("the commands card opens into six closed scope selectors", async () => {
  stubFetch();
  const { result, errors } = await mount(`/dashboard/${GUILD_ID}/commands`, async doc => {
    await openTrigger(doc.querySelector('[aria-label="إعدادات ban"]')!);
    return {
      fields: SCOPE_LABELS.map(label => {
        const trigger = doc.querySelector<HTMLElement>(`[aria-label="${label}"]`);
        return {
          label,
          present: Boolean(trigger),
          summary: trigger?.textContent?.trim() ?? "",
          expanded: trigger?.getAttribute("aria-expanded")
        };
      }),
      openPanels: doc.querySelectorAll('[role="dialog"]').length
    };
  });

  assert.deepEqual(fatal(errors), [], "the opened card produced no render error");

  // Two columns of three, so every one of the six is accounted for.
  assert.equal(result.fields.length, 6);
  for (const field of result.fields) {
    assert.ok(field.present, `${field.label} is rendered`);
    assert.equal(field.expanded, "false", `${field.label} starts closed`);
  }

  // Three allow-lists read "everyone may", three deny-lists read "nobody is
  // excluded". Neither reads "nothing", which would mean the opposite.
  const summaries = result.fields.map(field => field.summary);
  assert.deepEqual(
    summaries,
    ["الكل مسموح", "بدون", "الكل مسموح", "بدون", "الكل مسموح", "بدون"],
    "each trigger carries what its empty selection means"
  );

  // The whole point of the rebuild: six selectors, not six open lists.
  assert.equal(result.openPanels, 0, "no panel is in the document until one is asked for");
});

/**
 * The punishment commands that own a role field, built by core rather than
 * hand-written.
 *
 * `commandFlagsFor` is what the server actually sends, so a fixture built from
 * it cannot be missing a field the board reads. That is precisely how the two
 * hand-written stubs above failed when this work landed: they carried the shape
 * as it was the day they were written, and the board's change diff had started
 * reading three arrays that were not in them.
 */
const roleFieldCommands = commandFlagsFor(new Map()).filter(command =>
  ["ban", "mute", "prison", "blacklist", "down", "block"].includes(command.name)
);

/** Serves a different commands payload for the duration of `run`. */
async function withCommands<T>(commands: unknown[], run: () => Promise<T>): Promise<T> {
  const entry = payloads.find(([pattern]) => pattern.test(`/api/guilds/${GUILD_ID}/commands`))!;
  const original = entry[1];
  entry[1] = { ...(original as Record<string, unknown>), commands };
  try {
    return await run();
  } finally {
    entry[1] = original;
  }
}

test("each role field is offered on the card of the command that applies it, and nowhere else", async () => {
  const expected: [string, string][] = [
    ["mute", "رتبة المكتوم"],
    ["prison", "رتبة السجن"],
    ["prison", "قناة السجن الصوتية"],
    ["blacklist", "رتب البلاك ليست"],
    ["down", "الرتب الإدارية"],
    ["block", "رتب البلوك"]
  ];

  for (const [name, label] of expected) {
    stubFetch();
    const { result, errors } = await withCommands(roleFieldCommands, () =>
      mount(`/dashboard/${GUILD_ID}/commands`, async doc => {
        await openTrigger(doc.querySelector(`[aria-label="إعدادات ${name}"]`)!);
        return {
          present: Boolean(doc.querySelector(`[aria-label="${label}"]`)),
          section: (doc.body.textContent ?? "").includes("الأدوار الخاصة")
        };
      })
    );

    assert.deepEqual(fatal(errors), [], `the /${name} card produced no render error`);
    assert.ok(result.present, `/${name} offers «${label}»`);
    assert.ok(result.section, `/${name} shows the role-fields section`);
  }

  // And the negative direction, without which the six assertions above would pass
  // just as well if the section were rendered on every card. `/ban` owns no role
  // field, so it must not offer the section at all — a control there would be one
  // that stores nothing and is then dropped by core's normalisation.
  stubFetch();
  const banOnly = await withCommands(
    roleFieldCommands.filter(command => command.name === "ban"),
    () =>
      mount(`/dashboard/${GUILD_ID}/commands`, async doc => {
        await openTrigger(doc.querySelector('[aria-label="إعدادات ban"]')!);
        return (doc.body.textContent ?? "").includes("الأدوار الخاصة");
      })
  );
  assert.deepEqual(fatal(banOnly.errors), [], "the /ban card produced no render error");
  assert.equal(banOnly.result, false, "/ban offers no role-fields section");
});

test("a scope selector opens into a list, and ticking an entry is a pending change", async () => {
  stubFetch();
  const { result, errors } = await mount(`/dashboard/${GUILD_ID}/commands`, async doc => {
    await openTrigger(doc.querySelector('[aria-label="إعدادات ban"]')!);
    const trigger = doc.querySelector<HTMLElement>('[aria-label="الرتب المسموحة"]')!;
    await openTrigger(trigger);

    const panel = panelFor(doc, "الرتب المسموحة");
    const panelsOpened = doc.querySelectorAll('[role="dialog"]').length;

    // The name is read off the row rather than hard-coded, so this asserts the
    // wiring — panel to trigger — rather than restating the fixture.
    // Scoped to the panel on purpose: a role name also appears in the app
    // shell's own navigation, so a whole-document search finds furniture.
    const rows = panel ? [...panel.querySelectorAll("label")] : [];
    const first = rows[0];
    const firstName = first?.querySelector("span.truncate")?.textContent?.trim() ?? "";
    first?.querySelector<HTMLElement>('button[role="checkbox"]')?.click();
    await settle();

    return {
      panelsOpened,
      entries: rows.length,
      firstName,
      summaryAfter: trigger.textContent?.trim() ?? "",
      saveBar: doc.body.textContent?.includes("تغيير غير محفوظ") ?? false
    };
  });

  assert.deepEqual(fatal(errors), [], "opening and ticking produced no render error");

  // `> 0` before judging anything: "the trigger names what was ticked" is
  // trivially satisfiable by an empty string on a panel that rendered no rows.
  assert.ok(result.entries > 0, "the panel really did render its entries");
  assert.ok(result.firstName.length > 0, "and the first row carries a name");
  assert.equal(result.panelsOpened, 1, "exactly one panel is open");
  // The trigger's text is the name followed by the count badge, so it is
  // asserted as "starts with the name" rather than as an exact match — the exact
  // form would be restating the markup instead of the behaviour.
  assert.ok(
    result.summaryAfter.startsWith(result.firstName),
    `the trigger names what was ticked (saw ${JSON.stringify(result.summaryAfter)})`
  );
  assert.match(result.summaryAfter, /1$/, "and counts it, so a customised field is visible while shut");
  assert.ok(result.saveBar, "ticking a scope makes the change pending rather than saving it");
});

test("the shortcut field turns a typed alias into a chip, and refuses a published name", async () => {
  stubFetch();
  const { result, errors } = await mount(`/dashboard/${GUILD_ID}/commands`, async doc => {
    await openTrigger(doc.querySelector('[aria-label="إعدادات ban"]')!);
    const input = doc.querySelector<HTMLInputElement>("#alias-ban")!;

    typeInto(doc, input, "باند");
    await settle();
    const addButton = [...doc.querySelectorAll("button")].find(button => button.textContent?.trim() === "إضافة");
    addButton?.click();
    await settle();

    const afterAdd = {
      chip: doc.body.textContent?.includes("/باند") ?? false,
      saveBar: doc.body.textContent?.includes("تغيير غير محفوظ") ?? false
    };

    // A published command name can never work as an alias: Discord resolves the
    // real command first, so it would be a shortcut that silently does nothing.
    typeInto(doc, input, "kick");
    await settle();
    const problem = [...doc.querySelectorAll("p")]
      .map(node => node.textContent ?? "")
      .find(text => text.includes("اسم أمر منشور"));

    return {
      afterAdd,
      problem: problem ?? null,
      addDisabled: [...doc.querySelectorAll("button")].find(button => button.textContent?.trim() === "إضافة")?.disabled ?? null
    };
  });

  assert.deepEqual(fatal(errors), [], "editing the shortcuts produced no render error");
  assert.ok(result.afterAdd.chip, "the alias is shown as a chip once added");
  assert.ok(result.afterAdd.saveBar, "and it is a pending change, not an instant write");
  assert.ok(result.problem, "a name that collides with a published command is explained, not swallowed");
  assert.equal(result.addDisabled, true, "and it cannot be added anyway");
});

test("delete-on-leave is offered only where a member can actually leave", async () => {
  stubFetch();
  const { result, errors } = await mount(`/dashboard/${GUILD_ID}/commands`, async doc => {
    await openTrigger(doc.querySelector('[aria-label="إعدادات ban"]')!);
    const onMemberCommand = Boolean(doc.querySelector("#retract-ban"));
    await openTrigger(doc.querySelector('[aria-label="إعدادات clear"]')!);
    return { onMemberCommand, onChannelCommand: Boolean(doc.querySelector("#retract-clear")) };
  });

  assert.deepEqual(fatal(errors), [], "no render error");

  // Both directions. `/clear` acts on a channel, so there is no departure that
  // could ever trigger the deletion — the control would be a switch that does
  // nothing, which is the defect this screen exists to avoid.
  assert.equal(result.onMemberCommand, true, "/ban acts on a member, so it offers the control");
  assert.equal(result.onChannelCommand, false, "/clear does not, so it does not");
});

/**
 * The unsaved-changes bar, driven through the interface.
 *
 * `draft-form.test.tsx` proves the hook: `dirty` is derived, `reset` restores,
 * `commit` rebases. What it cannot prove is that a *screen* wired those to the
 * floating bar an operator actually clicks — that the bar is absent over an
 * untouched form, that its two buttons do what their labels say, and that a save
 * the server refused does not quietly clear the bar, leaving the operator sure
 * an edit that was never written is safe.
 *
 * The logging screen is the driver because its save is one PUT whose echo *is*
 * the contract: the route returns the settings it stored, and the screen
 * rebases on them.
 *
 * Reading happens on the captured markup, not inside the interact hook, because
 * a click's own state change (`setSaving(true)`) is an event-handler update and
 * flushes at once, while what the awaited save produces (`setError`,
 * `setSaving(false)`, `commit`) lands as promise continuations. Those are not
 * painted until the surrounding `act` exits, and `mount()` reads the markup
 * exactly then — after the tree has settled and before it is unmounted. Reading
 * from inside the hook sees the spinner forever, which is how a working failure
 * path reads as "the bar vanished".
 */

/** The master switch's state, read out of captured markup. */
function loggingEnabled(html: string) {
  const probe = document.createElement("div");
  probe.innerHTML = html;
  return probe.querySelector('[aria-label="تفعيل السجلات"]')?.getAttribute("aria-checked") ?? null;
}

/** Toggles the logging master switch by clicking it, the way an operator does. */
async function toggleLogging(doc: Document) {
  await openTrigger(doc.querySelector('[aria-label="تفعيل السجلات"]')!);
}

/**
 * Serves the read payloads and records the logging PUT, echoing its body the
 * way the route does — or refusing it when `refusal` is set, so the failure
 * path is the server's own 409 answer rather than a simulated network drop.
 */
function stubFetchWithSave(refusal: string | null = null) {
  const puts: LoggingSettings[] = [];
  (globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
    const path = raw.split("?")[0]!;
    if (init?.method === "PUT" && path.endsWith("/logging")) {
      const body = JSON.parse(String(init.body)) as LoggingSettings;
      puts.push(body);
      if (refusal) {
        return {
          ok: false,
          status: 409,
          headers: new Map(),
          json: async () => ({ error: "VERSION_CONFLICT", message: refusal })
        };
      }
      return { ok: true, status: 200, headers: new Map(), json: async () => ({ settings: body, savedAt: new Date().toISOString() }) };
    }
    const match = payloads.find(([pattern]) => pattern.test(path));
    if (!match) return { ok: false, status: 404, headers: new Map(), json: async () => ({ error: "NOT_FOUND" }) };
    return { ok: true, status: 200, headers: new Map(), json: async () => match[1] };
  };
  return puts;
}

test("the unsaved-changes bar is absent over an untouched form and appears on a real edit", async () => {
  stubFetchWithSave();
  const { html, result, errors } = await mount(`/dashboard/${GUILD_ID}/logs`, async doc => {
    // The untouched form is read here, before the edit: this is settled state,
    // so a synchronous read is honest. The *edited* form is read from the markup
    // the harness captures once everything has flushed — see the note above.
    const barBefore = doc.querySelector('[role="status"]');
    await toggleLogging(doc);
    return { barBefore: Boolean(barBefore) };
  });

  assert.deepEqual(fatal(errors), [], "no render error");

  // Absent first: a bar over a form nobody has touched is a bar that gets
  // ignored, which is why `dirty` is derived rather than set by hand.
  assert.equal(result.barBefore, false, "no save bar before any change");
  assert.equal(loggingEnabled(html), "false", "the switch moved");
  assert.match(html, /حفظ التغييرات/, "turning the switch off shows the bar");
});

test("«إعادة ضبط» clears the bar at once and puts the control back", async () => {
  stubFetchWithSave();
  const { html, errors } = await mount(`/dashboard/${GUILD_ID}/logs`, async doc => {
    await toggleLogging(doc);
    // The bar's own button, not a keyboard shortcut or a second switch: the
    // label is the contract, and the bar keeps no copy of the data by design.
    const reset = [...doc.querySelectorAll("button")].find(element => /إعادة ضبط/.test(element.textContent ?? ""));
    assert.ok(reset, "the bar is offering its reset button");
    reset!.click();
  });

  assert.deepEqual(fatal(errors), [], "no render error");

  assert.doesNotMatch(html, /حفظ التغييرات/, "reverting clears the bar");
  // The control follows the revert rather than the two disagreeing — an operator
  // who watches the switch return to its start must not see the bar linger.
  assert.equal(loggingEnabled(html), "true", "the switch returned to its saved state");
});

test("a successful save clears the bar and keeps the server's answer", async () => {
  const puts = stubFetchWithSave();
  const { html, errors } = await mount(`/dashboard/${GUILD_ID}/logs`, async doc => {
    await toggleLogging(doc);
    const save = [...doc.querySelectorAll("button")].find(element => /حفظ التغييرات/.test(element.textContent ?? ""));
    assert.ok(save, "the bar is offering its save button");
    save!.click();
  });

  assert.deepEqual(fatal(errors), [], "no render error");

  // The PUT carried the edit — the screen did not send a stale draft.
  assert.equal(puts.length, 1, "one save request");
  assert.equal(puts[0]!.enabled, false, "the request body carries the edit");
  assert.doesNotMatch(html, /حفظ التغييرات/, "a clean save removes the bar");
  // And re-editing starts from the server's value, not the pre-edit one: a later
  // toggle is a *new* change, which is what `commit` rebasing on the echo buys.
  assert.equal(loggingEnabled(html), "false", "the saved value is what stays on screen");
});

test("a refused save keeps the change, keeps the bar, and says why", async () => {
  const refusal = "الإصدار الموجود أحدث من تعديلك؛ أعد المحاولة.";
  stubFetchWithSave(refusal);
  const { html, errors } = await mount(`/dashboard/${GUILD_ID}/logs`, async doc => {
    await toggleLogging(doc);
    const save = [...doc.querySelectorAll("button")].find(element => /حفظ التغييرات/.test(element.textContent ?? ""));
    assert.ok(save, "the bar is offering its save button");
    save!.click();
  });

  assert.deepEqual(fatal(errors), [], "no render error");

  // The bar is still up and the failure is named inside it, beside the button
  // that caused it — not only in a toast the operator may have dismissed.
  assert.match(html, /حفظ التغييرات/, "the bar stays after a failure");
  assert.match(html, new RegExp(refusal), "the server's reason is shown inside the bar");
  // The edit survived: the form does not read "saved" for something the server
  // refused, which is the lie this bar exists to avoid.
  assert.equal(loggingEnabled(html), "false", "the change is still on screen");
});

/* ------------------------------------------------------------------ *
 * The rebuilt logs screen: thirteen sections behind a sidebar, and the
 * channel setup/teardown that change the guild itself.
 *
 * The save-bar tests above drive the same `useDraftForm` every screen shares,
 * so what is left to prove here is specific to this screen's new shape: that
 * the sidebar swaps panes instead of scrolling fourteen cards, that the bulk
 * buttons move every sub-switch in a section at once, and that deleting
 * channels — the one irreversible write the dashboard offers — cannot happen
 * without a confirmation that names what it will destroy.
 * ------------------------------------------------------------------ */

/** The sidebar entry for one section, matched by its label. */
function navButton(doc: Document, label: string): HTMLElement | null {
  const nav = doc.querySelector('nav[aria-label="أقسام السجلات"]');
  return (
    [...(nav?.querySelectorAll("button") ?? [])].find(button =>
      button.textContent?.trim().startsWith(label)
    ) ?? null
  );
}

/**
 * The card the sidebar swaps in. Found by its description rather than its
 * title, because the title is one short word that other copy can contain while
 * the description is unique to the section.
 */
function sectionCard(doc: Document, description: string): Element | null {
  return [...doc.querySelectorAll("div")].find(div => div.textContent?.includes(description)) ?? null;
}

/** The active sidebar entry, read out of captured markup. */
function activeNavLabel(html: string): string | null {
  const probe = document.createElement("div");
  probe.innerHTML = html;
  return probe.querySelector('nav[aria-label="أقسام السجلات"] button[aria-current="true"]')?.textContent?.trim() ?? null;
}

test("the logs sidebar lists every section and swaps one card in for another", async () => {
  stubFetch();
  const { html: general, errors } = await mount(`/dashboard/${GUILD_ID}/logs`);

  assert.deepEqual(fatal(errors), [], "no render error");

  // The general pane is the landing one — the master switch lives here, and no
  // section card is mounted until one is chosen.
  assert.match(general, /التسجيل المركزي/);
  for (const label of logCategories.map(category => category.label)) {
    assert.match(general, new RegExp(label), `the sidebar lists «${label}»`);
  }

  const roles = logCategories.find(category => category.id === "role-log")!;
  assert.doesNotMatch(
    general,
    new RegExp(roles.description),
    "a section's card is not drawn before the operator picks it"
  );

  const { html: section } = await mount(`/dashboard/${GUILD_ID}/logs`, async doc => {
    const picked = navButton(doc, roles.label);
    assert.ok(picked, "the section has a sidebar entry");
    picked!.click();
  });

  assert.ok(activeNavLabel(section)?.startsWith(roles.label), "the sidebar marks the section now showing");
  assert.match(section, new RegExp(roles.description), "the section's card carries its description");
  // The records follow the header directly: no collapsed list to open first, so
  // every label is on the page the moment the section is picked.
  for (const event of roles.events) {
    assert.match(section, new RegExp(event.label), `the record «${event.label}» is drawn without an extra click`);
  }
  assert.doesNotMatch(section, /التسجيل المركزي/, "the general card is unmounted, not stacked above it");
});

test("«تعطيل الكل» mutes every event in a section at once", async () => {
  stubFetchWithSave();
  const voice = logCategories.find(category => category.id === "voice-log")!;

  const { html, errors } = await mount(`/dashboard/${GUILD_ID}/logs`, async doc => {
    navButton(doc, voice.label)!.click();
    await settle();
    // The bulk buttons are mounted by the sidebar swap, so the card is only
    // queryable after that click has flushed.
    const button = [...(sectionCard(doc, voice.description)?.querySelectorAll("button") ?? [])].find(
      element => element.textContent?.trim() === "تعطيل الكل"
    );
    assert.ok(button, "the section card offers «تعطيل الكل»");
    button!.click();
  });

  assert.deepEqual(fatal(errors), [], "no render error");

  assert.match(
    html,
    new RegExp(`${voice.events.length} مكتوم`),
    "every event in the section is muted, not only the visible ones"
  );
  assert.match(html, /حفظ التغييرات/, "the move lights the save bar");
});

test("«تفعيل الكل» lifts the mute and saves an explicit flag per event", async () => {
  const puts = stubFetchWithSave();
  const voice = logCategories.find(category => category.id === "voice-log")!;

  const { html, errors } = await mount(`/dashboard/${GUILD_ID}/logs`, async doc => {
    navButton(doc, voice.label)!.click();
    await settle();

    const bulk = (text: string) => {
      const button = [...(sectionCard(doc, voice.description)?.querySelectorAll("button") ?? [])].find(
        element => element.textContent?.trim() === text
      );
      assert.ok(button, `«${text}» is offered inside the section card`);
      button!.click();
    };

    bulk("تعطيل الكل");
    await settle();
    bulk("تفعيل الكل");
    await settle();

    const save = [...doc.querySelectorAll("button")].find(element => /حفظ التغييرات/.test(element.textContent ?? ""));
    assert.ok(save, "either bulk move lights the save bar");
    save!.click();
  });

  assert.deepEqual(fatal(errors), [], "no render error");

  assert.doesNotMatch(html, new RegExp(`${voice.events.length} مكتوم`), "no event is left muted");
  assert.doesNotMatch(html, /حفظ التغييرات/, "the save cleared the bar");

  // The request carries an explicit flag per event rather than relying on the
  // shipped default — which is what keeps the section on after a later change
  // to that default.
  assert.equal(puts.length, 1, "one save request");
  for (const event of voice.events) {
    assert.equal(puts[0]!.eventFlags[event.id], true, `${event.id} is explicitly on after «تفعيل الكل»`);
  }
});

/**
 * Both maps fall back — a missing icon renders the generic glyph, a missing hint
 * renders no line — so a record added to the schema without an entry looks
 * merely plainer than its neighbours, which nothing else in the build surfaces.
 */
test("every record carries an icon and a line naming when it fires", () => {
  const missingIcons: string[] = [];
  const missingHints: string[] = [];

  for (const category of logCategories) {
    for (const event of category.events) {
      if (!(event.id in eventIcons)) missingIcons.push(event.id);
      if (!(event.id in eventHints)) missingHints.push(event.id);
    }
  }

  assert.deepEqual(
    missingIcons,
    [],
    "these records would render with the generic glyph: " + missingIcons.join(", ")
  );
  assert.deepEqual(
    missingHints,
    [],
    "these records would render with no firing line: " + missingHints.join(", ")
  );
});

test("a record card ships compact when off and unfolds when switched on", async () => {
  stubFetchWithSave();
  const roles = logCategories.find(category => category.id === "role-log")!;
  const first = roles.events[0]!;

  // Ship the record disabled so the compact state is the *initial* render of
  // its card: a card that enters with the switch off has no fold to wait for,
  // so the pickers' absence is real and not pending behind an exit animation
  // (which this fake DOM's frame loop never advances). The fold-back on
  // deactivation is the same conditional render in reverse, driven by the same
  // state — only its timing lives in the browser.
  const loggingEntry = payloads.find(([pattern]) => pattern.test("/api/guilds/x/logging"))!;
  const originalPayload = loggingEntry[1];
  loggingEntry[1] = {
    settings: {
      ...(originalPayload as { settings: LoggingSettings }).settings,
      eventFlags: { [first.id]: false }
    }
  };

  /** The record's own switch, found by its aria-label inside the section card. */
  const recordSwitch = (doc: Document): HTMLElement =>
    [...(sectionCard(doc, roles.description)?.querySelectorAll<HTMLButtonElement>('button[role="switch"]') ?? [])].find(
      element => element.getAttribute("aria-label") === first.label
    )!;

  /** The text of the one card the switch lives in, not of its section. */
  const cardText = (doc: Document) => {
    let element = recordSwitch(doc)!.parentElement;
    while (element && !/bg-card/.test(element.className ?? "")) element = element.parentElement;
    return element?.textContent ?? "";
  };

  let compactWhenOff = false;
  let unfoldedWhenOn = false;
  try {
    const { html, errors } = await mount(`/dashboard/${GUILD_ID}/logs`, async doc => {
      navButton(doc, roles.label)!.click();
      await settle();
      compactWhenOff =
        cardText(doc).includes(first.label) && !cardText(doc).includes("قناة السجل") && !cardText(doc).includes("لون السجل");

      recordSwitch(doc)!.click();
      await settle();
      unfoldedWhenOn = cardText(doc).includes("قناة السجل") && cardText(doc).includes("لون السجل");
    });

    assert.deepEqual(fatal(errors), [], "no render error");
    assert.equal(compactWhenOff, true, "an off record is a compact card: name and firing line, no pickers");
    assert.equal(unfoldedWhenOn, true, "switching on unfolds the channel and colour pickers");
    assert.match(html, /قناة السجل/, "the unfolded card carries the channel picker in the final render");
    assert.match(html, /لون السجل/, "…and the colour picker");
  } finally {
    loggingEntry[1] = originalPayload;
  }
});

test("the logs page carries the stats banner, the X/N sidebar counts, and no premium badge", async () => {
  stubFetch();
  const { html, errors } = await mount(`/dashboard/${GUILD_ID}/logs`);

  assert.deepEqual(fatal(errors), [], "no render error");

  assert.match(html, /تتبع جميع الأحداث في السيرفر/, "the banner names what the screen does");
  for (const label of ["إجمالي السجلات", "السجلات المفعلة", "الأقسام", "القنوات المستخدمة"]) {
    assert.match(html, new RegExp(label), `the banner carries the «${label}» pill`);
  }
  // The sidebar count is enabled/total, rendered LTR so "0/18" does not read as
  // "18/0". Unset flags read as enabled, so a fresh guild shows every count full.
  const members = logCategories.find(category => category.id === "member-log")!;
  assert.match(
    html,
    new RegExp(`\\d+/${members.events.length}`),
    "each section row shows its enabled/total count"
  );
  // The premium-badge decision is standing: no record, section, or banner is
  // ever marked as a special tier.
  assert.doesNotMatch(html, /بوتات خاصة/, "no section or record carries a premium badge");
  assert.doesNotMatch(html, /Premium/i, "…and none carries an English one either");
});

test("a channel action starts a visible cooldown when it finishes", async () => {
  stubFetchWithChannelActions();

  const { html, errors } = await mount(`/dashboard/${GUILD_ID}/logs`, async doc => {
    const create = [...doc.querySelectorAll("button")].find(element =>
      /إنشاء قنوات عادية/.test(element.textContent ?? "")
    );
    assert.ok(create, "the normal-setup card is offered");
    create!.click();
  });

  assert.deepEqual(fatal(errors), [], "no render error");

  // The badge counts down in mm:ss and the buttons rest while it runs — that is
  // the whole contract, visible right on the card instead of a silent disable.
  assert.match(html, /\d{2}:\d{2}/, "a cooldown badge with a mm:ss countdown is visible");
  assert.match(html, /جارٍ التنفيذ…|disabled/, "the action cards are resting");
});

/**
 * Serves the read payloads and answers the two channel endpoints, echoing the
 * routing table the way the routes do. The stored settings bind one channel, so
 * the teardown dialog has a count to name.
 */
function stubFetchWithChannelActions() {
  const setups: string[] = [];
  const teardowns: string[] = [];
  const bound: LoggingSettings = {
    enabled: true,
    mode: "detailed",
    globalChannelId: null,
    ignoredChannelIds: [],
    ignoredRoleIds: [],
    embedColor: "#5865f2",
    eventFlags: {},
    categoryChannels: { "member-log": "2" },
    categoryColors: {},
    eventChannels: {},
    eventColors: {}
  };

  (globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
    const path = raw.split("?")[0]!;
    if (path.endsWith("/logging/setup") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { mode: string };
      setups.push(body.mode);
      // Echo the routing table the way the route does: normal binds one channel
      // per section, detailed binds one per record.
      const normal = body.mode === "normal";
      return {
        ok: true,
        status: 200,
        headers: new Map(),
        json: async () => ({
          settings: {
            ...bound,
            mode: body.mode,
            categoryChannels: normal ? { "member-log": "3" } : {},
            eventChannels: normal ? {} : { "member.join": "3" }
          },
          savedAt: new Date().toISOString(),
          created: [{ name: normal ? "member-log" : "member-join", channelId: "3" }],
          deleted: [],
          failed: []
        })
      };
    }
    if (path.endsWith("/logging/channels") && init?.method === "DELETE") {
      teardowns.push("delete");
      return {
        ok: true,
        status: 200,
        headers: new Map(),
        json: async () => ({
          settings: { ...bound, enabled: false, globalChannelId: null, categoryChannels: {}, eventChannels: {} },
          savedAt: new Date().toISOString(),
          deleted: ["2"],
          failed: []
        })
      };
    }
    if (path.endsWith("/logging")) {
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as LoggingSettings;
        return { ok: true, status: 200, headers: new Map(), json: async () => ({ settings: body, savedAt: new Date().toISOString() }) };
      }
      return { ok: true, status: 200, headers: new Map(), json: async () => ({ settings: bound }) };
    }
    const match = payloads.find(([pattern]) => pattern.test(path));
    if (!match) return { ok: false, status: 404, headers: new Map(), json: async () => ({ error: "NOT_FOUND" }) };
    return { ok: true, status: 200, headers: new Map(), json: async () => match[1] };
  };
  return { setups, teardowns };
}

test("deleting the log channels asks first, names the count, and only then acts", async () => {
  const { setups, teardowns } = stubFetchWithChannelActions();

  const { html, errors } = await mount(`/dashboard/${GUILD_ID}/logs`, async doc => {
    const trigger = [...doc.querySelectorAll("button")].find(element =>
      /حذف قنوات السجلات/.test(element.textContent ?? "")
    );
    assert.ok(trigger, "the teardown button is offered on the general pane");
    assert.equal(trigger!.getAttribute("disabled"), null, "it is live: one channel is currently bound");

    // The dialog is portalled, so it is only visible while the tree is mounted —
    // the assertions that name what it says happen here, against the live document.
    trigger!.click();
    await settle();
    const dialog = doc.querySelector('[role="dialog"]');
    assert.ok(dialog, "a confirmation dialog opened");
    assert.match(dialog!.textContent ?? "", /سيتم حذف 1 قناة/, "it names the channel count, not a generic warning");
    assert.match(dialog!.textContent ?? "", /لا يمكن التراجع/, "and says the move is irreversible");

    // Cancel has to leave everything exactly as it was — no request, no state.
    const cancel = [...dialog!.querySelectorAll("button")].find(element => /إلغاء/.test(element.textContent ?? ""));
    cancel!.click();
    await settle();
    assert.equal(doc.querySelectorAll('[role="dialog"]').length, 0, "cancel closes the dialog without a request");

    // Reopen and confirm this time. The dialog's own button is the bare word
    // «حذف», which is what distinguishes it from the screen's trigger.
    trigger!.click();
    await settle();
    const confirm = [...doc.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(element =>
      /^حذف$/.test(element.textContent?.trim() ?? "")
    );
    assert.ok(confirm, "the dialog has its own destructive button, distinct from the screen's");
    confirm!.click();
    await settle();
    assert.equal(doc.querySelectorAll('[role="dialog"]').length, 0, "confirm closes the dialog");
  });

  assert.deepEqual(fatal(errors), [], "no render error");

  assert.equal(teardowns.length, 1, "exactly one DELETE was issued");
  assert.equal(setups.length, 0, "setup was never touched");
  assert.equal(loggingEnabled(html), "false", "logging is off in the committed settings");
  assert.match(html, /تم حذف قنوات السجلات وتعطيل التسجيل/, "the outcome is reported, not swallowed");
});

test("creating the log channels commits through its own response, not the draft", async () => {
  const { setups } = stubFetchWithChannelActions();

  const { html, errors } = await mount(`/dashboard/${GUILD_ID}/logs`, async doc => {
    const create = [...doc.querySelectorAll("button")].find(element =>
      /إنشاء قنوات عادية/.test(element.textContent ?? "")
    );
    assert.ok(create, "the section-channel setup button is offered");
    create!.click();
  });

  assert.deepEqual(fatal(errors), [], "no render error");

  assert.equal(setups.length, 1, "one setup request");
  assert.equal(setups[0], "normal", "the button carries its mode to the endpoint");
  assert.doesNotMatch(html, /جارٍ الإنشاء/, "the button is enabled again once the request landed");
  assert.doesNotMatch(html, /حفظ التغييرات/, "setup commits through its own response, so no draft is pending");
  assert.match(html, /تم إنشاء قنوات الأقسام وربطها/, "the created channels are reported");
});

