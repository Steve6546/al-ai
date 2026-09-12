import type { Tier } from "./permissions.js";

/**
 * Command registry for the dashboard's General Commands section.
 *
 * SCOPE: only commands named explicitly in the project directive are listed.
 * The directive names Ban, Unban, Kick, Timeout, Warn and Mute, and assigns
 * Warn/Timeout/Mute to Moderator while the rest require Admin. Commands for the
 * remaining modules are intentionally absent rather than invented — they are
 * added here once the owner specifies them.
 */

export type CommandModule = "Moderation" | "Auto-Roles" | "Logging" | "Voice" | "Info";

export type CommandDefinition = {
  name: string;
  module: CommandModule;
  description: string;
  minimumTier: Tier;
};

export const commandRegistry: readonly CommandDefinition[] = [
  { name: "ban", module: "Moderation", description: "حظر عضو", minimumTier: "admin" },
  { name: "unban", module: "Moderation", description: "رفع الحظر", minimumTier: "admin" },
  { name: "kick", module: "Moderation", description: "طرد عضو", minimumTier: "admin" },
  { name: "timeout", module: "Moderation", description: "إسكات مؤقت", minimumTier: "moderator" },
  { name: "mute", module: "Moderation", description: "كتم عضو", minimumTier: "moderator" },
  { name: "warn", module: "Moderation", description: "تحذير عضو", minimumTier: "moderator" }
] as const;

export const commandModules: readonly CommandModule[] = ["Moderation", "Auto-Roles", "Logging", "Voice", "Info"] as const;

const byName = new Map(commandRegistry.map(entry => [entry.name, entry]));

if (byName.size !== commandRegistry.length) throw new Error("Duplicate command name in the AL AI command registry.");

export function requireCommand(name: string) {
  const command = byName.get(name);
  if (!command) throw new Error(`Unregistered command: ${name}`);
  return command;
}

export function commandsForModule(module: CommandModule) {
  return commandRegistry.filter(entry => entry.module === module);
}

/** A command switch as the dashboard sees it. */
export type CommandFlag = CommandDefinition & { enabled: boolean };
