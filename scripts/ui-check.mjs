/**
 * A real-browser check of the dashboard.
 *
 * The unit tests see the DOM without a layout engine: `getBoundingClientRect()`
 * returns zeroes there, so "the page does not scroll sideways" and "the tabs fit
 * on a 320px screen" are not things they can assert. This runs the built
 * bundle in a real browser, at real viewport widths, and measures.
 *
 * Three things make it trustworthy:
 *
 * - The browser is launched with `--disable-extensions`, so a message about a
 *   `chrome-extension://` resource cannot be mistaken for a problem with this
 *   app. The console log is read from *this* browser, and the ones that were
 *   reported in the field (`200.js`, `M_ID`, `floating-widget.js`) come from an
 *   extension - they are in no bundle of ours.
 * - The API is stubbed *inside* the page, before any script runs, so the app
 *   boots into its real screens without a Discord session and without a
 *   network. The stub answers the three calls the boot makes and a neutral
 *   empty object for everything else.
 * - The bundle is served exactly as built (`dist/`), so what is measured is
 *   what would ship.
 *
 * Usage:  node scripts/ui-check.mjs            the shell, both palettes, every width
 *          node scripts/ui-check.mjs --live     the real pages, against the running stack
 * Output: .al-ai/ui-check/*.png  (git-ignored) and a report on stdout.
 * Exit:   0 when every check passed, 1 otherwise.
 */
import { createServer } from "node:http";
import { readFile, stat, mkdir, writeFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, extname, resolve, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import axe from "axe-core";
const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const distDir = join(repoRoot, "apps", "dashboard", "dist");
const outDir = join(repoRoot, ".al-ai", "ui-check");

/**
 * The real pages, visited against the running dashboard.
 *
 * The stubbed pass proves the *shell* behaves; this one proves the *pages* do,
 * against the real BFF and the real database - the responses, the permissions
 * and the empty states are the ones an operator would meet.
 *
 * It needs a session, because the pages are behind the session guard. The
 * session is read from the database (the newest one that has not expired) and
 * put into the browser as the cookie the server expects; it is never printed.
 */
const LIVE = process.argv.includes("--live");

async function liveSession() {
  const requireFrom = createRequire(join(process.cwd(), "apps", "dashboard", "package.json"));
  const { Client } = requireFrom("pg");
  // The connection string may not be in the environment when the script is run
  // directly; the project's own `.env` is the other place it lives.
  const connectionString =
    process.env.DATABASE_URL ??
    Object.fromEntries(
      (await readFile(join(process.cwd(), ".env"), "utf8"))
        .split(/\r?\n/)
        .filter(line => line && !line.startsWith("#") && line.includes("="))
        .map(line => {
          const index = line.indexOf("=");
          return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
        })
    ).DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set - run through npm so --env-file=.env applies");
  const client = new Client({ connectionString, application_name: "al-ai-ui-check" });
  await client.connect();
  const session = await client.query(
    "select id from oauth_sessions where expires_at > now() order by last_seen_at desc limit 1"
  );
  const guild = await client.query(
    "select id from guilds where bot_present order by member_count desc limit 1"
  );
  await client.end();
  if (!session.rows.length) throw new Error("no valid session in the database - run `npm run dev:session` first");
  if (!guild.rows.length) throw new Error("no guild with the bot in it - the pages would all be empty");
  return { session: session.rows[0].id, guild: guild.rows[0].id };
}

/** The pages of the dashboard, in the order an operator meets them. */
const LIVE_PAGES = [
  { label: "dashboard", view: "" },
  { label: "levels", view: "levels" },
  { label: "commands", view: "commands" },
  { label: "logs", view: "logs" },
  { label: "welcome-messages", view: "welcome-messages" },
  { label: "security", view: "security" },
  { label: "audit", view: "audit" },
  { label: "network", view: "network" },
  { label: "customization", view: "customization" }
];

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
].filter(Boolean);

const VIEWPORTS = [
  { name: "320-small", width: 320, height: 720 },
  { name: "375-phone", width: 375, height: 812 },
  { name: "390-phone", width: 390, height: 844 },
  { name: "430-phone-large", width: 430, height: 932 },
  { name: "768-tablet", width: 768, height: 1024 },
  { name: "1024-small-desktop", width: 1024, height: 768 },
  { name: "1440-desktop", width: 1440, height: 900 }
];

/**
 * The accessibility scan.
 *
 * `axe-core` is run inside the same real browser, against the same screens, in
 * both palettes - so the result is a measurement of the shipped bundle rather
 * than of a claim. The rules checked are the WCAG 2.2 A/AA ones axe ships
 * (colour-contrast included), and the report names the offending nodes.
 *
 * The file is *injected* into the page rather than imported, so it is resolved
 * from the package rather than from a hard-coded path - which also tells the
 * dependency checker that the package is genuinely used.
 */
const AXE_SOURCE = fileURLToPath(import.meta.resolve("axe-core"));

/**
 * Waits until the app has finished its first load.
 *
 * The live pages answer from the real BFF, which reads Discord - so a screen
 * can still be showing the loading row a second after the navigation. The
 * check waits for the loading text to go rather than for a fixed delay, and
 * reports how long it took.
 */
async function waitForApp(cdp, sessionId, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const probe = await cdp.send(
      "Runtime.evaluate",
      {
        expression: `(() => {
          const text = (document.querySelector("#root")?.textContent ?? "").trim();
          return JSON.stringify({ loading: text.includes("جارٍ التحميل"), length: text.length });
        })()`,
        returnByValue: true
      },
      sessionId
    );
    const state = JSON.parse(probe.result.value);
    if (!state.loading && state.length > 0) return true;
    await sleep(300);
  }
  return false;
}

async function runAxe(cdp, sessionId, url, label, palette) {
  const source = await readFile(AXE_SOURCE, "utf8");
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source }, sessionId);
  await cdp.send("Page.navigate", { url }, sessionId);
  await sleep(1500);
  const result = await cdp.send(
    "Runtime.evaluate",
    {
      expression: `(async () => {
        if (typeof axe === "undefined") return JSON.stringify({ error: "axe was not injected" });
        const run = await axe.run(document, { resultTypes: ["violations"] });
        return JSON.stringify(
          run.violations.map(violation => ({
            id: violation.id,
            impact: violation.impact,
            help: violation.help,
            nodes: violation.nodes.slice(0, 3).map(node => ({
              target: node.target.join(" "),
              html: node.html.slice(0, 220),
              summary: (node.failureSummary ?? "").split("\\n")[0]
            }))
          }))
        );
      })()`,
      awaitPromise: true,
      returnByValue: true
    },
    sessionId
  );
  const violations = JSON.parse(result.result.value);
  return { label, palette, violations };
}

/**
 * The palettes to sweep.
 *
 * The appearance follows the operating system by default, and a machine's
 * system can be either - so a check that only ever saw one of them would
 * leave the other one unmeasured. The media feature is emulated rather than
 * the preference stored, because the stored preference is per-browser-profile
 * and the emulated one is exactly the thing the theme engine reads.
 */
const PALETTES = [
  { name: "light", scheme: "light" },
  { name: "dark", scheme: "dark" }
];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2"
};

/** The API the boot actually calls, answered inside the page. */
const API_STUB = `
(() => {
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  const routes = {
    "/api/session": {
      authenticated: true,
      user: { id: "1", username: "owner", avatarUrl: null, expiresAt: new Date(Date.now() + 86400000).toISOString(), isPlatformOwner: true }
    },
    "/api/health": {
      status: "healthy",
      dashboard: "online",
      bot: "connected",
      database: "reachable",
      verification: { guildCount: 1, uniqueUsers: 42, reviewRequired: false, warning: null },
      gateway: { eventsLastMinute: 0, ceiling: 120 }
    },
    "/api/guilds": {
      guilds: [{
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
      }]
    },
    "/api/guilds/111111111111111111/metrics": {
      bot: { online: true, pingMs: 42, lastSeenAt: new Date().toISOString() },
      members: { total: 42, online: 7, onlineNote: null },
      punishments24h: { total: 0, byAction: {} },
      recentActivity: []
    }
  };
  const original = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.url, window.location.origin);
    if (url.pathname.startsWith("/api/")) {
      const body = routes[url.pathname] ?? {};
      return Promise.resolve(json(body));
    }
    return original(input, init);
  };
})();
`;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    try {
      await stat(candidate);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/** Serves `dist/` the way the production server does, with an SPA fallback. */
async function serveDist() {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const requested = normalize(url.pathname).replace(/^(\.\.[/\\])+/, "");
    let filePath = join(distDir, requested);
    try {
      const info = await stat(filePath);
      if (info.isDirectory()) filePath = join(filePath, "index.html");
    } catch {
      filePath = join(distDir, "index.html");
    }
    try {
      const body = await readFile(filePath);
      response.writeHead(200, { "content-type": MIME[extname(filePath)] ?? "application/octet-stream" });
      response.end(body);
    } catch {
      response.writeHead(404).end("not found");
    }
  });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  const { port } = server.address();
  return { server, origin: `http://127.0.0.1:${port}` };
}

/** A minimal CDP client over the browser's WebSocket. */
class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    socket.addEventListener("message", event => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(`${message.error.message} (${JSON.stringify(message.error.data ?? "")})`));
        else resolve(message.result);
        return;
      }
      const handlers = this.listeners.get(message.method) ?? [];
      for (const handler of handlers) handler(message.params, message.sessionId);
    });
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", () => reject(new Error("CDP socket failed")), { once: true });
    });
    return new Cdp(socket);
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.socket.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  on(method, handler) {
    const handlers = this.listeners.get(method) ?? [];
    handlers.push(handler);
    this.listeners.set(method, handlers);
  }

  close() {
    try {
      this.socket.close();
    } catch {
      /* already gone */
    }
  }
}

async function waitForPort(portFile, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const text = await readFile(portFile, "utf8");
      const port = Number(text.split("\n")[0].trim());
      if (Number.isFinite(port) && port > 0) return port;
    } catch {
      /* not written yet */
    }
    await sleep(120);
  }
  throw new Error("the browser did not report a debugging port");
}

async function main() {
  const chrome = await findChrome();
  if (!chrome) {
    console.log("SKIP  no Chrome or Edge binary found - the visual check cannot run on this machine");
    return 0;
  }
  await stat(join(distDir, "index.html")).catch(() => {
    throw new Error("apps/dashboard/dist/index.html is missing - run `npm run build` first");
  });
  await mkdir(outDir, { recursive: true });

  // The live pass drives the *running* dashboard (the real BFF, the real
  // database, the real session guard); the stubbed pass serves the built
  // bundle on its own, which is what makes the viewport sweep deterministic.
  const live = LIVE ? await liveSession() : null;
  const { server, origin: stubOrigin } = await serveDist();
  const origin = live ? "http://127.0.0.1:3000" : stubOrigin;
  const profile = mkdtempSync(join(tmpdir(), "al-ai-ui-"));
  const browser = spawn(
    chrome,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      // The point of the check: a browser without extensions, so a
      // `chrome-extension://` message cannot be blamed on this app.
      "--disable-extensions",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank"
    ],
    { stdio: "ignore", windowsHide: true }
  );

  const failures = [];
  const consoleMessages = [];
  let cdp = null;

  try {
    const port = await waitForPort(join(profile, "DevToolsActivePort"));
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    cdp = await Cdp.connect(version.webSocketDebuggerUrl);

    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });

    cdp.on("Runtime.consoleAPICalled", params => {
      consoleMessages.push({ type: params.type, text: (params.args ?? []).map(arg => arg.value ?? arg.description ?? "").join(" ") });
    });
    cdp.on("Runtime.exceptionThrown", params => {
      consoleMessages.push({ type: "exception", text: params.exceptionDetails?.text ?? "unknown exception" });
    });
    cdp.on("Log.entryAdded", params => {
      consoleMessages.push({ type: params.entry.level, text: params.entry.text });
    });

    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Runtime.enable", {}, sessionId);
    await cdp.send("Log.enable", {}, sessionId);
    await cdp.send("Network.enable", {}, sessionId);

    // The live pass signs the browser in with the session the database holds,
    // so the pages answer with the real data. The cookie is never printed.
    if (live) {
      await cdp.send(
        "Network.setCookie",
        {
          name: "__Host-al_ai_session",
          value: live.session,
          url: "http://127.0.0.1:3000",
          path: "/",
          secure: true,
          httpOnly: true
        },
        sessionId
      );
    }
    if (!LIVE) await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: API_STUB }, sessionId);

    for (const palette of PALETTES) {
      await cdp.send(
        "Emulation.setEmulatedMedia",
        { features: [{ name: "prefers-color-scheme", value: palette.scheme }] },
        sessionId
      );

      for (const viewport of VIEWPORTS) {
        await cdp.send(
          "Emulation.setDeviceMetricsOverride",
          { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.width < 700 },
          sessionId
        );
        await cdp.send("Page.navigate", { url: `${origin}/` }, sessionId);
        await sleep(1500);

        const probe = await cdp.send(
          "Runtime.evaluate",
          {
            expression: `(() => {
              const root = document.querySelector("#root");
              const doc = document.documentElement;
              const widest = [...document.querySelectorAll("*")]
                .map(el => ({ tag: el.tagName, width: el.getBoundingClientRect().right }))
                .filter(entry => entry.width > window.innerWidth + 1)
                .slice(0, 3)
                .map(entry => entry.tag + ":" + Math.round(entry.width));
              return JSON.stringify({
                overflow: doc.scrollWidth - window.innerWidth,
                direction: getComputedStyle(doc).direction,
                theme: doc.dataset.theme ?? "(none)",
                appearance: doc.dataset.appearance ?? "(none)",
                rendered: (root?.textContent ?? "").trim().length,
                widest
              });
            })()`,
            returnByValue: true
          },
          sessionId
        );

        const result = JSON.parse(probe.result.value);
        const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
        await writeFile(join(outDir, `${palette.name}-${viewport.name}.png`), Buffer.from(shot.data, "base64"));

        const overflowOk = result.overflow <= 1;
        const rtlOk = result.direction === "rtl";
        const renderedOk = result.rendered > 0;
        const themeOk = result.theme === palette.scheme;
        if (!overflowOk) failures.push(`${palette.name}/${viewport.name}: horizontal overflow of ${result.overflow}px (${result.widest.join(", ")})`);
        if (!rtlOk) failures.push(`${palette.name}/${viewport.name}: document direction is ${result.direction}, not rtl`);
        if (!renderedOk) failures.push(`${palette.name}/${viewport.name}: the app rendered nothing`);
        if (!themeOk) failures.push(`${palette.name}/${viewport.name}: the palette resolved to "${result.theme}"`);

        console.log(
          `${overflowOk && rtlOk && renderedOk && themeOk ? "PASS" : "FAIL"}  ${palette.name.padEnd(5)} ${viewport.name.padEnd(16)} ${String(
            viewport.width
          ).padStart(4)}px  overflow=${result.overflow}px dir=${result.direction} theme=${result.theme} text=${result.rendered} chars`
        );
      }
    }

    // The real pages, each one visited in both palettes.
    if (live) {
      // The guild to visit is one the *signed-in account* can reach - the
      // dashboard's own list, read through the API the page itself uses.
      await cdp.send("Page.navigate", { url: `${origin}/` }, sessionId);
      await sleep(1500);
      const guildList = await cdp.send(
        "Runtime.evaluate",
        {
          expression: `(async () => {
            const response = await fetch("/api/guilds", { credentials: "same-origin" });
            const body = await response.json();
            return JSON.stringify((body.guilds ?? []).map(guild => ({ id: guild.id, members: guild.memberCount ?? 0 })));
          })()`,
          awaitPromise: true,
          returnByValue: true
        },
        sessionId
      );
      const guilds = JSON.parse(guildList.result.value);
      if (!guilds.length) {
        failures.push("the signed-in account reaches no guild - the pages would all be empty");
      }
      const guild = guilds.sort((a, b) => b.members - a.members)[0]?.id ?? live.guild;
      console.log(`live pages: ${guilds.length} guild(s) reachable, visiting the largest`);

      const liveReports = [];
      for (const palette of PALETTES) {
        await cdp.send(
          "Emulation.setEmulatedMedia",
          { features: [{ name: "prefers-color-scheme", value: palette.scheme }] },
          sessionId
        );
        for (const width of [375, 1440]) {
          await cdp.send(
            "Emulation.setDeviceMetricsOverride",
            { width, height: width === 375 ? 812 : 900, deviceScaleFactor: 1, mobile: width < 700 },
            sessionId
          );
          for (const page of LIVE_PAGES) {
            const path = `/dashboard/${guild}${page.view ? `/${page.view}` : ""}`;
            await cdp.send("Page.navigate", { url: `${origin}${path}` }, sessionId);
            await waitForApp(cdp, sessionId);
            // The dashboard throttles a session to 120 requests a minute, and a
            // page load spends five or six of them. The sweep therefore paces
            // itself: running it flat out would measure the throttle answering 429
            // instead of the pages.
            await sleep(3_500);
            const probe = await cdp.send(
              "Runtime.evaluate",
              {
                expression: `(() => {
                  const doc = document.documentElement;
                  const text = (document.querySelector("#root")?.textContent ?? "").trim();
                  const clipped = [...document.querySelectorAll("main *")]
                    .filter(el => {
                      const style = getComputedStyle(el);
                      return style.overflow === "hidden" && el.scrollWidth > el.clientWidth + 2 && el.children.length === 0;
                    })
                    .slice(0, 2)
                    .map(el => el.tagName + "." + (el.className || "").toString().slice(0, 40));
                  return JSON.stringify({
                    overflow: doc.scrollWidth - window.innerWidth,
                    text: text.length,
                    crashed: text.includes("تعذّر عرض") || text.includes("Something went wrong"),
                    clipped
                  });
                })()`,
                returnByValue: true
              },
              sessionId
            );
            const result = JSON.parse(probe.result.value);
            const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
            await writeFile(
              join(outDir, `live-${palette.name}-${width}-${page.label}.png`),
              Buffer.from(shot.data, "base64")
            );
            const ok = result.overflow <= 1 && result.text > 0 && !result.crashed;
            if (!ok) {
              failures.push(
                `live ${palette.name}/${width}px ${page.label}: overflow=${result.overflow}px text=${result.text} crashed=${result.crashed} clipped=${result.clipped.join(",")}`
              );
            }
            console.log(
              `${ok ? "PASS" : "FAIL"}  live ${palette.name.padEnd(5)} ${String(width).padStart(4)}px ${page.label.padEnd(17)} overflow=${result.overflow}px text=${result.text} chars${result.crashed ? " CRASHED" : ""}`
            );
          }
        }
      }

      // The accessibility scan over every real page, in both palettes.
      for (const palette of PALETTES) {
        await cdp.send(
          "Emulation.setEmulatedMedia",
          { features: [{ name: "prefers-color-scheme", value: palette.scheme }] },
          sessionId
        );
        await cdp.send(
          "Emulation.setDeviceMetricsOverride",
          { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false },
          sessionId
        );
        for (const page of LIVE_PAGES) {
          const path = `/dashboard/${live.guild}${page.view ? `/${page.view}` : ""}`;
          await cdp.send("Page.navigate", { url: `${origin}${path}` }, sessionId);
          await waitForApp(cdp, sessionId);
          await sleep(3_500);
          liveReports.push(await runAxe(cdp, sessionId, `${origin}${path}`, page.label, palette.name));
        }
      }
      const liveViolations = liveReports.flatMap(report =>
        report.violations.map(violation => ({ ...violation, screen: report.label, palette: report.palette }))
      );
      for (const report of liveReports) {
        const ids = report.violations.map(violation => violation.id);
        console.log(
          `${ids.length === 0 ? "PASS" : "FAIL"}  axe ${report.palette.padEnd(5)} ${report.label.padEnd(17)} ${
            ids.length === 0 ? "no violations" : ids.join(", ")
          }`
        );
      }
      for (const violation of liveViolations) {
        failures.push(
          `axe live (${violation.screen}/${violation.palette}) ${violation.id} [${violation.impact}] ${violation.help} — ${violation.nodes
            .map(node => `${node.target} ${node.html}`)
            .join(" | ")}`
        );
      }
      await writeFile(join(outDir, "axe-live.json"), JSON.stringify(liveReports, null, 2));
    }
    // The stub-driven pass: the shell, the account menu, the appearance panel and
    // the broken-payload scenario. In live mode the API answers with the real
    // data, so the stub-only expectations do not apply.
    if (!live) {
    // The guild screen: the shell, the sidebar and the header, at the two
    // widths that matter - the desktop rail and the phone drawer.
    // The route is `/dashboard/:guildId[/view]` (apps/dashboard/src/lib/router.ts),
    // and the id has to be a snowflake or the app treats it as a broken link.
    const GUILD_ID = "111111111111111111";
    for (const palette of PALETTES) {
      await cdp.send(
        "Emulation.setEmulatedMedia",
        { features: [{ name: "prefers-color-scheme", value: palette.scheme }] },
        sessionId
      );
    for (const shell of [
      { name: "1440-guild", width: 1440, height: 900 },
      { name: "1024-guild", width: 1024, height: 768 },
      { name: "375-guild", width: 375, height: 812 }
    ]) {
        await cdp.send(
          "Emulation.setDeviceMetricsOverride",
          { width: shell.width, height: shell.height, deviceScaleFactor: 1, mobile: shell.width < 700 },
          sessionId
        );
        await cdp.send("Page.navigate", { url: `${origin}/dashboard/${GUILD_ID}` }, sessionId);
        await sleep(1800);
        const probe = await cdp.send(
          "Runtime.evaluate",
          {
            expression: `(() => {
              const doc = document.documentElement;
              const text = (document.querySelector("#root")?.textContent ?? "").trim();
              const nav = document.querySelector("header nav");
              const sidebar = document.querySelector("aside");
              return JSON.stringify({
                overflow: doc.scrollWidth - window.innerWidth,
                text: text.length,
                hasBreadcrumb: Boolean(nav),
                hasSidebar: Boolean(sidebar),
                theme: doc.dataset.theme ?? "(none)",
                path: window.location.pathname
              });
            })()`,
            returnByValue: true
          },
          sessionId
        );
        const result = JSON.parse(probe.result.value);
        const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
        await writeFile(join(outDir, `${palette.name}-${shell.name}.png`), Buffer.from(shot.data, "base64"));
        if (result.overflow > 1) failures.push(`${palette.name}/${shell.name}: horizontal overflow of ${result.overflow}px`);
        if (!result.hasBreadcrumb) failures.push(`${palette.name}/${shell.name}: the header carries no breadcrumb`);
        if (shell.width >= 1024 && !result.hasSidebar) failures.push(`${palette.name}/${shell.name}: the desktop sidebar is missing`);
        if (result.path !== `/dashboard/${GUILD_ID}`) failures.push(`${palette.name}/${shell.name}: the app left the guild route (${result.path})`);
        if (result.theme !== palette.scheme) failures.push(`${palette.name}/${shell.name}: the palette resolved to "${result.theme}"`);
        console.log(
          `${result.overflow <= 1 && result.hasBreadcrumb ? "PASS" : "FAIL"}  ${palette.name.padEnd(5)} ${shell.name.padEnd(12)} ${String(
            shell.width
          ).padStart(4)}px  overflow=${result.overflow}px breadcrumb=${result.hasBreadcrumb} sidebar=${result.hasSidebar} theme=${result.theme} text=${result.text} chars`
        );
      }
    }

    // The account menu and the appearance panel, opened for real: the account
    // menu has to offer the actions that exist, and the appearance panel has to
    // change the palette when a mode is picked.
    await cdp.send(
      "Emulation.setDeviceMetricsOverride",
      { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false },
      sessionId
    );
    await cdp.send("Page.navigate", { url: `${origin}/dashboard/111111111111111111` }, sessionId);
    await sleep(1500);
    const accountClicked = await cdp.send(
      "Runtime.evaluate",
      {
        expression: `(() => {
          const trigger = document.querySelector("button[data-account-trigger]");
          if (!trigger) return "no trigger";
          // Radix opens a menu on pointerdown, not on click: a synthetic
          // \`click()\` would leave the menu closed and the check would be
          // measuring the test rather than the menu.
          const options = { bubbles: true, cancelable: true, button: 0, pointerType: "mouse", isPrimary: true };
          trigger.dispatchEvent(new PointerEvent("pointerdown", options));
          trigger.dispatchEvent(new PointerEvent("pointerup", options));
          // A popover toggles on click; a menu opens on pointerdown. Dispatching
          // the whole sequence covers both, the way a real pointer does.
          trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
          return "clicked";
        })()`,
        returnByValue: true
      },
      sessionId
    );
    await sleep(600);
    const menu = await cdp.send(
      "Runtime.evaluate",
      {
        expression: `(() => {
          const text = document.body.textContent ?? "";
          const wanted = ["فتح الحساب في Discord", "تسجيل الخروج"];
          const copyButton = document.querySelector("button[aria-label='نسخ معرّف Discord']");
          return JSON.stringify({
            open: wanted.every(item => text.includes(item)) && Boolean(copyButton),
            missing: wanted.filter(item => !text.includes(item)).concat(copyButton ? [] : ["نسخ معرّف Discord"])
          });
        })()`,
        returnByValue: true
      },
      sessionId
    );
    const menuResult = JSON.parse(menu.result.value);
    if (!menuResult.open) {
      failures.push(`the account menu is missing: ${menuResult.missing.join(", ")}`);
    }
    console.log(`${menuResult.open ? "PASS" : "FAIL"}  account menu       ${accountClicked.result.value}  open=${menuResult.open}`);

    // The appearance panel: open it from the sidebar and pick the light mode,
    // then read the palette back - the panel has to change the document, not
    // just look like it does.
    //
    // The account menu is closed first: an open menu is a dismissable layer,
    // and it swallows the pointer events aimed at the button underneath it.
    await cdp.send(
      "Runtime.evaluate",
      {
        expression: `(() => {
          const account = document.querySelector("button[data-account-trigger]");
          if (account) {
            const options = { bubbles: true, cancelable: true, button: 0, pointerType: "mouse", isPrimary: true };
            account.dispatchEvent(new PointerEvent("pointerdown", options));
            account.dispatchEvent(new PointerEvent("pointerup", options));
          }
          return "closed";
        })()`,
        returnByValue: true
      },
      sessionId
    );
    await sleep(400);
    await cdp.send(
      "Runtime.evaluate",
      {
        expression: `(() => {
          const trigger = document.querySelector("button[aria-label='المظهر']");
          if (!trigger) return JSON.stringify({ clicked: false, reason: "no appearance button" });
          const options = { bubbles: true, cancelable: true, button: 0, pointerType: "mouse", isPrimary: true };
          trigger.dispatchEvent(new PointerEvent("pointerdown", options));
          trigger.dispatchEvent(new PointerEvent("pointerup", options));
          trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
          return JSON.stringify({ clicked: true, before: document.documentElement.dataset.theme });
        })()`,
        returnByValue: true
      },
      sessionId
    );
    await sleep(600);
    const pick = await cdp.send(
      "Runtime.evaluate",
      {
        expression: `(() => {
          const light = [...document.querySelectorAll("button")].find(button => button.textContent?.trim() === "فاتح");
          if (!light) {
            const trigger = document.querySelector("button[aria-label='المظهر']");
            return JSON.stringify({
              picked: false,
              triggerState: trigger?.getAttribute("data-state") ?? "(none)",
              poppers: document.querySelectorAll("[data-radix-popper-content-wrapper]").length,
              menus: document.querySelectorAll("[role='dialog']").length
            });
          }
          const options = { bubbles: true, cancelable: true, button: 0, pointerType: "mouse", isPrimary: true };
          light.dispatchEvent(new PointerEvent("pointerdown", options));
          light.dispatchEvent(new PointerEvent("pointerup", options));
          light.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
          return JSON.stringify({ picked: true });
        })()`,
        returnByValue: true
      },
      sessionId
    );
    const pickResult = pick.result.value;
    await sleep(500);
    const afterTheme = await cdp.send(
      "Runtime.evaluate",
      {
        expression: `JSON.stringify({
          theme: document.documentElement.dataset.theme,
          stored: window.localStorage.getItem("al-ai.appearance")
        })`,
        returnByValue: true
      },
      sessionId
    );
    const themeResult = JSON.parse(afterTheme.result.value);
    const switched = themeResult.theme === "light" && (themeResult.stored ?? "").includes("light");
    if (!switched) {
      failures.push(`the appearance panel did not switch the palette (theme=${themeResult.theme}, stored=${themeResult.stored})`);
    }
    console.log(
      `${switched ? "PASS" : "FAIL"}  appearance panel   pick=${pickResult} theme=${themeResult.theme} stored=${themeResult.stored}`
    );

    // The accessibility scan, on the screens that matter, in both palettes.
    const axeReports = [];
    for (const palette of PALETTES) {
      await cdp.send(
        "Emulation.setEmulatedMedia",
        { features: [{ name: "prefers-color-scheme", value: palette.scheme }] },
        sessionId
      );
      for (const screen of [
        { label: "selector", path: "/" },
        { label: "dashboard", path: "/dashboard/111111111111111111" }
      ]) {
        axeReports.push(await runAxe(cdp, sessionId, `${origin}${screen.path}`, screen.label, palette.name));
      }
    }
    const axeViolations = axeReports.flatMap(report =>
      report.violations.map(violation => ({ ...violation, screen: report.label, palette: report.palette }))
    );
    for (const report of axeReports) {
      const ids = report.violations.map(violation => violation.id);
      console.log(
        `${ids.length === 0 ? "PASS" : "FAIL"}  axe ${report.palette.padEnd(5)} ${report.label.padEnd(10)} ${
          ids.length === 0 ? "no violations" : ids.join(", ")
        }`
      );
    }
    for (const violation of axeViolations) {
      failures.push(
        `axe (${violation.screen}/${violation.palette}) ${violation.id} [${violation.impact}] ${violation.help} — ${violation.nodes.map(node => `${node.target} ${node.html}`).join(" | ")}`
      );
    }
    await writeFile(join(outDir, "axe.json"), JSON.stringify(axeReports, null, 2));


    // A broken payload must not take the screen down with it. The stub is
    // replaced with one that answers the metrics route with `{}` - the shape a
    // stale server or a truncated response would produce - and the screen has
    // to say so instead of throwing inside the render.
    const brokenStub = `
      (() => {
        const original = window.fetch.bind(window);
        window.fetch = (input, init) => {
          const url = new URL(typeof input === "string" ? input : input.url, window.location.origin);
          if (url.pathname.endsWith("/metrics")) {
            return Promise.resolve(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
          }
          return original(input, init);
        };
      })();
    `;
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: brokenStub }, sessionId);
    await cdp.send("Page.navigate", { url: `${origin}/dashboard/111111111111111111` }, sessionId);
    await sleep(1800);
    const brokenProbe = await cdp.send(
      "Runtime.evaluate",
      {
        expression: `(() => {
          const text = (document.querySelector("#root")?.textContent ?? "").trim();
          return JSON.stringify({
            overflow: document.documentElement.scrollWidth - window.innerWidth,
            hasMessage: text.includes("غير مكتملة") || text.includes("تعذّر"),
            text: text.length
          });
        })()`,
        returnByValue: true
      },
      sessionId
    );
    const brokenResult = JSON.parse(brokenProbe.result.value);
    const brokenShot = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
    await writeFile(join(outDir, "375-broken-metrics.png"), Buffer.from(brokenShot.data, "base64"));
    if (!brokenResult.hasMessage) failures.push("a truncated metrics payload did not produce a readable message");
    console.log(
      `${brokenResult.hasMessage ? "PASS" : "FAIL"}  broken metrics   375px  message=${brokenResult.hasMessage} overflow=${brokenResult.overflow}px`
    );

    const errors = consoleMessages.filter(message => message.type === "error" || message.type === "exception");
    const extensionNoise = errors.filter(message => /chrome-extension|floating-widget|200\.js|M_ID/.test(message.text));
    const realErrors = errors.filter(message => !/chrome-extension|floating-widget|200\.js|M_ID/.test(message.text));
    if (realErrors.length) failures.push(`${realErrors.length} console error(s): ${realErrors.slice(0, 3).map(e => e.text).join(" | ")}`);
    console.log(`console: ${consoleMessages.length} message(s), ${errors.length} error(s), ${extensionNoise.length} extension-origin`);
    console.log(`axe-core ${axe.version}: ${axeReports.length} screen/palette combinations scanned`);

    await writeFile(join(outDir, "console.json"), JSON.stringify(consoleMessages, null, 2));
    }
  } finally {
    cdp?.close();
    browser.kill();
    server.close();
    // The browser's profile is a temporary directory: left behind, every run
    // would add one. Windows keeps the directory locked for a moment after the
    // process is gone, so the removal is retried rather than attempted once.
    await new Promise(resolve => {
      if (browser.exitCode !== null || browser.signalCode !== null) return resolve(undefined);
      browser.once("exit", () => resolve(undefined));
      setTimeout(() => resolve(undefined), 5_000);
    });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
        break;
      } catch {
        await sleep(400);
      }
    }
  }

  console.log("");
  if (failures.length) {
    console.log(`${failures.length} check(s) failed:`);
    for (const failure of failures) console.log(`  - ${failure}`);
    return 1;
  }
  console.log("all visual checks passed");
  return 0;
}

process.exitCode = await main();
