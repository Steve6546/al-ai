import test from "node:test";
import assert from "node:assert/strict";
import {
  ADAPTER_ENDPOINTS,
  ADAPTER_HOST,
  APPLYABLE_KEYS,
  filterApplyableConfig,
  signAdapterRequest,
  startIntegrationAdapter,
  type AdapterHandler
} from "../src/integration-adapter.ts";

/**
 * GOVERNANCE rule 16 — the integration adapter is a local control surface.
 * These tests prove it refuses anonymous callers, replayed nonces and
 * non-allowlisted config keys.
 */

const SECRET = "test-secret-not-a-real-key";

type Harness = Awaited<ReturnType<typeof boot>>;

async function boot() {
  const consumed = new Set<string>();
  const calls: string[] = [];

  const handler = (name: string): AdapterHandler => async () => {
    calls.push(name);
    return { from: name };
  };

  const adapter = startIntegrationAdapter({
    hmacSecret: SECRET,
    sourceLayer: "bot-runtime",
    port: 0,
    consumeNonce: async nonce => {
      if (consumed.has(nonce)) return false;
      consumed.add(nonce);
      return true;
    },
    handlers: {
      getStatus: handler("getStatus"),
      diagnose: handler("diagnose"),
      readLogs: handler("readLogs"),
      suggestConfig: handler("suggestConfig"),
      applyConfig: handler("applyConfig"),
      listChannels: handler("listChannels")
    }
  });

  const address = await adapter.listen();
  return { adapter, calls, base: `http://${ADAPTER_HOST}:${address.port}` };
}

async function call(
  base: string,
  endpoint: string,
  body: Record<string, unknown> = {},
  options: { sign?: boolean; timestamp?: string; reuse?: ReturnType<typeof signAdapterRequest> } = {}
) {
  const payload = JSON.stringify(body);
  const signature = options.reuse ?? signAdapterRequest(payload, SECRET, options.timestamp);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options.sign !== false) {
    headers["x-al-nonce"] = signature.nonce;
    headers["x-al-timestamp"] = signature.timestamp;
    headers["x-al-signature"] = signature.signature;
  }
  const response = await fetch(`${base}/${endpoint}`, { method: "POST", headers, body: payload });
  return { status: response.status, body: (await response.json()) as Record<string, unknown>, signature };
}

test("the adapter binds to loopback only", async () => {
  const harness: Harness = await boot();
  try {
    assert.equal(harness.adapter.host, ADAPTER_HOST);
    assert.equal(harness.base.includes("127.0.0.1"), true);
  } finally {
    await harness.adapter.close();
  }
});

test("a request with no signature is refused", async () => {
  const harness = await boot();
  try {
    const result = await call(harness.base, "getStatus", {}, { sign: false });
    assert.equal(result.status, 401);
    assert.equal(result.body.error, "LAYER_SIGNATURE_MISSING");
  } finally {
    await harness.adapter.close();
  }
});

test("a forged signature is refused", async () => {
  const harness = await boot();
  try {
    const forged = signAdapterRequest("{}", "the-wrong-secret");
    const result = await call(harness.base, "getStatus", {}, { reuse: forged });
    assert.equal(result.status, 401);
    assert.equal(result.body.error, "LAYER_SIGNATURE_INVALID");
  } finally {
    await harness.adapter.close();
  }
});

test("a tampered body is refused even when the signature was valid for the original", async () => {
  const harness = await boot();
  try {
    const signature = signAdapterRequest(JSON.stringify({ limit: 1 }), SECRET);
    const response = await fetch(`${harness.base}/readLogs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-al-nonce": signature.nonce,
        "x-al-timestamp": signature.timestamp,
        "x-al-signature": signature.signature
      },
      body: JSON.stringify({ limit: 9999 })
    });
    assert.equal(response.status, 401);
  } finally {
    await harness.adapter.close();
  }
});

test("a nonce cannot be replayed", async () => {
  const harness = await boot();
  try {
    const first = await call(harness.base, "getStatus");
    assert.equal(first.status, 200);

    const replay = await call(harness.base, "getStatus", {}, { reuse: first.signature });
    assert.equal(replay.status, 401);
    assert.equal(replay.body.error, "LAYER_NONCE_REPLAYED");
  } finally {
    await harness.adapter.close();
  }
});

test("a stale timestamp is refused", async () => {
  const harness = await boot();
  try {
    const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const result = await call(harness.base, "getStatus", {}, { timestamp: stale });
    assert.equal(result.status, 401);
    assert.equal(result.body.error, "LAYER_SIGNATURE_EXPIRED");
  } finally {
    await harness.adapter.close();
  }
});

test("a correctly signed request reaches its handler", async () => {
  const harness = await boot();
  try {
    const result = await call(harness.base, "diagnose");
    assert.equal(result.status, 200);
    assert.equal(result.body.ok, true);
    assert.deepEqual(result.body.result, { from: "diagnose" });
    assert.deepEqual(harness.calls, ["diagnose"]);
  } finally {
    await harness.adapter.close();
  }
});

test("every documented endpoint is reachable when signed", async () => {
  const harness = await boot();
  try {
    for (const endpoint of ADAPTER_ENDPOINTS) {
      const result = await call(harness.base, endpoint);
      assert.equal(result.status, 200, `${endpoint} responds`);
    }
    assert.deepEqual(harness.calls.sort(), [...ADAPTER_ENDPOINTS].sort());
  } finally {
    await harness.adapter.close();
  }
});

test("an unknown endpoint is not routable", async () => {
  const harness = await boot();
  try {
    const result = await call(harness.base, "dropDatabase");
    assert.equal(result.status, 404);
    assert.equal(result.body.error, "UNKNOWN_ENDPOINT");
  } finally {
    await harness.adapter.close();
  }
});

test("applyConfig only accepts allowlisted keys", () => {
  const { accepted, rejected } = filterApplyableConfig({
    "logging.enabled": true,
    "logging.embedColor": "#ffffff",
    "security.hmacSecret": "please-rotate-me"
  });

  assert.deepEqual(Object.keys(accepted).sort(), ["logging.embedColor", "logging.enabled"]);
  assert.deepEqual(rejected, ["security.hmacSecret"]);
  assert.equal(APPLYABLE_KEYS.includes("security.hmacSecret" as never), false);
});
