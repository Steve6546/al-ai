import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eventsByCategory, logDestinations, type LogDestination } from "@al-ai/core";

/**
 * GOVERNANCE rule 15 — operational state lives in `config/`, never in code and
 * never guessed. Values the owner has not decided stay `null` with an explicit
 * `_todo` so a production deploy fails loudly instead of inventing a default.
 */

export const CONFIG_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "config");

export type ControlPlane = {
  schemaVersion: number;
  instance: { name: string; sourceLayer: string };
  intents: { warnAt: number; limit: number; renewalDays: number; renewedAt: string | null; _todo?: string };
  retention: { auditDays: number | null; logDays: number | null; _todo?: string };
  encryption: { keyRotationDays: number | null; _todo?: string };
  gateway: { ceilingPerMinute: number; voiceDebounceMs: number };
  commands: { deployment: string; _todo?: string };
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

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(join(CONFIG_DIR, file), "utf8")) as T;
}

export function loadControlPlane(): ControlPlane {
  return readJson<ControlPlane>("control-plane.json");
}

export function loadChannelDeclaration(): ChannelDeclaration {
  return readJson<ChannelDeclaration>("channels.json");
}

/**
 * Fails when `config/channels.json` drifts from the compiled event schema.
 * The schema is the authority; the config file must describe it exactly.
 */
export function assertChannelsMatchSchema(declaration = loadChannelDeclaration()) {
  const declared = declaration.destinations.map(destination => destination.id);
  const expected = [...logDestinations];

  if (declared.length !== expected.length || expected.some(id => !declared.includes(id))) {
    throw new Error(
      `config/channels.json does not declare the seven destinations exactly. Expected ${expected.join(", ")}; got ${declared.join(", ")}.`
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
 * Values the owner must still decide. Empty in development, fatal in production.
 */
export function undecidedSettings(plane = loadControlPlane()): string[] {
  const undecided: string[] = [];
  if (plane.intents.renewedAt === null) undecided.push("intents.renewedAt");
  if (plane.retention.auditDays === null) undecided.push("retention.auditDays");
  if (plane.retention.logDays === null) undecided.push("retention.logDays");
  if (plane.encryption.keyRotationDays === null) undecided.push("encryption.keyRotationDays");
  return undecided;
}
