/**
 * GOVERNANCE rule 12 — intrusion detection is independent of the feature path.
 *
 * This module decides *whether* something is a security event and produces the
 * matching `security.*` id plus its payload. It never talks to Discord and never
 * routes: the caller hands the result to `logEvent()`, which writes it to
 * bot-log and to the append-only audit trail together.
 *
 * Every `security.*` id is `critical` by definition, so none of these signals
 * may be downgraded or swallowed by the caller.
 */

export type SecuritySignal = { id: string; data: Record<string, unknown> };

export type IntrusionDetectorOptions = {
  now?: () => number;
  /** Sliding window used for the rate-based signals. */
  windowMs?: number;
  /** Distinct authorization failures from one actor inside the window. */
  authorizationBurst?: number;
  /** Distinct signature failures from one layer inside the window. */
  signatureBurst?: number;
  /** Requests to one endpoint inside the window before it counts as abnormal. */
  requestBurst?: number;
};

const DEFAULT_WINDOW_MS = 60_000;

export function createIntrusionDetector(options: IntrusionDetectorOptions = {}) {
  const now = options.now ?? (() => Date.now());
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const authorizationBurst = options.authorizationBurst ?? 3;
  const signatureBurst = options.signatureBurst ?? 2;
  const requestBurst = options.requestBurst ?? 30;

  /** key -> timestamps inside the current window */
  const hits = new Map<string, number[]>();

  function record(key: string): number {
    const current = now();
    const kept = (hits.get(key) ?? []).filter(at => current - at < windowMs);
    kept.push(current);
    hits.set(key, kept);
    return kept.length;
  }

  /** Reads a counter without adding to it, dropping anything outside the window. */
  function countInWindow(key: string): number {
    const current = now();
    const kept = (hits.get(key) ?? []).filter(at => current - at < windowMs);
    hits.set(key, kept);
    return kept.length;
  }

  return {
    /**
     * An authorization attempt that failed — including a role that exists but is
     * too low, and a role that is not registered at all. Failed attempts are the
     * signal: they are what a probing attacker produces.
     */
    authorizationFailure(input: { guildId: string; actorId: string; action: string; reason: string }): SecuritySignal {
      const count = record(`auth:${input.guildId}:${input.actorId}`);
      return {
        id: "security.invalid-role-attempt",
        data: { action: input.action, actorId: input.actorId, reason: input.reason, attemptsInWindow: count }
      };
    },

    /** A layer signature that did not verify, for any reason. */
    signatureFailure(input: { layer: string; reason: string }): SecuritySignal {
      const count = record(`sig:${input.layer}`);
      return {
        id: "security.hmac-invalid",
        data: { layer: input.layer, reason: input.reason, attemptsInWindow: count }
      };
    },

    /**
     * Rate-based anomaly. Returns a signal only once one endpoint exceeds the
     * burst budget inside the window, so normal traffic stays quiet.
     */
    request(input: { endpoint: string; actorId?: string }): SecuritySignal | null {
      const count = record(`req:${input.endpoint}`);
      if (count <= requestBurst) return null;
      return {
        id: "security.abnormal-request",
        data: {
          endpoint: input.endpoint,
          pattern: `${count} requests in ${Math.round(windowMs / 1000)}s`,
          ...(input.actorId ? { actorId: input.actorId } : {})
        }
      };
    },

    /** A token, session or role that was used after being revoked or expiring. */
    revokedCredential(input: { credentialType: string; reason: string }): SecuritySignal {
      return {
        id: "security.revoked-credential",
        data: { credentialType: input.credentialType, reason: input.reason }
      };
    },

    /** Reported by the audit-trail guard when a write was rejected as a mutation attempt. */
    auditTamper(input: { attempt: string; target: string }): SecuritySignal {
      return { id: "security.audit-tamper", data: { attempt: input.attempt, target: input.target } };
    },

    /** Reported by the watchdog when a security component stops checking in. */
    watchdogDown(input: { component: string; silentForMs: number }): SecuritySignal {
      return { id: "security.watchdog-down", data: { component: input.component, silentForMs: input.silentForMs } };
    },

    /** True when this actor has already tripped the authorization burst budget. */
    isAuthorizationBursting(guildId: string, actorId: string) {
      return countInWindow(`auth:${guildId}:${actorId}`) >= authorizationBurst;
    },

    /** True when this layer has already tripped the signature burst budget. */
    isSignatureBursting(layer: string) {
      return countInWindow(`sig:${layer}`) >= signatureBurst;
    },

    reset() {
      hits.clear();
    }
  };
}

export type IntrusionDetector = ReturnType<typeof createIntrusionDetector>;
