import test from "node:test";
import assert from "node:assert/strict";
import { createNetworkManager } from "../server/network.js";

/**
 * The tunnel re-spawn ladder.
 *
 * ngrok refuses agents from some ISP addresses (ERR_NGROK_9040) and a
 * residential line rotates to an allowed one minutes later. Before this, one
 * exit meant `tunnelStatus = "error"` and an operator who had to re-pick the
 * mode by hand every time the line re-dialled. Now a few spaced attempts happen
 * first, and they stop, because an auth failure that is *not* transient must not
 * spawn an ngrok forever.
 *
 * `NGROK_PATH` points at this very Node binary: the manager spawns
 * `node http <port> …`, which fails immediately, so the exit path is exercised
 * without a network or a real agent.
 */

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function harness(retryDelaysMs: number[]) {
  const previous = process.env.NGROK_PATH;
  process.env.NGROK_PATH = process.execPath;
  const warnings: Array<{ msg: string; payload: unknown }> = [];
  const manager = createNetworkManager({
    port: 4599,
    retryDelaysMs,
    getSetting: async () => null,
    setSetting: async () => undefined,
    log: {
      info: () => undefined,
      warn: (payload, msg) => warnings.push({ msg: String(msg), payload })
    }
  });
  return {
    manager,
    exits: () => warnings.filter(w => w.msg === "ngrok tunnel exited").length,
    // `stop()` is deliberately a no-op (a restart re-adopts the tunnel), so the
    // only way to end an agent from code is the mode toggle.
    async cleanup() {
      await manager.applyReach({ mode: "off", hasDomain: false, domain: null });
      if (previous === undefined) delete process.env.NGROK_PATH;
      else process.env.NGROK_PATH = previous;
    }
  };
}

test("a tunnel that dies is restarted, then gives up with a count", async () => {
  const h = harness([40, 60]);
  try {
    await h.manager.applyReach({ mode: "tunnel", hasDomain: false, domain: null });

    // Two scheduled retries plus the original start.
    const deadline = Date.now() + 5_000;
    while (h.exits() < 3 && Date.now() < deadline) await sleep(50);
    assert.equal(h.exits(), 3, "one start and two retries, no more");

    const snapshot = h.manager.snapshot();
    assert.equal(snapshot.tunnelStatus, "error", "the ladder ends in a visible error, not silence");
    assert.match(String(snapshot.tunnelError), /بعد 2 محاولات/, "the operator is told how many attempts were made");
  } finally {
    await h.cleanup();
  }
});

test("an empty ladder fails on the first exit, as before", async () => {
  const h = harness([]);
  try {
    await h.manager.applyReach({ mode: "tunnel", hasDomain: false, domain: null });
    const deadline = Date.now() + 3_000;
    while (h.manager.snapshot().tunnelStatus !== "error" && Date.now() < deadline) await sleep(50);

    assert.equal(h.manager.snapshot().tunnelStatus, "error");
    assert.equal(h.exits(), 1, "no retries were configured, so exactly one exit");
  } finally {
    await h.cleanup();
  }
});

test("stopping cancels a retry that has not fired yet", async () => {
  const h = harness([60_000]);
  try {
    await h.manager.applyReach({ mode: "tunnel", hasDomain: false, domain: null });
    const deadline = Date.now() + 3_000;
    while (h.exits() < 1 && Date.now() < deadline) await sleep(50);
    assert.equal(h.exits(), 1, "the first exit happened");

    await h.manager.applyReach({ mode: "off", hasDomain: false, domain: null });
    const exitsAfterStop = h.exits();
    await sleep(300);
    assert.equal(h.exits(), exitsAfterStop, "nothing respawned after the operator stopped it");
    assert.equal(h.manager.snapshot().tunnelStatus, "off");
  } finally {
    await h.cleanup();
  }
});
