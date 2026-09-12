import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { LAYER_SIGNATURE_TTL_MS, newNonce, layerSignature, verifyLayerRequest } from "@al-ai/core";

/**
 * GOVERNANCE rule 16 — the integration adapter is a local control surface, not
 * a public API.
 *
 *  - It binds to 127.0.0.1 only. Binding to 0.0.0.0 is refused outright, so a
 *    misconfigured firewall can never expose it.
 *  - Every call is HMAC-signed over `nonce.timestamp.body` and the nonce is
 *    single-use with a five-minute ceiling.
 *  - `applyConfig` accepts an allowlist of keys. It cannot be used to write
 *    arbitrary state, and it never echoes a secret back.
 */

export const DEFAULT_ADAPTER_PORT = 3400;
export const ADAPTER_HOST = "127.0.0.1";

/** The only keys `applyConfig` will accept. Anything else is rejected. */
export const APPLYABLE_KEYS = ["logging.enabled", "logging.globalChannelId", "logging.embedColor"] as const;
export type ApplyableKey = (typeof APPLYABLE_KEYS)[number];

export type AdapterRequest = { endpoint: string; body: Record<string, unknown> };
export type AdapterHandler = (request: AdapterRequest) => Promise<unknown>;

export type IntegrationAdapterDeps = {
  hmacSecret: string;
  sourceLayer: string;
  consumeNonce: (nonce: string, expiresAt: Date) => Promise<boolean>;
  handlers: {
    getStatus: AdapterHandler;
    diagnose: AdapterHandler;
    readLogs: AdapterHandler;
    suggestConfig: AdapterHandler;
    applyConfig: AdapterHandler;
    listChannels: AdapterHandler;
  };
  port?: number;
  now?: () => number;
};

export const ADAPTER_ENDPOINTS = ["getStatus", "diagnose", "readLogs", "suggestConfig", "applyConfig", "listChannels"] as const;
export type AdapterEndpoint = (typeof ADAPTER_ENDPOINTS)[number];

function isEndpoint(value: string): value is AdapterEndpoint {
  return (ADAPTER_ENDPOINTS as readonly string[]).includes(value);
}

/**
 * Rejects any key that is not on the allowlist, so a caller cannot smuggle an
 * unexpected field into the write path.
 */
export function filterApplyableConfig(input: Record<string, unknown>) {
  const accepted: Partial<Record<ApplyableKey, unknown>> = {};
  const rejected: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if ((APPLYABLE_KEYS as readonly string[]).includes(key)) {
      accepted[key as ApplyableKey] = value;
    } else {
      rejected.push(key);
    }
  }
  return { accepted, rejected };
}

async function readBody(request: IncomingMessage, limit = 64 * 1024) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error("BODY_TOO_LARGE");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function startIntegrationAdapter(deps: IntegrationAdapterDeps) {
  const now = deps.now ?? (() => Date.now());
  const port = deps.port ?? DEFAULT_ADAPTER_PORT;
  let closed = false;

  const server: Server = createServer((request, response) => {
    void handle(request, response);
  });

  async function send(response: ServerResponse, status: number, payload: unknown) {
    const body = JSON.stringify(payload);
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
    response.end(body);
  }

  async function handle(request: IncomingMessage, response: ServerResponse) {
    // Defence in depth: even if something rebinds the socket, refuse non-loopback peers.
    const remote = request.socket.remoteAddress ?? "";
    if (!(remote === ADAPTER_HOST || remote === "::1" || remote === "::ffff:127.0.0.1")) {
      await send(response, 403, { error: "ADAPTER_LOCAL_ONLY" });
      return;
    }

    const url = new URL(request.url ?? "/", `http://${ADAPTER_HOST}`);
    const endpoint = url.pathname.replace(/^\//, "");

    if (endpoint === "ping") {
      await send(response, 200, { ok: true, sourceLayer: deps.sourceLayer });
      return;
    }
    if (!isEndpoint(endpoint)) {
      await send(response, 404, { error: "UNKNOWN_ENDPOINT" });
      return;
    }

    let body = "";
    try {
      body = await readBody(request);
    } catch {
      await send(response, 413, { error: "BODY_TOO_LARGE" });
      return;
    }

    const nonce = String(request.headers["x-al-nonce"] ?? "");
    const timestamp = String(request.headers["x-al-timestamp"] ?? "");
    const signature = String(request.headers["x-al-signature"] ?? "");
    if (!nonce || !timestamp || !signature) {
      await send(response, 401, { error: "LAYER_SIGNATURE_MISSING" });
      return;
    }

    try {
      await verifyLayerRequest(
        { nonce, timestamp, signature, body },
        deps.hmacSecret,
        nonceValue => deps.consumeNonce(nonceValue, new Date(now() + LAYER_SIGNATURE_TTL_MS)),
        now()
      );
    } catch (error) {
      await send(response, 401, { error: error instanceof Error ? error.message : "LAYER_SIGNATURE_INVALID" });
      return;
    }

    let parsed: Record<string, unknown> = {};
    if (body.trim()) {
      try {
        parsed = JSON.parse(body) as Record<string, unknown>;
      } catch {
        await send(response, 400, { error: "INVALID_JSON" });
        return;
      }
    }

    try {
      const result = await deps.handlers[endpoint]({ endpoint, body: parsed });
      await send(response, 200, { ok: true, endpoint, result });
    } catch (error) {
      await send(response, 500, { ok: false, error: error instanceof Error ? error.message : "ADAPTER_FAILED" });
    }
  }

  return {
    port,
    host: ADAPTER_HOST,
    async listen() {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, ADAPTER_HOST, () => {
          server.off("error", reject);
          resolve();
        });
      });
      const address = server.address();
      const boundPort = typeof address === "object" && address ? address.port : port;
      return { host: ADAPTER_HOST, port: boundPort };
    },
    async close() {
      if (closed) return;
      closed = true;
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  };
}

export type IntegrationAdapter = ReturnType<typeof startIntegrationAdapter>;

/** Helper for callers that need to sign an adapter request. */
export function signAdapterRequest(body: string, secret: string, timestamp = new Date().toISOString()) {
  const nonce = newNonce();
  return { nonce, timestamp, signature: layerSignature(nonce, timestamp, body, secret) };
}
