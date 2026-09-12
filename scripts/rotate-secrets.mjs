// One-off maintenance script: rotate weak/known AL AI secrets in .env.
// Safe to re-run; it only rewrites the three secret keys and never prints values.
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const path = ".env";
const keys = ["SESSION_SECRET", "EVENT_HMAC_SECRET", "ENCRYPTION_KEY"];
const raw = readFileSync(path, "utf8");
const lines = raw.split(/\r?\n/);

const weak = new Set([
  "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08", // sha256("test")
  "4a7c8b92e3d4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0",
  "c3ab8ff13720e8ad9047dd39466b3c8974e592c2fa383d4a3960714caef0c4f2"
]);

const rotated = [];
const next = lines.map((line) => {
  const match = /^([A-Z_]+)=(.*)$/.exec(line);
  if (!match || !keys.includes(match[1])) return line;
  const value = match[2].trim();
  if (value && !weak.has(value) && value.length >= 64) return line;
  rotated.push(match[1]);
  return `${match[1]}=${randomBytes(32).toString("hex")}`;
});

writeFileSync(path, next.join("\n"));
console.log(rotated.length ? `Rotated: ${rotated.join(", ")}` : "All secrets already strong.");
