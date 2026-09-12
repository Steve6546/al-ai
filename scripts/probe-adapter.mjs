import { readFileSync } from "node:fs";
import { createHmac, randomBytes } from "node:crypto";

const env = Object.fromEntries(
  readFileSync(new URL("../.env", import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter(line => line.includes("=") && !line.trimStart().startsWith("#"))
    .map(line => {
      const index = line.indexOf("=");
      return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
    })
);

const SECRET = env.EVENT_HMAC_SECRET;
const BASE = "http://127.0.0.1:3400";

function sign(body) {
  const nonce = randomBytes(24).toString("base64url");
  const timestamp = new Date().toISOString();
  const signature = createHmac("sha256", SECRET).update(`${nonce}.${timestamp}.${body}`).digest("hex");
  return { nonce, timestamp, signature };
}

async function call(endpoint, body = {}, { signed = true, reuse = null } = {}) {
  const payload = JSON.stringify(body);
  const sig = reuse ?? sign(payload);
  const headers = { "Content-Type": "application/json" };
  if (signed) {
    headers["x-al-nonce"] = sig.nonce;
    headers["x-al-timestamp"] = sig.timestamp;
    headers["x-al-signature"] = sig.signature;
  }
  const response = await fetch(`${BASE}/${endpoint}`, { method: "POST", headers, body: payload });
  return { status: response.status, body: await response.json().catch(() => null), sig };
}

const results = [];
results.push(["ping (unsigned, loopback)", await call("ping", {}, { signed: false })]);
results.push(["getStatus (unsigned)", await call("getStatus", {}, { signed: false })]);

const forged = sign("{}");
forged.signature = "0".repeat(64);
results.push(["getStatus (forged signature)", await call("getStatus", {}, { reuse: forged })]);

const valid = await call("getStatus");
results.push(["getStatus (valid)", valid]);
results.push(["getStatus (nonce replayed)", await call("getStatus", {}, { reuse: valid.sig })]);
results.push(["unknown endpoint", await call("dropDatabase")]);

for (const [label, result] of results) {
  const body = JSON.stringify(result.body);
  console.log(`${String(result.status).padEnd(4)} ${label.padEnd(30)} ${body.slice(0, 150)}`);
}

const full = await call("getStatus");
console.log("\nFull getStatus result:");
console.log(JSON.stringify(full.body.result, null, 2));
