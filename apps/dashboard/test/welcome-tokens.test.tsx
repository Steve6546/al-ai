import { dom } from "./dom-env.js";
import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement, useRef } from "react";
import { createRoot } from "react-dom/client";
import { TokenStrip, insertAtCursor } from "../src/views/settings/welcome-messages-parts";

/**
 * The token strip and the caret.
 *
 * `TokenStrip` used to take an `activeRef` and attach it to a hidden `<span>`
 * rendered *after* the textarea it was meant to target. React commits refs in
 * tree order, so the span won: `textRef.current` was a span, `selectionStart`
 * read as `undefined`, and every token — and every emoji, which shares the ref —
 * was appended to the end of the text instead of landing at the caret, with a
 * `setSelectionRange is not a function` thrown afterwards.
 *
 * Nothing covered it because the screen's tests drive the draft state, not the
 * DOM caret, so the strip looked wired while inserting in the wrong place.
 */

test("a token is inserted at the caret, not at the end", () => {
  const field = dom.window.document.createElement("textarea");
  dom.window.document.body.appendChild(field);
  field.value = "hello world";
  field.setSelectionRange(6, 6);

  assert.equal(insertAtCursor(field, "hello world", "{user}"), "hello {user}world");
});

test("mounting the strip leaves the field's ref pointing at the field", () => {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);

  const holder: { ref: { current: HTMLElement | null } | null } = { ref: null };
  function Probe() {
    const local = useRef<HTMLTextAreaElement>(null);
    holder.ref = local as unknown as { current: HTMLElement | null };
    return createElement(
      "div",
      null,
      createElement("textarea", { ref: local }),
      createElement(TokenStrip, { onInsert: () => {} })
    );
  }

  act(() => {
    createRoot(host).render(createElement(Probe));
  });

  assert.equal(holder.ref?.current?.tagName, "TEXTAREA", "the strip must not claim the caller's ref");
});

test("every token chip is a button that reports what was clicked", () => {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);

  const picked: string[] = [];
  act(() => {
    createRoot(host).render(createElement(TokenStrip, { onInsert: token => picked.push(token) }));
  });

  const chips = [...host.querySelectorAll("button")];
  assert.ok(chips.length > 0, "the strip renders at least one chip");
  for (const chip of chips) {
    assert.equal(chip.getAttribute("type"), "button", "a chip must not submit the surrounding form");
    act(() => {
      chip.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
  }
  assert.equal(picked.length, chips.length, "every chip reports its token");
  assert.ok(
    picked.every(token => token.startsWith("{") && token.endsWith("}")),
    "chips insert template tokens, not prose"
  );
});
