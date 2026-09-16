/**
 * Proves the commands *write* path, end to end, against the live server.
 *
 * The read path was verified by hand; the write path was not, and the fields
 * this check covers — `allowedUserIds`, `deniedUserIds`, `allowCustomReason`,
 * and now `aliases` and `deleteResponseOnLeave` — only matter if a save
 * actually persists them. A column that reads back as `[]` because nothing
 * ever wrote it looks identical to one that reads back as `[]` because the
 * write silently dropped it.
 *
 * `aliases` needs the stronger form of that check. `normaliseAliases` drops a
 * bad entry **without saying so**, so a stored `[]` has three possible causes:
 * nothing was written, everything was written and then rejected, or the write
 * path never normalised at all. The probe therefore submits a deliberately
 * mixed list — valid, duplicate, uppercase, and shadowing a published command
 * — and asserts the exact surviving array. That pins down which of the three
 * happened instead of accepting any empty result as "fine".
 *
 * `deleteResponseOnLeave` is only honoured for a `target: "member"` command, so
 * the probe reads the command's own `target` off the board and reports an
 * explicit SKIP rather than a silent pass when it does not apply.
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

/**
 * Aliases the probe submits.
 *
 * `PROBE_MIXED` is mostly poison on purpose: `UPPER` fails the lowercase rule,
 * `with space` fails the charset, `help` shadows a published command, and the
 * second `بروب` is a duplicate. Only `بروب` may survive. `PROBE_ALIASES` is
 * two entries that are all valid, so it proves the array round-trips more than
 * one element rather than just that the first one lands.
 */
const PROBE_MIXED = ["بروب", "UPPER", "with space", "help", "بروب"];
const PROBE_ALIASES = ["بروب", "zz-probe"];

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
  "preset_reasons",
  "aliases",
  "delete_response_on_leave",
  // The six role fields the punishment suite added. In this list for the same
  // reason as the rest: a column the restore does not cover is a column this
  // script leaves changed behind it.
  "muted_role_id",
  "prison_role_id",
  "prison_channel_id",
  "blacklist_role_ids",
  "admin_role_ids_to_strip",
  "blockable_role_ids"
];

const readRowFor = async name => {
  const result = await db.query(
    `select ${COLUMNS.join(", ")} from guild_command_flags where guild_id = $1 and command = $2`,
    [guildId, name]
  );
  return result.rows[0];
};

const readRow = () => readRowFor(command);

/** Maps a stored row back into a `Partial<CommandConfig>` the PUT route accepts. */
const rowToChange = (row, name = command) => ({
  name,
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
  presetReasons: row.preset_reasons ?? [],
  aliases: row.aliases ?? [],
  deleteResponseOnLeave: row.delete_response_on_leave,
  mutedRoleId: row.muted_role_id,
  prisonRoleId: row.prison_role_id,
  prisonChannelId: row.prison_channel_id,
  blacklistRoleIds: row.blacklist_role_ids ?? [],
  adminRoleIdsToStrip: row.admin_role_ids_to_strip ?? [],
  blockableRoleIds: row.blockable_role_ids ?? []
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

/** What the board would render, which is the only read path that matters here. */
const readBoard = async () => {
  const response = await fetch(`${BASE}/api/guilds/${guildId}/commands`, {
    headers: { cookie: `al_ai_session=${sessionId}` }
  });
  if (!response.ok) throw new Error(`GET /commands ${response.status}`);
  return response.json();
};

const boardCommand = async name => (await readBoard()).commands.find(entry => entry.name === name);

const findings = [];
const check = (label, actual, expected) => {
  const ok = typeof expected === "function" ? expected(actual) : actual === expected;
  findings.push({ label, actual, ok });
};

/**
 * A skip is recorded rather than dropped: "not applicable here" and "verified"
 * must not print the same way, or the report reads as coverage it does not have.
 */
const skip = (label, why) => findings.push({ label, actual: why, ok: true, skipped: true });

await db.connect();

/** Every row this run touches, so the `finally` puts all of them back. */
const originals = new Map();

/** Rows this run created, so the `finally` removes them again. */
const createdRows = new Set();

const restoreAll = async () => {
  try {
    // Deletions first: a row that did not exist before this run must not exist
    // after it either, or the next run's "it stayed false" probes would be
    // reading a row this one left behind.
    for (const name of createdRows) {
      try {
        await db.query("delete from guild_command_flags where guild_id = $1 and command = $2", [guildId, name]);
        const gone = await readRowFor(name);
        check(`/${name}: the row this run created was removed`, gone, undefined);
      } catch (error) {
        check(`/${name}: the row this run created was removed`, `delete failed — ${error.message}`, true);
      }
    }

    for (const [name, row] of originals) {
      try {
        await put(rowToChange(row, name));
        const restored = await readRowFor(name);
        const same = COLUMNS.every(column => JSON.stringify(restored[column]) === JSON.stringify(row[column]));
        check(`/${name}: the original row was restored exactly`, same, true);
        if (!same) console.log(`restore mismatch for /${name}:`, JSON.stringify({ original: row, restored }, null, 2));
      } catch (error) {
        check(`/${name}: the original row was restored exactly`, `restore failed — ${error.message}`, true);
      }
    }
  } finally {
    await db.end();
  }
};

try {
  const before = await readBoard();
  const subject = before.commands.find(entry => entry.name === command);
  if (!subject) throw new Error(`the board does not list /${command} — is the guild id right?`);

  const original = await readRow();
  if (!original) throw new Error(`no row for /${command} in guild ${guildId}`);
  originals.set(command, original);
  console.log(`/${command}  target=${subject.target}`);
  console.log(`original: ${JSON.stringify(original)}\n`);

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
  const asSeenByTheBoard = await boardCommand(command);
  check("the board reads back the saved user scope", asSeenByTheBoard.allowedUserIds, value => JSON.stringify(value) === JSON.stringify([PROBE_USER]));
  check("the board reads back the saved reason policy", asSeenByTheBoard.allowCustomReason, false);

  /* ------------------------------------------------------------------ *
   * Aliases
   *
   * The column accepting a write is the weak claim. The normaliser dropping
   * the bad half of a submitted list, silently, is the one that decides
   * whether an operator's `UPPER` or `help` becomes a command that never
   * fires. So the assertion is on the exact surviving array.
   * ------------------------------------------------------------------ */
  await put({ name: command, aliases: PROBE_MIXED });
  const mixed = await readRow();
  check(
    "only the valid alias survived normalisation",
    mixed.aliases,
    value => JSON.stringify(value) === JSON.stringify(["بروب"])
  );

  await put({ name: command, aliases: PROBE_ALIASES });
  const listed = await readRow();
  check(
    "a list of aliases round-trips in order",
    listed.aliases,
    value => JSON.stringify(value) === JSON.stringify(PROBE_ALIASES)
  );

  const withAliases = await boardCommand(command);
  check(
    "the board reads back the saved aliases",
    withAliases.aliases,
    value => JSON.stringify(value) === JSON.stringify(PROBE_ALIASES)
  );

  /* ------------------------------------------------------------------ *
   * Delete-on-leave
   * ------------------------------------------------------------------ */
  if (subject.target === "member") {
    await put({ name: command, deleteResponseOnLeave: true });
    const withLeave = await readRow();
    check("delete_response_on_leave reached the database", withLeave.delete_response_on_leave, true);

    const boardWithLeave = await boardCommand(command);
    check("the board reads back delete-on-leave", boardWithLeave.deleteResponseOnLeave, true);
  } else {
    skip(
      "delete_response_on_leave reached the database",
      `/${command} is target "${subject.target}", not "member" — the field does not apply`
    );
  }

  /* ------------------------------------------------------------------ *
   * The role fields the punishment suite added
   *
   * Six columns on one table, each owned by exactly one command. Two things
   * are worth probing rather than one: that the value reaches the column, and
   * that the board reads it back. A field that saves and is then dropped on
   * read is the same defect as one that never saved — it just takes one more
   * screen to notice, and the screen is where the operator lives.
   *
   * A partial PUT is not used here. The route normalises the body against the
   * registry, so a change carrying one field resets every other column to its
   * default — the row is sent whole, which is also what the board sends.
   * ------------------------------------------------------------------ */
  const roleFieldProbes = [
    { owner: "mute", field: "mutedRoleId", column: "muted_role_id", value: PROBE_USER, shape: "single" },
    { owner: "prison", field: "prisonRoleId", column: "prison_role_id", value: PROBE_USER, shape: "single" },
    { owner: "prison", field: "prisonChannelId", column: "prison_channel_id", value: PROBE_USER, shape: "single" },
    { owner: "blacklist", field: "blacklistRoleIds", column: "blacklist_role_ids", value: [PROBE_USER], shape: "list" },
    { owner: "down", field: "adminRoleIdsToStrip", column: "admin_role_ids_to_strip", value: [PROBE_USER], shape: "list" },
    { owner: "block", field: "blockableRoleIds", column: "blockable_role_ids", value: [PROBE_USER], shape: "list" }
  ];

  for (const probe of roleFieldProbes) {
    const row = await readRowFor(probe.owner);
    const onBoard = before.commands.find(entry => entry.name === probe.owner);
    if (!onBoard) {
      skip(`/${probe.owner}.${probe.field} round-trips`, `/${probe.owner} is not on this guild's board`);
      continue;
    }

    // A row that does not exist yet is created and then deleted in the restore.
    // The skip rule this script uses elsewhere exists so a *negative* assertion
    // ("it stayed false") is not made about a row the script brought into
    // existence. A positive one is different: the claim is that the value
    // reached the column, and a column that can only be written on rows that
    // already exist is not a column this feature can use.
    if (row) originals.set(probe.owner, row);
    else createdRows.add(probe.owner);

    await put({ ...rowToChange(row ?? {}, probe.owner), [probe.field]: probe.value });

    const stored = (await readRowFor(probe.owner))?.[probe.column];
    check(
      `/${probe.owner}: ${probe.field} reached ${probe.column}`,
      stored,
      value => JSON.stringify(value) === JSON.stringify(probe.value)
    );

    const seen = (await boardCommand(probe.owner))[probe.field];
    check(
      `/${probe.owner}: the board reads back ${probe.field}`,
      seen,
      value => JSON.stringify(value) === JSON.stringify(probe.value)
    );
  }

  /* ------------------------------------------------------------------ *
   * Ownership is enforced by the server, not just hidden by the card
   *
   * `ROLE_FIELD_OWNERS` is the single map the dashboard reads to decide which
   * card shows which field. If the server did not enforce the same map, the
   * two could disagree — and the way that shows up is a field that renders on
   * one command and is written onto another.
   * ------------------------------------------------------------------ */
  {
    const other = command === "mute" ? "ban" : command;
    const row = await readRowFor(other);
    if (!row) {
      skip("a role field sent to a command that does not own it is refused", `/${other} has no stored row to probe`);
    } else {
      originals.set(other, row);
      await put({ ...rowToChange(row, other), mutedRoleId: PROBE_USER });
      const stored = (await readRowFor(other)).muted_role_id;
      check(`/${other} did not store a muted role it does not own`, stored, null);
    }
  }

  // The negative half. Without it, "reached the database" only proves the
  // column accepts writes; it says nothing about the rule that an unsupported
  // control is refused rather than stored and ignored.
  //
  // The candidate must already have a row: probing a command that has none
  // would create one, and then "it stayed false" would be a claim about a row
  // this script brought into existence.
  const candidates = before.commands.filter(entry => entry.name !== command && entry.target !== "member");
  let inapplicable = null;
  for (const candidate of candidates) {
    const row = await readRowFor(candidate.name);
    if (row) {
      inapplicable = { entry: candidate, row };
      break;
    }
  }

  if (!inapplicable) {
    skip(
      "a non-member command refuses delete-on-leave",
      `none of the ${candidates.length} non-member commands has a stored row to probe`
    );
  } else {
    originals.set(inapplicable.entry.name, inapplicable.row);
    await put({ name: inapplicable.entry.name, deleteResponseOnLeave: true });
    const after = await readRowFor(inapplicable.entry.name);
    check(
      `/${inapplicable.entry.name} (target ${inapplicable.entry.target}) refused delete-on-leave`,
      after.delete_response_on_leave,
      false
    );
  }
} finally {
  await restoreAll();
}

const failed = findings.filter(finding => !finding.ok);
const skipped = findings.filter(finding => finding.skipped);
for (const finding of findings) {
  const verdict = finding.skipped ? "SKIP" : finding.ok ? "PASS" : "FAIL";
  console.log(`${verdict}  ${finding.label}  →  ${JSON.stringify(finding.actual)}`);
}
const judged = findings.length - skipped.length;
console.log(`\n${judged - failed.length}/${judged} checks passed${skipped.length ? `, ${skipped.length} skipped` : ""}`);
process.exit(failed.length ? 1 : 0);
