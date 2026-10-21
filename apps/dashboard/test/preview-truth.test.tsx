import "./dom-env.js";
import test from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { dom } from "./dom-env.js";
import { BotLivePreview } from "@/views/settings/bot-preview";
import { WelcomeMessagePreview } from "@/components/welcome-message-preview";
import { WelcomeImageCanvas } from "@/views/settings/welcome-image-canvas";
import type { PreviewProfile } from "@/views/settings/bot-preview";
import type { WelcomeImageConfig, WelcomeMessageSettings } from "@al-ai/core/browser";

/**
 * The two previews, and the promise they make.
 *
 * A preview is the operator's only view of what the members will see, so it
 * has to answer two questions honestly: *what* will be shown, and *is it
 * saved yet*. The first bug this file pins is the banner: the preview used to
 * fall back to the **account's** banner, so a server with no banner of its own
 * showed a picture that had never belonged to it.
 */

const PROFILE: PreviewProfile = {
  username: "AL AI",
  nickname: "AL AI",
  serverAvatarDataUrl: null,
  serverBannerDataUrl: null,
  accountAvatarUrl: "https://cdn.discordapp.com/avatars/1/account-avatar.png",
  accountBannerUrl: "https://cdn.discordapp.com/banners/1/account-banner.png",
  bio: null,
  roleColor: null,
  roleIconUrl: null
};

function render(element: React.ReactElement) {
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  return { container, root };
}

test("the bot's banner is the server's banner, never the account's", () => {
  const { container, root } = render(
    <BotLivePreview profile={PROFILE} guildName="سيرفر" memberCount={42} />
  );
  try {
    const html = container.innerHTML;
    // The *picture* falls back to the account's - that is Discord's own rule
    // for a member with no override. The *banner* does not.
    assert.equal(html.includes("account-avatar.png"), true, "the picture falls back to the account's, as Discord does");
    assert.equal(html.includes("account-banner.png"), false, "the account's banner is never the server's banner");
    assert.equal(html.includes("لا يوجد غلاف"), true, "a server with no banner says so");
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

test("the server's own banner is drawn", () => {
  const { container, root } = render(
    <BotLivePreview
      profile={{ ...PROFILE, serverBannerDataUrl: "data:image/png;base64,AAA" }}
      guildName="سيرفر"
      memberCount={42}
    />
  );
  try {
    assert.equal(container.innerHTML.includes("data:image/png;base64,AAA"), true, "the server's banner is drawn");
    assert.equal(container.innerHTML.includes("لا يوجد غلاف"), false, "and the empty state is gone");
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

test("a draft that is not saved says so instead of claiming Discord has it", () => {
  const { container, root } = render(
    <BotLivePreview profile={PROFILE} guildName="سيرفر" memberCount={42} pending />
  );
  try {
    assert.equal(container.textContent.includes("لم تُحفظ بعد"), true);
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

const SETTINGS: WelcomeMessageSettings = {
  enabled: true,
  imageEnabled: false,
  imageMode: "with_message",
  imageChannelId: null,
  channelId: "10",
  mode: "text",
  text: "أهلاً {user} في {server}",
  embed: {
    content: "",
    title: "",
    titleUrl: null,
    description: "",
    color: null,
    thumbnailMode: "none",
    thumbnailUrl: null,
    imageMode: "none",
    imageDataUrl: null,
    imageUrl: null,
    footer: "",
    footerIconUrl: null,
    timestamp: false,
    fields: []
  },
  image: {
    width: 1024,
    height: 512,
    quality: 0.9,
    background: { type: "color", color: "#0b1020", imageDataUrl: null },
    avatar: { x: 40, y: 40, size: 160, circular: true, strokeColor: null, strokeWidth: 0, enabled: true },
    username: {
      id: "username",
      text: "{user}",
      x: 240,
      y: 200,
      fontFamily: "IBM Plex Sans Arabic",
      fontSize: 48,
      color: "#ffffff",
      weight: "bold",
      align: "start"
    },
    customTexts: []
  }
};

test("the message preview applies the variables and says where it goes", () => {
  const { container, root } = render(
    <WelcomeMessagePreview
      settings={SETTINGS}
      values={{
        userMention: "@العضو",
        username: "عضو",
        server: "سيرفر الاختبار",
        memberCount: 12,
        inviterMention: "@الداعي",
        joinDate: "اليوم"
      }}
      avatarUrl={null}
      botName="AL AI"
      channelName="الترحيب"
    />
  );
  try {
    const text = container.textContent ?? "";
    assert.equal(text.includes("أهلاً @العضو في سيرفر الاختبار"), true, "the variables are applied");
    assert.equal(text.includes("إلى #الترحيب"), true, "the channel is named");
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

test("a message with no text says so instead of drawing an empty bubble", () => {
  const { container, root } = render(
    <WelcomeMessagePreview
      settings={{ ...SETTINGS, text: "" }}
      values={{
        userMention: "@العضو",
        username: "عضو",
        server: "سيرفر",
        memberCount: 12,
        inviterMention: "@الداعي",
        joinDate: "اليوم"
      }}
      avatarUrl={null}
      botName="AL AI"
      channelName={null}
    />
  );
  try {
    const text = container.textContent ?? "";
    assert.equal(text.includes("لا يوجد نص"), true);
    assert.equal(text.includes("لم تُختر القناة بعد"), true, "and the missing channel is named");
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

/**
 * The designer's canvas is the operator's preview of the exported image. If it
 * does not draw an effect, the operator is editing a card the bot will never
 * produce - so the canvas has to show the gradient, the glow and the outline.
 */
const CANVAS_CONFIG: WelcomeImageConfig = {
  width: 800,
  height: 400,
  quality: 0.9,
  background: { type: "gradient", color: null, gradientFrom: "#1d4ed8", gradientTo: "#7c3aed", opacity: 0.5, imageDataUrl: null },
  avatar: {
    x: 40,
    y: 40,
    size: 160,
    circular: true,
    strokeColor: null,
    strokeWidth: 0,
    enabled: true,
    glowColor: "#3b82f6",
    glowSize: 24
  },
  username: {
    id: "username",
    text: "{user}",
    x: 240,
    y: 200,
    fontFamily: "IBM Plex Sans Arabic",
    fontSize: 48,
    color: "#ffffff",
    weight: "bold",
    align: "start",
    strokeColor: "#000000",
    strokeWidth: 4,
    shadowColor: "#000000",
    shadowSize: 6,
    letterSpacing: 3
  },
  customTexts: []
};

test("the designer's canvas draws the effects it was given", () => {
  const { container, root } = render(
    <WelcomeImageCanvas
      config={CANVAS_CONFIG}
      values={{
        userMention: "@العضو",
        username: "عضو",
        server: "سيرفر",
        memberCount: 12,
        inviterMention: "@الداعي",
        joinDate: "اليوم"
      }}
      selected={null}
      onSelect={() => {}}
      onConfigChange={() => {}}
    />
  );
  try {
    const html = container.innerHTML;
    // The browser normalises a hex colour into rgb() in an inline style, so
    // the gradient is matched on its shape and its two stops.
    assert.equal(html.includes("linear-gradient(135deg"), true, "the gradient is drawn");
    assert.equal(html.includes("rgb(29, 78, 216)"), true, "with its first stop");
    assert.equal(html.includes("rgb(124, 58, 237)"), true, "and its second stop");
    assert.equal(html.includes("opacity: 0.5"), true, "the background's opacity is applied");
    assert.equal(html.includes("0 0 24px #3b82f6"), true, "the avatar's glow is drawn");
    assert.equal(html.includes('stroke="#000000"'), true, "the text's outline is drawn");
    assert.equal(html.includes('paint-order="stroke"'), true, "and under the fill, the way the renderer draws it");
    assert.equal(html.includes('letter-spacing="3"'), true, "the letter spacing is drawn");
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
