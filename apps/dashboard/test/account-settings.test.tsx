// Imported first: React and Radix must be evaluated after a DOM exists.
import { dom } from "./dom-env.js";
import test from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { I18nProvider } from "../src/lib/i18n";
import { SettingsView } from "../src/views/account-settings";

/**
 * The account settings centre, mounted for real.
 *
 * The screen is the one place that changes account-wide security, so these
 * tests use the actual fetch layer: they prove the language write reaches
 * `PUT /api/me/preferences`, that a current code is sent before a new
 * authenticator is issued, and that the one-time setup material comes back
 * from the server rather than being invented in the browser.
 */

type FetchCall = { path: string; init?: RequestInit };

function answer(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map<string, string>(),
    json: async () => body
  };
}

const now = Date.now();
const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();

const overview = {
  twoFactor: {
    enrolled: true,
    confirmedAt: iso(-86_400_000),
    recoveryCodesRemaining: 8
  },
  sessions: [
    {
      current: true,
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0 Safari/537.36",
      createdAt: iso(-3_600_000),
      lastSeenAt: iso(-60_000),
      expiresAt: iso(86_400_000)
    },
    {
      current: false,
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1",
      createdAt: iso(-7_200_000),
      lastSeenAt: iso(-3_600_000),
      expiresAt: iso(86_400_000)
    }
  ],
  platformOwner: false
};

const setup = {
  secret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
  otpauthUri:
    "otpauth://totp/AL%20AI%3Aowner?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=AL%20AI&algorithm=SHA1&digits=6&period=30",
  recoveryCodes: [
    "ABCDE-FGHJK",
    "LMNOP-QRSTU",
    "VWXYZ-23456",
    "ABCDE-7FGHJ",
    "KLMNP-QRSTU",
    "VWXYZ-2BCDE",
    "FGHJK-LMNOP",
    "QRSTU-VWXYZ",
    "23456-ABCDE",
    "FGHJK-7LMNP"
  ],
  expiresAt: iso(10 * 60_000),
  replacing: true
};

function stubFetch() {
  const calls: FetchCall[] = [];
  (globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown, init?: RequestInit) => {
    const path = String(input).split("?")[0]!;
    calls.push({ path, init });
    if (path === "/api/me/security") return answer(overview);
    if (path === "/api/me/preferences" && init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as { language: string };
      return answer({ language: body.language });
    }
    if (path === "/api/me/2fa/setup") return answer(setup);
    return answer({ error: "NOT_FOUND", message: "not found" }, 404);
  };
  return calls;
}

const USER = {
  id: "123456789012345678",
  username: "owner",
  handle: "owner",
  avatarUrl: null,
  expiresAt: iso(86_400_000),
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

async function settle() {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 15));
    });
  }
}

async function mount(interact?: (doc: Document) => Promise<void> | void) {
  stubFetch();
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
            <SettingsView user={USER} guild={GUILD} />
          </TooltipProvider>
        </I18nProvider>
      );
    });
    await settle();
    if (interact) {
      await act(async () => {
        await interact(dom.window.document);
      });
      await settle();
    }
    const html = container.innerHTML;
    const text = dom.window.document.body.textContent ?? "";
    root.unmount();
    return { html, text, errors };
  } finally {
    console.error = originalError;
    container.remove();
  }
}

function buttonByText(doc: Document, text: string): HTMLElement {
  const button = [...doc.querySelectorAll("button")].find(element => element.textContent?.trim().includes(text));
  assert.ok(button, `a button containing “${text}” is on screen`);
  return button as HTMLElement;
}

test("the security section shows the real protection state and live sessions", async () => {
  let securityText = "";
  const { text, html, errors } = await mount(async doc => {
    buttonByText(doc, "الأمان").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    await settle();
    securityText = doc.body.textContent ?? "";
    buttonByText(doc, "الجلسات").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    await settle();
  });

  assert.deepEqual(errors.filter(line => /Rendered more hooks|Uncaught/.test(line)), [], "no render failure");
  assert.match(securityText, /التحقق بخطوتين مفعّل/, "the enrolled state is shown");
  assert.match(securityText, /بقي 8 من رموز الاسترداد/, "the remaining recovery-code count is real");
  assert.match(html, /Chrome · Windows/, "the session device is described, not dumped as a user-agent");
  assert.match(text, /2 جلسة نشطة/, "both live sessions are counted");
});

test("switching language writes the account preference and flips the direction", async () => {
  const calls = stubFetch();
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <I18nProvider initialLanguage="ar">
          <TooltipProvider delayDuration={0}>
            <SettingsView user={USER} guild={GUILD} />
          </TooltipProvider>
        </I18nProvider>
      );
    });
    await settle();

    await act(async () => {
      buttonByText(dom.window.document, "اللغة").dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true })
      );
    });
    await settle();

    await act(async () => {
      buttonByText(dom.window.document, "English").dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true })
      );
    });
    await settle();

    const write = calls.find(call => call.path === "/api/me/preferences" && call.init?.method === "PUT");
    assert.ok(write, "the language is written to the account");
    assert.deepEqual(JSON.parse(String(write?.init?.body)), { language: "en" });
    assert.equal(dom.window.document.documentElement.dir, "ltr", "the document direction follows the language");
    assert.match(dom.window.document.body.textContent ?? "", /Language and direction/, "the screen is in English");
  } finally {
    act(() => {
      root.unmount();
    });
    container.remove();
  }
});

test("changing the authenticator asks for a current code before issuing a new secret", async () => {
  const calls = stubFetch();
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <I18nProvider initialLanguage="ar">
          <TooltipProvider delayDuration={0}>
            <SettingsView user={USER} guild={GUILD} />
          </TooltipProvider>
        </I18nProvider>
      );
    });
    await settle();

    await act(async () => {
      buttonByText(dom.window.document, "الأمان").dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true })
      );
    });
    await settle();

    await act(async () => {
      buttonByText(dom.window.document, "تغيير تطبيق المصادقة").dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true })
      );
    });
    await settle();

    const input = dom.window.document.querySelector<HTMLInputElement>("#settings-reverify-code");
    assert.ok(input, "the re-verification field is offered");
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, "123456");
    input!.dispatchEvent(new dom.window.Event("input", { bubbles: true }));

    await act(async () => {
      dom.window.document
        .querySelector("#settings-reverify-code")!
        .closest("form")!
        .dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    });
    await settle();

    const setupCall = calls.find(call => call.path === "/api/me/2fa/setup");
    assert.ok(setupCall, "the setup request is sent only after the current code");
    assert.deepEqual(JSON.parse(String(setupCall?.init?.body)), { code: "123456" });
    const text = dom.window.document.body.textContent ?? "";
    assert.match(text, /GEZD GNBV GY3T QOJQ GEZD GNBV GY3T QOJQ/, "the new key is shown for manual entry");
    assert.match(text, /otpauth:\/\/totp\//, "the manual URI is shown");
    assert.match(text, /رموز الاسترداد \(10\)/, "the new single-use codes are shown");
  } finally {
    act(() => {
      root.unmount();
    });
    container.remove();
  }
});
