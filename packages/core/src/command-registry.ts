import type { DiscordPermissionBit } from "./discord-permissions.js";
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
 *
 * The list is deliberately wider than the commands that exist today. A section
 * with nothing in it is still shown — with a count of zero and an explanation
 * rather than a fabricated row — because the alternative is worse in both
 * directions: an operator who cannot see that voice tools are coming assumes
 * they were never planned, and a section padded with placeholder commands is a
 * database full of switches nothing reads.
 */
export type CommandCategory =
  | "core"
  | "penalties"
  | "punishment-logs"
  | "channel-management"
  | "chat-tools"
  | "voice"
  | "role-management"
  | "special-roles"
  | "member-info"
  | "bot-tools"
  | "protection"
  | "levels"
  | "server-stats"
  | "profile";

export const commandCategories: readonly CommandCategory[] = [
  "core",
  "penalties",
  "punishment-logs",
  "channel-management",
  "chat-tools",
  "voice",
  "role-management",
  "special-roles",
  "member-info",
  "bot-tools",
  "protection",
  "levels",
  "server-stats",
  "profile"
] as const;

export const commandCategoryLabels: Record<CommandCategory, string> = {
  core: "الأوامر الأساسية",
  penalties: "العقوبات",
  "punishment-logs": "سجلات العقوبات",
  "channel-management": "إدارة القنوات",
  "chat-tools": "أدوات الشات",
  voice: "إدارة الصوت",
  "role-management": "إدارة الرتب",
  "special-roles": "الرتب الخاصة",
  "member-info": "معلومات السيرفر والأعضاء",
  "bot-tools": "أدوات البوت الخاص",
  protection: "الحماية",
  levels: "المستويات والخبرة",
  "server-stats": "إحصائيات السيرفر",
  profile: "الملف الشخصي"
};

export const commandCategoryDescriptions: Record<CommandCategory, string> = {
  core: "أوامر التعريف بالبوت والوصول إلى اللوحة.",
  penalties: "عقوبات الأعضاء: الحظر والطرد والإسكات والتحذيرات والأسماء.",
  "punishment-logs": "القناة التي تُسجَّل فيها العقوبات وتنبيهاتها.",
  "channel-management": "إنشاء القنوات وتعديلها وترتيبها.",
  "chat-tools": "إجراءات على القناة التي كُتب فيها الأمر: الحذف والإغلاق والوضع البطيء.",
  voice: "التحكم في الغرف الصوتية: النقل والكتم والصمّ.",
  "role-management": "إنشاء الرتب وإسنادها وسحبها.",
  "special-roles": "الرتب التفاعلية التي يمنحها الأعضاء لأنفسهم.",
  "member-info": "بطاقة العضو ومعلومات السيرفر.",
  "bot-tools": "أوامر تشغيلية خاصة ببوت AL AI نفسه.",
  protection: "مضاد التخريب والحجر الصحي وحدود الحماية.",
  levels: "نظام الخبرة والمستويات.",
  "server-stats": "عدادات الأعضاء والرسائل.",
  profile: "ملف العضو الشخصي وتخصيصه."
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
  /**
   * Discord's own permission bit for this command, shown to the operator as a
   * badge on the command's card.
   *
   * This is what replaced the tier dropdown. The dropdown asked the operator to
   * translate "moderator" into a set of people; this names the thing Discord
   * already enforces, so the requirement is stated once, in Discord's own terms,
   * and cannot drift from what the client shows in the role editor.
   *
   * Omitted for a command that every member may run.
   */
  requiredPermission?: DiscordPermissionBit;
};

/**
 * Discord refuses a timeout longer than 28 days.
 *
 * Declared before the registry because the timeout entry carries it as its
 * `maxDurationSeconds`, so the cap travels with the command rather than being
 * rediscovered by whichever layer happens to call Discord first.
 */
export const TIMEOUT_MAX_SECONDS = 28 * 24 * 60 * 60;

export const commandRegistry: readonly CommandDefinition[] = [
  /* ---------------- Core ----------------
   * The commands that explain AL AI and get the operator somewhere. None of
   * them changes a guild, so none declares a permission bit: every member may
   * ask what a command does, and refusing that would be a lockout with no
   * purpose behind it. `/settings` is the exception — it hands back a link into
   * a screen that re-checks its own authorization, but naming `MANAGE_GUILD`
   * here keeps the badge honest about who the link is for. */
  { name: "help", category: "core", description: "عرض قائمة الأوامر وشرح كل أمر", minimumTier: "moderator", target: "none" },
  { name: "commands", category: "core", description: "عرض الأوامر المتاحة لك في هذا السيرفر", minimumTier: "moderator", target: "none" },
  { name: "settings", category: "core", description: "الحصول على رابط إعدادات البوت في اللوحة", minimumTier: "admin", target: "none", requiredPermission: "MANAGE_GUILD" },
  { name: "dashboard", category: "core", description: "الحصول على رابط لوحة التحكم", minimumTier: "moderator", target: "none" },
  { name: "al-status", category: "core", description: "عرض حالة AL AI", minimumTier: "moderator", target: "none" },
  { name: "colors", category: "core", description: "عرض ألوان الرتب المتاحة في السيرفر", minimumTier: "moderator", target: "none" },

  /* ---------------- Penalties ----------------
   * Everything that records or applies a punishment. `warns` and `delwarn` are
   * records rather than Discord mutations, which is why they are logged by the
   * handler instead of by the gateway listener — see `onCommand`. */
  { name: "ban", category: "penalties", description: "حظر عضو", minimumTier: "admin", target: "member", supportsReason: true, supportsPurge: true, supportsNotify: true, requiredPermission: "BAN_MEMBERS" },
  { name: "unban", category: "penalties", description: "رفع الحظر", minimumTier: "admin", target: "member", supportsReason: true, supportsNotify: true, requiredPermission: "BAN_MEMBERS" },
  { name: "kick", category: "penalties", description: "طرد عضو", minimumTier: "admin", target: "member", supportsReason: true, supportsNotify: true, requiredPermission: "KICK_MEMBERS" },
  { name: "timeout", category: "penalties", description: "إسكات مؤقت", minimumTier: "moderator", target: "member", supportsReason: true, supportsPurge: true, supportsNotify: true, supportsDuration: true, maxDurationSeconds: TIMEOUT_MAX_SECONDS, requiredPermission: "MODERATE_MEMBERS" },
  { name: "untimeout", category: "penalties", description: "رفع الإسكات المؤقت عن عضو", minimumTier: "moderator", target: "member", supportsReason: true, supportsNotify: true, requiredPermission: "MODERATE_MEMBERS" },
  { name: "warn", category: "penalties", description: "تحذير عضو", minimumTier: "moderator", target: "member", supportsReason: true, requiresReason: true, supportsNotify: true, requiredPermission: "MODERATE_MEMBERS" },
  { name: "warns", category: "penalties", description: "عرض تحذيرات عضو", minimumTier: "moderator", target: "member", requiredPermission: "MODERATE_MEMBERS" },
  { name: "delwarn", category: "penalties", description: "حذف تحذير واحد بعينه", minimumTier: "moderator", target: "member", supportsReason: true, requiredPermission: "MODERATE_MEMBERS" },
  { name: "clearwarns", category: "penalties", description: "مسح كل تحذيرات عضو", minimumTier: "admin", target: "member", supportsReason: true, supportsNotify: true, requiredPermission: "MODERATE_MEMBERS" },
  { name: "setnick", category: "penalties", description: "تغيير الاسم المستعار لعضو", minimumTier: "moderator", target: "member", supportsReason: true, requiredPermission: "MANAGE_NICKNAMES" },

  /* ---------------- Chat tools ----------------
   * No member target, so no member hierarchy check applies. */
  { name: "clear", category: "chat-tools", description: "حذف عدد من الرسائل", minimumTier: "moderator", target: "none", requiredPermission: "MANAGE_MESSAGES" },
  { name: "lock", category: "chat-tools", description: "إغلاق القناة", minimumTier: "admin", target: "none", supportsReason: true, requiredPermission: "MANAGE_CHANNELS" },
  { name: "unlock", category: "chat-tools", description: "فتح القناة", minimumTier: "admin", target: "none", supportsReason: true, requiredPermission: "MANAGE_CHANNELS" },
  { name: "slowmode", category: "chat-tools", description: "ضبط الوضع البطيء", minimumTier: "moderator", target: "none", requiredPermission: "MANAGE_CHANNELS" }
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

export type CommandDuration = "permanent" | "5m" | "30m" | "1h" | "6h" | "12h" | "1d" | "3d" | "7d" | "14d" | "30d" | "custom";

export type DurationOption = { value: CommandDuration; label: string; seconds: number | null };

/**
 * `custom` is not a length, and it is not a second spelling of `permanent`.
 *
 * The two differ in exactly one place, and it is a place that matters: a preset
 * reason may carry a paired duration. Under `permanent` that pair still fills
 * the gap — the operator picked "سبام — ساعة", so an hour is applied. Under
 * `custom` it does not: the moderator is asked to write a duration every single
 * time, and a preset's suggestion is treated as a label rather than as a length.
 *
 * That is the whole difference, which is why it is worth having. A thirteenth
 * option meaning "the same as دائم" would be a control that changes nothing.
 */
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
  { value: "30d", label: "شهر", seconds: 30 * 24 * 60 * 60 },
  { value: "custom", label: "مخصص — يجب كتابة مدة عند الاستخدام", seconds: null }
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

/**
 * The duration a run will actually use, before it becomes a number of seconds.
 *
 * Three inputs compete, and the order between them is the whole point:
 *
 * 1. `custom` wins outright. The operator asked to be prompted every time, so
 *    neither a preset's paired length nor the stored default may fill the gap —
 *    that is what separates `custom` from `permanent`, and the only reason the
 *    option exists.
 * 2. Otherwise a preset reason's own duration wins, because "سبام — ساعة" is a
 *    more specific instruction than a command-wide default.
 * 3. Otherwise the default applies.
 *
 * Lives in core so the bot and its tests reach the same verdict from the same
 * configuration — the rule used to be half here and half in the bot's handler.
 */
export function resolveCommandDuration(config: Pick<CommandConfig, "defaultDuration" | "presetReasons">, reason: string): CommandDuration {
  if (config.defaultDuration === "custom") return "custom";
  return config.presetReasons.find(preset => preset.label === reason)?.duration ?? config.defaultDuration;
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
  /**
   * Members allowed to run this command, on top of everything else.
   *
   * The narrowest escape hatch there is, and the only one that binds to a person
   * rather than a role. It exists for the case a role cannot express: one
   * trusted helper, or the owner's second account, on a server whose roles are
   * otherwise meaningful and should not be reshuffled to admit one person.
   */
  allowedUserIds: string[];
  /**
   * Members barred from this command even when a role or a tier would allow it.
   *
   * A deny beats every allow, including `allowedUserIds` — so a person listed in
   * both lists is denied. That is what "denied" means; the alternative would make
   * the deny list unreliable exactly when it is needed most.
   */
  deniedUserIds: string[];
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
  /**
   * Whether the moderator may type a reason of their own.
   *
   * Only meaningful once preset reasons exist. With this off, a reason that
   * matches no preset is refused — which is how an operator gets a clean,
   * countable set of reasons without Discord's own choice list, whose entries
   * are frozen at registration time and so could never follow a setting.
   */
  allowCustomReason: boolean;
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
    allowedUserIds: [],
    deniedUserIds: [],
    cooldownSeconds: 0,
    autoDeleteResponseSeconds: 0,
    requireReason: Boolean(definition.requiresReason),
    // On by default, which is what the screen did before the switch existed: a
    // moderator could always type their own reason. A setting that silently
    // narrowed an existing behaviour would be a regression dressed as a default.
    allowCustomReason: true,
    defaultDuration: DEFAULT_COMMAND_DURATION,
    presetReasons: []
  };
}

export const MAX_CUSTOM_ROLES_PER_COMMAND = 25;
export const MAX_SCOPED_CHANNELS_PER_COMMAND = 25;
export const MAX_SCOPED_USERS_PER_COMMAND = 25;

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
  const allowCustomReason = definition.supportsReason
    ? input?.allowCustomReason === undefined
      ? base.allowCustomReason
      : Boolean(input.allowCustomReason)
    : true;
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
    allowedUserIds: normaliseIdList(input?.allowedUserIds, MAX_SCOPED_USERS_PER_COMMAND),
    deniedUserIds: normaliseIdList(input?.deniedUserIds, MAX_SCOPED_USERS_PER_COMMAND),
    cooldownSeconds: clampInteger(input?.cooldownSeconds, 0, MAX_COOLDOWN_SECONDS),
    autoDeleteResponseSeconds: clampInteger(input?.autoDeleteResponseSeconds, 0, MAX_AUTO_DELETE_SECONDS),
    requireReason,
    allowCustomReason,
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

/**
 * Truncates to a whole number and holds it inside `[min, max]`.
 *
 * Shared because the dashboard's command editor clamps the same two fields
 * (`cooldownSeconds` and `autoDeleteResponseSeconds`) against the same limits
 * exported just above. The view used to carry a second copy of this function,
 * which meant the two could drift: the constants came from here while the rule
 * that applies them did not, so an edit to one side would leave the editor and
 * the validator disagreeing about what a legal value is.
 *
 * `value` is `unknown` on purpose — it is fed straight from a request body or a
 * number input, and both can arrive as something that is not a number. Anything
 * unusable becomes `min` rather than `NaN`.
 */
export function clampInteger(value: unknown, min: number, max: number): number {
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
  /** The Discord permission the command asks of whoever runs it, if any. */
  requiredPermission?: DiscordPermissionBit;
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
    supportsDuration: Boolean(definition.supportsDuration),
    // Spread rather than assigned, so an absent permission stays absent instead
    // of becoming an explicit `undefined` key — `exactOptionalPropertyTypes`
    // treats those as different, and the dashboard reads the absence as "every
    // member may run this".
    ...(definition.requiredPermission ? { requiredPermission: definition.requiredPermission } : {})
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
  /** The member running the command. Checked against the user lists. */
  userId: string;
  roleIds: readonly string[];
  channelId: string;
};

export type ScopeVerdict =
  | { allowed: true }
  | { allowed: false; reason: "USER_DENIED" | "ROLE_DENIED" | "CHANNEL_DENIED" | "CHANNEL_NOT_ALLOWED" };

/**
 * Whether the member, role and channel scopes permit this run.
 *
 * Order matters and is deliberate: every deny is settled before any allow, so an
 * operator who barred a person cannot have them re-admitted by a role or a
 * channel rule. A member listed in both an allow and a deny is denied — that is
 * what "denied" means, and the alternative would make the deny list unreliable
 * exactly when it is needed most.
 *
 * The user check comes first because it is the narrowest statement the operator
 * can make: barring one person is a more specific intent than barring a role,
 * and the reason the operator is shown should name the specific thing they did.
 */
export function assessCommandScope(config: CommandConfig, input: CommandScopeInput): ScopeVerdict {
  if (config.deniedUserIds.includes(input.userId)) return { allowed: false, reason: "USER_DENIED" };
  if (input.roleIds.some(id => config.deniedRoleIds.includes(id))) return { allowed: false, reason: "ROLE_DENIED" };
  if (config.deniedChannelIds.includes(input.channelId)) return { allowed: false, reason: "CHANNEL_DENIED" };
  if (config.allowedChannelIds.length > 0 && !config.allowedChannelIds.includes(input.channelId)) {
    return { allowed: false, reason: "CHANNEL_NOT_ALLOWED" };
  }
  return { allowed: true };
}

export const scopeReasonMessages: Record<Exclude<ScopeVerdict, { allowed: true }>["reason"], string> = {
  USER_DENIED: "هذا الأمر ممنوع عليك تحديداً.",
  ROLE_DENIED: "إحدى رتبك مستثناة من هذا الأمر.",
  CHANNEL_DENIED: "هذا الأمر ممنوع في هذه القناة.",
  CHANNEL_NOT_ALLOWED: "هذا الأمر مسموح في قنوات محددة فقط."
};

/**
 * Whether the member is admitted by the allow-lists.
 *
 * Separate from `assessCommandScope` because it answers the opposite question:
 * the scopes above can only ever *refuse* someone the tier already admitted,
 * while these lists are the way in for somebody it did not. Keeping the two
 * apart is what lets the bot report "you are not permitted" separately from
 * "this command is barred here" — two different problems for the operator.
 */
export function isAdmittedByAllowList(config: CommandConfig, input: Pick<CommandScopeInput, "userId" | "roleIds">): boolean {
  return config.allowedUserIds.includes(input.userId) || input.roleIds.some(id => config.allowedRoleIds.includes(id));
}

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
