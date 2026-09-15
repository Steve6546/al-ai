import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { allDestinations, eventsByCategory, type LogDestination } from "@al-ai/core";

/**
 * GOVERNANCE rule 15 — operational state lives in `config/`, never in code and
 * never guessed. Values the owner has not decided stay `null` with an explicit
 * `_todo` so a production deploy fails loudly instead of inventing a default.
 */

export const CONFIG_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "config");

/**
 * The file layout this build understands. Declared in code as well as in the
 * JSON, because a version nobody compares is decoration: the file could be
 * rewritten for a newer layout and this build would read it anyway, ignoring
 * every key it did not recognise. A mismatch now fails the boot, which is the
 * only moment the difference is still cheap to fix.
 */
export const CONTROL_PLANE_SCHEMA_VERSION = 1;
export const CHANNEL_SCHEMA_VERSION = 2;

export type ControlPlane = {
  schemaVersion: number;
  /**
   * Identifies which layer produced an event. `index.ts` carries it into every
   * signed envelope and into the audit trail, so it lives here rather than in a
   * constant that happened to hold the same string.
   *
   * There is deliberately no `name`. The bot's name is owned by the Discord
   * application and by `bot_identity`, which the dashboard writes; a third copy
   * here would be a setting an operator could edit with no effect at all.
   */
  instance: { sourceLayer: string };
  intents: { warnAt: number; limit: number; renewalDays: number; renewedAt: string | null; _note?: string; _todo?: string };
  retention: { auditDays: number | null; logDays: number | null; _note?: string; _todo?: string };
  encryption: { keyRotationDays: number | null; _note?: string; _todo?: string };
  gateway: { ceilingPerMinute: number; voiceDebounceMs: number };
  commands: { deployment: string; _note?: string; _todo?: string };
};

export type ChannelDeclaration = {
  schemaVersion: number;
  destinations: {
    id: LogDestination;
    label: string;
    subCategories: string[];
    required: boolean;
    note?: string;
  }[];
};

/**
 * Reads a config file and says *which* file failed.
 *
 * A malformed `control-plane.json` used to surface as a bare `SyntaxError`
 * thrown from the `JSON.parse` below, with a Node stack and no mention of the
 * file — while the boot's handler said "configuration is invalid" and pointed
 * at the channels assertion instead. `dir` exists so that failure can be tested
 * against a throwaway directory rather than the real one.
 */
function readJson<T>(file: string, dir = CONFIG_DIR): T {
  const path = join(dir, file);
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch {
    throw new Error(`config/${file} could not be read at ${path}.`);
  }
  try {
    return JSON.parse(source) as T;
  } catch (error) {
    throw new Error(`config/${file} is not valid JSON: ${error instanceof Error ? error.message : error}`);
  }
}

/**
 * The control plane validates itself on read, so no call site can forget to.
 * That matters because forgetting is exactly what happened: `index.ts` asserted
 * the channel declaration but read the control plane unguarded, and the drift
 * below was reachable in production.
 *
 * `config/channels.json` is validated instead by `assertChannelsMatchSchema`,
 * which the boot runs before this — its check needs the compiled event schema,
 * not just the file.
 */
export function loadControlPlane(dir = CONFIG_DIR): ControlPlane {
  const plane = readJson<ControlPlane>("control-plane.json", dir);
  assertControlPlane(plane);
  return plane;
}

export function loadChannelDeclaration(dir = CONFIG_DIR): ChannelDeclaration {
  return readJson<ChannelDeclaration>("channels.json", dir);
}

/**
 * Fails when `config/channels.json` drifts from the compiled event schema.
 * The schema is the authority; the config file must describe it exactly.
 */
export function assertChannelsMatchSchema(declaration = loadChannelDeclaration()) {
  if (declaration.schemaVersion !== CHANNEL_SCHEMA_VERSION) {
    throw new Error(
      `config/channels.json declares version ${JSON.stringify(declaration.schemaVersion)}; this build reads version ${CHANNEL_SCHEMA_VERSION}.`
    );
  }

  const declared = declaration.destinations.map(destination => destination.id);
  // Every destination, including the internal one: the config file is the
  // registry of what exists, while `logDestinations` is only what an operator
  // is offered.
  const expected = [...allDestinations];

  if (declared.length !== expected.length || expected.some(id => !declared.includes(id))) {
    throw new Error(
      `config/channels.json does not declare the destinations exactly. Expected ${expected.join(", ")}; got ${declared.join(", ")}.`
    );
  }

  for (const destination of declaration.destinations) {
    const inSchema = eventsByCategory(destination.id).sort();
    const inConfig = [...destination.subCategories].sort();
    const missing = inSchema.filter(id => !inConfig.includes(id));
    const extra = inConfig.filter(id => !inSchema.includes(id));
    if (missing.length || extra.length) {
      throw new Error(
        `config/channels.json is out of sync for ${destination.id}. Missing: ${missing.join(", ") || "—"}. Unknown: ${extra.join(", ") || "—"}.`
      );
    }
  }

  return true;
}

/**
 * GOVERNANCE rule 15 — the file is the authority, so it is checked before the
 * runtime reads a single field out of it.
 *
 * This is not decoration. `readJson` casts without looking, so a drifted file
 * reached the runtime as `undefined` and the *fallbacks* answered instead:
 * deleting `gateway.ceilingPerMinute` left `undecidedSettings()` empty, left
 * `plane.gateway.ceilingPerMinute` undefined, and let `EventPipeline` throttle
 * at its own constant of 120 — a rate ceiling the config never stated, with
 * nothing printed and nothing logged. The same shape of drift reaches
 * `intents.limit` (where `uniqueUsers >= undefined` is false forever, so the
 * over-limit state becomes unreachable) and `intents.renewedAt` (where a date
 * that does not parse makes `renewalDueAt()` return null, so the yearly renewal
 * alert never fires).
 *
 * Every problem is reported together, so an operator fixing a config sees all
 * of it in one boot rather than one mistake per restart.
 */
export function assertControlPlane(plane: ControlPlane): true {
  const problems: string[] = [];

  if (plane?.schemaVersion !== CONTROL_PLANE_SCHEMA_VERSION) {
    problems.push(`schemaVersion must be ${CONTROL_PLANE_SCHEMA_VERSION} (got ${JSON.stringify(plane?.schemaVersion)})`);
  }

  /** A section the runtime reads fields from; `null` is a missing section, not an empty one. */
  const section = (name: string): Record<string, unknown> | null => {
    const value = (plane as unknown as Record<string, unknown> | null)?.[name];
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      problems.push(`${name} must be an object (got ${JSON.stringify(value)})`);
      return null;
    }
    return value as Record<string, unknown>;
  };

  /** A whole number the runtime compares against, schedules with, or divides by. */
  const whole = (owner: Record<string, unknown> | null, path: string, key: string, min: number) => {
    if (!owner) return;
    const value = owner[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
      problems.push(`${path} must be a whole number of at least ${min} (got ${JSON.stringify(value)})`);
    }
  };

  /** A window in days the owner may still have left undecided as `null`. */
  const window = (owner: Record<string, unknown> | null, path: string, key: string) => {
    if (!owner) return;
    const value = owner[key];
    // `null` is legitimate here: `undecidedSettings` reports it and a production
    // boot refuses to start on it. A wrong *type* is not — it would read as
    // "decided" while being unusable.
    if (value === null) return;
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
      problems.push(`${path} must be a positive whole number of days or null (got ${JSON.stringify(value)})`);
    }
  };

  /** A string the runtime uses as an identity or carries into a signed envelope. */
  const text = (owner: Record<string, unknown> | null, path: string, key: string) => {
    if (!owner) return;
    const value = owner[key];
    if (typeof value !== "string" || value.trim() === "") {
      problems.push(`${path} must be a non-empty string (got ${JSON.stringify(value)})`);
    }
  };

  const instance = section("instance");
  text(instance, "instance.sourceLayer", "sourceLayer");

  const intents = section("intents");
  whole(intents, "intents.warnAt", "warnAt", 0);
  whole(intents, "intents.limit", "limit", 1);
  whole(intents, "intents.renewalDays", "renewalDays", 1);
  if (intents) {
    const renewedAt = intents.renewedAt;
    if (renewedAt !== null && (typeof renewedAt !== "string" || Number.isNaN(new Date(renewedAt).getTime()))) {
      problems.push(`intents.renewedAt must be an ISO date or null (got ${JSON.stringify(renewedAt)})`);
    }
  }

  const retention = section("retention");
  window(retention, "retention.auditDays", "auditDays");
  window(retention, "retention.logDays", "logDays");

  const encryption = section("encryption");
  window(encryption, "encryption.keyRotationDays", "keyRotationDays");

  const gateway = section("gateway");
  whole(gateway, "gateway.ceilingPerMinute", "ceilingPerMinute", 1);
  whole(gateway, "gateway.voiceDebounceMs", "voiceDebounceMs", 0);

  const commands = section("commands");
  text(commands, "commands.deployment", "deployment");

  if (problems.length) {
    throw new Error(`config/control-plane.json is malformed: ${problems.join("; ")}.`);
  }

  return true;
}

/**
 * Values the owner must still decide. All four were settled for this instance,
 * so this returns `[]` today — it stays as the guard rather than being deleted,
 * because the moment someone adds a field as `null` a production boot must fail
 * loudly instead of quietly inventing a policy. Development only warns.
 */
export function undecidedSettings(plane = loadControlPlane()): string[] {
  const undecided: string[] = [];
  if (plane.intents.renewedAt === null) undecided.push("intents.renewedAt");
  if (plane.retention.auditDays === null) undecided.push("retention.auditDays");
  if (plane.retention.logDays === null) undecided.push("retention.logDays");
  if (plane.encryption.keyRotationDays === null) undecided.push("encryption.keyRotationDays");
  return undecided;
}
