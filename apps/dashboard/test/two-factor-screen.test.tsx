// Imported first: see dom-env.ts. React must be evaluated after a DOM exists.
import { dom } from "./dom-env.js";
import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement, StrictMode } from "react";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { TwoFactorScreen } from "../src/components/two-factor-screen";

/**
 * The admin second-factor screen, mounted for real.
 *
 * `renderToString` would only ever see the loading state; these tests let the
 * enrolment request settle and then read the loaded screen. That is the only
 * way to catch the two failures this screen is built to avoid: a hook that
 * runs on one render and not the other (which blanks the page), and a
 * "success" that never came from `POST /api/2fa/verify`.
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

function stubFetch(enrollment: unknown, verify?: { status: number; body: unknown }) {
  const calls: FetchCall[] = [];
  (globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown, init?: RequestInit) => {
    const path = String(input).split("?")[0]!;
    calls.push({ path, init });
    if (path === "/api/2fa/enrollment") return answer(enrollment);
    if (path === "/api/2fa/verify") return answer(verify?.body ?? { ok: true }, verify?.status ?? 200);
    if (path === "/api/2fa/cancel") return answer({ ok: true });
    return answer({ error: "NOT_FOUND" }, 404);
  };
  return calls;
}

const future = () => new Date(Date.now() + 3 * 60 * 1000).toISOString();

const enrolledPayload = {
  enrolled: true,
  secret: null,
  otpauthUri: null,
  recoveryCodes: [],
  expiresAt: future()
};

const firstEnrollmentPayload = {
  enrolled: false,
  secret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
  otpauthUri: "otpauth://totp/AL%20AI%3Aoperator?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=AL%20AI&algorithm=SHA1&digits=6&period=30",
  recoveryCodes: ["ABCDE-FGHJK", "LMNOP-QRSTU", "VWXYZ-23456", "ABCDE-7FGHJ", "KLMNP-QRSTU", "VWXYZ-2BCDE", "FGHJK-LMNOP", "QRSTU-VWXYZ", "23456-ABCDE", "FGHJK-7LMNP"],
  expiresAt: future()
};

async function mountScreen(
  props: { enrolled: boolean; onVerified: () => void; onCancelled: () => void; onExpired?: () => void },
  interact?: (doc: Document) => Promise<void> | void
) {
  const { createRoot } = await import("react-dom/client");
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
        createElement(
          StrictMode,
          null,
          createElement(TooltipProvider, { delayDuration: 200, children: createElement(TwoFactorScreen, props) })
        )
      );
    });
    for (let i = 0; i < 6; i += 1) {
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 15));
      });
    }
    if (interact) {
      await act(async () => {
        await interact(dom.window.document);
      });
    }
    const html = container.innerHTML;
    root.unmount();
    return { html, errors };
  } finally {
    console.error = originalError;
    container.remove();
  }
}

function typeCode(doc: Document, value: string) {
  const input = doc.querySelector<HTMLInputElement>("#two-factor-code");
  assert.ok(input, "the code field is on screen");
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input!.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
}

function submitCode(doc: Document) {
  const form = doc.querySelector("form");
  assert.ok(form, "the verification form is on screen");
  form!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
}

const noop = () => undefined;

test("an enrolled admin sees the code prompt, and never a secret or recovery codes", async () => {
  const calls = stubFetch(enrolledPayload);
  const { html, errors } = await mountScreen({ enrolled: true, onVerified: noop, onCancelled: noop, onExpired: noop });

  assert.deepEqual(errors.filter(line => /Rendered more hooks|Uncaught/.test(line)), [], "no render failure");
  assert.match(html, /التحقق بخطوتين/);
  assert.match(html, /رمز التحقق من التطبيق/);
  // The deadline is worded as one ("sign-in expires in …") so it cannot be
  // read as the 30-second code ring sitting above the boxes.
  assert.match(html, /تنتهي صلاحية الدخول بعد/, "the pending login is counted down in both states");
  assert.doesNotMatch(html, /المفتاح السري/);
  assert.doesNotMatch(html, /رموز الاسترداد \(/);
  assert.ok(calls.some(call => call.path === "/api/2fa/enrollment"), "the deadline is read from the server even when enrolled");
});

test("a first sign-in shows the key, the otpauth link and ten codes exactly once", async () => {
  stubFetch(firstEnrollmentPayload);
  const { html, errors } = await mountScreen({ enrolled: false, onVerified: noop, onCancelled: noop, onExpired: noop });

  assert.deepEqual(errors.filter(line => /Rendered more hooks|Uncaught/.test(line)), [], "no hook-order failure");
  assert.match(html, /تظهر هذه الرموز مرة واحدة فقط/);
  assert.match(html, /GEZD GNBV GY3T QOJQ GEZD GNBV GY3T QOJQ/, "the base32 key is grouped for a human");
  assert.match(html, /otpauth:\/\/totp\//);
  assert.match(html, /رموز الاسترداد \(10\)/);
  assert.match(html, /تأكيد التسجيل والدخول/);
});

test("a wrong code is reported with the remaining attempts and invents no success", async () => {
  const calls = stubFetch(enrolledPayload, {
    status: 400,
    body: { error: "INVALID_CODE", message: "الرمز غير صحيح.", attemptsRemaining: 3 }
  });
  let verified = 0;
  const { html } = await mountScreen(
    { enrolled: true, onVerified: () => (verified += 1), onCancelled: noop, onExpired: noop },
    doc => {
      typeCode(doc, "000000");
      submitCode(doc);
    }
  );

  assert.equal(verified, 0, "onVerified must not run for a refused code");
  assert.match(html, /المحاولات المتبقّية: 3/);
  const verify = calls.find(call => call.path === "/api/2fa/verify");
  assert.deepEqual(JSON.parse(String(verify?.init?.body)), { code: "000000" });
});

test("a verified code calls onVerified only after the request really resolved", async () => {
  const calls = stubFetch(enrolledPayload);
  let verified = 0;
  let expired = 0;
  await mountScreen(
    { enrolled: true, onVerified: () => (verified += 1), onCancelled: noop, onExpired: () => (expired += 1) },
    doc => {
      typeCode(doc, "123456");
      submitCode(doc);
    }
  );

  assert.equal(verified, 1);
  assert.equal(expired, 0);
  assert.ok(calls.some(call => call.path === "/api/2fa/verify"));
});

test("an expired pending login says so and hands the operator back to sign-in", async () => {
  stubFetch(enrolledPayload, { status: 401, body: { error: "PENDING_EXPIRED", message: "انتهت مدة التسجيل." } });
  let expired = 0;
  let verified = 0;
  const { html } = await mountScreen(
    { enrolled: true, onVerified: () => (verified += 1), onCancelled: noop, onExpired: () => (expired += 1) },
    doc => {
      typeCode(doc, "123456");
      submitCode(doc);
    }
  );

  assert.equal(expired, 1, "the parent re-reads /api/session instead of trusting a stale flag");
  assert.equal(verified, 0);
  assert.match(html, /انتهت مدة تسجيل الدخول/);
});

test("cancelling destroys the pending login and returns to the sign-in screen", async () => {
  const calls = stubFetch(enrolledPayload);
  let cancelled = 0;
  await mountScreen(
    { enrolled: true, onVerified: noop, onCancelled: () => (cancelled += 1), onExpired: noop },
    doc => {
      const button = [...doc.querySelectorAll("button")].find(element => element.textContent?.trim() === "إلغاء");
      assert.ok(button, "the cancel button is offered");
      button!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    }
  );

  assert.equal(cancelled, 1);
  assert.ok(calls.some(call => call.path === "/api/2fa/cancel" && call.init?.method === "POST"));
});
