import {
  ANTI_NUKE_WINDOW_MS,
  assessNukeAction,
  type AntiNukeConfig,
  type AntiNukeLimits,
  type NukeAction,
  type NukeAssessment,
  type NukeProtectionKey,
  type ProtectionPunishment,
  protectionEnabled
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
    record(input: { guildId: string; actorId: string; action: NukeAction; limits: AntiNukeLimits; windowMs?: number }): NukeAssessment | null {
      if (latched.has(actorKey(input.guildId, input.actorId))) return null;

      const window = input.windowMs ?? windowMs;
      const key = `${actorKey(input.guildId, input.actorId)}:${input.action}`;
      const current = now();
      const kept = (hits.get(key) ?? []).filter(at => current - at < window);
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
    }
  };
}

/* ------------------------------------------------------------------ *
 * Mitigation
 * ------------------------------------------------------------------ */

export type NukeIncident = {
  guildId: string;
  actorId: string;
  action: NukeAction;
  /** The registry entry whose punishment applies to this incident. */
  protectionKey: NukeProtectionKey;
  /** How many of this action the actor performed inside the window. */
  count: number;
  limit: number;
};

/** What a single punishment attempt returned. `ok` is true only on Discord's confirmation. */
export type PunishmentResult = { ok: boolean; detail: string };

export type MitigationOutcome = {
  incident: NukeIncident;
  /** The punishment the protection asked for. */
  punishment: ProtectionPunishment;
  /** True only when Discord confirmed the punishment actually happened. */
  applied: boolean;
  /** What happened, or the real reason it failed. */
  detail: string;
  /** Whether the owner was reached. False is not a failure of the punishment itself. */
  ownerNotified: boolean;
};

export type MitigationDeps = {
  ban: (guildId: string, actorId: string, reason: string) => Promise<PunishmentResult>;
  kick: (guildId: string, actorId: string, reason: string) => Promise<PunishmentResult>;
  timeout: (guildId: string, actorId: string, seconds: number, reason: string) => Promise<PunishmentResult>;
  removeRoles: (guildId: string, actorId: string, reason: string) => Promise<PunishmentResult>;
  warn: (guildId: string, actorId: string, reason: string) => Promise<PunishmentResult>;
  /** DMs the guild owner with this text. Resolves false when it could not be delivered. */
  notifyOwner: (message: string) => Promise<boolean>;
};

/**
 * Runs the punishment the protection chose, then tells the owner.
 *
 * The actor is acted on first and the owner told second, for the same reason as
 * before: an attacker left active for the length of a network round trip is
 * exactly when the rest of the channels go. The punishment is read from the
 * incident's own protection, so two protections never share one — and the old
 * fixed "strip roles then quarantine" sequence is gone; `remove-roles` is now a
 * punishment an operator picks, not a behaviour that always runs.
 *
 * Neither step throws: a DM failure must not abort the punishment, and a
 * punishment failure must not stop the owner being told. `applied` is true only
 * when Discord confirmed the write, never on the request alone.
 */
export async function mitigateNuke(
  incident: NukeIncident,
  config: AntiNukeConfig,
  deps: MitigationDeps
): Promise<MitigationOutcome> {
  const settings = config.protections[incident.protectionKey];
  const punishment = settings?.punishment ?? "remove-roles";
  const windowSeconds = settings?.windowSeconds ?? 600;
  const reason = `AL AI anti-nuke: ${incident.action} ×${incident.count} in ${windowSeconds}s (limit ${incident.limit})`;

  const attempt = async (): Promise<PunishmentResult> => {
    switch (punishment) {
      case "ban":
        return deps.ban(incident.guildId, incident.actorId, reason);
      case "kick":
        return deps.kick(incident.guildId, incident.actorId, reason);
      case "timeout":
        return deps.timeout(incident.guildId, incident.actorId, settings?.timeoutSeconds ?? 600, reason);
      case "warn":
        return deps.warn(incident.guildId, incident.actorId, reason);
      case "remove-roles":
      default:
        return deps.removeRoles(incident.guildId, incident.actorId, reason);
    }
  };

  const result = await attempt().catch((error: unknown) => ({
    ok: false,
    detail: error instanceof Error ? error.message : String(error)
  }));

  const ownerNotified = await deps
    .notifyOwner(ownerAlert(incident, { punishment, applied: result.ok, detail: result.detail }))
    .catch(() => false);

  return { incident, punishment, applied: result.ok, detail: result.detail, ownerNotified };
}

/** The Arabic message the owner receives. Kept here so the wording is testable. */
export function ownerAlert(
  incident: NukeIncident,
  outcome: Pick<MitigationOutcome, "punishment" | "applied" | "detail">
): string {
  const lines = [
    "🚨 منع AL AI عملية تخريب في سيرفرك.",
    "",
    `العضو: <@${incident.actorId}>`,
    `الإجراء: ${incident.count} (الحد المسموح ${incident.limit}).`,
    "",
    `العقوبة: ${outcome.punishment} — ${outcome.applied ? "نُفِّذت" : "فشلت"}.`,
    outcome.detail,
    "",
    "راجع العضو قبل إعادة رتبه."
  ];
  return lines.join("\n");
}

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
export type NukeObservation = {
  action: NukeAction;
  /**
   * The registry entry this event belongs to, so the operator's switch for
   * *this* action is the one asked about.
   *
   * Not the same as `action`: creating and deleting roles share one budget but
   * are two protections, and an operator who turns off role creation still
   * expects deletions to be caught.
   */
  protectionKey: NukeProtectionKey;
  guildId: string;
  actorId: string;
};

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
      return { action: "channel-delete", protectionKey: "channel-delete", guildId: event.guildId, actorId: event.actorId };
    case "server.channel-create":
      return { action: "channel-create", protectionKey: "channel-create", guildId: event.guildId, actorId: event.actorId };
    case "server.channel-update":
      return { action: "channel-update", protectionKey: "channel-update", guildId: event.guildId, actorId: event.actorId };
    case "channel.permission-update":
      return { action: "channel-permissions", protectionKey: "channel-permissions", guildId: event.guildId, actorId: event.actorId };
    case "moderation.ban":
      return { action: "ban", protectionKey: "member-ban", guildId: event.guildId, actorId: event.actorId };
    case "role.create":
      return { action: "role-change", protectionKey: "role-create", guildId: event.guildId, actorId: event.actorId };
    case "role.delete":
      // Counted with role creation in one budget: swapping roles out is one
      // behaviour, and two separate budgets would quietly double the allowance.
      return { action: "role-change", protectionKey: "role-delete", guildId: event.guildId, actorId: event.actorId };
    default:
      return null;
  }
}

export type AntiNukeEngineDeps = {
  /** Resolves the guild's configuration, normally through the shared config cache. */
  configFor: (guildId: string) => Promise<AntiNukeConfig>;
  ban: MitigationDeps["ban"];
  kick: MitigationDeps["kick"];
  timeout: MitigationDeps["timeout"];
  removeRoles: MitigationDeps["removeRoles"];
  warn: MitigationDeps["warn"];
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

        const { action, protectionKey, guildId, actorId } = observation;
        // The bot's own role creation on invite would otherwise trip its own
        // limit the moment it joined a busy server.
        if (actorId === deps.selfId?.()) return null;

        const config = await deps.configFor(guildId).catch(() => null);
        if (!config?.enabled) return null;
        // The per-protection switch, asked after the guild-level one: an operator
        // who turned this action off does not want it counted, and a counter that
        // runs anyway can still trip the shared budget it feeds.
        if (!protectionEnabled(config.protections, protectionKey)) return null;

        const assessment = tracker.record({
          guildId,
          actorId,
          action,
          limits: config.limits,
          // The window is per protection: a fast channel purge and a slow role
          // drip should not share one.
          windowMs: (config.protections[protectionKey]?.windowSeconds ?? 600) * 1000
        });
        if (!assessment?.tripped) return null;

        const incident: NukeIncident = {
          guildId,
          actorId,
          action,
          protectionKey,
          count: assessment.count,
          limit: assessment.limit
        };

        const outcome = await mitigateNuke(incident, config, {
          ban: deps.ban,
          kick: deps.kick,
          timeout: deps.timeout,
          removeRoles: deps.removeRoles,
          warn: deps.warn,
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

