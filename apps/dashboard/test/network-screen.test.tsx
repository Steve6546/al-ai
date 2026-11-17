// Imported first: React and Radix must be evaluated after a DOM exists.
import { dom } from "./dom-env.js";
import test from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { I18nProvider } from "../src/lib/i18n";
import { NetworkView } from "../src/views/settings/network";

/**
 * The reach screen, mounted for real against a stubbed `/api`.
 *
 * The bug this pins was reported from the browser console of the hosted
 * deployment: every visit to this screen produced a red
 * `POST /api/network/firewall 409`. The server was right — that route opens a
 * Windows firewall rule and refuses to run when the deployment is hosted — but
 * the client asked before it knew where it was running, on a screen whose
 * hosted branch never renders the control.
 *
 * The assertion is therefore about *requests*, not rendering: hosted must not
 * call the endpoint at all, local must call it exactly once.
 */

type Call = { path: string; method: string };

function answer(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map<string, string>(),
    json: async () => body
  };
}

const base = {
  mode: "none",
  tunnelProvider: "ngrok",
  tunnelUrl: null,
  tunnelDomain: null,
  tunnelStable: false,
  tunnelStatus: "off",
  tunnelError: null,
  quotaExceeded: false,
  vpnAdapters: [],
  tunnelCallbackVerified: false
};

const hosted = {
  ...base,
  hosted: true,
  publicUrl: "https://example.apps.bot-hosting.cloud",
  lanEnabled: false,
  lanUrls: [],
  machineHosts: [],
  primaryLanHost: null,
  boundHost: "0.0.0.0",
  port: 25880
};

const local = {
  ...base,
  hosted: false,
  publicUrl: null,
  lanEnabled: true,
  lanUrls: [{ url: "http://192.168.1.20:25880", host: "192.168.1.20", label: "Wi-Fi" }],
  machineHosts: [{ host: "192.168.1.20", label: "Wi-Fi" }],
  primaryLanHost: "192.168.1.20",
  boundHost: "0.0.0.0",
  port: 25880
};

function stubApi(snapshot: Record<string, unknown>) {
  const calls: Call[] = [];
  (globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown, init?: RequestInit) => {
    const path = String(input).split("?")[0]!;
    calls.push({ path, method: (init?.method ?? "GET").toUpperCase() });
    if (path === "/api/network") return answer(snapshot);
    if (path === "/api/network/firewall") {
      // Exactly what the server answers on a hosted deployment.
      return snapshot.hosted
        ? answer({ error: "HOSTED_NETWORK" }, 409)
        : answer({ status: "allowed", needsAdmin: false, ruleName: "AL AI", port: 25880, profiles: [], detail: "allowed" });
    }
    return answer({ error: "NOT_FOUND" }, 404);
  };
  return calls;
}

// The screen has two independent promises (the snapshot, then the firewall
// read it gates) plus a lazily imported QR renderer, so one macrotask is not
// enough to reach a quiet tree.
const settle = async () => {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
    });
  }
};

async function mount(snapshot: Record<string, unknown>) {
  const calls = stubApi(snapshot);
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  try {
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <I18nProvider initialLanguage="ar">
          <TooltipProvider delayDuration={0}>
            <NetworkView />
          </TooltipProvider>
        </I18nProvider>
      );
    });
    await settle();
    const text = container.textContent ?? "";
    root.unmount();
    return { calls, text, errors };
  } finally {
    console.error = originalError;
    container.remove();
  }
}

test("a hosted deployment never asks an endpoint its own server refuses", async () => {
  const { calls, text, errors } = await mount(hosted);
  const firewall = calls.filter(call => call.path === "/api/network/firewall");
  assert.equal(firewall.length, 0, `firewall was requested ${firewall.length} time(s) on a hosted deployment`);
  assert.match(text, /example\.apps\.bot-hosting\.cloud/, "the public URL is the one useful thing on this screen");
  // React's act() hygiene is not the subject here: the subject is that a hosted
  // load produces no failed request. A 409 from the firewall route did print a
  // console error in the browser, so the check stays — minus the act warning
  // that fires from the lazily imported QR renderer's own state update.
  const real = errors.filter(message => !message.includes("not wrapped in act"));
  assert.deepEqual(real, [], "no console error from a request is allowed on a hosted load");
});

test("a local deployment reads the firewall verdict once the snapshot is known", async () => {
  const { calls, text } = await mount(local);
  const firewall = calls.filter(call => call.path === "/api/network/firewall");
  assert.equal(firewall.length, 1, `expected exactly one firewall read, saw ${firewall.length}`);
  assert.match(text, /192\.168\.1\.20/, "local links still render");
});
