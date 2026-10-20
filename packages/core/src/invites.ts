import { normaliseSnowflake } from "./snowflake.js";

/* ------------------------------------------------------------------ *
 * Invites (referrals) system — settings
 * ------------------------------------------------------------------ */

/**
 * The invites module's per-guild configuration.
 *
 * The module answers one question per join — "who brought this member in, and
 * does it count?" — and this settings shape decides only the policy around
 * that question: what counts as a fake account, whether milestone roles survive
 * a net drop, and the prose the log embeds carry.
 */
export type InviteSettings = {
  enabled: boolean;
  /**
   * An account younger than this many days is recorded as fake: it is logged
   * and counted in the inviter's fakes column, but never in their net. 0 keeps
   * every account.
   */
  fakeAccountDays: number;
  /**
   * When an inviter's net drops below a milestone they hold, keep the role
   * anyway. Off by default: the board stays honest — a milestone is a level,
   * not a title for life — and the operator opts into leniency.
   */
  keepRolesOnLeave: boolean;
  /**
   * A member who arrives through their own invite earns nothing. Always
   * enforced at runtime; the switch only decides whether the attempt is logged
   * at all — an operator hunting alts wants the log line, one drowning in them
   * turns it off.
   */
  logSelfInvites: boolean;
  logJoins: boolean;
  logLeaves: boolean;
  logMilestones: boolean;
  joinMessage: string;
  leaveMessage: string;
  milestoneMessage: string;
  /** Reward roles granted when an inviter's net reaches each threshold. */
  milestoneRoles: InviteMilestone[];
};

/** One milestone rule: a net-invites threshold and the role it grants. */
export type InviteMilestone = { id: string; net: number; roleId: string };

/** The shipped defaults: the module exists but is off until the operator arms it. */
export const DEFAULT_INVITE_SETTINGS: InviteSettings = {
  enabled: false,
  fakeAccountDays: 3,
  keepRolesOnLeave: false,
  logSelfInvites: true,
  logJoins: true,
  logLeaves: true,
  logMilestones: true,
  joinMessage:
    "👋 انضم {user} إلى السيرفر.\nعمر الحساب: {user.age}\nصاحب الدعوة: {inviter} — الكود: {invite.code}\nدعوات الداعي: {inviter.net} صافي ({inviter.total} كلي، {inviter.leaves} مغادرون، {inviter.fakes} وهميون)",
  leaveMessage:
    "🚪 غادر {user} السيرفر.\nكان قد دعاه {inviter}.\nتم خصم نقطة من الداعي، مجموع دعواته الحالي: {inviter.net}",
  milestoneMessage: "🎉 وصل {inviter} إلى {inviter.net} إحالة صافية وحصل على رتبة جديدة!",
  milestoneRoles: []
};

/** An account age above this is meaningless — clamped so a bad save cannot store a year. */
export const MAX_FAKE_ACCOUNT_DAYS = 30;

/** How many milestone rules one guild may carry. */
export const MAX_INVITE_MILESTONES = 25;

/** Highest net threshold a milestone may name. */
export const MAX_MILESTONE_NET = 1_000_000;

/**
 * The tokens an invites template may carry, offered as quick buttons on the
 * screen. Kept beside the renderer so a token added to one is added to both.
 */
export const INVITE_MESSAGE_TOKENS = [
  "{user}",
  "{user.id}",
  "{user.age}",
  "{inviter}",
  "{inviter.total}",
  "{inviter.net}",
  "{inviter.leaves}",
  "{inviter.fakes}",
  "{invite.code}"
] as const;

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.round(numeric)));
}

function normaliseMessage(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  return trimmed.slice(0, 500);
}

/** Milestone list: snowflake role ids, thresholds clamped to [1, MAX], deduped per threshold. */
export function normaliseInviteMilestones(value: unknown): InviteMilestone[] {
  if (!Array.isArray(value)) return [];
  const seenThreshold = new Set<number>();
  const seenRole = new Set<string>();
  const rules: InviteMilestone[] = [];
  for (const entry of value) {
    const source = (entry ?? {}) as Partial<InviteMilestone>;
    const roleId = normaliseSnowflake(source.roleId);
    if (!roleId || seenRole.has(roleId)) continue;
    const net = clampInt(source.net, 1, MAX_MILESTONE_NET, 1);
    // One role may appear once, and one threshold may appear once: a duplicate
    // is inert repetition, and two rules at the same threshold would make the
    // plan's "which milestone did I just hit" answer ambiguous.
    if (seenThreshold.has(net)) continue;
    seenThreshold.add(net);
    seenRole.add(roleId);
    rules.push({
      id: typeof source.id === "string" && source.id ? source.id.slice(0, 64) : "",
      net,
      roleId
    });
    if (rules.length >= MAX_INVITE_MILESTONES) break;
  }
  return rules;
}

/**
 * Normalised, not trusted — the same helper the BFF writes through and the bot
 * reads through, so a hand-crafted PUT cannot store a value the bot would
 * behave differently on.
 */
export function normaliseInviteSettings(value: unknown): InviteSettings {
  const source = (value ?? {}) as Partial<InviteSettings>;
  return {
    enabled: source.enabled === true,
    fakeAccountDays: clampInt(source.fakeAccountDays, 0, MAX_FAKE_ACCOUNT_DAYS, DEFAULT_INVITE_SETTINGS.fakeAccountDays),
    keepRolesOnLeave: source.keepRolesOnLeave === true,
    logSelfInvites: source.logSelfInvites !== false,
    logJoins: source.logJoins !== false,
    logLeaves: source.logLeaves !== false,
    logMilestones: source.logMilestones !== false,
    joinMessage: normaliseMessage(source.joinMessage, DEFAULT_INVITE_SETTINGS.joinMessage),
    leaveMessage: normaliseMessage(source.leaveMessage, DEFAULT_INVITE_SETTINGS.leaveMessage),
    milestoneMessage: normaliseMessage(source.milestoneMessage, DEFAULT_INVITE_SETTINGS.milestoneMessage),
    milestoneRoles: normaliseInviteMilestones(source.milestoneRoles)
  };
}

/* ------------------------------------------------------------------ *
 * Join classification
 * ------------------------------------------------------------------ */

/** Why a join was classified the way it was — logged verbatim in the join embed. */
export type InviteJoinKind = "regular" | "fake" | "rejoin" | "self" | "vanity" | "unknown";

export type InviteJoinDecision = {
  kind: InviteJoinKind;
  /** The inviter this join is attributed to, when one exists and is not the joiner. */
  inviterId: string | null;
  /** Whether the inviter's `regular` (and therefore net) grows by one. */
  countsToInviter: boolean;
  /** Whether the join is recorded on the inviter's `fakes` counter. */
  countsAsFake: boolean;
  /** Whether the join is recorded on the inviter's `rejoins` counter. */
  countsAsRejoin: boolean;
};

export type InviteJoinFacts = {
  joinerId: string;
  /** The invite the join was attributed to, when the tracker could name one. */
  inviteCode: string | null;
  inviterId: string | null;
  /** True when the guild's vanity URL brought the member in (its use count rose). */
  isVanity: boolean;
  /** The joiner's account age in milliseconds. */
  accountAgeMs: number;
  /** The member's prior row, when this account has joined this guild before. */
  previous: { counted: boolean } | null;
  settings: Pick<InviteSettings, "fakeAccountDays">;
};

/**
 * The whole "does this join count" decision, in one pure function.
 *
 * The order is deliberate, and each rule exists because of a specific way the
 * number can be gamed or misread:
 *
 * 1. **No attribution** (vanity or the tracker's honest "cannot name one")
 *    counts for nobody. Guessing an inviter would put a fabricated referral
 *    on someone's board.
 * 2. **Self-invite** — the joiner standing behind their own link — earns
 *    nothing. This is the cheapest alt farm there is, and Discord hands us
 *    the fact for free.
 * 3. **Re-join** — any prior row for this account — never counts twice. A
 *    member who leaves and re-enters ten times through the same link earns
 *    their inviter exactly what the first entry did: one point, once.
 * 4. **Fake** — an account younger than the guild's threshold — is logged and
 *    counted in `fakes` but never in the net.
 * 5. Everything else is a regular, counted referral.
 */
export function classifyInviteJoin(facts: InviteJoinFacts): InviteJoinDecision {
  const fakeCeilingMs = facts.settings.fakeAccountDays * 86_400_000;
  const fresh = facts.accountAgeMs < fakeCeilingMs;

  if (facts.inviteCode && facts.inviterId && facts.inviterId === facts.joinerId) {
    return { kind: "self", inviterId: null, countsToInviter: false, countsAsFake: false, countsAsRejoin: false };
  }
  if (facts.previous) {
    return {
      kind: "rejoin",
      inviterId: facts.inviterId,
      countsToInviter: false,
      countsAsFake: false,
      countsAsRejoin: facts.inviterId !== null
    };
  }
  if (!facts.inviteCode || !facts.inviterId) {
    return {
      kind: facts.isVanity ? "vanity" : "unknown",
      inviterId: null,
      countsToInviter: false,
      countsAsFake: false,
      countsAsRejoin: false
    };
  }
  if (fresh) {
    return { kind: "fake", inviterId: facts.inviterId, countsToInviter: false, countsAsFake: true, countsAsRejoin: false };
  }
  return { kind: "regular", inviterId: facts.inviterId, countsToInviter: true, countsAsFake: false, countsAsRejoin: false };
}

/* ------------------------------------------------------------------ *
 * Milestone roles
 * ------------------------------------------------------------------ */

/**
 * The desired milestone roles for a net score: every rule whose threshold the
 * score reaches, deduplicated. Stack semantics — a member at 25 net holds the
 * 5, 10 and 25 roles — because a milestone is a ladder the guild designed
 * deliberately; collapsing to "only the highest" would make the lower tiers
 * meaningless the moment someone jumped past them.
 */
export function desiredInviteMilestoneRoles(milestones: readonly InviteMilestone[], net: number): string[] {
  const seen = new Set<string>();
  const roles: string[] = [];
  for (const milestone of milestones) {
    if (net < milestone.net || seen.has(milestone.roleId)) continue;
    seen.add(milestone.roleId);
    roles.push(milestone.roleId);
  }
  return roles;
}

/**
 * The role diff for one inviter, after their net moved in either direction.
 *
 * Revocation is confined to the roles the milestones themselves name — a
 * moderator's hand-assigned role is never touched — and `keepRolesOnLeave`
 * turns the revoke half off entirely, per the operator's leniency choice.
 */
export function planMilestoneRoleChanges(
  currentRoleIds: readonly string[],
  net: number,
  milestones: readonly InviteMilestone[],
  keepRolesOnLeave: boolean
): { toAdd: string[]; toRemove: string[] } {
  const desired = desiredInviteMilestoneRoles(milestones, net);
  const held = new Set(currentRoleIds);
  const toAdd = desired.filter(roleId => !held.has(roleId));
  if (keepRolesOnLeave) return { toAdd, toRemove: [] };
  const named = new Set(milestones.map(milestone => milestone.roleId));
  const satisfied = new Set(desired);
  const toRemove = [...named].filter(roleId => held.has(roleId) && !satisfied.has(roleId));
  return { toAdd, toRemove };
}

/* ------------------------------------------------------------------ *
 * Aggregates and templates
 * ------------------------------------------------------------------ */

/** The counters one inviter carries. `bonus` holds the moderators' manual edits. */
export type InviteStats = {
  regular: number;
  fakes: number;
  rejoins: number;
  leaves: number;
  bonus: number;
};

export const EMPTY_INVITE_STATS: InviteStats = { regular: 0, fakes: 0, rejoins: 0, leaves: 0, bonus: 0 };

/** Every join ever attributed to this inviter, counted or not. */
export function inviteTotal(stats: InviteStats): number {
  return stats.regular + stats.fakes + stats.rejoins;
}

/** The number the leaderboard ranks by and the milestones test against. */
export function inviteNet(stats: InviteStats): number {
  return stats.regular - stats.leaves + stats.bonus;
}

/** The values an invites template's tokens fill, in the shape callers build. */
export type InviteTemplateValues = {
  userMention: string;
  userId: string;
  userAge: string;
  inviterMention: string;
  stats: InviteStats;
  inviteCode: string;
};

/**
 * Fills an invites template's tokens. Unknown tokens are left as the operator
 * typed them — a template is prose, and silently eating text the operator
 * wrote would be worse than showing a token nobody substituted. A missing
 * inviter renders the inviter tokens as "غير معروف" rather than an empty
 * string, because an empty slot in a sentence reads as a rendering bug.
 */
export function renderInviteTemplate(template: string, values: InviteTemplateValues): string {
  const unknown = "غير معروف";
  return template
    .replaceAll("{user}", values.userMention)
    .replaceAll("{user.id}", values.userId)
    .replaceAll("{user.age}", values.userAge)
    .replaceAll("{inviter}", values.inviterMention || unknown)
    .replaceAll("{inviter.total}", values.inviterMention ? String(inviteTotal(values.stats)) : unknown)
    .replaceAll("{inviter.net}", values.inviterMention ? String(inviteNet(values.stats)) : unknown)
    .replaceAll("{inviter.leaves}", values.inviterMention ? String(values.stats.leaves) : unknown)
    .replaceAll("{inviter.fakes}", values.inviterMention ? String(values.stats.fakes) : unknown)
    .replaceAll("{invite.code}", values.inviteCode ? `\`${values.inviteCode}\`` : unknown);
}

const DAY = 86_400_000;

/**
 * An account age, in the operator's own words: "منذ 5 أشهر".
 *
 * Takes the account's creation timestamp and the clock to compare it against
 * (both explicit, so a test can freeze time). The unit is the largest one that
 * keeps the number readable — a 400-day-old account reads as "سنة", not
 * "منذ 400 يوم" — and Arabic takes its real plural forms, "يوم / يومين /
 * أيام", because a mistranslated age is the first thing a member screenshots.
 */
export function formatAccountAge(createdAtMs: number, now: number = Date.now()): string {
  const age = Math.max(0, now - createdAtMs);
  if (age < DAY) return "أقل من يوم";

  const days = Math.floor(age / DAY);
  const units: { limit: number; value: number; one: string; two: string; many: string; plural: string }[] = [
    { limit: 7, value: days, one: "يوم", two: "يومين", many: "أيام", plural: "يوماً" },
    { limit: 30, value: Math.floor(days / 7), one: "أسبوع", two: "أسبوعين", many: "أسابيع", plural: "أسبوعاً" },
    { limit: 365, value: Math.floor(days / 30), one: "شهر", two: "شهرين", many: "أشهر", plural: "شهراً" },
    { limit: Infinity, value: Math.floor(days / 365), one: "سنة", two: "سنتين", many: "سنوات", plural: "سنة" }
  ];
  const unit = units.find(entry => days < entry.limit)!;
  const count = Math.max(1, unit.value);
  // Arabic counts 1 and 2 as fused forms — "يوم", "يومين" — so the number
  // itself is spoken only from 3 up.
  if (count === 1) return `منذ ${unit.one}`;
  if (count === 2) return `منذ ${unit.two}`;
  const word = count <= 10 ? unit.many : unit.plural;
  return `منذ ${count} ${word}`;
}
