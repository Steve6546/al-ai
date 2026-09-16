/**
 * A real-browser verification pass for the dashboard.
 *
 * Two things this does that no unit test can:
 *
 *   1. It lays the page out. Every claim in this change — "the window does not
 *      scroll", "the menu is capped at 256px", "the popup is as wide as its
 *      trigger" — is a statement about geometry, and jsdom has no layout engine.
 *      `getBoundingClientRect()` there returns zeroes for everything, so a test
 *      can only ever assert the *class names* that are supposed to produce the
 *      geometry. This measures the geometry itself.
 *   2. It screenshots. The complaint being fixed was visual.
 *
 * The app is served from `dist/` exactly as built, and the BFF is replaced by a
 * `fetch` stub injected before any script runs — so the real bundle, the real
 * CSS and the real Radix behaviour are all under test, with no Discord session
 * and no network.
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  commandCategories,
  commandCategoryDescriptions,
  commandCategoryLabels,
  commandFlagsFor,
  discordPermissionLabels
} from "@al-ai/core";

const REPO = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const DIST = join(REPO, "apps", "dashboard", "dist");
const OUT = join(REPO, ".workbuddy-ai", "verify");
const CHROME = join(process.env.LOCALAPPDATA ?? "", "ms-playwright", "chromium-1200", "chrome-win64", "chrome.exe");

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };

/* ------------------------------------------------------------------ *
 * The stub BFF
 * ------------------------------------------------------------------ */

const GUILD_ID = "1540515175826985080";

const guild = {
  id: GUILD_ID,
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

/** Thirty roles, so the quarantine picker has a list worth capping. */
const roles = Array.from({ length: 30 }, (_, index) => ({
  id: String(index + 10),
  name: `رتبة الحجر رقم ${index + 1}`,
  position: 30 - index,
  managed: false,
  isDefault: false,
  color: 0
}));

/**
 * The commands screen's payload, built from the real registry.
 *
 * Imported rather than hand-copied on purpose: a fixture written out by hand
 * stops covering the thing it was written for the moment a command is added, and
 * that is exactly the failure this screen has had before — a stub whose
 * `commands` array was empty meant the board the operator actually uses was
 * never mounted, while the test stayed green.
 *
 * `commandFlagsFor(new Map())` is the same call the BFF makes for a guild that
 * has never touched a setting, so the fixture is the real shape by construction.
 * The harness therefore runs under `tsx`, which resolves the workspace's
 * TypeScript entry points.
 */
const commandsPayload = {
  categories: commandCategories.map(id => ({ id, label: commandCategoryLabels[id], description: commandCategoryDescriptions[id] })),
  commands: commandFlagsFor(new Map()),
  roles,
  channels: [
    { id: "333333333333333333", name: "عام", type: "text" },
    { id: "444444444444444444", name: "الإشراف", type: "text" }
  ],
  permissionLabels: discordPermissionLabels
};

const STUB = `
(() => {
  const payloads = [
    [/^\\/api\\/session$/, { authenticated: true, user: { id: "1", username: "owner", avatarUrl: null, expiresAt: new Date(Date.now() + 3.6e6).toISOString() } }],
    [/^\\/api\\/health$/, { status: "healthy", dashboard: "online", bot: "connected", database: "reachable", gateway: { eventsLastMinute: 0, ceiling: 120 }, verification: { guildCount: 1, uniqueUsers: 1, reviewRequired: false, warning: null } }],
    [/^\\/api\\/guilds$/, { guilds: ${JSON.stringify([guild])} }],
    [/^\\/api\\/guilds\\/[^/]+\\/customization$/, {
      settings: { nickname: "AL uwu", roleColor: "#050572", roleIconUrl: "" },
      permissions: [{ key: "change_nickname", label: "تغيير الاسم المستعار", granted: true }],
      hierarchy: { botPosition: 5, highestManagedPosition: 3, blocked: false, message: null },
      roleIcon: { locked: false, unknown: false, reason: null }
    }],
    [/^\\/api\\/bot\\/identity$/, {
      settings: { avatarDataUrl: "", bannerDataUrl: "", bio: "استُعيد", status: "idle", activityType: "listening", activityText: "السجلات", statusDuration: "", statusExpiresAt: "" },
      snapshot: null
    }],
    [/^\\/api\\/guilds\\/[^/]+\\/security\\/config$/, {
      config: { enabled: true, limits: { channelDeletesPerMinute: 3, bansPerMinute: 5, roleChangesPerMinute: 3 }, quarantineRoleId: null },
      roles: ${JSON.stringify(roles)},
      actions: [{ action: "ban", label: "حظر الأعضاء", limit: 5 }]
    }],
    [/^\\/api\\/guilds\\/[^/]+\\/security$/, { events: [] }],
    [/^\\/api\\/guilds\\/[^/]+\\/tiers$/, { roles: ${JSON.stringify(roles)}, configured: { ownerRoleIds: [], adminRoleIds: [], moderatorRoleIds: [] }, botHighestRolePosition: 10, unassignable: [], warning: null }],
    [/^\\/api\\/guilds\\/[^/]+\\/metrics$/, { bot: { online: true, pingMs: 30, lastSeenAt: new Date().toISOString() }, members: { total: 10, online: null, onlineNote: null }, punishments24h: { total: 0, ban: 0, kick: 0, timeout: 0, warn: 0 }, recentActivity: [] }],
    [/^\\/api\\/guilds\\/[^/]+\\/commands$/, ${JSON.stringify(commandsPayload)}],
    [/^\\/api\\/guilds\\/[^/]+\\/members$/, { members: [] }]
  ];
  window.fetch = async (input) => {
    const raw = typeof input === "string" ? input : (input && input.url) || String(input);
    const path = raw.split("?")[0];
    const hit = payloads.find(([re]) => re.test(path));
    const body = hit ? hit[1] : { error: "NOT_FOUND" };
    return {
      ok: Boolean(hit),
      status: hit ? 200 : 404,
      headers: { get: () => null },
      json: async () => body,
      text: async () => JSON.stringify(body)
    };
  };
})();
`;

/* ------------------------------------------------------------------ *
 * The static server
 * ------------------------------------------------------------------ */

const server = createServer(async (req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  const file = join(DIST, path === "/" ? "index.html" : path);
  const target = existsSync(file) && extname(file) ? file : join(DIST, "index.html");
  res.writeHead(200, { "content-type": MIME[extname(target)] ?? "application/octet-stream" });
  res.end(await readFile(target));
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;

/* ------------------------------------------------------------------ *
 * Chromium over CDP
 * ------------------------------------------------------------------ */

const profile = mkdtempSync(join(tmpdir(), "al-ai-verify-"));
const PORT = 9333;
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--no-proxy-server",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    "about:blank"
  ],
  { stdio: "ignore" }
);

const sleep = ms => new Promise(done => setTimeout(done, ms));

async function waitForDevTools() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (response.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  throw new Error("Chromium never opened its DevTools port.");
}

await waitForDevTools();
const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = targets.find(target => target.type === "page");

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((done, fail) => {
  socket.addEventListener("open", done, { once: true });
  socket.addEventListener("error", fail, { once: true });
});

let nextId = 0;
const pending = new Map();
/**
 * Everything the page logged or threw, so "no console errors" is a measurement
 * rather than an assumption. A React render failure surfaces here as an
 * exception; a component that warns about a bad prop surfaces as a console
 * message. Both are invisible to a screenshot.
 */
const consoleErrors = [];
socket.addEventListener("message", event => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
    return;
  }
  if (message.method === "Runtime.exceptionThrown") {
    const detail = message.params?.exceptionDetails;
    consoleErrors.push(detail?.exception?.description ?? detail?.text ?? "unknown exception");
  }
  if (message.method === "Runtime.consoleAPICalled" && message.params?.type === "error") {
    consoleErrors.push(message.params.args?.map(arg => arg.value ?? arg.description ?? "").join(" ") ?? "console.error");
  }
});

function send(method, params = {}) {
  const id = ++nextId;
  return new Promise(resolve => {
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
  });
}

/** Runs an expression in the page and returns its value. */
async function evaluate(expression) {
  const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.result?.exceptionDetails) throw new Error(JSON.stringify(result.result.exceptionDetails));
  return result.result.result.value;
}

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send("Page.addScriptToEvaluateOnNewDocument", { source: STUB });

/** Opens a route, waits for the screen's data to land, and reports what it measured. */
async function visit(path, ready) {
  await send("Page.navigate", { url: `${origin}${path}` });
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await sleep(100);
    if (await evaluate(`Boolean(${ready})`)) return;
  }
  throw new Error(`The screen at ${path} never became ready.`);
}

async function shoot(name) {
  const shot = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(OUT, `${name}.png`), Buffer.from(shot.result.data, "base64"));
}

const findings = [];
const check = (label, actual, expected) => {
  const ok = typeof expected === "function" ? expected(actual) : actual === expected;
  findings.push({ label, actual, ok });
};

try {
  /* ---- 1. the frame ---- */
  await visit(
    `/dashboard/${GUILD_ID}/customization`,
    `document.querySelector('main') && document.body.textContent.includes('الهوية العالمية')`
  );

  check("window does not scroll", await evaluate(`document.scrollingElement.scrollHeight - document.scrollingElement.clientHeight`), 0);
  check("main does scroll", await evaluate(`document.querySelector('main').scrollHeight > document.querySelector('main').clientHeight + 100`), true);

  const before = await evaluate(`(() => {
    const rect = el => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top), left: Math.round(r.left) }; };
    return {
      header: rect(document.querySelector('header')),
      sidebar: rect(document.querySelector('aside')),
      preview: rect(document.querySelector('main .lg\\\\:sticky') ?? document.querySelector('main'))
    };
  })()`);

  await evaluate(`document.querySelector('main').scrollTop = 600`);
  await sleep(150);

  const after = await evaluate(`(() => {
    const rect = el => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top), left: Math.round(r.left) }; };
    return {
      header: rect(document.querySelector('header')),
      sidebar: rect(document.querySelector('aside')),
      preview: rect(document.querySelector('main .lg\\\\:sticky') ?? document.querySelector('main')),
      scrolled: document.querySelector('main').scrollTop
    };
  })()`);

  check("the header did not move", after.header.top, before.header.top);
  check("the sidebar did not move", after.sidebar.top, before.sidebar.top);
  check("the page really scrolled", after.scrolled, value => value > 100);
  check(
    "the live preview stayed put",
    after.preview.top,
    value => Math.abs(value - before.preview.top) <= 4
  );
  await shoot("customization");

  /* ---- 2. the activity picker ---- */
  await evaluate(`(() => {
    const trigger = document.querySelector('[aria-label="نوع النشاط"]');
    trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse' }));
    return true;
  })()`);
  await sleep(300);

  const activity = await evaluate(`(() => {
    const wrapper = document.querySelector('[data-radix-popper-content-wrapper]');
    const viewport = document.querySelector('[data-radix-select-viewport]');
    const trigger = document.querySelector('[aria-label="نوع النشاط"]');
    if (!wrapper || !viewport) return null;
    const content = viewport.parentElement;
    const box = content.getBoundingClientRect();
    return {
      triggerWidth: Math.round(trigger.getBoundingClientRect().width),
      contentWidth: Math.round(box.width),
      contentHeight: Math.round(box.height),
      maxHeight: getComputedStyle(content).maxHeight,
      viewportHeight: Math.round(viewport.getBoundingClientRect().height),
      background: getComputedStyle(content).backgroundColor,
      itemColour: getComputedStyle(document.querySelector('[role="option"]')).color
    };
  })()`);

  check("the activity menu has geometry", activity, value => value !== null);
  check("the activity menu matches its trigger's width", activity?.contentWidth, value => Math.abs(value - activity.triggerWidth) <= 2);
  check("the activity menu is not clamped to the trigger's height", activity?.viewportHeight, value => value > 60);
  check("the activity menu is capped at 256px", activity?.contentHeight, value => value <= 258);
  check("the activity menu has a real max-height", activity?.maxHeight, "256px");
  check("the activity menu is not white", activity?.background, value => value !== "rgb(255, 255, 255)");
  await shoot("activity-menu");

  /*
   * Why the stock viewport height class was removed.
   *
   * The comment on the viewport claims that class was inert. That is a claim
   * about Radix's own layout, not about this code, and it is the whole reason
   * the line was deleted — so it is measured rather than asserted, including the
   * part that makes it surprising.
   *
   * The first version of this probe assigned the declaration back with
   * `style.height = 'var(--radix-select-trigger-height)'` and read back an
   * unchanged height. That looked like proof the class was harmless. It was not
   * proof of anything: assigning a `var()` reference through the CSSOM is not
   * honoured here. The second version assigned the variable's *resolved* pixel
   * value and got the same unchanged height — which is real evidence, and the
   * reason is in the content's computed `display`.
   */
  const clamp = await evaluate(`(() => {
    const viewport = document.querySelector('[data-radix-select-viewport]');
    const content = viewport.parentElement;
    const before = Math.round(viewport.getBoundingClientRect().height);
    const variable = getComputedStyle(viewport).getPropertyValue('--radix-select-trigger-height').trim();
    viewport.style.height = variable;
    const after = Math.round(viewport.getBoundingClientRect().height);
    viewport.style.height = '';
    return {
      variable,
      before,
      after,
      contentDisplay: getComputedStyle(content).display,
      contentDirection: getComputedStyle(content).flexDirection,
      viewportFlex: getComputedStyle(viewport).flexBasis
    };
  })()`);

  check("the trigger-height variable resolves on the viewport", clamp.variable, value => /^[0-9.]+px$/.test(value));
  check("…because the content is a column flex container", clamp.contentDisplay, "flex");
  check("…with a direction that puts the viewport's height on the main axis", clamp.contentDirection, "column");
  check("…where `flex-basis` beats `height`", clamp.viewportFlex, "0%");
  check(
    "so the stock height class could not have been capping anything",
    clamp.after,
    value => value === clamp.before
  );

  /* ---- 3. the quarantine picker, with thirty roles ---- */
  await visit(
    `/dashboard/${GUILD_ID}/security`,
    `document.querySelector('#quarantine-role') && document.body.textContent.includes('رتبة الحجر')`
  );

  await evaluate(`(() => {
    const trigger = document.querySelector('#quarantine-role');
    trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse' }));
    return true;
  })()`);
  await sleep(300);

  const quarantine = await evaluate(`(() => {
    const viewport = document.querySelector('[data-radix-select-viewport]');
    const trigger = document.querySelector('#quarantine-role');
    if (!viewport) return null;
    const content = viewport.parentElement;
    const box = content.getBoundingClientRect();
    return {
      triggerWidth: Math.round(trigger.getBoundingClientRect().width),
      contentWidth: Math.round(box.width),
      contentHeight: Math.round(box.height),
      viewportHeight: Math.round(viewport.getBoundingClientRect().height),
      viewportScrolls: viewport.scrollHeight > viewport.clientHeight + 10,
      options: document.querySelectorAll('[role="option"]').length
    };
  })()`);

  check("the quarantine menu has geometry", quarantine, value => value !== null);
  check("the quarantine menu offers every role", quarantine?.options, 31);
  check("the quarantine menu matches its trigger's width", quarantine?.contentWidth, value => Math.abs(value - quarantine.triggerWidth) <= 2);
  check("the quarantine menu is capped at 256px", quarantine?.contentHeight, value => value <= 258);
  check("the quarantine menu scrolls inside that cap", quarantine?.viewportScrolls, true);
  await shoot("quarantine-menu");

  /* ---- 4. the guild selector frame ---- */
  await visit(`/`, `document.querySelector('main') && document.body.textContent.includes('اختر سيرفراً')`);
  check("the selector's header is at the top", await evaluate(`Math.round(document.querySelector('header').getBoundingClientRect().top)`), 0);
  await shoot("guild-selector");

  /* ---- 5. the commands screen ---- */
  /*
   * The screen this round rebuilt. Everything asserted here is something a unit
   * test cannot reach: that the whole board lays out at 1440px, that the section
   * nav stays put while twenty cards scroll past it, and that the browser logs
   * nothing while all of it renders.
   */
  await visit(
    `/dashboard/${GUILD_ID}/commands`,
    `document.querySelector('nav[aria-label="أقسام الأوامر"]') && document.body.textContent.includes('إجمالي الأوامر')`
  );

  // Reset here rather than at the top: the earlier screens are not under test,
  // and a warning from one of them would be misattributed to this one.
  consoleErrors.length = 0;
  await sleep(400);
  check("the commands screen logs nothing", consoleErrors, value => value.length === 0);

  const sectionNames = await evaluate(`[...document.querySelectorAll('nav[aria-label="أقسام الأوامر"] button')].map(b => b.textContent.trim())`);
  // Fourteen sections plus the "all commands" row.
  check("the sidebar offers every section and the all-commands row", sectionNames.length, 15);
  check(
    "…including the ones with no commands yet",
    sectionNames.some(name => name.includes("سجلات العقوبات")) && sectionNames.some(name => name.includes("إدارة الصوت")),
    true
  );

  check("the permission badge is rendered", await evaluate(`document.body.textContent.includes('يتطلب:')`), true);
  check("a command with no requirement says so", await evaluate(`document.body.textContent.includes('متاح للجميع')`), true);

  /*
   * The tier dropdown was the thing this screen was rebuilt to remove.
   *
   * Scoped to the board on purpose. `document.body` also contains the app
   * shell, which legitimately shows the viewer's *own* tier in its footer and
   * links to the tiers screen — so a whole-page search for the word "المالك"
   * fails on furniture that has nothing to do with this screen. The first
   * version of this check did exactly that and reported a false failure.
   *
   * `/timeout` is expanded first so the check cannot pass vacuously: the
   * default-duration picker only exists inside an open card, and "no control
   * carries a tier" is trivially true on a board that has no controls at all.
   * The board does keep real comboboxes, so "no combobox" would be the wrong
   * question — the question is what they contain.
   */
  await evaluate(`(() => {
    document.querySelector('[aria-label="إعدادات timeout"]').click();
    return true;
  })()`);
  await sleep(300);

  const tierControls = await evaluate(`(() => {
    const board = document.querySelector('nav[aria-label="أقسام الأوامر"]').parentElement;
    const tiers = ['المالك', 'مدير', 'مشرف'];
    const isTier = text => tiers.includes(text.trim());
    const controls = [...board.querySelectorAll('select, [role="combobox"]')];
    return {
      total: controls.length,
      texts: controls.map(el => el.textContent.trim()).slice(0, 8),
      offenders: controls.map(el => el.textContent.trim()).filter(isTier),
      standalone: [...board.querySelectorAll('*')]
        .filter(el => el.children.length === 0 && isTier(el.textContent))
        .map(el => el.tagName.toLowerCase() + ':' + el.textContent.trim())
    };
  })()`);
  check("the expanded board really does contain pickers", tierControls.total, value => value > 0);
  check("none of those pickers carries a tier", tierControls.offenders, value => value.length === 0);
  check("no tier name stands alone on the board", tierControls.standalone, value => value.length === 0);

  /* An empty section explains itself rather than showing a blank pane. */
  await evaluate(`(() => {
    const target = [...document.querySelectorAll('nav[aria-label="أقسام الأوامر"] button')]
      .find(button => button.textContent.includes('سجلات العقوبات'));
    target.click();
    return true;
  })()`);
  await sleep(250);
  check(
    "an empty section says the commands are coming",
    await evaluate(`document.body.textContent.includes('سيتم توفيرها في التحديثات القادمة')`),
    true
  );
  await shoot("commands-empty-section");

  /* Back to the full list, then the sticky-nav measurement. */
  await evaluate(`(() => {
    const target = [...document.querySelectorAll('nav[aria-label="أقسام الأوامر"] button')]
      .find(button => button.textContent.includes('كل الأوامر'));
    target.click();
    return true;
  })()`);
  await sleep(250);

  const boardBefore = await evaluate(`(() => {
    const main = document.querySelector('main');
    const nav = document.querySelector('nav[aria-label="أقسام الأوامر"]');
    return { navTop: Math.round(nav.getBoundingClientRect().top), scrollable: main.scrollHeight > main.clientHeight + 200 };
  })()`);
  check("the commands board is long enough to scroll", boardBefore.scrollable, true);

  const boardAfter = await evaluate(`(() => {
    const main = document.querySelector('main');
    main.scrollTop = 400;
    const nav = document.querySelector('nav[aria-label="أقسام الأوامر"]');
    return { navTop: Math.round(nav.getBoundingClientRect().top), scrolled: Math.round(main.scrollTop) };
  })()`);
  check("the page really scrolled", boardAfter.scrolled, value => value > 100);
  check(
    "the section nav stays put while the cards scroll",
    Math.abs(boardAfter.navTop - boardBefore.navTop),
    value => value <= 2
  );
  check("the window still does not scroll", await evaluate(`document.scrollingElement.scrollHeight - document.scrollingElement.clientHeight`), 0);

  /* ---- 5b. the six scope selectors: closed, and opening one moves nothing ---- */
  /*
   * The rebuild's claim is geometric. Six always-open checkbox lists made the
   * card taller than the screen, so the operator scrolled past four of them to
   * reach the fifth; six closed selectors do not. That is a measurement, so it
   * is measured here — jsdom has no layout engine and reports zero for every
   * rectangle, and a class name only says what the markup intended.
   *
   * The card is re-expanded first: the empty-section check above filtered
   * `/timeout` out of the list, which unmounted it and reset its open state.
   */
  await evaluate(`(() => {
    const trigger = document.querySelector('[aria-label="إعدادات timeout"]');
    trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
    trigger.click();
    return true;
  })()`);
  await sleep(300);

  const SCOPE_LABELS = [
    "الرتب المسموحة",
    "الرتب الممنوعة",
    "الأشخاص المصرحين",
    "الأشخاص الممنوعين",
    "القنوات المسموحة",
    "القنوات الممنوعة"
  ];

  const scopeClosed = await evaluate(`(() => {
    const labels = ${JSON.stringify(SCOPE_LABELS)};
    const found = labels.map(label => document.querySelector('[aria-label="' + label + '"]'));
    return {
      count: found.filter(Boolean).length,
      expanded: found.map(el => el && el.getAttribute('aria-expanded')),
      panels: document.querySelectorAll('[role="dialog"]').length,
      summaries: found.map(el => el && el.textContent.trim())
    };
  })()`);
  check("all six scope selectors are on the card", scopeClosed.count, 6);
  check("and every one of them starts closed", scopeClosed.expanded, value => value.every(entry => entry === "false"));
  check("so no panel is in the document yet", scopeClosed.panels, 0);
  check(
    "each trigger states what its empty selection means",
    scopeClosed.summaries,
    // Three allow-lists read "everyone may", three deny-lists read "nobody is
    // excluded". "Nothing" would mean the opposite of the first three.
    value => JSON.stringify(value) === JSON.stringify(["الكل مسموح", "بدون", "الكل مسموح", "بدون", "الكل مسموح", "بدون"])
  );

  const beforeOpen = await evaluate(`(() => {
    const main = document.querySelector('main');
    const board = document.querySelector('nav[aria-label="أقسام الأوامر"]').parentElement;
    return {
      mainScrollHeight: main.scrollHeight,
      boardHeight: Math.round(board.getBoundingClientRect().height)
    };
  })()`);

  await evaluate(`(() => {
    const trigger = document.querySelector('[aria-label="الرتب المسموحة"]');
    trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
    trigger.click();
    return true;
  })()`);
  await sleep(300);

  const opened = await evaluate(`(() => {
    const trigger = document.querySelector('[aria-label="الرتب المسموحة"]');
    const panel = document.querySelector('[role="dialog"][aria-label="الرتب المسموحة"]');
    if (!panel) return { present: false };
    const list = panel.querySelector('div.max-h-56');
    const rect = panel.getBoundingClientRect();
    const main = document.querySelector('main');
    const board = document.querySelector('nav[aria-label="أقسام الأوامر"]').parentElement;
    return {
      present: true,
      panels: document.querySelectorAll('[role="dialog"]').length,
      triggerExpanded: trigger.getAttribute('aria-expanded'),
      triggerWidth: Math.round(trigger.getBoundingClientRect().width),
      panelWidth: Math.round(rect.width),
      panelTop: Math.round(rect.top),
      rows: panel.querySelectorAll('button[role="checkbox"]').length,
      listScrolls: list ? list.scrollHeight > list.clientHeight : null,
      listMaxHeight: list ? getComputedStyle(list).maxHeight : null,
      boardHeight: Math.round(board.getBoundingClientRect().height),
      mainScrollHeight: main.scrollHeight
    };
  })()`);

  check("clicking a selector opens a panel", opened.present, true);
  check("exactly one panel, and it is the one that was clicked", opened.panels, 1);
  check("the trigger reports itself expanded", opened.triggerExpanded, "true");
  // The panel is sized to its trigger so it lines up with the column it belongs
  // to. `min-w` alone would not: the two columns are different widths.
  check("the panel is as wide as its trigger", opened.panelWidth, value => Math.abs(value - opened.triggerWidth) <= 2);
  check("the panel is on screen", opened.panelTop, value => value > 0 && value < 900);
  // `> 0` before judging anything: "the list is capped" is trivially true on a
  // list that rendered no rows at all.
  check("the panel offers every role", opened.rows, 30);
  check("the list scrolls inside its cap", opened.listScrolls, true);
  check("the cap is a real max-height", opened.listMaxHeight, "224px");
  // The claim, measured: a portalled panel is out of the document flow, so
  // opening it cannot push the cards below it down.
  check("opening a selector does not lengthen the board", opened.boardHeight - beforeOpen.boardHeight, value => value <= 2);
  check("and does not lengthen the document either", opened.mainScrollHeight - beforeOpen.mainScrollHeight, value => value <= 2);
  check("the window still does not scroll", await evaluate(`document.scrollingElement.scrollHeight - document.scrollingElement.clientHeight`), 0);

  /*
   * The "customised" badge, in both directions.
   *
   * It marks a command whose settings differ from what shipped, so on a guild
   * that has never been touched it must mark almost nothing — a badge on every
   * card is noise, and noise is how a real signal gets ignored. `/warn` is the
   * one exception and deliberately so: "reason required" is its shipped default,
   * because a warning with no reason is not worth recording. Asserting both the
   * absence and the presence is what stops the badge from quietly becoming
   * always-on or never-on.
   */
  const markedCustomised = await evaluate(`(() => {
    const board = document.querySelector('nav[aria-label="أقسام الأوامر"]').parentElement;
    const marked = [];
    for (const name of board.querySelectorAll('p[dir="ltr"]')) {
      const row = name.parentElement;
      if (row && [...row.children].some(el => el.textContent.trim() === 'مخصّص')) {
        marked.push(name.textContent.trim());
      }
    }
    return marked;
  })()`);
  check("a command with nothing configured is not marked customised", markedCustomised.includes("/help"), false);
  check("a command whose shipped default is non-default is marked", markedCustomised, value => value.length > 0 && value.length < 5);

  await shoot("commands-scope-open");

  /* Ticking an entry has to reach the draft, not just the checkbox. */
  const ticked = await evaluate(`(() => {
    const panel = document.querySelector('[role="dialog"][aria-label="الرتب المسموحة"]');
    const row = panel.querySelector('label');
    const name = row.querySelector('span.truncate').textContent.trim();
    row.querySelector('button[role="checkbox"]').click();
    return name;
  })()`);
  await sleep(300);

  const afterTick = await evaluate(`(() => {
    const trigger = document.querySelector('[aria-label="الرتب المسموحة"]');
    return {
      summary: trigger.textContent.trim(),
      saveBar: document.body.textContent.includes('تغيير غير محفوظ')
    };
  })()`);
  check("ticking a role names it on the trigger", afterTick.summary.startsWith(ticked), true);
  check("…and marks the change unsaved rather than writing it", afterTick.saveBar, true);

  await shoot("commands-scope-ticked");

  /* Put the draft back so the screenshots after this one show the default state. */
  await evaluate(`(() => {
    const panel = document.querySelector('[role="dialog"][aria-label="الرتب المسموحة"]');
    const clear = [...panel.querySelectorAll('button')].find(button => button.textContent.includes('مسح الاختيار'));
    if (clear) clear.click();
    return true;
  })()`);
  await sleep(200);
  await evaluate(`(() => {
    const cancel = [...document.querySelectorAll('button')].find(button => /إلغاء/.test(button.textContent));
    if (cancel) cancel.click();
    return true;
  })()`);
  await sleep(200);

  await shoot("commands-screen");
} finally {
  socket.close();
  chrome.kill();
  server.close();
}

const failed = findings.filter(finding => !finding.ok);
for (const finding of findings) {
  console.log(`${finding.ok ? "PASS" : "FAIL"}  ${finding.label}  →  ${JSON.stringify(finding.actual)}`);
}
console.log(`\n${findings.length - failed.length}/${findings.length} checks passed`);
process.exit(failed.length ? 1 : 0);
