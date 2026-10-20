import { normaliseSnowflake } from "./snowflake.js";

/* ------------------------------------------------------------------ *
 * Levels system — XP math
 * ------------------------------------------------------------------ */

/**
 * The XP a member needs to *reach* `level`, per the system's one formula:
 * `(level × 25)²`. Level 1 = 625, level 5 = 15 625, level 10 = 62 500,
 * level 20 = 250 000. Every other number in the feature — the inverse, the
 * progress bar, the formula card on the screen — is derived from this, so the
 * coefficient lives in one place only.
 */
export const LEVEL_XP_STEP = 25;

/** The maximum level the system will record when no guild cap is set. */
export const MAX_LEVEL = 100;

/** The hard ceiling any guild cap may reach, and what "unlimited" means. */
export const MAX_LEVEL_CAP = 1000;

export const UNLIMITED_LEVEL_CAP = 0;

export function xpForLevel(level: number): number {
  const safe = Math.max(0, Math.floor(level));
  return (safe * LEVEL_XP_STEP) ** 2;
}

/**
 * The inverse: the whole level a member is on given their total XP.
 * `floor(√xp / 25)` — an XP total below 625 is level 0.
 *
 * Product policy (single source of truth): levels cap at `cap` — the guild's
 * own setting (`maxLevelCap`, 0 = unlimited up to MAX_LEVEL_CAP) or the
 * shipped MAX_LEVEL. The formula stays pure below the cap, but a member
 * beyond it reads as capped everywhere — bot notifications, leaderboard,
 * sync and the screens — so no surface can ever disagree about a level. At
 * the cap the member simply stops levelling up.
 */
export function levelFromXp(xp: number, cap: number = MAX_LEVEL): number {
  const safe = Math.max(0, Math.floor(xp));
  const ceiling = Math.max(1, Math.floor(cap) || MAX_LEVEL_CAP);
  return Math.min(ceiling, Math.floor(Math.sqrt(safe) / LEVEL_XP_STEP));
}

/** How far along the current level a member is, for the progress bar. */
export type LevelProgress = {
  level: number;
  /** XP accumulated inside the current level, above its base. */
  xpInLevel: number;
  /** XP needed to move from this level to the next. */
  xpForNextLevel: number;
  /** 0–100, rounded to one decimal. */
  percent: number;
  /** Total XP at the next level's threshold. */
  nextLevelXp: number;
};

export function levelProgress(xp: number, cap: number = MAX_LEVEL): LevelProgress {
  const total = Math.max(0, Math.floor(xp));
  const level = levelFromXp(total, cap);
  const baseXp = xpForLevel(level);
  // At the cap the bar reads full rather than dividing by zero.
  const nextLevel = Math.min(level + 1, Math.max(1, Math.floor(cap) || MAX_LEVEL_CAP));
  const targetXp = xpForLevel(nextLevel);
  const span = Math.max(1, targetXp - baseXp);
  const xpInLevel = Math.min(total - baseXp, span);
  return {
    level,
    xpInLevel: Math.max(0, xpInLevel),
    xpForNextLevel: span,
    percent: Math.min(100, Math.round((Math.max(0, xpInLevel) / span) * 1000) / 10),
    nextLevelXp: targetXp
  };
}

/* ------------------------------------------------------------------ *
 * Levels system — settings
 * ------------------------------------------------------------------ */

/**
 * Where a level-up notification goes. `"same_channel"` answers in the channel
 * the XP was earned in, `"custom_channel"` in `notifyChannelId`, `"send_dm"`
 * in the member's DMs. The same destination serves text and voice level-ups;
 * the two message templates are what differ.
 */
export type LevelNotifyMode = "same_channel" | "custom_channel" | "send_dm";

export type LevelSettings = {
  enabled: boolean;
  textXpEnabled: boolean;
  voiceXpEnabled: boolean;
  /** XP per qualifying message: a random draw within [textXpMin, textXpMax]. */
  textXpMin: number;
  textXpMax: number;
  /** XP per qualifying voice minute: a random draw within the same range rule. */
  voiceXpMin: number;
  voiceXpMax: number;
  /** 0 = unlimited (up to MAX_LEVEL_CAP); otherwise the guild's own ceiling. */
  maxLevelCap: number;
  /** Zero out a member's XP when they leave the guild. */
  resetOnLeave: boolean;
  /** Seconds between two XP grants for the same author. 10–3600. */
  textCooldownSeconds: number;
  /** Voice channel members required before any of them earns XP. 1–10. */
  voiceMinMembers: number;
  ignoreMuted: boolean;
  ignoreDeafened: boolean;
  ignoreAfk: boolean;
  notifyLevelUp: boolean;
  notifyMode: LevelNotifyMode;
  /** Only meaningful when notifyMode is "custom_channel". */
  notifyChannelId: string | null;
  /** Attach a rich rank card (avatar + progress) to level-up notifications. */
  rankCardEnabled: boolean;
  textLevelUpMessage: string;
  voiceLevelUpMessage: string;
  /** Keep every level role earned so far, instead of only the highest. */
  roleStacking: boolean;
  /** XP multipliers held by members carrying certain roles. */
  roleMultipliers: LevelMultiplier[];
  /** XP multipliers earned inside certain channels. */
  channelMultipliers: LevelMultiplier[];
  ignoredTextChannelIds: string[];
  ignoredVoiceChannelIds: string[];
  ignoredRoleIds: string[];
};

/** One multiplier rule: a role or channel id and its XP factor. */
export type LevelMultiplier = { id: string; multiplier: number };

export const MULTIPLIER_FLOOR = 0.1;
export const MULTIPLIER_CEILING = 10;
export const MAX_MULTIPLIERS = 50;

export const DEFAULT_LEVEL_SETTINGS: LevelSettings = {
  enabled: false,
  textXpEnabled: true,
  voiceXpEnabled: true,
  textXpMin: 15,
  textXpMax: 25,
  voiceXpMin: 3,
  voiceXpMax: 3,
  maxLevelCap: MAX_LEVEL,
  resetOnLeave: false,
  textCooldownSeconds: 120,
  voiceMinMembers: 2,
  ignoreMuted: true,
  ignoreDeafened: true,
  ignoreAfk: true,
  notifyLevelUp: false,
  notifyMode: "same_channel",
  notifyChannelId: null,
  rankCardEnabled: false,
  textLevelUpMessage: "🎉 مبروك {user}! وصلت للمستوى **{level}**!",
  voiceLevelUpMessage: "🎤 مبروك {user}! وصلت للمستوى الصوتي **{level}**!",
  roleStacking: false,
  roleMultipliers: [],
  channelMultipliers: [],
  ignoredTextChannelIds: [],
  ignoredVoiceChannelIds: [],
  ignoredRoleIds: []
};

export const LEVEL_NOTIFY_MODES: readonly LevelNotifyMode[] = ["same_channel", "custom_channel", "send_dm"];

/** Tokens a level-up template may carry, offered as quick buttons on the screen. */
export const LEVEL_MESSAGE_TOKENS = ["{user}", "{level}", "{xp}", "{server}"] as const;

const MESSAGE_CEILING = 500;

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.round(numeric)));
}

/** Multiplier lists: snowflake ids, factors clamped to [0.1, 10], deduped. */
export function normaliseLevelMultipliers(value: unknown): LevelMultiplier[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const rules: LevelMultiplier[] = [];
  for (const entry of value) {
    const source = (entry ?? {}) as Partial<LevelMultiplier>;
    const id = normaliseSnowflake(source.id);
    if (!id || seen.has(id)) continue;
    const numeric = typeof source.multiplier === "number" ? source.multiplier : Number(source.multiplier);
    if (!Number.isFinite(numeric)) continue;
    seen.add(id);
    rules.push({
      id,
      multiplier: Math.min(MULTIPLIER_CEILING, Math.max(MULTIPLIER_FLOOR, Math.round(numeric * 100) / 100))
    });
    if (rules.length >= MAX_MULTIPLIERS) break;
  }
  return rules;
}

/**
 * The XP a member actually earns: the base draw multiplied by every matching
 * rule — roles the member carries and the channel the XP was earned in.
 * Multipliers compound (two ×2 rules make ×4), and the floor keeps whole XP.
 */
export function applyXpMultipliers(
  amount: number,
  roleRules: LevelMultiplier[],
  channelRules: LevelMultiplier[],
  facts: { roleIds: string[] | null; channelId: string | null }
): number {
  let factor = 1;
  for (const rule of roleRules) {
    if (facts.roleIds?.includes(rule.id)) factor *= rule.multiplier;
  }
  for (const rule of channelRules) {
    if (facts.channelId && rule.id === facts.channelId) factor *= rule.multiplier;
  }
  return Math.max(0, Math.floor(amount * factor));
}

function normaliseMessage(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  return trimmed.slice(0, MESSAGE_CEILING);
}

function normaliseSnowflakeList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const entry of value) {
    const id = normaliseSnowflake(entry);
    if (id) seen.add(id);
  }
  return [...seen];
}

/**
 * Normalised, not trusted — the same helper the BFF writes through and the bot
 * reads through. A list entry that is not a snowflake is dropped rather than
 * kept, so a half-typed id can never sit in an ignore list pretending to match
 * something; numbers are clamped to the ranges the screens offer, so a
 * hand-crafted PUT cannot store a cooldown the bot would behave differently on.
 */
export function normaliseLevelSettings(value: unknown): LevelSettings {
  const source = (value ?? {}) as Partial<LevelSettings>;
  const mode = LEVEL_NOTIFY_MODES.includes(source.notifyMode as LevelNotifyMode)
    ? (source.notifyMode as LevelNotifyMode)
    : DEFAULT_LEVEL_SETTINGS.notifyMode;
  // Text draws keep min ≤ max (a crossed pair is swapped, not rejected), and
  // the level cap: 0 means "unlimited" up to the hard ceiling, anything else
  // clamps to a sane range.
  const rawCap = clampInt(source.maxLevelCap, 0, MAX_LEVEL_CAP, DEFAULT_LEVEL_SETTINGS.maxLevelCap);
  const maxLevelCap = rawCap === UNLIMITED_LEVEL_CAP ? UNLIMITED_LEVEL_CAP : Math.max(10, rawCap);
  let textXpMin = clampInt(source.textXpMin, 1, 100, DEFAULT_LEVEL_SETTINGS.textXpMin);
  let textXpMax = clampInt(source.textXpMax, 1, 100, DEFAULT_LEVEL_SETTINGS.textXpMax);
  if (textXpMin > textXpMax) [textXpMin, textXpMax] = [textXpMax, textXpMin];
  let voiceXpMin = clampInt(source.voiceXpMin, 0, 100, DEFAULT_LEVEL_SETTINGS.voiceXpMin);
  let voiceXpMax = clampInt(source.voiceXpMax, 0, 100, DEFAULT_LEVEL_SETTINGS.voiceXpMax);
  if (voiceXpMin > voiceXpMax) [voiceXpMin, voiceXpMax] = [voiceXpMax, voiceXpMin];
  return {
    enabled: source.enabled === true,
    textXpEnabled: source.textXpEnabled !== false,
    voiceXpEnabled: source.voiceXpEnabled !== false,
    textXpMin,
    textXpMax,
    voiceXpMin,
    voiceXpMax,
    maxLevelCap,
    resetOnLeave: source.resetOnLeave === true,
    textCooldownSeconds: clampInt(source.textCooldownSeconds, 10, 3600, DEFAULT_LEVEL_SETTINGS.textCooldownSeconds),
    voiceMinMembers: clampInt(source.voiceMinMembers, 1, 10, DEFAULT_LEVEL_SETTINGS.voiceMinMembers),
    ignoreMuted: source.ignoreMuted !== false,
    ignoreDeafened: source.ignoreDeafened !== false,
    ignoreAfk: source.ignoreAfk !== false,
    notifyLevelUp: source.notifyLevelUp === true,
    notifyMode: mode,
    notifyChannelId: mode === "custom_channel" ? normaliseSnowflake(source.notifyChannelId) : null,
    rankCardEnabled: source.rankCardEnabled === true,
    textLevelUpMessage: normaliseMessage(source.textLevelUpMessage, DEFAULT_LEVEL_SETTINGS.textLevelUpMessage),
    voiceLevelUpMessage: normaliseMessage(source.voiceLevelUpMessage, DEFAULT_LEVEL_SETTINGS.voiceLevelUpMessage),
    roleStacking: source.roleStacking === true,
    roleMultipliers: normaliseLevelMultipliers(source.roleMultipliers),
    channelMultipliers: normaliseLevelMultipliers(source.channelMultipliers),
    ignoredTextChannelIds: normaliseSnowflakeList(source.ignoredTextChannelIds),
    ignoredVoiceChannelIds: normaliseSnowflakeList(source.ignoredVoiceChannelIds),
    ignoredRoleIds: normaliseSnowflakeList(source.ignoredRoleIds)
  };
}

/* ------------------------------------------------------------------ *
 * Levels system — role rewards
 * ------------------------------------------------------------------ */

/** Which track a reward belongs to. `"dual"` rewards need both levels at once. */
export type LevelRewardKind = "text" | "voice" | "dual";

export type LevelRoleReward = {
  id: string;
  kind: LevelRewardKind;
  /** For "dual" rewards this is the required *text* level. */
  level: number;
  /** For "dual" rewards, the required voice level. */
  voiceLevel: number | null;
  roleId: string;
  /**
   * Per-rule stacking: while satisfied, the role stays on the member even
   * without the guild-wide stacking switch — the modal's "keep previous
   * ranks" choice, stored per rule instead of only globally.
   */
  alwaysKeep: boolean;
};

/** The hard ceiling on a reward rule's level, regardless of any guild cap. */
export const MAX_REWARD_LEVEL = 500;

export function normaliseLevelRewardKind(value: unknown): LevelRewardKind {
  return value === "voice" || value === "dual" ? value : "text";
}

/** A single reward row normalised from storage or a request body. */
export function normaliseLevelReward(value: unknown): LevelRoleReward | null {
  const source = (value ?? {}) as Partial<LevelRoleReward>;
  const roleId = normaliseSnowflake(source.roleId);
  if (!roleId) return null;
  const kind = normaliseLevelRewardKind(source.kind);
  const level = clampInt(source.level, 1, MAX_REWARD_LEVEL, 1);
  return {
    id: typeof source.id === "string" && source.id ? source.id : "",
    kind,
    level,
    voiceLevel: kind === "dual" ? clampInt(source.voiceLevel, 1, MAX_REWARD_LEVEL, 1) : null,
    roleId,
    alwaysKeep: source.alwaysKeep === true
  };
}

export function normaliseLevelRewardList(value: unknown): LevelRoleReward[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const rewards: LevelRoleReward[] = [];
  for (const entry of value) {
    const reward = normaliseLevelReward(entry);
    if (!reward?.roleId) continue;
    const key = `${reward.kind}:${reward.level}:${reward.voiceLevel ?? ""}:${reward.roleId}`;
    // A duplicate rule is inert repetition, not a second grant.
    if (seen.has(key)) continue;
    seen.add(key);
    rewards.push(reward);
  }
  return rewards;
}

/**
 * Fills a level-up template's tokens. Unknown tokens are left as the operator
 * typed them — a template is prose, and silently eating text the operator
 * wrote would be worse than showing a token nobody substituted.
 */
export function renderLevelMessage(
  template: string,
  values: { user: string; level: number; xp: number; server: string }
): string {
  return template
    .replaceAll("{user}", values.user)
    .replaceAll("{level}", String(values.level))
    .replaceAll("{xp}", String(values.xp))
    .replaceAll("{server}", values.server);
}

/**
 * For every reward role a member's levels satisfy, which rule kinds back it.
 *
 * The reconciliation contract in one place: a role is "should have" while at
 * least one source backs it, so a member who loses their dual qualification
 * keeps a role their text level still earns — and the UI can show those
 * sources instead of implying that one lost rule deletes the role. Duplicate
 * role ids across rules collapse into one entry.
 */
export function roleSourcesFor(
  rewards: LevelRoleReward[],
  textLevel: number,
  voiceLevel: number
): Map<string, LevelRewardKind[]> {
  const sources = new Map<string, LevelRewardKind[]>();
  for (const reward of rewards) {
    const satisfied =
      reward.kind === "dual"
        ? textLevel >= reward.level && voiceLevel >= (reward.voiceLevel ?? 0)
        : reward.kind === "voice"
          ? voiceLevel >= reward.level
          : textLevel >= reward.level;
    if (!satisfied) continue;
    const kinds = sources.get(reward.roleId) ?? [];
    if (!kinds.includes(reward.kind)) kinds.push(reward.kind);
    sources.set(reward.roleId, kinds);
  }
  return sources;
}

/** A configuration problem the screens surface, derived from real data. */
export type LevelConfigProblem = {
  code: "reward-role-missing" | "notify-channel-missing";
  message: string;
};

/**
 * Detects stored configuration that can no longer work, so the screens show
 * warnings that come from data rather than guesses. `grantableRoleIds` is the
 * role list already filtered to what the bot can grant; `channelIds` the
 * guild's visible channels.
 */
export function detectLevelConfigProblems(
  settings: LevelSettings,
  rewards: LevelRoleReward[],
  grantableRoleIds: ReadonlySet<string>,
  channelIds: ReadonlySet<string>
): LevelConfigProblem[] {
  const problems: LevelConfigProblem[] = [];
  const effectiveCap = settings.maxLevelCap === UNLIMITED_LEVEL_CAP ? MAX_LEVEL_CAP : settings.maxLevelCap;
  for (const reward of rewards) {
    if (!grantableRoleIds.has(reward.roleId)) {
      problems.push({
        code: "reward-role-missing",
        message: `قاعدة المستوى ${reward.level} تشير إلى رتبة محذوفة، أو مُدارة، أو فوق أعلى رتبة البوت — لن تُطبَّق حتى تُعدَّل.`
      });
    }
    if (reward.level > effectiveCap) {
      problems.push({
        code: "reward-role-missing",
        message: `قاعدة المستوى ${reward.level} أعلى من سقف المستوى الحالي (${effectiveCap}) — لن تُمنح أبداً حتى يُرفع السقف.`
      });
    }
  }
  if (settings.notifyMode === "custom_channel") {
    if (!settings.notifyChannelId || !channelIds.has(settings.notifyChannelId)) {
      problems.push({
        code: "notify-channel-missing",
        message: "قناة إشعارات الترقية محذوفة أو غير ظاهرة للبوت — لن يصل أي إشعار حتى تُختار قناة أخرى."
      });
    }
  }
  return problems;
}
