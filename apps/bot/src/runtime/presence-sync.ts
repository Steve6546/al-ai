/**
 * Presence sync.
 *
 * The bot's status and activity live on its gateway connection, so they are the
 * one part of the appearance that cannot be applied over REST. The dashboard
 * stores them; this applies them without a restart, and remembers what it sent so
 * an unchanged value is never re-sent.
 *
 * Everything else — the nickname, avatar, banner, role colour and bio — is
 * applied by the dashboard itself, which can report each field's outcome to the
 * operator as it happens. Splitting the work this way gives every stored field
 * exactly one writer, so neither side overwrites the other.
 *
 * GOVERNANCE rule 18: the value the dashboard stores is exactly the value applied
 * here — same shape, same normalisation, no field that saves without effect.
 *
 * Dependencies are injected so the decision logic can be tested without Discord.
 */

import { effectiveBotStatus, normaliseBotIdentity, type BotIdentitySettings } from "@al-ai/core";

/** The slice of the global identity the gateway owns. */
export type BotPresence = Pick<BotIdentitySettings, "status" | "activityType" | "activityText">;

export type PresenceSyncDeps = {
  loadIdentity: () => Promise<BotIdentitySettings>;
  /** Applies the presence and reports whether it actually reached the gateway. */
  applyPresence: (presence: BotPresence) => Promise<boolean>;
  onError?: (error: unknown) => void;
};

/** Stable key so an unchanged presence is recognised without deep comparison. */
function keyOf(presence: BotPresence) {
  return `${presence.status}\u0000${presence.activityType}\u0000${presence.activityText}`;
}

export function createPresenceSync(deps: PresenceSyncDeps) {
  let applied: string | null = null;

  return {
    /** Applies whatever changed. Safe to call repeatedly. */
    async run() {
      let desired: BotPresence;
      try {
        // Normalised on the way in with the same rules the BFF applied on the way
        // out, so a stored value can never mean two things on the two sides.
        const identity = normaliseBotIdentity(await deps.loadIdentity());
        desired = {
          // The *effective* status, not the stored one. A timed `dnd` whose
          // window has closed must read as `online` — that is the whole point of
          // offering a duration. The stored row keeps the operator's choice, so
          // reopening the screen still shows what they picked.
          status: effectiveBotStatus(identity, Date.now()),
          activityType: identity.activityType,
          activityText: identity.activityText
        };
      } catch (error) {
        deps.onError?.(error);
        return;
      }

      const key = keyOf(desired);
      if (applied === key) return;

      const ok = await deps.applyPresence(desired).catch(error => {
        deps.onError?.(error);
        return false;
      });
      // Only remember a presence the gateway actually took, so a failed call is
      // retried rather than recorded as applied.
      if (ok) applied = key;
    },

    /** Exposed for tests and for the shutdown path. */
    applied() {
      return applied;
    },

    forget() {
      applied = null;
    }
  };
}

export type PresenceSync = ReturnType<typeof createPresenceSync>;
