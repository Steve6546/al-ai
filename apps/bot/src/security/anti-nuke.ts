import {
  ANTI_NUKE_WINDOW_MS,
  assessNukeAction,
  type AntiNukeConfig,
  type AntiNukeLimits,
  type NukeAction,
  type NukeAssessment
} from "@al-ai/core";
import type { BotEvent } from "../lib/discord.js";

/**
 * GOVERNANCE rule 12 — the anti-nuke engine is independent of the feature path.
 *
 * It observes the same normalised event stream the logger does, but it is wired
 * in front of it and never through it: a moderator cannot disable their own
 * oversight by muting a log channel, and a failure here cannot stop logging.
 *
 * Two responsibilities live in this file, both testable without Discord:
 *   - the sliding-window counter that decides when a burst has crossed a limit
 *   - the mitigation sequence that runs once it has
 */

export type AntiNukeTrackerOptions = {
  now?: () => number;
  windowMs?: number;
};

/**
 * Counts destructive actions per actor, inside a sliding window.
 *
 * Deliberately knows nothing about where limits come from: the caller resolves
 * the guild's configuration (an async, cached read) and passes the limits in.
 * Keeping that out of here means the counting logic has no I/O to mock.
 */
export function createAntiNukeTracker(options: AntiNukeTrackerOptions = {}) {
  const now = options.now ?? (() => Date.now());
  const windowMs = options.windowMs ?? ANTI_NUKE_WINDOW_MS;

  /** "guild:actor:action" -> timestamps inside the current window */
  const hits = new Map<string, number[]>();
  /** "guild:actor" -> already mitigated; further actions are not re-reported. */
  const latched = new Set<string>();

  const actorKey = (guildId: string, actorId: string) => `${guildId}:${actorId}`;

  return {
    /**
     * Counts one destructive action and reports where it stands.
     *
     * Returns null only when this actor has already been mitigated. They are
     * quarantined at that point, so re-notifying the owner on every later action
     * would be noise about a fire that is already out.
     */
    record(input: { guildId: string; actorId: string; action: NukeAction; limits: AntiNukeLimits }): NukeAssessment | null {
      if (latched.has(actorKey(input.guildId, input.actorId))) return null;

      const key = `${actorKey(input.guildId, input.actorId)}:${input.action}`;
      const current = now();
      const kept = (hits.get(key) ?? []).filter(at => current - at < windowMs);
      kept.push(current);
      hits.set(key, kept);

      const assessment = assessNukeAction(input.action, kept.length, input.limits);
      // Latch on the crossing action, not on the first action past it, so the
      // owner receives exactly one message per incident.
      if (assessment.tripped) latched.add(actorKey(input.guildId, input.actorId));
      return assessment;
    },

    /** True when this actor has already been mitigated and is awaiting review. */
    isLatched(guildId: string, actorId: string) {
      return latched.has(actorKey(guildId, actorId));
    },

    /**
     * Clears the latch for one actor.
     *
     * No production caller today — it is exercised by the tests, like
     * `countFor` and `reset`, and kept as the surface a release flow would use.
     * It previously claimed to be "called when an operator releases someone
     * from quarantine", which described a caller that does not exist and
     * overstated what an unreleased latch costs:
     *
     *  - containment is `roles.set([quarantineRoleId])`, which is persisted in
     *    Discord, so an actor the latch still covers is not punished twice;
     *  - the latch itself lives in this process's memory, so a restart clears it
     *    along with every counter.
     *
     * The reachable consequence is therefore narrower than "latched forever":
     * within one process lifetime the owner is told about an incident once, and
     * a restart may report it a second time. Nothing is left contained.
     */
    release(guildId: string, actorId: string) {
      latched.delete(actorKey(guildId, actorId));
    },

    /** Drops counters whose window has passed, so the map cannot grow forever. */
    prune() {
      const current = now();
      for (const [key, times] of hits) {
        const kept = times.filter(at => current - at < windowMs);
        if (kept.length) hits.set(key, kept);
        else hits.delete(key);
      }
    },

    /** How many actions this actor has recorded for this action class right now. */
    countFor(guildId: string, actorId: string, action: NukeAction) {
      const current = now();
      return (hits.get(`${actorKey(guildId, actorId)}:${action}`) ?? []).filter(at => current - at < windowMs).length;
    },

    reset() {
      hits.clear();
      latched.clear();
    }
  };
}

export type AntiNukeTracker = ReturnType<typeof createAntiNukeTracker>;

/* ------------------------------------------------------------------ *
 * Mitigation
 * ------------------------------------------------------------------ */

export type NukeIncident = {
  guildId: string;
  actorId: string;
  action: NukeAction;
  /** How many of this action the actor performed inside the window. */
  count: number;
  limit: number;
};

export type MitigationOutcome = {
  incident: NukeIncident;
  /**
   * How many roles were stripped and replaced with the quarantine role.
   *
   * Null means no quarantine role is configured, so no roles were touched —
   * distinct from 0, which means the actor held no roles to strip.
   */
  quarantined: number | null;
  /** Whether the owner was reached. False is not a failure of the mitigation itself. */
  ownerNotified: boolean;
};

export type MitigationDeps = {
  /**
   * Replaces every role the member holds with the quarantine role.
   * Returns how many were stripped, or null when the member could not be changed.
   */
  quarantine: (guildId: string, actorId: string, quarantineRoleId: string) => Promise<number | null>;
  /** DMs the guild owner with this text. Resolves false when it could not be delivered. */
  notifyOwner: (message: string) => Promise<boolean>;
};

/**
 * Runs the response to a tripped limit, in the order that matters.
 *
 * The actor is neutralised first and the owner told second. Reversing that
 * would leave the attacker active for the length of a network round trip, which
 * is exactly when they would delete the rest of the channels.
 *
 * Neither step throws: a DM failure must not abort the quarantine, and a
 * quarantine failure must not stop the owner being told. The caller logs the
 * outcome either way, so a partial mitigation is still on the record.
 */
export async function mitigateNuke(
  incident: NukeIncident,
  config: AntiNukeConfig,
  deps: MitigationDeps
): Promise<MitigationOutcome> {
  let quarantined: number | null = null;
  if (config.quarantineRoleId) {
    quarantined = await deps.quarantine(incident.guildId, incident.actorId, config.quarantineRoleId).catch(() => null);
  }

  const ownerNotified = await deps.notifyOwner(ownerAlert(incident, { quarantined })).catch(() => false);

  return { incident, quarantined, ownerNotified };
}

/** The Arabic message the owner receives. Kept here so the wording is testable. */
export function ownerAlert(incident: NukeIncident, outcome: Pick<MitigationOutcome, "quarantined">): string {
  const lines = [
    "🚨 منع AL AI عملية تخريب في سيرفرك.",
    "",
    `العضو: <@${incident.actorId}>`,
    `الإجراء: ${incident.count} خلال دقيقة (الحد المسموح ${incident.limit}).`,
    ""
  ];
  lines.push(
    outcome.quarantined === null
      ? "لم تُسحب رتبه: لم تُحدَّد رتبة حجر بعد. حدّدها من لوحة التحكم ← الأمان."
      : `سُحبت رتبه (${outcome.quarantined}) ووُضع في رتبة الحجر.`
  );
  lines.push("راجع العضو قبل إعادة رتبه.");
  return lines.join("\n");
}

/* ------------------------------------------------------------------ *
 * Event mapping
 * ------------------------------------------------------------------ */

/**
 * A destructive action that Discord attributed to a named person.
 *
 * Returned as a whole rather than as a bare action so the narrowing happens in
 * one place: `BotEvent` has variants with no guild or actor at all, and the
 * switch below is the only spot that knows which are which.
 */
export type NukeObservation = { action: NukeAction; guildId: string; actorId: string };

/**
 * Which destructive actions the engine watches.
 *
 * Only events Discord attributes to a named actor count. An event with no actor
 * cannot be attributed to a person, and blaming whoever happens to be nearest
 * would be worse than not reacting at all.
 */
export function nukeActionOf(event: BotEvent): NukeObservation | null {
  switch (event.type) {
    case "server.channel-delete":
      return { action: "channel-delete", guildId: event.guildId, actorId: event.actorId };
    case "moderation.ban":
      return { action: "ban", guildId: event.guildId, actorId: event.actorId };
    case "role.create":
    case "role.delete":
      // Counted together: swapping roles out is one behaviour, and two separate
      // budgets would quietly double the allowance.
      return { action: "role-change", guildId: event.guildId, actorId: event.actorId };
    default:
      return null;
  }
}

export type AntiNukeEngineDeps = {
  /** Resolves the guild's configuration, normally through the shared config cache. */
  configFor: (guildId: string) => Promise<AntiNukeConfig>;
  quarantine: MitigationDeps["quarantine"];
  /** Sends the alert to the guild owner. */
  notifyOwner: (guildId: string, message: string) => Promise<boolean>;
  /** Writes `security.nuke-prevented`. Never allowed to throw into the event path. */
  report: (incident: NukeIncident, outcome: MitigationOutcome) => Promise<void>;
  /** The bot's own user ID, so its setup actions are never treated as an attack. */
  selfId?: () => string | null;
};

/**
 * The engine as the event path sees it: one async call per event, and no way for
 * a failure here to disturb logging.
 */
export function createAntiNukeEngine(deps: AntiNukeEngineDeps, options: AntiNukeTrackerOptions = {}) {
  const tracker = createAntiNukeTracker(options);

  return {
    tracker,

    /**
     * Watches one event. Returns the mitigation outcome when a limit was crossed.
     *
     * Never throws: this runs in front of the logger, and an exception escaping
     * here would be a security tool taking down the audit trail it protects.
     */
    async observe(event: BotEvent): Promise<MitigationOutcome | null> {
      try {
        const observation = nukeActionOf(event);
        if (!observation) return null;

        const { action, guildId, actorId } = observation;
        // The bot's own role creation on invite would otherwise trip its own
        // limit the moment it joined a busy server.
        if (actorId === deps.selfId?.()) return null;

        const config = await deps.configFor(guildId).catch(() => null);
        if (!config?.enabled) return null;

        const assessment = tracker.record({ guildId, actorId, action, limits: config.limits });
        if (!assessment?.tripped) return null;

        const incident: NukeIncident = {
          guildId,
          actorId,
          action,
          count: assessment.count,
          limit: assessment.limit
        };

        const outcome = await mitigateNuke(incident, config, {
          quarantine: deps.quarantine,
          notifyOwner: message => deps.notifyOwner(guildId, message)
        });

        await deps.report(incident, outcome).catch(() => undefined);
        return outcome;
      } catch (error) {
        console.error("AL AI anti-nuke observation failed", error);
        return null;
      }
    }
  };
}

export type AntiNukeEngine = ReturnType<typeof createAntiNukeEngine>;
