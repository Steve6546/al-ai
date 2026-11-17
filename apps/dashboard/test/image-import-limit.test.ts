/**
 * The import endpoint is a memory boundary as well as an SSRF one.
 *
 * Each import holds its chunks and then the base64 it produces — about 5 MB at
 * the 2 MB ceiling — inside an 80 MB heap on a 256 MB container. A signed-in
 * session is not a concurrency limit: two tabs and a double-click are enough to
 * stack imports, and the failure mode is a container OOM kill that looks like
 * "the bot restarted by itself".
 *
 * These tests pin the ceiling, and — the part that actually bites — that a slot
 * is returned when the import *fails*, because three refusals in a row would
 * otherwise wedge the endpoint until a restart.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_CONCURRENT_IMAGE_IMPORTS,
  ImageImportBusyError,
  activeImageImportCount,
  withImageImportSlot
} from "../server/appearance.js";

/** A promise you resolve by hand, so a slot can be held open on purpose. */
function gate() {
  let release!: () => void;
  const opened = new Promise<void>(resolve => {
    release = resolve;
  });
  return { opened, release };
}

test("the ceiling admits exactly as many imports as it promises", async () => {
  const gates = Array.from({ length: MAX_CONCURRENT_IMAGE_IMPORTS }, gate);
  const running = gates.map(entry => withImageImportSlot(async () => {
    await entry.opened;
    return "done";
  }));

  assert.equal(activeImageImportCount(), MAX_CONCURRENT_IMAGE_IMPORTS, "every slot is held");

  await assert.rejects(
    () => withImageImportSlot(async () => "should not run"),
    (error: unknown) => error instanceof ImageImportBusyError,
    "one import past the ceiling is refused, not queued into the heap"
  );

  for (const entry of gates) entry.release();
  assert.deepEqual(await Promise.all(running), Array(MAX_CONCURRENT_IMAGE_IMPORTS).fill("done"));
  assert.equal(activeImageImportCount(), 0, "released back to zero");
});

test("a slot comes back after a failed import", async () => {
  await assert.rejects(() => withImageImportSlot(async () => {
    throw new Error("الرابط غير مسموح");
  }));
  assert.equal(activeImageImportCount(), 0, "a refusal must not hold a slot");

  // The endpoint still works afterwards: same ceiling, no residue.
  const result = await withImageImportSlot(async () => "ok");
  assert.equal(result, "ok");
  assert.equal(activeImageImportCount(), 0);
});
