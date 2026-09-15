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
    [/^\\/api\\/guilds\\/[^/]+\\/metrics$/, { bot: { online: true, pingMs: 30, lastSeenAt: new Date().toISOString() }, members: { total: 10, online: null, onlineNote: null }, punishments24h: { total: 0, ban: 0, kick: 0, timeout: 0, warn: 0 }, recentActivity: [] }]
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
socket.addEventListener("message", event => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
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
