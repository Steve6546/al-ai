import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import "./dom-env.js";
import { InvitesView } from "../src/views/settings/invites";
import type { Guild, InviteSettings } from "@/types";

/**
 * The invites screen's on/off contract, mounted for real: the switch decides
 * whether the policy, milestones and templates cards exist at all. Off hides —
 * nothing dimmed, nothing "disabled-looking but saving" — and the stored values
 * survive the round trip, which is the same contract the welcome screen keeps.
 */

const GUILD: Guild = {
  id: "700000000000000002",
  name: "Invites Test",
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

const SETTINGS: InviteSettings = {
  enabled: false,
  fakeAccountDays: 3,
  keepRolesOnLeave: false,
  logSelfInvites: true,
  logJoins: true,
  logLeaves: true,
  logMilestones: true,
  joinMessage: "قالب الدخول",
  leaveMessage: "قالب الخروج",
  milestoneMessage: "قالب الإنجاز",
  milestoneRoles: []
};

let stored: InviteSettings = JSON.parse(JSON.stringify(SETTINGS));

beforeEach(() => {
  stored = JSON.parse(JSON.stringify(SETTINGS));
  (globalThis as { fetch?: unknown }).fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith("/invites/settings")) {
      if (init?.method === "PUT") {
        stored = JSON.parse(String(init.body));
        return Promise.resolve(
          new Response(JSON.stringify({ settings: stored, savedAt: new Date().toISOString() }), {
            status: 200,
            headers: { "content-type": "application/json" }
          })
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ settings: stored, roles: [], problems: [] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
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
    root.render(createElement(InvitesView, { guild: GUILD }));
  });
  await act(async () => {
    await Promise.resolve();
  });
  return { container, root };
}

async function toggle(container: HTMLElement) {
  // This screen uses the shadcn/Radix Switch, which renders a
  // `<button role="switch">` — unlike HeroUI's checkbox-bearing Switch.Content.
  const control = container.querySelector<HTMLInputElement>("input[type='checkbox'], [role='switch']");
  assert.ok(control, "the module switch renders a pressable control");
  await act(async () => {
    control.click();
    await Promise.resolve();
  });
}

test("a disabled module shows the hero and nothing else — no dimmed look-alike form", async () => {
  const { container, root } = await mountScreen();
  try {
    assert.equal(container.textContent.includes("موديول الإحالات"), true, "the hero card is present");
    assert.equal(container.textContent.includes("تُمنح تلقائياً"), false, "milestones card hidden");
    assert.equal(container.textContent.includes("قوالب السجلات"), false, "templates card hidden");
    assert.equal(container.textContent.includes("عتبة الحساب الوهمي"), false, "policy details hidden");
    assert.equal(container.textContent.includes("معطّل"), true, "the alert names the state");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("arming the module reveals every section, and the stored template survives the round trip", async () => {
  const { container, root } = await mountScreen();
  try {
    await toggle(container);
    assert.equal(container.textContent.includes("تُمنح تلقائياً"), true, "milestones card appears");
    assert.equal(container.textContent.includes("قوالب السجلات"), true, "templates card appears");
    assert.equal(container.textContent.includes("عتبة الحساب الوهمي"), true, "policy details appear");
    // The textarea holds the value fetched from storage — hiding never wiped it.
    const textarea = container.querySelector("textarea");
    assert.ok(textarea, "the template textarea renders");
    assert.equal((textarea as HTMLTextAreaElement).value, "قالب الدخول");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("arming then disarming persists through the save bar, and the off state wipes nothing", async () => {
  const { container, root } = await mountScreen();
  try {
    // Arm → save. The draft differs from storage, so the bar is up.
    await toggle(container);
    const saveButton = [...container.querySelectorAll("button")].find(button => button.textContent?.includes("حفظ التعديلات"));
    assert.ok(saveButton, "the save bar appears for the pending toggle");
    await act(async () => {
      saveButton.click();
      await Promise.resolve();
    });
    assert.equal(stored.enabled, true, "the first PUT carried the armed state");

    // Now disarm through the bar: after the commit, one toggle off is a real
    // pending change again, and the save must land exactly that OFF state.
    await toggle(container);
    assert.equal(container.textContent.includes("قوالب السجلات"), false, "sections hidden again");
    const bar = [...container.querySelectorAll("button")].find(button => button.textContent?.includes("حفظ التعديلات"));
    assert.ok(bar, "the bar is up for the disarming change");
    await act(async () => {
      bar!.click();
      await Promise.resolve();
    });
    assert.equal(stored.enabled, false, "the final PUT carried the disarmed state");
    assert.equal(stored.joinMessage, "قالب الدخول", "the stored template was not wiped by the off state");
    assert.equal(container.textContent.includes("قوالب السجلات"), false, "sections hidden again after save");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
