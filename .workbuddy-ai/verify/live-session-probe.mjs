/**
 * Renders one screen of the *live* dashboard for one real session and reports
 * what the browser painted — as text, not as a screenshot.
 *
 *   node .workbuddy-ai/verify/live-session-probe.mjs <guildId> <sessionId> <label>
 *
 * The gap this fills, and the reason it exists at all:
 *
 *   - `browser-check.mjs` stubs `fetch` with fixtures, so it can only ever see
 *     the view the fixture describes. It runs as the platform owner.
 *   - `mount.test.tsx` is jsdom, which has no layout and, more to the point,
 *     only sees the payloads its own stubs hand it.
 *   - `live-screens-check.mjs` is real and live, but it only asks whether a
 *     screen rendered *anything* and whether the console stayed quiet.
 *
 * So the identity screen shipped a defect that every one of them reported as
 * clean: the three global cards (نبذة عني / الصور / الحالة والنشاط) were gated on
 * the platform owner's editable draft, which meant every guild admin saw a
 * screen without them — the route had sent the data, the preview drew it, and
 * nothing else did. It was invisible from the owner's seat and invisible to
 * every stub, and it was reported from the field as "the old design is still
 * what the server gives me".
 *
 * Reading the painted text is what makes that visible: `hasBio: false` next to
 * `hasNickname: true` says the screen is missing a section, not that it is
 * loading, empty or broken.
 *
 * What it asks now is the opposite question, because the screen was rebuilt
 * around a single scope. There is no longer an owner branch and an admin branch
 * to compare, so the run that matters is one admin session looking at its own
 * server: every field must be an editor, and nothing account-wide may appear.
 * The outline therefore reports what is *present* (the six controls, by their
 * own ids and labels) and what is *absent* (`accountWideLeaks`, which must come
 * back empty) rather than a split between two viewers.
 *
 * Output: the outline as JSON, plus two PNGs in this directory — the top of the
 * screen, and the screen scrolled to its middle, because the form is taller
 * than the viewport and scrolls inside `main` rather than the document.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const OUT = join(REPO, ".workbuddy-ai", "verify");
const CHROME = join(process.env.LOCALAPPDATA ?? "", "ms-playwright", "chromium-1200", "chrome-win64", "chrome.exe");

const [guildId, sessionId, label, view = "customization"] = process.argv.slice(2);
if (!guildId || !sessionId) {
  console.error("usage: node live-session-probe.mjs <guildId> <sessionId> [label] [view]");
  process.exit(2);
}

const BASE = "http://localhost:3000";
const COOKIE = "__Host-al_ai_session";

const profile = mkdtempSync(join(tmpdir(), "al-ai-probe-"));
const PORT = 9341;

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

async function evaluate(expression) {
  const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.result?.exceptionDetails) throw new Error(JSON.stringify(result.result.exceptionDetails));
  return result.result.result.value;
}

try {
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Network.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  /* The `__Host-` prefix is what the BFF uses under NODE_ENV=production, and it
     is only accepted with Secure, path=/ and no Domain — hence `url` rather than
     `domain`. If the server ever answers unauthenticated the run is worthless,
     so it is checked rather than assumed. */
  const set = await send("Network.setCookie", {
    name: COOKIE,
    value: sessionId,
    url: BASE,
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "Lax"
  });
  console.log(`cookie ${COOKIE}: ${set.result?.success ? "set" : "REJECTED " + JSON.stringify(set.result)}`);

  const url = `${BASE}/dashboard/${guildId}/${view}`;
  await send("Page.navigate", { url });

  for (let attempt = 0; attempt < 80; attempt += 1) {
    await sleep(150);
    const text = await evaluate(`(document.querySelector('main')?.innerText ?? '').length`);
    if (text > 300) break;
  }
  await sleep(900);

  const authenticated = await evaluate(
    `fetch('/api/session', { credentials: 'same-origin' }).then(r => r.json()).then(v => v.authenticated === true).catch(() => false)`
  );

  const outline = await evaluate(`(() => {
    const main = document.querySelector('main');
    // The card titles. CardTitle's own classes are
    // 'font-semibold leading-none tracking-tight', but tailwind-merge drops
    // leading-none the moment the caller also passes text-base — Tailwind 4's
    // text-base sets a line-height as well, and it wins as the later class. So
    // this matches on the two that survive. Selecting on all three finds
    // nothing and reports an empty outline for a screen full of cards, which is
    // exactly how the mismatch was measured. (No backticks in here — this whole
    // block is inside a template literal.)
    const cards = [...main.querySelectorAll('div.font-semibold.tracking-tight')]
      .map(node => node.innerText.trim())
      .filter(Boolean);
    const text = main.innerText;
    return {
      url: location.pathname,
      headings: [...main.querySelectorAll('h1,h2,h3')].map(node => node.innerText.trim()),
      cardTitles: [...new Set(cards)],
      // The three cards the single-scope screen is built from.
      hasIdentityCard: text.includes('الهوية'),
      hasImagesCard: text.includes('الصور'),
      hasRoleCard: text.includes('رتبة البوت'),
      // The six controls of §2, each by the marker only that control carries:
      // an id, a placeholder, an aria-label. Labels are drawn for every viewer,
      // so a probe keyed on a label would go green on a screen where the control
      // behind it had been removed.
      hasNicknameField: Boolean(main.querySelector('#nickname')),
      hasBioEditor: Boolean(main.querySelector('#bio')),
      hasAvatarUrlField: Boolean(main.querySelector('[aria-label="رابط صورة السيرفر"]')),
      hasBannerUrlField: Boolean(main.querySelector('[aria-label="رابط غلاف السيرفر"]')),
      // The colour picker is the one control with no id and no aria-label on its
      // trigger — its aria-labels live inside the popover, which Radix does not
      // mount until it opens — so this one falls back to its label. That is the
      // weaker kind of marker and it is marked as such: the other five above are
      // the load-bearing ones.
      hasColourField: text.includes('لون رتبة البوت'),
      hasRoleIconControl: text.includes('أيقونة الرتبة'),
      // The scope claim, both halves, as raw evidence.
      //
      // perServerWording should be non-empty: the screen is *supposed* to name
      // the server it scopes to. accountWideLeaks must be empty — those are
      // the §1 strings, and any of them appearing here means an account-wide
      // concept survived on a per-server form. The two are reported separately
      // because a probe that lumped them together could not tell a correct
      // screen from a deleted one. (No backticks in here — this whole block is
      // inside a template literal, and one would end it early.)
      perServerWording: ['هذا السيرفر'].filter(needle => text.includes(needle)),
      accountWideLeaks: ['كل السيرفرات', 'الصورة العالمية', 'قراءة فقط', 'حصرياً', 'عالمي']
        .filter(needle => text.includes(needle)),
      hasStatusPicker: Boolean(main.querySelector('[aria-label="حالة البوت"]')),
      hasActivityPicker: Boolean(main.querySelector('[aria-label="نوع النشاط"]')),
      // The cross-reference that replaced the status controls, so the operator
      // is told where they went rather than finding them missing.
      pointsAtPresenceScreen: text.includes('شاشة «حالة البوت»'),
      statusOptions: ['متصل','خامل','مشغول','غير ظاهر'].filter(needle => text.includes(needle)),
      chars: text.length
    };
  })()`);

  console.log(`\n===== ${label ?? sessionId} =====`);
  console.log(`authenticated: ${authenticated}`);
  console.log(JSON.stringify(outline, null, 2));

  const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  writeFileSync(join(OUT, `probe-${label ?? sessionId}.png`), Buffer.from(shot.result.data, "base64"));
  console.log(`shot -> .workbuddy-ai/verify/probe-${label ?? sessionId}.png`);

  /* The screen scrolls inside `main`, not the document (the shell owns the
     viewport), so a "full page" capture shows nothing extra — the rest of the
     form is below the fold of the scroll container. Scrolling that container and
     shooting again is what shows the cards the top of the page cuts off. */
  const scrolled = await evaluate(`(() => {
    const main = document.querySelector('main');
    const box = main.querySelector('div[class*="overflow-y-auto"], div[class*="overflow-auto"]') ?? main;
    box.scrollTop = 480;
    return box.scrollTop;
  })()`);
  await sleep(700);
  const lower = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  writeFileSync(join(OUT, `probe-${label ?? sessionId}-lower.png`), Buffer.from(lower.result.data, "base64"));
  console.log(`scrolled to ${scrolled} -> .workbuddy-ai/verify/probe-${label ?? sessionId}-lower.png`);
} finally {
  socket.close();
  chrome.kill();
}
