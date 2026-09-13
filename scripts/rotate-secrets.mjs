// Maintenance script: rotate weak/known AL AI secrets in .env.
//
// Safe to re-run. It only rewrites the keys it owns and never prints a value.
//
//   node scripts/rotate-secrets.mjs          rotate whatever is still weak
//   node scripts/rotate-secrets.mjs --force  rotate the database password too
//
// The database password is the one secret that lives in two places at once — in
// PostgreSQL and inside DATABASE_URL — so the two writes are ordered and rolled
// back rather than left half-applied, which would lock every service out.
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { Client } from "pg";

const path = ".env";
const keys = ["SESSION_SECRET", "EVENT_HMAC_SECRET", "ENCRYPTION_KEY"];
const raw = readFileSync(path, "utf8");
const lines = raw.split(/\r?\n/);

const weak = new Set([
  "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08", // sha256("test")
  "4a7c8b92e3d4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0",
  "c3ab8ff13720e8ad9047dd39466b3c8974e592c2fa383d4a3960714caef0c4f2",
  "change_me"
]);

function readValue(name) {
  const line = lines.find(entry => entry.startsWith(`${name}=`));
  return line ? line.slice(name.length + 1).trim() : null;
}

function setValue(name, value) {
  const index = lines.findIndex(entry => entry.startsWith(`${name}=`));
  if (index === -1) {
    lines.push(`${name}=${value}`);
    return;
  }
  lines[index] = `${name}=${value}`;
}

/* ------------------------------------------------------------------ *
 * Application secrets
 * ------------------------------------------------------------------ */

const rotated = [];
for (let index = 0; index < lines.length; index += 1) {
  const match = /^([A-Z_]+)=(.*)$/.exec(lines[index]);
  if (!match || !keys.includes(match[1])) continue;
  const value = match[2].trim();
  if (value && !weak.has(value) && value.length >= 64) continue;
  rotated.push(match[1]);
  lines[index] = `${match[1]}=${randomBytes(32).toString("hex")}`;
}

// Written before the database step, so a database outage cannot cost the
// application secrets their rotation. The database step writes again on top.
writeFileSync(path, lines.join("\n"));

/* ------------------------------------------------------------------ *
 * Database password
 *
 * 32 random bytes rendered as hex: 256 bits of entropy, and the alphabet is
 * `[0-9a-f]`, so the value needs no escaping in a SQL literal and no
 * percent-encoding in the URL. Both of those are places a "clever" password
 * silently corrupts the connection string.
 * ------------------------------------------------------------------ */

const force = process.argv.includes("--force");
const databaseUrl = readValue("DATABASE_URL");

async function rotateDatabasePassword() {
  if (!databaseUrl) {
    console.log("DATABASE_URL is absent; skipping the database password.");
    return;
  }

  const url = new URL(databaseUrl);
  // POSTGRES_PASSWORD is the declared source, but DATABASE_URL is what the
  // services actually connect with — so fall back to it rather than assume the
  // two were kept in step.
  const oldPassword = readValue("POSTGRES_PASSWORD") ?? decodeURIComponent(url.password);

  if (oldPassword && !weak.has(oldPassword) && oldPassword.length >= 32 && !force) {
    console.log("Database password already strong. Re-run with --force to rotate it anyway.");
    return;
  }

  const user = decodeURIComponent(url.username);
  const nextPassword = randomBytes(32).toString("hex");
  // Quoted once and reused, so the rollback cannot drift from the forward step.
  const quotedUser = `"${user.replaceAll('"', '""')}"`;

  // Connect with the credential that is still valid right now.
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    // A utility statement cannot take a bind parameter, so the literal is built
    // by hand — which is safe precisely because the value is hex-only.
    await client.query(`ALTER USER ${quotedUser} WITH PASSWORD '${nextPassword}'`);

    url.password = nextPassword;
    setValue("POSTGRES_PASSWORD", nextPassword);
    setValue("DATABASE_URL", url.toString());

    try {
      writeFileSync(path, lines.join("\n"));
    } catch (error) {
      // The database now holds a password .env does not know. Put it back, so a
      // failed write leaves the system exactly as it was.
      await client.query(`ALTER USER ${quotedUser} WITH PASSWORD '${oldPassword}'`).catch(() => {});
      throw error;
    }

    console.log("Rotated: POSTGRES_PASSWORD, DATABASE_URL");
    console.log("Restart the bot and the dashboard: both hold a pool built with the old password.");
  } finally {
    await client.end().catch(() => {});
  }
}

await rotateDatabasePassword();

console.log(rotated.length ? `Rotated: ${rotated.join(", ")}` : "Application secrets already strong.");
