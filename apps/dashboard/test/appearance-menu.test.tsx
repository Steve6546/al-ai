import "./dom-env.js";
import test from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { dom } from "./dom-env.js";
import { AppearanceMenu } from "@/components/appearance-menu";

/**
 * The appearance panel, opened and used.
 *
 * The theme engine has its own unit tests; this one is about the *panel*: it
 * has to open, it has to offer the three modes and the five accents, and
 * picking a mode has to change the document and be remembered - the whole
 * point of the control.
 */
function renderPanel() {
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<AppearanceMenu />);
  });
  return { container, root };
}

test("the panel opens and offers the modes and the accents", async () => {
  const { container, root } = renderPanel();
  try {
    const trigger = container.querySelector("button[aria-label='المظهر']") as HTMLElement | null;
    assert.ok(trigger, "the panel has a trigger");

    await act(async () => {
      // A popover toggles on a click; a menu opens on a pointerdown. The
      // panel is a popover, so it is a click.
      (trigger as HTMLElement).click();
      await new Promise(resolve => setTimeout(resolve, 30));
    });

    const panel = dom.window.document.body.textContent ?? "";
    for (const mode of ["فاتح", "داكن", "النظام"]) {
      assert.ok(panel.includes(mode), `the panel offers the ${mode} mode`);
    }
    // The accents are swatches, so they are named rather than written - the
    // name is what a screen reader announces, so it is what the test reads.
    for (const accent of ["أزرق", "بنفسجي", "زمردي", "كهرماني", "وردي"]) {
      const swatch = dom.window.document.querySelector(`button[aria-label='${accent}']`);
      assert.ok(swatch, `the panel offers the ${accent} accent`);
    }
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  }
});

test("picking the light mode changes the document and is remembered", async () => {
  const { container, root } = renderPanel();
  try {
    const trigger = container.querySelector("button[aria-label='المظهر']") as HTMLElement | null;
    assert.ok(trigger);

    await act(async () => {
      (trigger as HTMLElement).click();
      await new Promise(resolve => setTimeout(resolve, 30));
    });

    const light = [...dom.window.document.querySelectorAll("button")].find(
      button => button.textContent?.trim() === "فاتح"
    );
    assert.ok(light, "the light mode is offered");

    await act(async () => {
      (light as HTMLElement).click();
      await new Promise(resolve => setTimeout(resolve, 20));
    });

    assert.equal(dom.window.document.documentElement.dataset.theme, "light");
    assert.equal(dom.window.document.documentElement.classList.contains("light"), true);
    const stored = dom.window.localStorage.getItem("al-ai.appearance");
    assert.ok(stored && stored.includes("light"), `the choice is remembered, stored: ${stored}`);
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  }
});
