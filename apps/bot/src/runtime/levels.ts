import {
  levelFromXp,
  type LevelRoleReward,
  type LevelSettings
} from "@al-ai/core";

/**
 * The levels engine's decision logic — pure, or bounded to the database.
 *
 * Nothing here touches discord.js. The Discord I/O (reading voice states,
 * sending messages, mutating member roles) belongs to `index.ts`, which owns
 * the settings caches and the hierarchy checks; this module decides *what*
 * should happen, so every rule is unit-testable without a client.
 *
 * ---------------------------------------------------------------
 * Text XP: one gain per author per cooldown window. The gate is an
 * in-memory map rather than Redis because this bot runs as a single
 * process against one database — a map answers in nanoseconds and a
 * second bot process is a deployment mistake the instance lock already
 * forbids.
 * ---------------------------------------------------------------
 */
export class TextCooldownGate {
  private readonly last = new Map<string, number>();

  constructor(private readonly maxEntries = 20_000) {}

  /**
   * Returns true when this author may earn XP now, and records the moment.
   * A message inside the window is refused without touching the database —
   * the entire point of the cooldown.
   */
  tryConsume(guildId: string, userId: string, cooldownSeconds: number, now = Date.now()): boolean {
    const key = `${guildId}:${userId}`;
    const last = this.last.get(key);
    if (last !== undefined && now - last < cooldownSeconds * 1000) return false;
    this.last.set(key, now);
    if (this.last.size > this.maxEntries) this.sweep(now);
    return true;
  }

  /** Drops entries idle for an hour or more — burst traffic cannot pin memory. */
  sweep(now = Date.now()): number {
    let removed = 0;
    for (const [key, at] of this.last) {
      if (now - at >= 3_600_000) {
        this.last.delete(key);
        removed++;
      }
    }
    return removed;
  }
}

/** XP one qualifying message earns: a random draw in the guild's range. */
export function textXpGain(settings: LevelSettings, random: () => number = Math.random): number {
  return randomInt(settings.textXpMin, settings.textXpMax, random);
}

/** XP one qualifying voice minute earns — same range rule on the voice track. */
export function voiceXpGain(settings: LevelSettings, random: () => number = Math.random): number {
  return randomInt(settings.voiceXpMin, settings.voiceXpMax, random);
}

function randomInt(min: number, max: number, random: () => number): number {
  const low = Math.min(min, max);
  const high = Math.max(min, max);
  return low + Math.floor(random() * (high - low + 1));
}

/** The facts about one arriving message the text rules need. */
export type TextMessageFacts = {
  isBot: boolean;
  isWebhook: boolean;
  channelId: string;
  /**
   * The thread's parent channel id when the message was sent inside a thread.
   * Ignoring a channel must ignore its threads too, or the ignore rule is
   * trivially bypassed by opening a thread under it.
   */
  parentChannelId?: string | null;
  /**
   * Discord marks join/boost/pin and every other non-conversation message as
   * system. None of them is the interaction the XP rewards, and each arrives
   * with the member as its author, so the filter has to be explicit here.
   * Media-only messages (images, stickers) are NOT system — they count as
   * normal conversation and earn XP by documented product policy.
   */
  isSystem?: boolean;
  /** The author's role ids, or null when the member object is unavailable. */
  memberRoleIds: string[] | null;
};

/**
 * Whether a message earns XP. Bots and webhooks are structurally excluded —
 * a bot talking to another bot must not farm levels off each other — and so
 * are system messages. A member whose roles could not be read is given the
 * benefit of the doubt on the role-ignore rule only; the channel rules are
 * checked regardless, on both the thread and its parent.
 */
export function shouldEarnTextXp(settings: LevelSettings, facts: TextMessageFacts): boolean {
  if (!settings.enabled || !settings.textXpEnabled) return false;
  if (facts.isBot || facts.isWebhook) return false;
  if (facts.isSystem === true) return false;
  if (settings.ignoredTextChannelIds.includes(facts.channelId)) return false;
  if (facts.parentChannelId && settings.ignoredTextChannelIds.includes(facts.parentChannelId)) return false;
  if (facts.memberRoleIds?.some(roleId => settings.ignoredRoleIds.includes(roleId))) return false;
  return true;
}

/** The facts about one voice member at a tick instant. */
export type VoiceMemberFacts = {
  isBot: boolean;
  channelId: string | null;
  memberRoleIds: string[] | null;
  selfMute: boolean;
  selfDeaf: boolean;
  serverMute: boolean;
  serverDeaf: boolean;
};

/** The channel-level context one member is judged against at the same instant. */
export type VoiceChannelContext = {
  /** The guild's AFK channel id, from Discord's own guild settings. */
  afkChannelId: string | null;
  /**
   * How many members in the channel pass the same member-level rules — bots,
   * ignored roles, AFK, mute and deafen — *including the member being judged*.
   * The min-members guard counts eligible conversation, not raw heads: a room
   * of one talker and three muted lurkers is a solo room by this definition.
   * Stage channels need no special case: an audience is muted by design, so
   * speakers can earn and listeners cannot, which is the honest reading.
   */
  eligibleCount: number;
};

/**
 * The member-level half of voice eligibility: everything except the
 * min-members rule. Exported because the min-members count itself is built
 * from this same predicate — one eligibility policy, used for both the count
 * and the grant, never two divergent copies.
 */
export function voiceMemberMeetsRules(
  settings: LevelSettings,
  member: VoiceMemberFacts,
  context: { afkChannelId: string | null }
): boolean {
  if (!settings.enabled || !settings.voiceXpEnabled) return false;
  if (!member.channelId || member.isBot) return false;
  if (settings.ignoredVoiceChannelIds.includes(member.channelId)) return false;
  if (settings.ignoreAfk && context.afkChannelId && member.channelId === context.afkChannelId) return false;
  if (settings.ignoredRoleIds.some(roleId => member.memberRoleIds?.includes(roleId))) return false;
  if (settings.ignoreMuted && (member.selfMute || member.serverMute)) return false;
  if (settings.ignoreDeafened && (member.selfDeaf || member.serverDeaf)) return false;
  return true;
}

/** Counts the members of one channel who pass the member-level rules. */
export function countEligibleVoiceMembers(
  settings: LevelSettings,
  members: VoiceMemberFacts[],
  context: { afkChannelId: string | null }
): number {
  return members.filter(member => voiceMemberMeetsRules(settings, member, context)).length;
}

/**
 * Whether a member earns voice XP at this tick.
 *
 * The solo-farming guard is `eligibleCount < voiceMinMembers` — the default of
 * 2 means a member alone in a room earns nothing, no matter how long they sit
 * there, and ineligible lurkers do not legitimise the room either.
 */
export function isVoiceEligible(
  settings: LevelSettings,
  member: VoiceMemberFacts,
  context: VoiceChannelContext
): boolean {
  if (!voiceMemberMeetsRules(settings, member, { afkChannelId: context.afkChannelId })) return false;
  if (context.eligibleCount < settings.voiceMinMembers) return false;
  return true;
}

/**
 * Hybrid voice timing: sessions accrue time, the minute tick credits it.
 *
 * `voiceStateUpdate` opens a session the moment a member joins (so no tick
 * granularity is charged to time the member was not present for) and the 60s
 * heartbeat credits whole elapsed minutes from `lastCreditedAt`. On leave the
 * remaining whole minutes are credited once, so a member who joins and leaves
 * between two ticks still gets their time. Crediting policy: a member earns
 * only while they pass the rules *at credit time* — an ineligible stretch
 * advances the clock without paying, because the engine cannot re-judge the
 * past and must not guess.
 */
export class VoiceSessionTracker {
  private readonly sessions = new Map<string, { channelId: string; lastCreditedAt: number }>();

  private static key(guildId: string, userId: string): string {
    return `${guildId}:${userId}`;
  }

  onJoin(guildId: string, userId: string, channelId: string, now: number): void {
    this.sessions.set(VoiceSessionTracker.key(guildId, userId), { channelId, lastCreditedAt: now });
  }

  /** A channel move keeps the session and its accrued-time anchor. */
  onMove(guildId: string, userId: string, channelId: string): void {
    const session = this.sessions.get(VoiceSessionTracker.key(guildId, userId));
    if (session) session.channelId = channelId;
  }

  /** Ends the session and returns its channel id, for the final delta credit. */
  onLeave(guildId: string, userId: string): string | null {
    const key = VoiceSessionTracker.key(guildId, userId);
    const session = this.sessions.get(key);
    if (!session) return null;
    this.sessions.delete(key);
    return session.channelId;
  }

  /** True while a member is tracked as sitting in a voice channel. */
  isActive(guildId: string, userId: string): boolean {
    return this.sessions.has(VoiceSessionTracker.key(guildId, userId));
  }

  /** Whole minutes elapsed since the last credit, capped by the elapsed span. */
  minutesToCredit(guildId: string, userId: string, now: number): number {
    const session = this.sessions.get(VoiceSessionTracker.key(guildId, userId));
    if (!session) return 0;
    const elapsedMs = Math.max(0, now - session.lastCreditedAt);
    return Math.floor(elapsedMs / 60_000);
  }

  /** Advances the credit anchor — called after every successful credit. */
  markCredited(guildId: string, userId: string, now: number): void {
    const session = this.sessions.get(VoiceSessionTracker.key(guildId, userId));
    if (session) session.lastCreditedAt = now;
  }

  /** Snapshot of the live session count, for the status surface. */
  size(): number {
    return this.sessions.size;
  }

  /** Restart drops the in-memory sessions — the un-credited remainder (< 1 tick) is lost by design. */
  clear(): void {
    this.sessions.clear();
  }
}

/**
 * Which reward roles a member's current levels earn, under the stacking rule.
 *
 * With stacking the answer is every satisfied rule; without it, only the
 * highest satisfied rule *per track* survives — a member can hold their best
 * text reward, their best voice reward and their best dual reward at once,
 * which is what "أعلى رتبة وصل إليها" means when the tracks are independent.
 */
export function desiredLevelRoles(
  rewards: LevelRoleReward[],
  textLevel: number,
  voiceLevel: number,
  stacking: boolean
): string[] {
  const satisfied = rewards.filter(reward => {
    if (reward.kind === "dual") {
      return textLevel >= reward.level && voiceLevel >= (reward.voiceLevel ?? 0);
    }
    // Each single-condition track is judged against its own level.
    return reward.kind === "voice" ? voiceLevel >= reward.level : textLevel >= reward.level;
  });
  const desired = new Set<string>();
  // A keep-marked rule pins its role while it is satisfied — the operator's
  // per-rule choice from the modal, independent of the guild-wide switch.
  for (const reward of satisfied) {
    if (reward.alwaysKeep) desired.add(reward.roleId);
  }
  if (stacking) {
    for (const reward of satisfied) desired.add(reward.roleId);
    return [...desired];
  }

  // Without stacking, the highest satisfied rule per track is what survives —
  // three independent picks, on top of any keep-pinned roles.
  const highestOf = (kind: LevelRoleReward["kind"]) => {
    let best: LevelRoleReward | null = null;
    for (const reward of satisfied) {
      if (reward.kind !== kind) continue;
      if (!best || reward.level > best.level) best = reward;
    }
    return best?.roleId ?? null;
  };
  const picks = [highestOf("text"), highestOf("voice"), highestOf("dual")];
  for (const pick of picks) {
    if (pick) desired.add(pick);
  }
  return [...desired];
}

/**
 * The grant/revoke diff for one member, over *this system's* roles only.
 *
 * A role the member holds that no rule names is never touched — levels must
 * not revoke what a moderator assigned by hand. Revokes cover both a level
 * regression (a reset) and an edited rule the member no longer satisfies:
 * both arrive here as "held but no longer desired".
 */
export function planLevelRoleChanges(
  heldRoleIds: string[],
  desiredRoleIds: string[],
  allRewardRoleIds: string[]
): { toAdd: string[]; toRemove: string[] } {
  const held = new Set(heldRoleIds);
  const desired = new Set(desiredRoleIds);
  const rewardRoles = new Set(allRewardRoleIds);
  const toAdd = [...desired].filter(roleId => !held.has(roleId));
  const toRemove = [...rewardRoles].filter(roleId => held.has(roleId) && !desired.has(roleId));
  return { toAdd, toRemove };
}

/** The level a member reaches after an XP write, and whether it rose. */
export function levelStep(oldXp: number, newXp: number, cap: number): { level: number; leveledUp: boolean } {
  const before = levelFromXp(oldXp, cap);
  const after = levelFromXp(newXp, cap);
  return { level: after, leveledUp: after > before };
}
