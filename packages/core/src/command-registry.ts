import type { Tier } from "./permissions.js";

/**
 * Command registry for the dashboard's General Commands section.
 *
 * SCOPE: only commands named explicitly in the project directive are listed.
 * The directive names Ban, Unban, Kick, Timeout, Warn, Clear, Lock, Unlock,
 * Slowmode, Warns and Clearwarns. Commands for the remaining modules are
 * intentionally absent rather than invented — they are added here once the
 * owner specifies them.
 *
 * `/mute` is deliberately gone. A voice mute is not what the directive means by
 * moderation: Discord's native timeout already silences a member everywhere,
 * including voice, and it expires on its own. Keeping a second, weaker command
 * with an overlapping name only invited the wrong one to be used.
 */

export type CommandModule = "Moderation" | "Auto-Roles" | "Logging" | "Voice" | "Info";

/**
 * What a command acts on. This drives the whole pipeline: a `member` command
 * runs the role-hierarchy check against a target, a `channel` command runs it
 * against the channel, and `none` skips it entirely.
 */
export type CommandTarget = "member" | "channel" | "none";

export type CommandDefinition = {
  name: string;
  module: CommandModule;
  description: string;
  /** The shipped default. A guild may override it with `allowedLevel`. */
  minimumTier: Tier;
  target: CommandTarget;
  /** A reason is mandatory before the command will run. */
  requiresReason?: boolean;
  /** The guild may configure how much of the target's recent history to purge. */
  supportsPurge?: boolean;
  /** The guild may configure a DM to the target when the action lands. */
  supportsNotify?: boolean;
};

export const commandRegistry: readonly CommandDefinition[] = [
  // Member actions.
  { name: "ban", module: "Moderation", description: "حظر عضو", minimumTier: "admin", target: "member", supportsPurge: true, supportsNotify: true },
  { name: "unban", module: "Moderation", description: "رفع الحظر", minimumTier: "admin", target: "member", supportsNotify: true },
  { name: "kick", module: "Moderation", description: "طرد عضو", minimumTier: "admin", target: "member", supportsNotify: true },
  { name: "timeout", module: "Moderation", description: "إسكات مؤقت", minimumTier: "moderator", target: "member", supportsPurge: true, supportsNotify: true },
  { name: "warn", module: "Moderation", description: "تحذير عضو", minimumTier: "moderator", target: "member", requiresReason: true, supportsNotify: true },
  { name: "warns", module: "Moderation", description: "عرض تحذيرات عضو", minimumTier: "moderator", target: "member" },
  { name: "clearwarns", module: "Moderation", description: "مسح تحذيرات عضو", minimumTier: "admin", target: "member", supportsNotify: true },

  // Channel actions. No member target, so no member hierarchy check applies.
  { name: "clear", module: "Moderation", description: "حذف عدد من الرسائل", minimumTier: "moderator", target: "none" },
  { name: "lock", module: "Moderation", description: "إغلاق القناة", minimumTier: "admin", target: "none" },
  { name: "unlock", module: "Moderation", description: "فتح القناة", minimumTier: "admin", target: "none" },
  { name: "slowmode", module: "Moderation", description: "ضبط الوضع البطيء", minimumTier: "moderator", target: "none" }
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

/* ------------------------------------------------------------------ *
 * Per-command configuration
 *
 * One object per command per guild. The defaults below are what an operator
 * gets without touching anything, and they are single-sourced here so the
 * dashboard, the BFF validator and the bot's runtime cannot disagree.
 * ------------------------------------------------------------------ */

/** Discord accepts 0–7 days of history to delete when banning. */
export const MAX_PURGE_DAYS = 7;

export type CommandConfig = {
  /** The command this configuration belongs to. Matches the registry name. */
  name: string;
  enabled: boolean;
  /** Overrides the registry's `minimumTier` for this guild. */
  allowedLevel: Tier;
  /** DM the target when an action is taken against them. */
  dmOnAction: boolean;
  /** Days of the target's recent messages to remove. 0 means "leave them". */
  deleteMessageDays: number;
  /**
   * Extra roles allowed to run this command, on top of the tier mapping.
   * An escape hatch for "let the trial mods use /warn" without making them
   * full moderators across every command.
   */
  customRoleIds: string[];
};

/** The configuration a command has before the operator changes anything. */
export function defaultCommandConfig(definition: CommandDefinition): CommandConfig {
  return {
    name: definition.name,
    enabled: true,
    allowedLevel: definition.minimumTier,
    // A DM is off by default: messaging a member is an external action, and the
    // owner should opt into it rather than discover it after the fact.
    dmOnAction: false,
    deleteMessageDays: 0,
    customRoleIds: []
  };
}

export const MAX_CUSTOM_ROLES_PER_COMMAND = 25;

/**
 * Normalises a stored or submitted configuration against its definition.
 *
 * Anything the command does not support is forced back to its default rather
 * than stored and ignored — a purge setting on `/warn` would be a control that
 * does nothing, which is worse than no control at all.
 */
export function normaliseCommandConfig(definition: CommandDefinition, input: Partial<CommandConfig> | null | undefined): CommandConfig {
  const base = defaultCommandConfig(definition);
  const days = Number.isFinite(input?.deleteMessageDays) ? Math.trunc(input!.deleteMessageDays!) : 0;

  return {
    name: definition.name,
    enabled: input?.enabled === undefined ? base.enabled : Boolean(input.enabled),
    allowedLevel: isAllowedLevel(input?.allowedLevel) ? input.allowedLevel : base.allowedLevel,
    dmOnAction: definition.supportsNotify && input?.dmOnAction ? true : false,
    deleteMessageDays: definition.supportsPurge ? Math.min(Math.max(days, 0), MAX_PURGE_DAYS) : 0,
    customRoleIds: normaliseRoleIdList(input?.customRoleIds)
  };
}

const SNOWFLAKE = /^\d{17,20}$/;
const TIERS: readonly Tier[] = ["owner", "admin", "moderator"];

function isAllowedLevel(value: unknown): value is Tier {
  return typeof value === "string" && (TIERS as readonly string[]).includes(value);
}

function normaliseRoleIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id): id is string => typeof id === "string" && SNOWFLAKE.test(id)))].slice(
    0,
    MAX_CUSTOM_ROLES_PER_COMMAND
  );
}

/** A command switch as the dashboard sees it: the definition plus this guild's overrides. */
export type CommandFlag = CommandConfig & {
  module: CommandModule;
  description: string;
  minimumTier: Tier;
  target: CommandTarget;
  supportsPurge: boolean;
  supportsNotify: boolean;
};

/** Joins the registry to a guild's stored configuration, filling every gap with a default. */
export function commandFlagsFor(configured: Map<string, Partial<CommandConfig>>): CommandFlag[] {
  return commandRegistry.map(definition => ({
    ...normaliseCommandConfig(definition, configured.get(definition.name)),
    module: definition.module,
    description: definition.description,
    minimumTier: definition.minimumTier,
    target: definition.target,
    supportsPurge: Boolean(definition.supportsPurge),
    supportsNotify: Boolean(definition.supportsNotify)
  }));
}
