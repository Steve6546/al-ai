/**
 * Loads the *live* dashboard and screenshots the commands screen.
 *
 * `browser-check.mjs` replaces the BFF with a `fetch` stub, which is what makes
 * it reproducible without a session — but it also means it can never catch the
 * failure this script exists for: a frontend that is new talking to a backend
 * that is stale. That mismatch is invisible to a stub, because the stub always
 * answers in the shape the current code expects.
 *
 * So this one drives the real server on 127.0.0.1:3000 with a real session
 * cookie, and reports what the browser logged.
 *
 *   node .workbuddy-ai/verify/live-commands-check.mjs <guildId> <sessionId>
 */

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const OUT = join(REPO, ".workbuddy-ai", "verify");
const CHROME = join(process.env.LOCALAPPDATA ?? "", "ms-playwright", "chromium-1200", "chrome-win64", "chrome.exe");

const guildId = process.argv[2];
const sessionId = process.argv[3];
if (!guildId || !sessionId) {
  console.error("usage: node live-commands-check.mjs <guildId> <sessionId>");
  process.exit(2);
}

const BASE = "http://localhost:3000";
const profile = mkdtempSync(join(tmpdir(), "al-ai-live-"));
const PORT = 9334;

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

async function evaluate(expression) {
  const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.result?.exceptionDetails) throw new Error(JSON.stringify(result.result.exceptionDetails));
  return result.result.result.value;
}

const findings = [];
const check = (label, actual, expected) => {
  const ok = typeof expected === "function" ? expected(actual) : actual === expected;
  findings.push({ label, actual, ok });
};

try {
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Network.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  // The session the operator is actually using, so the routes resolve for real.
  await send("Network.setCookie", {
    name: "al_ai_session",
    value: sessionId,
    domain: "localhost",
    path: "/",
    httpOnly: true
  });

  await send("Page.navigate", { url: `${BASE}/dashboard/${guildId}/commands` });

  let ready = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await sleep(150);
    ready = await evaluate(`Boolean(document.querySelector('nav[aria-label="أقسام الأوامر"]'))`);
    if (ready) break;
  }

  check("the commands board mounted against the live server", ready, true);

  await sleep(600);

  const state = await evaluate(`(() => {
    const text = document.body.textContent;
    const nav = document.querySelector('nav[aria-label="أقسام الأوامر"]');
    return {
      sections: nav ? nav.querySelectorAll('button').length : 0,
      iterableError: text.includes('is not iterable'),
      permissionBadge: text.includes('يتطلب:'),
      everyoneBadge: text.includes('متاح للجميع'),
      totalStat: text.includes('إجمالي الأوامر'),
      cards: document.querySelectorAll('main .font-mono').length
    };
  })()`);

  check("the 'is not iterable' crash is gone", state.iterableError, false);
  check("the board renders its stats", state.totalStat, true);
  check("every sidebar section is present", state.sections, 15);
  check("permission badges render", state.permissionBadge, true);
  check("commands with no requirement say so", state.everyoneBadge, true);
  check("command cards render", state.cards, value => value >= 20);
  check("the browser logged no errors", consoleErrors, value => value.length === 0);

  const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  writeFileSync(join(OUT, "live-commands-screen.png"), Buffer.from(shot.result.data, "base64"));

  if (consoleErrors.length) console.log("console errors:", JSON.stringify(consoleErrors.slice(0, 5), null, 2));
} finally {
  socket.close();
  chrome.kill();
}

const failed = findings.filter(finding => !finding.ok);
for (const finding of findings) {
  console.log(`${finding.ok ? "PASS" : "FAIL"}  ${finding.label}  →  ${JSON.stringify(finding.actual)}`);
}
console.log(`\n${findings.length - failed.length}/${findings.length} checks passed`);
process.exit(failed.length ? 1 : 0);
