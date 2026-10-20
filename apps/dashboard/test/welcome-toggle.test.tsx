import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import "./dom-env.js";
import { WelcomeView } from "../src/views/settings/welcome";
import type { DiscordRole, Guild, WelcomeSettings } from "@/types";

/**
 * The auto-role toggle, exercised end to end against the real screen.
 *
 * This is the test that caught the bug: HeroUI v3's Switch renders its hidden
 * checkbox inside `Switch.Content` (the SwitchButton), and the welcome screen
 * used to place a bare `Switch.Control` under the root — a span with nothing
 * clickable inside, so the toggle never flipped and the two role cards never
 * appeared. The test mounts the actual view, presses the actual switch, and
 * asserts the cards and the save bar behave.
 */

const GUILD: Guild = {
  id: "700000000000000001",
  name: "Welcome Test",
  iconUrl: null,
  memberCount: 10,
  tier: "owner",
  botPresent: true,
  canManage: true,
  canManageIdentity: true,
  canManageLogging: true,
  canManageCommands: true,
  canManageTiers: true,
  canInvite: true,
  canAdminInstance: false
} as unknown as Guild;

const SETTINGS: WelcomeSettings = {
  enabled: false,
  memberRoleId: null,
  botRoleId: null,
  delaySeconds: 0
};

const ROLES: DiscordRole[] = [
  { id: "711111111111111111", name: "عضو", color: 0x34d399, position: 1, managed: false, isDefault: false }
] as unknown as DiscordRole[];

let fetchCalls: { path: string; init?: RequestInit }[] = [];

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
  );
}

beforeEach(() => {
  fetchCalls = [];
  (globalThis as { fetch?: unknown }).fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    fetchCalls.push({ path, init });
    if (path.endsWith("/welcome")) {
      if (init?.method === "PUT") return jsonResponse({ settings: JSON.parse(String(init.body)), savedAt: new Date().toISOString() });
      return jsonResponse({ settings: SETTINGS, roles: ROLES });
    }
    return jsonResponse({ error: "NOT_FOUND" }, 404);
  }) as typeof fetch;
});

afterEach(() => {
  delete (globalThis as { fetch?: unknown }).fetch;
});

async function mountScreen() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(WelcomeView, { guild: GUILD }));
  });
  // The load effect resolves a promise; one more act settles it.
  await act(async () => {
    await Promise.resolve();
  });
  return { container, root };
}

function press(container: HTMLElement, root: Root) {
  const control = container.querySelector("[data-hero-ui-switch], [role='switch'], label:has(input[type='checkbox'])");
  assert.ok(control, "the switch renders a pressable control");
  const input = container.querySelector<HTMLInputElement>("input[type='checkbox']");
  assert.ok(input, "the switch renders its hidden checkbox input");
  act(() => {
    input!.click();
  });
  return input;
}

test("the toggle renders a real checkbox — the thing that was missing", async () => {
  const { container, root } = await mountScreen();
  try {
    const input = container.querySelector<HTMLInputElement>("input[type='checkbox']");
    assert.ok(input, "HeroUI's Switch.Content provides the hidden checkbox input");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("pressing the toggle reveals the member and bot role cards immediately", async () => {
  const { container, root } = await mountScreen();
  try {
    assert.equal(container.textContent.includes("رتب الأعضاء الجدد"), false, "cards are hidden while off");
    press(container, root);
    assert.equal(container.textContent.includes("رتب الأعضاء الجدد"), true, "member role card appears on toggle");
    assert.equal(container.textContent.includes("رتب البوتات الجديدة"), true, "bot role card appears on toggle");
    assert.equal(container.textContent.includes("التوقيت"), true, "timing card appears on toggle");
    assert.equal(container.textContent.includes("لديك تعديلات غير محفوظة"), true, "the save bar appears for the pending change");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("pressing again hides the cards without losing the saved values", async () => {
  const { container, root } = await mountScreen();
  try {
    press(container, root);
    press(container, root);
    assert.equal(container.textContent.includes("رتب الأعضاء الجدد"), false, "cards hidden again");
    assert.equal(container.textContent.includes("مُعطّل"), true, "state badge reads disabled");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("saving a toggled-on state persists through the existing PUT and reads back", async () => {
  const { container, root } = await mountScreen();
  try {
    press(container, root);
    const saveButton = [...container.querySelectorAll("button")].find(button => button.textContent?.includes("حفظ التعديلات"));
    assert.ok(saveButton, "the save bar's save button is present");
    await act(async () => {
      saveButton!.click();
      await Promise.resolve();
    });
    const put = fetchCalls.find(call => call.init?.method === "PUT");
    assert.ok(put, "the save went through the welcome PUT");
    const body = JSON.parse(String(put!.init!.body)) as { enabled: boolean };
    assert.equal(body.enabled, true, "the PUT carried the toggled-on state");
    assert.equal(container.textContent.includes("لديك تعديلات غير محفوظة"), false, "the bar clears after a confirmed save");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
