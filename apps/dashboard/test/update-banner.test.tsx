import "./dom-env.js";
import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { dom } from "./dom-env.js";
import { I18nProvider } from "@/lib/i18n";
import { UpdateBanner } from "@/components/update-banner";

/**
 * The "a new version is available" bar.
 *
 * It is the one piece of the dashboard that is *about* the dashboard: it tells
 * an operator with a tab left open that a deploy has landed. Nothing else
 * surfaces that, and it is invisible in a screenshot, so its contract is pinned
 * here instead.
 *
 * The baseline is the bundle this document actually loaded — read from its own
 * `<script type="module">` tag — not the first poll. That distinction is the
 * whole point: a tab opened *before* a deploy whose first poll lands *after* it
 * must still see the bar. A test that only compared two polls would pass while
 * that case stayed broken.
 */

const LOADED = "assets/index-AAAA.js";
const DEPLOYED = "assets/index-BBBB.js";

/** The entry script the served `index.html` names — the banner's own baseline. */
function installLoadedScript(src = LOADED) {
  const script = dom.window.document.createElement("script");
  script.type = "module";
  script.setAttribute("src", `/${src}`);
  dom.window.document.head.appendChild(script);
  return () => script.remove();
}

/** Answers `/api/version` with `version`; `"fail"` makes the request itself throw. */
function stubVersion(version: string | null | "fail") {
  (globalThis as unknown as { fetch: unknown }).fetch = async () => {
    if (version === "fail") throw new Error("network down");
    return {
      ok: true,
      status: 200,
      headers: new Map(),
      json: async () => ({ version })
    };
  };
}

async function renderBanner() {
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(I18nProvider, null, createElement(UpdateBanner)));
  });
  // The check runs in an effect; give the stubbed fetch a turn to resolve.
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 30));
  });
  return {
    container,
    cleanup: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  };
}

test("the bar appears when the served build differs from the loaded one", async () => {
  const removeScript = installLoadedScript(LOADED);
  stubVersion(DEPLOYED);
  const { container, cleanup } = await renderBanner();
  try {
    const text = container.textContent ?? "";
    assert.match(text, /تحديث جديد متاح/, "the bar announces the new version");
    const reload = [...container.querySelectorAll("button")].find(button =>
      /إعادة التحميل/.test(button.textContent ?? "")
    );
    assert.ok(reload, "the bar offers a reload button");
  } finally {
    await cleanup();
    removeScript();
  }
});

test("the bar stays hidden when the served build is the one that loaded", async () => {
  const removeScript = installLoadedScript(LOADED);
  stubVersion(LOADED);
  const { container, cleanup } = await renderBanner();
  try {
    assert.equal(container.textContent?.trim(), "", "an up-to-date tab is not interrupted");
  } finally {
    await cleanup();
    removeScript();
  }
});

/**
 * The case the baseline exists for: a tab opened *before* the deploy.
 *
 * The document loaded `AAAA`; by the time its first poll runs, the server is
 * already answering `BBBB`. Comparing two polls would adopt `BBBB` as the
 * baseline and report "up to date" while the tab runs stale code. Reading the
 * script tag makes the difference visible on the very first check.
 */
test("a tab opened before the deploy still sees the bar on its first check", async () => {
  const removeScript = installLoadedScript(LOADED);
  stubVersion(DEPLOYED);
  const { container, cleanup } = await renderBanner();
  try {
    assert.match(
      container.textContent ?? "",
      /تحديث جديد متاح/,
      "the pre-deploy tab is told, not left running the old bundle"
    );
  } finally {
    await cleanup();
    removeScript();
  }
});

test("a failed check is never reported as an update", async () => {
  const removeScript = installLoadedScript(LOADED);
  stubVersion("fail");
  const { container, cleanup } = await renderBanner();
  try {
    assert.equal(container.textContent?.trim(), "", "a network failure does not raise a false alarm");
  } finally {
    await cleanup();
    removeScript();
  }
});

/**
 * `null` is the server saying "I cannot name the served bundle" — an unbuilt
 * `dist/`, not a new build. The banner must treat it as no information rather
 * than as a version that differs from the loaded one.
 */
test("a null version from the server is not treated as a new build", async () => {
  const removeScript = installLoadedScript(LOADED);
  stubVersion(null);
  const { container, cleanup } = await renderBanner();
  try {
    assert.equal(container.textContent?.trim(), "", "an absent version is not an update");
  } finally {
    await cleanup();
    removeScript();
  }
});

/**
 * A document with no entry script — a test harness, an unusual embed — has no
 * baseline of its own. It falls back to the served build, which is the old
 * behaviour: the first poll becomes the baseline and no bar is shown. Pinned so
 * a future change cannot make the fallback path raise a spurious bar.
 */
test("a document with no entry script falls back without a false bar", async () => {
  stubVersion(DEPLOYED);
  const { container, cleanup } = await renderBanner();
  try {
    assert.equal(container.textContent?.trim(), "", "no script tag means no baseline to differ from");
  } finally {
    await cleanup();
  }
});
