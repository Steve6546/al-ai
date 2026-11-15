// Imported first on purpose: see the note in `dom-env.ts`.
import { dom } from "./dom-env.js";
import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { Toaster } from "../src/components/toaster";

/**
 * The toast stack must not live inside the screen that pushed it.
 *
 * A toast used to render at `z-50` inside a `framer-motion` wrapper. That
 * wrapper's `transform` made it the containing block for the toast's `fixed`
 * position, so the header (`z-30`) painted over it and `<main>`'s scroll box
 * clipped it. The fix has two halves: a portal to `document.body`, and the
 * `--z-toast` token above HeroUI's overlay. This test proves the first half
 * actually runs after mount — `renderToString` cannot, because effects do not
 * run there and portals are unsupported.
 */
test("the toast stack is portalled to document.body, above every overlay", async () => {
  const { createRoot } = await import("react-dom/client");
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(
      createElement(Toaster, {
        toasts: [{ id: "1", tone: "error", title: "فشل الحفظ", description: "الصورة الرمزية مرفوضة." }],
        onDismiss: () => {}
      })
    );
  });

  // The effect has run, so the stack moved out of the screen's subtree.
  assert.equal(container.textContent, "", "the toast must not stay in the screen's stacking context");
  const stack = dom.window.document.body.querySelector(".fixed.top-4");
  assert.ok(stack, "the stack exists at the body level");
  assert.match(String(stack.className), /z-\[var\(--z-toast\)\]/, "the stack sits above the overlay token");
  assert.match(String(stack.className), /pointer-events-none/, "the wrapper lets clicks through");
  const alert = stack.querySelector("[role='alert']");
  assert.ok(alert, "a failure interrupts");
  assert.match(String(alert.className), /pointer-events-auto/, "the card itself is interactive");

  await act(async () => root.unmount());
  container.remove();
});
