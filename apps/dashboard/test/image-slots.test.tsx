import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { dom } from "./dom-env.js";
import { CustomizationView } from "../src/views/settings/customization";
import type { Guild } from "@/types";

/**
 * The image slots draw what members actually see.
 *
 * A server profile is a layer of overrides over the account's own profile, so an
 * empty slot is not "no picture" — it is the account's picture showing through.
 * The banner slot said «لا يوجد غلاف» over a bot with a banner every member can
 * see, which is the same fake-empty-state bug twice in one screen: the preview
 * was fixed and the field was not. These assert both halves, and that the
 * fallback is *labelled*, so it can never be mistaken for a saved override.
 */

const GUILD = {
  id: "700000000000000021",
  name: "Slot Test",
  iconUrl: null,
  memberCount: 12,
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

const ACCOUNT_BANNER = "https://cdn.discordapp.com/banners/1544750141112582187/6c21bded.png?size=600";
const ACCOUNT_AVATAR = "https://cdn.discordapp.com/avatars/1544750141112582187/a_24ea05.gif?size=128";

const realFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input);
    if (url.includes("/customization")) {
      return Response.json({
        settings: {
          enabled: true,
          nickname: "",
          roleColor: null,
          roleIconUrl: null,
          // `""` is what the column really holds for "no custom image" — an
          // empty string, not null, and a `??` chain stops on it.
          avatarDataUrl: "",
          bannerDataUrl: "",
          bio: ""
        },
        permissions: [{ key: "change_nickname", label: "تغيير الاسم المستعار", granted: true }],
        hierarchy: { botPosition: 5, highestManagedPosition: 3, blocked: false, message: null },
        roleIcon: { locked: false, unknown: false, reason: null },
        profile: {
          username: "ddas",
          nickname: null,
          avatarUrl: null,
          bannerUrl: null,
          accountAvatarUrl: ACCOUNT_AVATAR,
          accountBannerUrl: ACCOUNT_BANNER
        }
      });
    }
    return Response.json({}, { status: 404 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

async function mountScreen() {
  const container = document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(CustomizationView, { guild: GUILD }));
  });
  await act(async () => {
    await Promise.resolve();
  });
  return { container, root };
}

test("the preview card draws the account's banner where the server has none", async () => {
  const { container, root } = await mountScreen();
  try {
    const banner = [...container.querySelectorAll<HTMLElement>("[style]")].find(element =>
      element.style.backgroundImage.includes(ACCOUNT_BANNER)
    );
    assert.ok(banner, "the account's banner is drawn on the card where the server has none");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("the preview card draws the account's picture, and an animated account arrives as a gif", async () => {
  const { container, root } = await mountScreen();
  try {
    const image = [...container.querySelectorAll("img")].find(element => element.getAttribute("src") === ACCOUNT_AVATAR);
    assert.ok(image, "the account's picture shows through where the server has none");
    assert.match(ACCOUNT_AVATAR, /\.gif\?/, "an animated account is served as the gif, so it animates");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
