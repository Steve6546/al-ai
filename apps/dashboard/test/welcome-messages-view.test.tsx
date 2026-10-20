import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import "./dom-env.js";
import { WelcomeMessagesView } from "../src/views/settings/welcome-messages";
import type { ChannelOption, Guild, WelcomeMessageSettings } from "@/types";

/**
 * The welcome-messages screen, mounted for real: the three tabs switch
 * without a reload, the conditional image channel appears only in
 * separate-channel mode, the embed preview renders the draft's own text, and
 * a save goes through the single PUT with the toggled state.
 */

const GUILD: Guild = {
  id: "700000000000000004",
  name: "Welcome Msg Test",
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
  canAdminInstance: false
} as unknown as Guild;

const CHANNELS: ChannelOption[] = [
  { id: "755555555555555551", name: "general" },
  { id: "755555555555555552", name: "welcome" }
] as ChannelOption[];

const SETTINGS: WelcomeMessageSettings = {
  enabled: false,
  imageEnabled: false,
  imageMode: "with_message",
  imageChannelId: null,
  channelId: null,
  mode: "embed",
  text: "أهلاً {user}!",
  embed: {
    content: "Hello, {user}",
    title: "مرحباً بك! 🎉",
    titleUrl: null,
    description: "وصف الترحيب",
    color: "#3b82f6",
    thumbnailMode: "none",
    thumbnailUrl: null,
    imageMode: "none",
    imageDataUrl: null,
    imageUrl: null,
    footer: "",
    footerIconUrl: null,
    timestamp: true,
    fields: []
  },
  image: {
    width: 400,
    height: 200,
    quality: 0.9,
    background: { type: "transparent", color: null, imageDataUrl: null },
    avatar: { enabled: true, x: 136, y: 20, size: 128, circular: true, strokeColor: "#3b82f6", strokeWidth: 4 },
    username: { id: "username", text: "{username}", x: 200, y: 160, fontFamily: "Segoe UI", fontSize: 32, color: "#ffffff", weight: "bold", align: "center" },
    customTexts: []
  }
};

let stored: WelcomeMessageSettings = JSON.parse(JSON.stringify(SETTINGS));

beforeEach(() => {
  stored = JSON.parse(JSON.stringify(SETTINGS));
  (globalThis as { fetch?: unknown }).fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith("/welcome-messages")) {
      if (init?.method === "PUT") {
        stored = JSON.parse(String(init.body));
        return Promise.resolve(
          new Response(JSON.stringify({ settings: stored, savedAt: new Date().toISOString() }), { status: 200, headers: { "content-type": "application/json" } })
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ settings: stored, channels: CHANNELS }), { status: 200, headers: { "content-type": "application/json" } })
      );
    }
    return Promise.resolve(new Response("{}", { status: 404 }));
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
    root.render(createElement(WelcomeMessagesView, { guild: GUILD }));
  });
  await act(async () => {
    await Promise.resolve();
  });
  return { container, root };
}

function clickButton(container: HTMLElement, text: string): HTMLElement {
  const button = [...container.querySelectorAll("button")].find(entry => entry.textContent?.includes(text));
  assert.ok(button, `a button labelled ${text} is rendered`);
  return button;
}

async function press(container: HTMLElement, element: HTMLElement) {
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
}

test("the settings tab carries both switches and both channel pickers, with the image channel conditional", async () => {
  const { container, root } = await mountScreen();
  try {
    assert.equal(container.textContent.includes("تفعيل رسالة الترحيب"), true);
    assert.equal(container.textContent.includes("تفعيل صورة الترحيب"), true);
    assert.equal(container.textContent.includes("اختر قناة الصورة"), false, "the image channel is hidden in with_message mode");
    assert.equal(container.textContent.includes("قناة الترحيب"), true);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("the message tab switches between text and embed, and the preview renders the draft's own words", async () => {
  const { container, root } = await mountScreen();
  try {
    await press(container, clickButton(container, "الرسالة"));
    // The in-place editor renders the title and description as field values.
    const fields = Array.from(container.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea"));
    const titleInput = fields.find(element => element.value === "مرحباً بك! 🎉");
    assert.ok(titleInput, "the title is editable in place with the draft's value");
    const description = fields.find(element => element.value === "وصف الترحيب");
    assert.ok(description, "the description is editable in place");
    await press(container, clickButton(container, "نص فقط"));
    assert.equal(container.textContent.includes("رسالة الترحيب (نص عادي)"), true);
    assert.equal(container.textContent.includes("مرحباً بك! 🎉"), false, "the embed form is gone in text mode");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("the image tab shows the canvas, the sub-tab strip, and the drag hint", async () => {
  const { container, root } = await mountScreen();
  try {
    await press(container, clickButton(container, "الصورة"));
    assert.equal(container.textContent.includes("اسحب العناصر لتحريكها"), true);
    assert.equal(container.textContent.includes("اسم_المستخدِم"), true, "the username layer previews its rendered token");
    assert.equal(container.textContent.includes("الخلفية"), true, "the sub-tabs render");
    assert.equal(container.textContent.includes("الإعدادات"), true);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("toggling the module on and saving lands the armed state through the PUT", async () => {
  const { container, root } = await mountScreen();
  try {
    const switches = container.querySelectorAll("[role='switch']");
    assert.ok(switches.length >= 2, "both switches render as pressable controls");
    await press(container, switches[0] as HTMLElement);
    const save = clickButton(container, "حفظ التغييرات");
    assert.ok(container.textContent.includes("لديك تغييرات غير محفوظة"), "the save bar shows the pending change");
    await press(container, save);
    assert.equal(stored.enabled, true, "the PUT carried the armed state");
    assert.equal(container.textContent.includes("لديك تغييرات غير محفوظة"), false, "the bar clears after the save");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
