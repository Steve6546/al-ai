import { dom } from "./dom-env.js";
import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { useCopy } from "../src/lib/use-copy";

/**
 * The clipboard has two paths, and the second one is the one that matters on a
 * plain-HTTP LAN origin: `navigator.clipboard` is `undefined` there, not a
 * rejected promise. The old code tried only the async path, so every copy
 * button did nothing at all — no copy, no confirmation, no error.
 */
function Harness({ report }: { report: (ok: boolean) => void }) {
  const { copied, copy } = useCopy(1_000);
  return createElement(
    "button",
    {
      id: "copy",
      onClick: async () => report(await copy("hello", "k"))
    },
    copied ?? "idle"
  );
}

test("copy falls back to execCommand when the async clipboard is unavailable", async () => {
  const originalClipboard = navigator.clipboard;
  Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });

  let execCalls = 0;
  const originalExec = (document as unknown as { execCommand?: unknown }).execCommand;
  // jsdom does not implement execCommand; the fallback only needs it to exist.
  Object.defineProperty(document, "execCommand", {
    value: () => {
      execCalls += 1;
      return true;
    },
    configurable: true,
    writable: true
  });

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  let result: boolean | null = null;

  try {
    await act(async () => {
      root.render(
        createElement(Harness, {
          report: (ok: boolean) => {
            result = ok;
          }
        })
      );
    });

    const button = container.querySelector<HTMLButtonElement>("#copy");
    assert.ok(button, "the copy button renders");

    await act(async () => {
      button!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 20));
    });

    assert.equal(result, true, "copy reports success through the fallback");
    assert.equal(execCalls, 1, "the legacy path ran once");
    assert.match(container.textContent ?? "", /k/, "the confirmation key is reflected");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    Object.defineProperty(navigator, "clipboard", { value: originalClipboard, configurable: true });
    Object.defineProperty(document, "execCommand", { value: originalExec, configurable: true, writable: true });
  }
});
