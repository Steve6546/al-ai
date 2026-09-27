import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import "./dom-env.js";
import { useDraftForm } from "../src/lib/use-draft-form";

/**
 * The one rule every settings screen depends on: the "حفظ التغييرات" bar is
 * shown for exactly as long as the draft differs from the saved value, and no
 * longer.
 *
 * These tests are the contract the five screens inherit — revert-by-hand has to
 * clear the bar at once, a save has to clear it, and a guild switch has to
 * discard a draft that no longer belongs to anything.
 */

type Settings = { enabled: boolean; name: string };

const base: Settings = { enabled: false, name: "original" };

/**
 * Mounts a probe that records every reading the hook produces.
 *
 * `renderToString` is no use here: the hook's rebase happens *during* a render,
 * which the server renderer does not retry the way the client one does.
 */
async function mount<T>(initial: T, equals?: (a: T, b: T) => boolean) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const readings: ReturnType<typeof useDraftForm<T>>[] = [];

  const Probe = (props: { source: T }) => {
    readings.push(equals ? useDraftForm(props.source, equals) : useDraftForm(props.source));
    return null;
  };

  const render = async (source: T) => {
    await act(async () => {
      root.render(createElement(Probe, { source }));
    });
  };
  const settle = async () => {
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
  };

  await render(initial);
  return {
    readings,
    render,
    settle,
    form: () => readings[readings.length - 1]!,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    }
  };
}

/** Applies an edit the way an event handler would, and lets React settle. */
async function edit<T>(harness: Awaited<ReturnType<typeof mount<T>>>, apply: (form: ReturnType<typeof useDraftForm<T>>) => void) {
  const form = harness.form();
  await act(async () => {
    apply(form);
  });
  await harness.settle();
}

test("a fresh load is clean — the bar never appears over an untouched form", async () => {
  const harness = await mount<Settings>(base);
  await harness.settle();
  assert.equal(harness.form().dirty, false, "the draft matches the saved value");
  assert.deepEqual(harness.form().draft, base);
  harness.unmount();
});

test("an edit makes the form dirty and reverting it clears the bar at once", async () => {
  const harness = await mount<Settings>(base);
  await harness.settle();

  // The operator flips a switch.
  await edit(harness, form => form.patch({ enabled: true }));
  assert.equal(harness.form().dirty, true, "editing the draft marks the form dirty");
  assert.deepEqual(harness.form().draft, { enabled: true, name: "original" });

  // ...and flips it back. The bar must disappear immediately, because the draft
  // is once again identical to what the server holds.
  await edit(harness, form => form.patch({ enabled: false }));
  assert.equal(harness.form().dirty, false, "returning the field to its original value clears the bar");
  assert.deepEqual(harness.form().draft, base);
  harness.unmount();
});

test("reset restores the whole draft, which is what the bar's «إعادة ضبط» does", async () => {
  const harness = await mount<Settings>(base);
  await harness.settle();

  await edit(harness, form => form.patch({ enabled: true, name: "edited" }));
  assert.equal(harness.form().dirty, true);

  await edit(harness, form => form.reset());
  assert.equal(harness.form().dirty, false, "reset clears the bar");
  assert.deepEqual(harness.form().draft, base, "reset restores every field, not just the last one");
  harness.unmount();
});

test("commit rebases on what the server returned and clears the bar", async () => {
  const harness = await mount<Settings>(base);
  await harness.settle();

  await edit(harness, form => form.patch({ enabled: true }));
  assert.equal(harness.form().dirty, true);

  const saved: Settings = { enabled: true, name: "server-normalised" };
  await edit(harness, form => form.commit(saved));
  assert.equal(harness.form().dirty, false, "a successful save clears the bar");
  assert.deepEqual(harness.form().saved, saved, "the saved value is what the server returned");
  assert.deepEqual(harness.form().draft, saved, "and the draft is rebased onto it — not the local copy");
  harness.unmount();
});

test("a new source discards the draft, so one guild's edits cannot leak into another", async () => {
  const harness = await mount<Settings>(base);
  await harness.settle();

  await edit(harness, form => form.patch({ enabled: true }));
  assert.equal(harness.form().dirty, true);

  const other: Settings = { enabled: false, name: "other-guild" };
  await harness.render(other);
  await harness.settle();
  assert.deepEqual(harness.form().draft, other, "the draft is rebased on the new source");
  assert.equal(harness.form().dirty, false, "and the pending edit is gone");
  harness.unmount();
});

test("a loading source stays inert and never reports a pending change", async () => {
  const harness = await mount<Settings | null>(null);
  await harness.settle();

  assert.equal(harness.form().dirty, false, "nothing is dirty before the data arrives");
  assert.equal(harness.form().draft, null);

  await harness.render(base);
  await harness.settle();
  assert.deepEqual(harness.form().draft, base, "arriving data rebases the form");
  assert.equal(harness.form().dirty, false);
  harness.unmount();
});

test("a custom equals decides what counts as a change", async () => {
  // A selection is a set: reordering it is not an edit.
  const equalAsSet = (a: string[], b: string[]) => [...a].sort().join() === [...b].sort().join();
  const harness = await mount<string[]>(["a", "b"], equalAsSet);
  await harness.settle();
  assert.equal(harness.form().dirty, false);

  await edit(harness, form => form.setDraft(["b", "a"]));
  assert.equal(harness.form().dirty, false, "a reordered list is the same selection");

  await edit(harness, form => form.setDraft(["a", "b", "c"]));
  assert.equal(harness.form().dirty, true, "adding an entry is a real change");
  harness.unmount();
});
