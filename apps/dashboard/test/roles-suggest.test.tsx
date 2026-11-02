import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { dom } from "./dom-env.js";
import { RolesView } from "../src/views/settings/roles";
import type { Guild } from "@/types";

/**
 * The tier screen, mounted with the roles Discord really reports.
 *
 * The screen's old shape asked the operator to pick staff roles out of a list
 * that said nothing about them, and to do it twice. What it now has to do is
 * show what each role already grants, say how many commands a tier runs, and
 * propose the mapping the server's own permissions imply. Each of those is
 * asserted here — including that the proposal lands in the right card, because
 * an admin suggestion applied to the moderator list would be a worse bug than
 * the one it replaces.
 */

const GUILD = {
  id: "700000000000000011",
  name: "Tier Test",
  iconUrl: null,
  memberCount: 30,
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

const ROLES = [
  { id: "100000000000000001", name: "Admin", position: 8, managed: false, isDefault: false, color: 0xe74c3c, powers: [{ key: "BAN_MEMBERS", label: "حظر الأعضاء", tier: "admin" as const }, { key: "MANAGE_ROLES", label: "إدارة الرتب", tier: "admin" as const }] },
  { id: "100000000000000002", name: "Mod", position: 6, managed: false, isDefault: false, color: 0x3498db, powers: [{ key: "MODERATE_MEMBERS", label: "إسكات الأعضاء", tier: "moderator" as const }] },
  { id: "100000000000000003", name: "[Member]", position: 1, managed: false, isDefault: false, color: 0x2ecc71, powers: [] }
];

const realFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input);
    if (url.includes("/tiers")) {
      return Response.json({
        roles: ROLES,
        configured: { adminRoleIds: [], moderatorRoleIds: [] },
        botHighestRolePosition: 5,
        unassignable: ["100000000000000001"],
        warning: null
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
    root.render(createElement(RolesView, { guild: GUILD }));
  });
  await act(async () => {
    await Promise.resolve();
  });
  return { container, root };
}

function buttonByText(container: HTMLElement, text: string) {
  return [...container.querySelectorAll("button")].find(entry => (entry.textContent ?? "").includes(text));
}

test("each role row says what Discord already grants it", async () => {
  const { container, root } = await mountScreen();
  try {
    const text = container.textContent ?? "";
    assert.ok(text.includes("حظر الأعضاء"), "an admin-tier permission is named on its row");
    assert.ok(text.includes("إسكات الأعضاء"), "as is a moderator-tier one");
    assert.ok(text.includes("لا صلاحيات إشراف في ديسكورد"), "and a role that grants nothing says that, rather than leaving the row blank");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("the cards state how many commands their tier runs", async () => {
  const { container, root } = await mountScreen();
  try {
    const badges = [...container.querySelectorAll("[data-tier-count], .tabular")].map(node => (node.textContent ?? "").trim());
    assert.ok(badges.some(entry => /أمرًا/.test(entry)), `a command count is shown beside each tier, got ${JSON.stringify(badges)}`);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("the proposal puts each role in the card its permissions belong to", async () => {
  const { container, root } = await mountScreen();
  try {
    const suggest = buttonByText(container, "اقترح");
    assert.ok(suggest, "the screen offers a proposal instead of a blank list");
    await act(async () => {
      suggest.click();
    });

    const chips = [...container.querySelectorAll("button[aria-label^='إزالة']")].map(node => node.getAttribute("aria-label"));
    // `Admin` is unassignable here (it sits above the bot's own role), so the
    // only role the server can be asked to grant is `Mod` — and it belongs to
    // the moderator card, not the admin one.
    assert.deepEqual(chips, ["إزالة Mod من مشرف"], `the proposal lands in the right tier, got ${JSON.stringify(chips)}`);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
