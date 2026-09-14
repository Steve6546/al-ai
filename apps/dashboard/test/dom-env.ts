/**
 * A DOM for the client-side tests, installed before React is imported.
 *
 * **Import order is load-bearing.** ES modules are evaluated in import order,
 * so a file that does `import "./dom-env.js"` first gets a `document` before
 * `react-dom` is evaluated. Doing the setup inline at the top of a test file
 * does *not* work: that file's own imports — including `App` and therefore
 * React — are evaluated first, so React comes up in a realm with no DOM.
 *
 * The failure is quiet and specific: rendering still works, but Radix's portal
 * content never appears. The trigger reports `data-state="open"` while
 * `document.querySelector('[role="menu"]')` finds nothing, which reads as "the
 * menu is broken" rather than "the harness was set up in the wrong order".
 */

import { JSDOM } from "jsdom";

export const dom = new JSDOM('<!doctype html><html dir="rtl" class="dark"><body></body></html>', {
  url: "http://127.0.0.1:3000/",
  pretendToBeVisual: true
});

// Copy every window member the Node realm lacks. Enumerating them by hand
// always misses one, and the failure reads as "HTMLFormElement is not defined"
// rather than as a missing global.
for (const key of Object.getOwnPropertyNames(dom.window)) {
  if (key in globalThis) continue;
  try {
    Object.defineProperty(globalThis, key, {
      get: () => (dom.window as unknown as Record<string, unknown>)[key],
      configurable: true
    });
  } catch {
    /* read-only host globals are fine to skip */
  }
}

for (const [key, value] of [
  ["window", dom.window],
  ["document", dom.window.document],
  ["navigator", dom.window.navigator]
] as const) {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}

/**
 * The DOM constructors have to come from jsdom, not from Node.
 *
 * Node 22 already defines `Event`, `CustomEvent`, `MessageEvent` and friends on
 * `globalThis`, so the copy loop above skips them — and a Node `CustomEvent` is
 * not a jsdom `Event`. Anything that constructs one and hands it to jsdom's
 * `dispatchEvent` fails with "parameter 1 is not of type 'Event'", which is how
 * Radix's dismissable layer broke the moment a dropdown was opened.
 */
for (const name of [
  "Event", "CustomEvent", "UIEvent", "MouseEvent", "PointerEvent", "KeyboardEvent",
  "FocusEvent", "InputEvent", "TouchEvent", "WheelEvent", "DragEvent", "AnimationEvent",
  "TransitionEvent", "CompositionEvent", "Node", "Element", "HTMLElement", "HTMLInputElement",
  "DocumentFragment", "DOMParser", "XMLHttpRequest", "FileReader", "Blob", "File", "FormData"
] as const) {
  const ctor = (dom.window as unknown as Record<string, unknown>)[name];
  if (ctor !== undefined) Object.defineProperty(globalThis, name, { value: ctor, configurable: true, writable: true });
}

Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { value: true, configurable: true, writable: true });
