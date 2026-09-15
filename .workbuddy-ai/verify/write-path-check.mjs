/**
 * Proves the commands *write* path, end to end, against the live server.
 *
 * The read path was verified by hand; the write path was not, and the three
 * fields this round added — `allowedUserIds`, `deniedUserIds`,
 * `allowCustomReason` — only matter if a save actually persists them. A column
 * that reads back as `[]` because nothing ever wrote it looks identical to one
 * that reads back as `[]` because the write silently dropped it.
 *
 * It restores the original row in a `finally`, so an assertion failure midway
 * still leaves the guild as it was found.
 *
 *   node .workbuddy-ai/verify/write-path-check.mjs <guildId> <sessionId> [command]
 */

import { Client } from "pg";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

const [guildId, sessionId, command = "warn"] = process.argv.slice(2);
if (!guildId || !sessionId) {
  console.error("usage: node write-path-check.mjs <guildId> <sessionId> [command]");
  process.exit(2);
}

const env = Object.fromEntries(
  readFileSync(resolve(REPO, ".env"), "utf8")
    .split(/\r?\n/)
    .filter(line => line && !line.startsWith("#") && line.includes("="))
    .map(line => {
      const at = line.indexOf("=");
      return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
    })
);

const BASE = "http://127.0.0.1:3000";
const PROBE_USER = "1234518878822989944";
const PROBE_DENIED = "999999999999999999";

const db = new Client({ connectionString: env.DATABASE_URL });

/** Every column the save path writes, so the restore is complete rather than partial. */
const COLUMNS = [
  "enabled",
  "allowed_user_ids",
  "denied_user_ids",
  "allow_custom_reason",
  "allowed_role_ids",
  "denied_role_ids",
  "allowed_channel_ids",
  "denied_channel_ids",
  "cooldown_seconds",
  "auto_delete_response_seconds",
  "require_reason",
  "default_duration",
  "preset_reasons"
];

const readRow = async () => {
  const result = await db.query(
    `select ${COLUMNS.join(", ")} from guild_command_flags where guild_id = $1 and command = $2`,
    [guildId, command]
  );
  return result.rows[0];
};

/** Maps a stored row back into a `Partial<CommandConfig>` the PUT route accepts. */
const rowToChange = row => ({
  name: command,
  enabled: row.enabled,
  allowedUserIds: row.allowed_user_ids ?? [],
  deniedUserIds: row.denied_user_ids ?? [],
  allowCustomReason: row.allow_custom_reason,
  allowedRoleIds: row.allowed_role_ids ?? [],
  deniedRoleIds: row.denied_role_ids ?? [],
  allowedChannelIds: row.allowed_channel_ids ?? [],
  deniedChannelIds: row.denied_channel_ids ?? [],
  cooldownSeconds: row.cooldown_seconds,
  autoDeleteResponseSeconds: row.auto_delete_response_seconds,
  requireReason: row.require_reason,
  defaultDuration: row.default_duration,
  presetReasons: row.preset_reasons ?? []
});

const put = async change => {
  const response = await fetch(`${BASE}/api/guilds/${guildId}/commands`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", cookie: `al_ai_session=${sessionId}` },
    body: JSON.stringify({ changes: [change] })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`PUT ${response.status}: ${JSON.stringify(body).slice(0, 200)}`);
  return body;
};

const findings = [];
const check = (label, actual, expected) => {
  const ok = typeof expected === "function" ? expected(actual) : actual === expected;
  findings.push({ label, actual, ok });
};

await db.connect();
let original = null;

try {
  original = await readRow();
  if (!original) throw new Error(`no row for /${command} in guild ${guildId}`);
  console.log(`original /${command}: ${JSON.stringify(original)}\n`);

  // A preset is included on purpose: `allowCustomReason` is only meaningful when
  // the command has preset reasons, and the normaliser drops it otherwise.
  await put({
    name: command,
    allowedUserIds: [PROBE_USER],
    deniedUserIds: [PROBE_DENIED],
    allowCustomReason: false,
    cooldownSeconds: 7,
    presetReasons: [{ id: "probe", label: "سبب اختباري", duration: null }]
  });

  const written = await readRow();
  check("allowed_user_ids reached the database", written.allowed_user_ids, value => JSON.stringify(value) === JSON.stringify([PROBE_USER]));
  check("denied_user_ids reached the database", written.denied_user_ids, value => JSON.stringify(value) === JSON.stringify([PROBE_DENIED]));
  check("allow_custom_reason reached the database", written.allow_custom_reason, false);
  check("cooldown_seconds reached the database", written.cooldown_seconds, 7);
  check("preset_reasons reached the database", written.preset_reasons?.length, 1);

  // And the read path returns what was written, which is what the board renders.
  const readBack = await fetch(`${BASE}/api/guilds/${guildId}/commands`, {
    headers: { cookie: `al_ai_session=${sessionId}` }
  }).then(response => response.json());
  const asSeenByTheBoard = readBack.commands.find(entry => entry.name === command);
  check("the board reads back the saved user scope", asSeenByTheBoard.allowedUserIds, value => JSON.stringify(value) === JSON.stringify([PROBE_USER]));
  check("the board reads back the saved reason policy", asSeenByTheBoard.allowCustomReason, false);
} finally {
  if (original) {
    await put(rowToChange(original));
    const restored = await readRow();
    const same = COLUMNS.every(column => JSON.stringify(restored[column]) === JSON.stringify(original[column]));
    check("the original row was restored exactly", same, true);
    if (!same) console.log("restore mismatch:", JSON.stringify({ original, restored }, null, 2));
  }
  await db.end();
}

const failed = findings.filter(finding => !finding.ok);
for (const finding of findings) {
  console.log(`${finding.ok ? "PASS" : "FAIL"}  ${finding.label}  →  ${JSON.stringify(finding.actual)}`);
}
console.log(`\n${findings.length - failed.length}/${findings.length} checks passed`);
process.exit(failed.length ? 1 : 0);
