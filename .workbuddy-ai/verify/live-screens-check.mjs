/**
 * Loads the *live* dashboard and walks every screen in a real browser.
 *
 * `browser-check.mjs` replaces the BFF with a `fetch` stub, which is what makes
 * it reproducible without a session — but that same stub is why it can never
 * catch the failure this script exists for: a frontend that is new talking to a
 * backend that is stale. The stub always answers in the shape the current code
 * expects, so the mismatch is invisible to it.
 *
 * This one drives the real server on 127.0.0.1:3000 with a real session cookie,
 * visits each screen, and reports what the browser logged.
 *
 *   node .workbuddy-ai/verify/live-screens-check.mjs <guildId> <sessionId>
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
  console.error("usage: node live-screens-check.mjs <guildId> <sessionId>");
  process.exit(2);
}

const BASE = "http://localhost:3000";

/** Every screen in the shell's navigation, plus the guild selector at the root. */
const SCREENS = [
  { view: null, label: "مُنتقي السيرفرات" },
  { view: "dashboard", label: "لوحة التحكم" },
  { view: "roles", label: "رتب الإدارة والمشرفين" },
  { view: "customization", label: "هوية البوت" },
  { view: "commands", label: "الأوامر" },
  { view: "security", label: "الحماية والأمان" },
  { view: "logs", label: "سجلات السيرفر" },
  { view: "audit", label: "سجل تدقيق اللوحة" }
];

const profile = mkdtempSync(join(tmpdir(), "al-ai-live-"));
const PORT = 9335;

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
let consoleErrors = [];
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

const rows = [];
let failures = 0;

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

  for (const screen of SCREENS) {
    consoleErrors = [];

    const url = screen.view === null ? `${BASE}/` : `${BASE}/dashboard/${guildId}/${screen.view}`;
    await send("Page.navigate", { url });

    // Generic readiness: the shell has rendered and `main` has real content.
    // A per-screen marker would be a better signal, but it would also be a
    // fixture that stops matching the screen the moment the copy changes — and
    // the measurement that matters here is what the console logged.
    let text = 0;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await sleep(150);
      text = await evaluate(`(document.querySelector('main')?.textContent ?? '').length`);
      if (text > 150) break;
    }
    await sleep(500);

    const state = await evaluate(`(() => {
      const body = document.body.textContent;
      return {
        chars: (document.querySelector('main')?.textContent ?? '').length,
        iterable: body.includes('is not iterable'),
        undefinedError: /Cannot read properties of (undefined|null)/.test(body),
        errorBanner: Boolean(document.querySelector('[role="alert"], .text-destructive'))
      };
    })()`);

    const errors = consoleErrors.slice();
    const clean = errors.length === 0 && !state.iterable && !state.undefinedError;

    rows.push({ label: screen.label, view: screen.view ?? "(root)", chars: state.chars, errors, iterable: state.iterable, clean });
    if (!clean) failures += 1;

    const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
    writeFileSync(join(OUT, `live-${screen.view ?? "root"}.png`), Buffer.from(shot.result.data, "base64"));
  }
} finally {
  socket.close();
  chrome.kill();
}

for (const row of rows) {
  console.log(`${row.clean ? "PASS" : "FAIL"}  ${row.label.padEnd(24)} (${row.view})  chars=${row.chars}  errors=${row.errors.length}${row.iterable ? "  ITERABLE-CRASH" : ""}`);
  for (const error of row.errors.slice(0, 2)) console.log(`        ${error.split("\n")[0].slice(0, 160)}`);
}
console.log(`\n${rows.length - failures}/${rows.length} screens clean`);
process.exit(failures ? 1 : 0);
