import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { dom } from "./dom-env.js";
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
let puts = 0;

beforeEach(() => {
  stored = JSON.parse(JSON.stringify(SETTINGS));
  puts = 0;
  (globalThis as { fetch?: unknown }).fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith("/welcome-messages")) {
      if (init?.method === "PUT") {
        puts += 1;
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

/**
 * Opens a Radix `Select` and waits for its portal.
 *
 * Radix records the pointer type on `pointerdown` and toggles on `click`, and
 * the panel is portalled to `document.body`, so the option cannot be queried
 * until the click's state has flushed.
 */
async function openSelect(trigger: Element) {
  trigger.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
  (trigger as HTMLElement).click();
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 20));
  });
}

/** Selects one option of the open panel, the way a pointer does. */
async function chooseOption(label: string) {
  const option = [...document.querySelectorAll<HTMLElement>("[role='option']")].find(entry =>
    entry.textContent?.includes(label)
  );
  assert.ok(option, `an option labelled ${label} is rendered`);
  option.dispatchEvent(new dom.window.MouseEvent("pointerup", { bubbles: true, cancelable: true, button: 0 }));
  option.click();
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 20));
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
    assert.equal(container.textContent.includes("نص الرسالة"), true);
    assert.equal(container.textContent.includes("معاينة الرسالة"), true, "the live preview is on the text tab");
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

test("an armed module without a channel is blocked before the request, with the reason on screen", async () => {
  const { container, root } = await mountScreen();
  try {
    const switches = container.querySelectorAll("[role='switch']");
    await press(container, switches[0] as HTMLElement);
    // The requirement is stated twice on purpose: at the field it belongs to,
    // and in the bar beside the button that would have sent the request.
    assert.equal(
      container.textContent.includes("الترحيب مفعَّل بلا قناة"),
      true,
      "the channel field says why it matters"
    );
    assert.equal(
      container.textContent.includes("اختر قناة الترحيب أولاً"),
      true,
      "the bar states the blocked reason without a round trip"
    );
    const save = clickButton(container, "حفظ التغييرات");
    assert.equal((save as HTMLButtonElement).disabled, true, "the save button is disabled while the form is invalid");
    await press(container, save);
    assert.equal(puts, 0, "a blocked save never reaches the server");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("the channel picker always has a label for 'no channel', so it is never a blank box", async () => {
  const { container, root } = await mountScreen();
  try {
    const trigger = container.querySelector<HTMLElement>("[role='combobox']");
    assert.ok(trigger, "the channel picker is a combobox");
    await openSelect(trigger);
    const labels = [...document.querySelectorAll<HTMLElement>("[role='option']")].map(option => option.textContent ?? "");
    assert.ok(labels.some(label => label.includes("بدون قناة")), "the sentinel value carries its own option");
    assert.ok(labels.some(label => label.includes("#general")), "and the guild's channels are listed");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("a burst of presses on save is one request, not a storm of them", async () => {
  // The reported symptom was a console full of identical 409s: `setSaving(true)`
  // only paints on the next render, so every click in a burst passed the
  // disabled check before it landed. The guard now flips in the click's tick.
  const { container, root } = await mountScreen();
  try {
    await press(container, container.querySelectorAll("[role='switch']")[0] as HTMLElement);
    const trigger = container.querySelector<HTMLElement>("[role='combobox']");
    assert.ok(trigger);
    await openSelect(trigger);
    await chooseOption("#welcome");

    const save = clickButton(container, "حفظ التغييرات");
    await act(async () => {
      save.click();
      save.click();
      save.click();
      await new Promise(resolve => setTimeout(resolve, 20));
    });
    assert.equal(puts, 1, "three presses in one tick still send one PUT");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("choosing a channel unblocks the save, and the PUT carries that channel", async () => {
  const { container, root } = await mountScreen();
  try {
    await press(container, container.querySelectorAll("[role='switch']")[0] as HTMLElement);
    const trigger = container.querySelector<HTMLElement>("[role='combobox']");
    assert.ok(trigger);
    await openSelect(trigger);
    await chooseOption("#welcome");

    const save = clickButton(container, "حفظ التغييرات");
    assert.equal((save as HTMLButtonElement).disabled, false, "a valid form can be saved");
    await press(container, save);
    assert.equal(puts, 1, "exactly one request went out");
    assert.equal(stored.enabled, true, "the PUT carried the armed state");
    assert.equal(stored.channelId, "755555555555555552", "and the channel the operator chose");
    assert.equal(container.textContent.includes("لديك تغييرات غير محفوظة"), false, "the bar clears after the save");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
