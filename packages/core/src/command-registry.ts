import type { Tier } from "./permissions.js";

/**
 * The AL AI command registry.
 *
 * SCOPE: only commands the bot actually publishes. Every entry here must have a
 * builder in `buildModerationCommands` (or `buildStatusCommand`), and every
 * published command must be listed here — `apps/bot/test/commands.test.ts`
 * asserts both directions, because a registry entry with no builder is a
 * command nobody can reach, and a published command with no entry bypasses the
 * whole configuration pipeline.
 *
 * `/mute` is deliberately gone. A voice mute is not what moderation means here:
 * Discord's native timeout already silences a member everywhere, including
 * voice, and it expires on its own. Keeping a second, weaker command with an
 * overlapping name only invited the wrong one to be used.
 */

/**
 * How commands are grouped in the dashboard.
 *
 * This is the operator's mental model, not the code layout: what punishes a
 * member, what acts on the channel it is typed in, and everything else. It is
 * also the section order the screen renders in.
 */
export type CommandCategory = "moderation" | "channels" | "general";

export const commandCategories: readonly CommandCategory[] = ["moderation", "channels", "general"] as const;

export const commandCategoryLabels: Record<CommandCategory, string> = {
  moderation: "أوامر الإدارة",
  channels: "أوامر القنوات والشات",
  general: "أوامر عامة"
};

export const commandCategoryDescriptions: Record<CommandCategory, string> = {
  moderation: "عقوبات الأعضاء: الحظر والطرد والإسكات والتحذيرات.",
  channels: "إجراءات على القناة التي كُتب فيها الأمر: الحذف والإغلاق والوضع البطيء.",
  general: "أوامر معلوماتية لا تغيّر شيئاً في السيرفر."
};

/**
 * What a command acts on. This drives the whole pipeline: a `member` command
 * runs the role-hierarchy check against a target, a `channel` command runs it
 * against the channel, and `none` skips it entirely.
 */
export type CommandTarget = "member" | "channel" | "none";

export type CommandDefinition = {
  name: string;
  category: CommandCategory;
  description: string;
  /** The shipped default. A guild may override it with `allowedLevel`. */
  minimumTier: Tier;
  target: CommandTarget;
  /**
   * The command publishes a reason option, so the guild may decide whether that
   * reason is mandatory. A command with no reason option cannot require one.
   */
  supportsReason?: boolean;
  /**
   * The reason is mandatory before the command will run, unless the guild
   * overrides it. Only meaningful together with `supportsReason`.
   */
  requiresReason?: boolean;
  /** The guild may configure how much of the target's recent history to purge. */
  supportsPurge?: boolean;
  /** The guild may configure a DM to the target when the action lands. */
  supportsNotify?: boolean;
  /**
   * The command consumes a duration, so the guild may set a default one and pair
   * preset reasons with a length. Discord's own timeout is the only command with
   * a real duration: a ban is permanent and a warning is a record, so offering a
   * duration there would be a control that changes nothing.
   */
  supportsDuration?: boolean;
  /**
   * The longest duration this command can actually apply, when Discord imposes
   * one. Declared here so the cap travels with the command instead of being
   * rediscovered by whichever layer happens to call Discord first.
   */
  maxDurationSeconds?: number;
};

/**
 * Discord refuses a timeout longer than 28 days.
 *
 * Declared before the registry because the timeout entry carries it as its
 * `maxDurationSeconds`, so the cap travels with the command rather than being
 * rediscovered by whichever layer happens to call Discord first.
 */
export const TIMEOUT_MAX_SECONDS = 28 * 24 * 60 * 60;

export const commandRegistry: readonly CommandDefinition[] = [  // Member actions.
  { name: "ban", category: "moderation", description: "حظر عضو", minimumTier: "admin", target: "member", supportsReason: true, supportsPurge: true, supportsNotify: true },
  { name: "unban", category: "moderation", description: "رفع الحظر", minimumTier: "admin", target: "member", supportsReason: true, supportsNotify: true },
  { name: "kick", category: "moderation", description: "طرد عضو", minimumTier: "admin", target: "member", supportsReason: true, supportsNotify: true },
  { name: "timeout", category: "moderation", description: "إسكات مؤقت", minimumTier: "moderator", target: "member", supportsReason: true, supportsPurge: true, supportsNotify: true, supportsDuration: true, maxDurationSeconds: TIMEOUT_MAX_SECONDS },
  { name: "warn", category: "moderation", description: "تحذير عضو", minimumTier: "moderator", target: "member", supportsReason: true, requiresReason: true, supportsNotify: true },
  { name: "warns", category: "moderation", description: "عرض تحذيرات عضو", minimumTier: "moderator", target: "member" },
  { name: "clearwarns", category: "moderation", description: "مسح تحذيرات عضو", minimumTier: "admin", target: "member", supportsReason: true, supportsNotify: true },

  // Channel actions. No member target, so no member hierarchy check applies.
  { name: "clear", category: "channels", description: "حذف عدد من الرسائل", minimumTier: "moderator", target: "none" },
  { name: "lock", category: "channels", description: "إغلاق القناة", minimumTier: "admin", target: "none", supportsReason: true },
  { name: "unlock", category: "channels", description: "فتح القناة", minimumTier: "admin", target: "none", supportsReason: true },
  { name: "slowmode", category: "channels", description: "ضبط الوضع البطيء", minimumTier: "moderator", target: "none" },

  // General. `al-status` used to sit outside the registry entirely, which meant
  // it could not be switched off, cooled down or scoped like every other
  // command. It is an ordinary registry entry now and goes through the same gate.
  { name: "al-status", category: "general", description: "عرض حالة AL AI", minimumTier: "moderator", target: "none" }
] as const;

const byName = new Map(commandRegistry.map(entry => [entry.name, entry]));

if (byName.size !== commandRegistry.length) throw new Error("Duplicate command name in the AL AI command registry.");

export function requireCommand(name: string) {
  const command = byName.get(name);
  if (!command) throw new Error(`Unregistered command: ${name}`);
  return command;
}

/* ------------------------------------------------------------------ *
 * Durations
 *
 * One list, used by the dashboard's dropdown, by the BFF's validator and by the
 * bot when it resolves a default. `seconds` is null for "permanent", which is
 * deliberately not zero: zero would read as "no duration" and silently become a
 * one-second action.
 * ------------------------------------------------------------------ */

export type CommandDuration = "permanent" | "5m" | "30m" | "1h" | "6h" | "12h" | "1d" | "3d" | "7d" | "14d" | "30d";

export type DurationOption = { value: CommandDuration; label: string; seconds: number | null };

export const commandDurations: readonly DurationOption[] = [
  { value: "permanent", label: "دائم", seconds: null },
  { value: "5m", label: "5 دقائق", seconds: 5 * 60 },
  { value: "30m", label: "30 دقيقة", seconds: 30 * 60 },
  { value: "1h", label: "ساعة", seconds: 60 * 60 },
  { value: "6h", label: "6 ساعات", seconds: 6 * 60 * 60 },
  { value: "12h", label: "12 ساعة", seconds: 12 * 60 * 60 },
  { value: "1d", label: "يوم", seconds: 24 * 60 * 60 },
  { value: "3d", label: "3 أيام", seconds: 3 * 24 * 60 * 60 },
  { value: "7d", label: "أسبوع", seconds: 7 * 24 * 60 * 60 },
  { value: "14d", label: "أسبوعين", seconds: 14 * 24 * 60 * 60 },
  { value: "30d", label: "شهر", seconds: 30 * 24 * 60 * 60 }
] as const;

export const DEFAULT_COMMAND_DURATION: CommandDuration = "permanent";

const durationValues = new Set<string>(commandDurations.map(option => option.value));

export function isCommandDuration(value: unknown): value is CommandDuration {
  return typeof value === "string" && durationValues.has(value);
}

/**
 * The length a duration means, in seconds, or `null` for "permanent".
 *
 * Clamped to what the command can actually apply, so the dashboard, the BFF and
 * the bot agree on one number instead of each applying its own cap. This is the
 * only place a duration becomes a number.
 */
export function durationSeconds(duration: CommandDuration, options?: { maxSeconds?: number }): number | null {
  const option = commandDurations.find(entry => entry.value === duration);
  if (!option || option.seconds === null) return null;
  const max = options?.maxSeconds;
  return max === undefined ? option.seconds : Math.min(option.seconds, max);
}

/**
 * The seconds a command will apply for a stored duration.
 *
 * Returns `null` for a command with no duration, and for "permanent" — which is
 * deliberately not zero, because zero would read as "no duration at all" and
 * silently collapse into a one-second action.
 */
export function commandDurationSeconds(definition: CommandDefinition, duration: CommandDuration): number | null {
  if (!definition.supportsDuration) return null;
  return durationSeconds(duration, definition.maxDurationSeconds === undefined ? {} : { maxSeconds: definition.maxDurationSeconds });
}

/** Arabic label for a stored duration, falling back to the raw value. */
export function durationLabel(duration: string): string {
  return commandDurations.find(option => option.value === duration)?.label ?? duration;
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

/** Longest cooldown an operator may set: one hour. */
export const MAX_COOLDOWN_SECONDS = 60 * 60;

/** Longest auto-delete delay for the bot's own reply: ten minutes. */
export const MAX_AUTO_DELETE_SECONDS = 10 * 60;

/** How many ready-made reasons one command may carry. */
export const MAX_PRESET_REASONS = 25;

/** Longest preset reason label Discord will echo back in a choice. */
export const MAX_PRESET_REASON_LABEL = 90;

/**
 * A ready-made reason the operator can attach to a command.
 *
 * `duration` is only carried by commands that consume one (`supportsDuration`).
 * For every other command it is forced to `null` rather than stored and
 * ignored, which is the same rule `deleteMessageDays` follows.
 */
export type PresetReason = {
  id: string;
  label: string;
  duration: CommandDuration | null;
};

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
   * Roles allowed to run this command, on top of the tier mapping.
   *
   * An escape hatch for "let the trial mods use /warn" without making them full
   * moderators across every command.
   */
  allowedRoleIds: string[];
  /**
   * Roles barred from this command even when their tier would allow it.
   *
   * A deny beats every allow: it is the only way to carve an exception out of a
   * broad tier without splitting the tier in two.
   */
  deniedRoleIds: string[];
  /** When non-empty, the command runs only in these channels. */
  allowedChannelIds: string[];
  /** Channels where the command never runs. */
  deniedChannelIds: string[];
  /** Seconds a member must wait between two runs of this command. 0 = no wait. */
  cooldownSeconds: number;
  /**
   * Seconds before the bot removes its own reply. 0 = keep it.
   *
   * Only the bot's reply is affected: a slash command leaves no command message
   * of its own for AL AI to delete.
   */
  autoDeleteResponseSeconds: number;
  /** A reason is mandatory, overriding the registry's shipped default. */
  requireReason: boolean;
  /** The duration applied when the operator does not supply one. */
  defaultDuration: CommandDuration;
  /** Ready-made reasons offered in Discord for this command. */
  presetReasons: PresetReason[];
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
    allowedRoleIds: [],
    deniedRoleIds: [],
    allowedChannelIds: [],
    deniedChannelIds: [],
    cooldownSeconds: 0,
    autoDeleteResponseSeconds: 0,
    requireReason: Boolean(definition.requiresReason),
    defaultDuration: DEFAULT_COMMAND_DURATION,
    presetReasons: []
  };
}

export const MAX_CUSTOM_ROLES_PER_COMMAND = 25;
export const MAX_SCOPED_CHANNELS_PER_COMMAND = 25;

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

  // A reason can only be demanded where a reason option exists, and a duration
  // only where one can be applied. Both are dropped for every other command.
  const requireReason = definition.supportsReason ? (input?.requireReason === undefined ? base.requireReason : Boolean(input.requireReason)) : false;
  const defaultDuration = definition.supportsDuration
    ? normaliseDuration(input?.defaultDuration, definition)
    : DEFAULT_COMMAND_DURATION;

  return {
    name: definition.name,
    enabled: input?.enabled === undefined ? base.enabled : Boolean(input.enabled),
    allowedLevel: isAllowedLevel(input?.allowedLevel) ? input.allowedLevel : base.allowedLevel,
    dmOnAction: definition.supportsNotify && input?.dmOnAction ? true : false,
    deleteMessageDays: definition.supportsPurge ? Math.min(Math.max(days, 0), MAX_PURGE_DAYS) : 0,
    allowedRoleIds: normaliseIdList(input?.allowedRoleIds, MAX_CUSTOM_ROLES_PER_COMMAND),
    deniedRoleIds: normaliseIdList(input?.deniedRoleIds, MAX_CUSTOM_ROLES_PER_COMMAND),
    allowedChannelIds: normaliseIdList(input?.allowedChannelIds, MAX_SCOPED_CHANNELS_PER_COMMAND),
    deniedChannelIds: normaliseIdList(input?.deniedChannelIds, MAX_SCOPED_CHANNELS_PER_COMMAND),
    cooldownSeconds: clampInteger(input?.cooldownSeconds, 0, MAX_COOLDOWN_SECONDS),
    autoDeleteResponseSeconds: clampInteger(input?.autoDeleteResponseSeconds, 0, MAX_AUTO_DELETE_SECONDS),
    requireReason,
    defaultDuration,
    presetReasons: definition.supportsReason ? normalisePresetReasons(input?.presetReasons, definition) : []
  };
}

const SNOWFLAKE = /^\d{17,20}$/;
const TIERS: readonly Tier[] = ["owner", "admin", "moderator"];

function isAllowedLevel(value: unknown): value is Tier {
  return typeof value === "string" && (TIERS as readonly string[]).includes(value);
}

function normaliseIdList(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id): id is string => typeof id === "string" && SNOWFLAKE.test(id)))].slice(0, limit);
}

function clampInteger(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

/**
 * A duration the command can actually apply.
 *
 * The stored value is kept as the operator chose it — "شهر" stays "شهر" rather
 * than being snapped down to the nearest option under Discord's cap, which would
 * silently turn a month into a fortnight. The cap is applied where the duration
 * becomes seconds (`commandDurationSeconds`), in this same module, so both sides
 * still agree on the number Discord receives.
 */
function normaliseDuration(value: unknown, definition: CommandDefinition): CommandDuration {
  if (!isCommandDuration(value)) return DEFAULT_COMMAND_DURATION;
  if (!definition.supportsDuration) return DEFAULT_COMMAND_DURATION;
  return value;
}

/**
 * Preset reasons, cleaned and capped.
 *
 * The id is what Discord echoes back when the operator picks a suggestion, so a
 * missing or duplicated id would make two different reasons indistinguishable.
 * Ids are therefore generated here when absent and de-duplicated, and a reason
 * whose label is empty is dropped rather than offered as a blank choice.
 */
function normalisePresetReasons(value: unknown, definition: CommandDefinition): PresetReason[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: PresetReason[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const label = typeof (entry as PresetReason).label === "string" ? (entry as PresetReason).label.trim() : "";
    if (!label) continue;
    const rawId = (entry as PresetReason).id;
    let id = typeof rawId === "string" && rawId.trim() ? rawId.trim().slice(0, 64) : "";
    if (!id || seen.has(id)) id = `preset-${result.length + 1}-${label.slice(0, 16)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const duration = definition.supportsDuration && isCommandDuration((entry as PresetReason).duration)
      ? normaliseDuration((entry as PresetReason).duration, definition)
      : null;
    result.push({ id, label: label.slice(0, MAX_PRESET_REASON_LABEL), duration });
    if (result.length >= MAX_PRESET_REASONS) break;
  }
  return result;
}

/** A command switch as the dashboard sees it: the definition plus this guild's overrides. */
export type CommandFlag = CommandConfig & {
  category: CommandCategory;
  description: string;
  minimumTier: Tier;
  target: CommandTarget;
  supportsReason: boolean;
  supportsPurge: boolean;
  supportsNotify: boolean;
  supportsDuration: boolean;
};

/** Joins the registry to a guild's stored configuration, filling every gap with a default. */
export function commandFlagsFor(configured: Map<string, Partial<CommandConfig>>): CommandFlag[] {
  return commandRegistry.map(definition => ({
    ...normaliseCommandConfig(definition, configured.get(definition.name)),
    category: definition.category,
    description: definition.description,
    minimumTier: definition.minimumTier,
    target: definition.target,
    supportsReason: Boolean(definition.supportsReason),
    supportsPurge: Boolean(definition.supportsPurge),
    supportsNotify: Boolean(definition.supportsNotify),
    supportsDuration: Boolean(definition.supportsDuration)
  }));
}

/* ------------------------------------------------------------------ *
 * Runtime evaluation
 *
 * The decisions below are pure so the dashboard, the BFF and the bot all reach
 * the same verdict from the same configuration — and so each one can be tested
 * without a Discord connection.
 * ------------------------------------------------------------------ */

export type CommandScopeInput = {
  roleIds: readonly string[];
  channelId: string;
};

export type ScopeVerdict = { allowed: true } | { allowed: false; reason: "ROLE_DENIED" | "CHANNEL_DENIED" | "CHANNEL_NOT_ALLOWED" };

/**
 * Whether the channel and role scopes permit this run.
 *
 * Order matters and is deliberate: a deny always beats an allow, so an operator
 * who barred a role cannot have it re-admitted by a channel rule. A member
 * holding both an allowed and a denied role is denied — that is what "denied"
 * means, and the alternative would make the deny list unreliable exactly when it
 * is needed most.
 */
export function assessCommandScope(config: CommandConfig, input: CommandScopeInput): ScopeVerdict {
  if (input.roleIds.some(id => config.deniedRoleIds.includes(id))) return { allowed: false, reason: "ROLE_DENIED" };
  if (config.deniedChannelIds.includes(input.channelId)) return { allowed: false, reason: "CHANNEL_DENIED" };
  if (config.allowedChannelIds.length > 0 && !config.allowedChannelIds.includes(input.channelId)) {
    return { allowed: false, reason: "CHANNEL_NOT_ALLOWED" };
  }
  return { allowed: true };
}

export const scopeReasonMessages: Record<Exclude<ScopeVerdict, { allowed: true }>["reason"], string> = {
  ROLE_DENIED: "إحدى رتبك مستثناة من هذا الأمر.",
  CHANNEL_DENIED: "هذا الأمر ممنوع في هذه القناة.",
  CHANNEL_NOT_ALLOWED: "هذا الأمر مسموح في قنوات محددة فقط."
};

/**
 * A cooldown tracker keyed by guild, command and member.
 *
 * Kept in memory on purpose: a cooldown is a courtesy against spam, not a
 * security boundary, and a restart clearing it costs nothing. Storing it would
 * add a write on every command for a rule that lasts seconds.
 */
export class CommandCooldowns {
  private readonly until = new Map<string, number>();

  /** Seconds still to wait, or 0 when the member may run the command now. */
  remainingSeconds(key: string, now: number): number {
    const expiry = this.until.get(key);
    if (expiry === undefined) return 0;
    if (expiry <= now) {
      this.until.delete(key);
      return 0;
    }
    return Math.ceil((expiry - now) / 1000);
  }

  /** Records a run. A cooldown of 0 clears any existing wait instead of setting one. */
  start(key: string, seconds: number, now: number): void {
    if (seconds <= 0) this.until.delete(key);
    else this.until.set(key, now + seconds * 1000);
  }

  get size(): number {
    return this.until.size;
  }
}

/** The key a cooldown is tracked under. */
export function cooldownKey(guildId: string, commandName: string, userId: string): string {
  return `${guildId}:${commandName}:${userId}`;
}
