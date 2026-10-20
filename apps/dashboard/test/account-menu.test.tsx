import "./dom-env.js";
import test from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { dom } from "./dom-env.js";
import { AccountMenu } from "@/components/account-menu";

/**
 * The account menu, opened and used.
 *
 * The menu is the operator's way out of the dashboard and their way into
 * their own account, so both are checked here: the identity block shows the
 * real names and the id, and the sign-out action calls the handler it was
 * given - the real session is destroyed by the server, and the menu's job is
 * to ask for that and nothing else.
 */
const USER = {
  id: "123456789012345678",
  username: "owner",
  handle: "owner",
  avatarUrl: null,
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  isPlatformOwner: true
};

const GUILD = {
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
} as never;

function openMenu(onLogout: () => void) {
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<AccountMenu user={USER} guild={GUILD} onLogout={onLogout} />);
  });
  const trigger = container.querySelector("button[data-account-trigger]") as HTMLElement | null;
  assert.ok(trigger, "the account row is a button");
  act(() => {
    trigger.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
  });
  return { container, root };
}

test("the menu shows the identity and the actions that exist", () => {
  let signedOut = false;
  const { container, root } = openMenu(() => {
    signedOut = true;
  });
  try {
    const text = dom.window.document.body.textContent ?? "";
    assert.ok(text.includes("owner"), "the display name is shown");
    assert.ok(text.includes("@owner"), "the handle is shown");
    assert.ok(text.includes("123456789012345678"), "the Discord id is shown");
    assert.ok(text.includes("فتح الحساب في Discord"), "the Discord link is offered");
    assert.ok(text.includes("تسجيل الخروج"), "signing out is offered");
    // The copy control is an icon, so it is named rather than written.
    assert.ok(
      dom.window.document.querySelector("button[aria-label='نسخ معرّف Discord']"),
      "the id can be copied"
    );
    assert.equal(signedOut, false, "opening the menu does not sign anybody out");
  } finally {
    act(() => {
      root.unmount();
    });
    container.remove();
  }
});

test("signing out calls the handler it was given", () => {
  let signedOut = false;
  const { container, root } = openMenu(() => {
    signedOut = true;
  });
  try {
    const item = [...dom.window.document.querySelectorAll("[role='menuitem']")].find(entry =>
      entry.textContent?.includes("تسجيل الخروج")
    );
    assert.ok(item, "the sign-out item is in the menu");
    act(() => {
      (item as HTMLElement).click();
    });
    assert.equal(signedOut, true, "the sign-out action was invoked");
  } finally {
    act(() => {
      root.unmount();
    });
    container.remove();
  }
});
