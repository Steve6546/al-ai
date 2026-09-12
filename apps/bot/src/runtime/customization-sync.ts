/**
 * Customization sync.
 *
 * The dashboard writes the bot's per-guild identity to the database; only the bot
 * can apply it to Discord. This runs on a timer so a dashboard change takes effect
 * without a restart, and it remembers what it already applied so an unchanged
 * value is never re-sent.
 *
 * GOVERNANCE rule 18: the appearance the dashboard stores is exactly the
 * appearance this module applies — same shape, same normalisation, no field that
 * saves without taking effect.
 *
 * Dependencies are injected so the decision logic can be tested without Discord.
 */

import { normaliseCustomization, type CustomizationSettings } from "@al-ai/core";

/**
 * The bot's per-guild presence: nickname plus the colour and icon of its own
 * role. This is an alias of the shared contract rather than a second declaration,
 * because a shape that exists twice is a shape that can drift — which is exactly
 * how the retired `avatarUrl`/`bannerUrl` fields came to be saved and never read.
 */
export type GuildAppearance = CustomizationSettings;

export type CustomizationSyncDeps = {
  guildIds: () => string[];
  loadAppearance: (guildId: string) => Promise<GuildAppearance>;
  /** Applies the whole appearance and reports whether Discord accepted it. */
  applyAppearance: (guildId: string, appearance: GuildAppearance) => Promise<boolean>;
  onError?: (guildId: string, error: unknown) => void;
};

/** Stable key so an unchanged appearance is recognised without deep comparison. */
function keyOf(appearance: GuildAppearance) {
  return `${appearance.nickname}\u0000${appearance.roleColor ?? ""}\u0000${appearance.roleIconUrl ?? ""}`;
}

export function createCustomizationSync(deps: CustomizationSyncDeps) {
  const applied = new Map<string, string>();

  return {
    /** Applies whatever changed. Safe to call repeatedly. */
    async run() {
      for (const guildId of deps.guildIds()) {
        let desired: GuildAppearance;
        try {
          // Normalised on the way in, with the same rules the BFF applied on the
          // way out, so "  AL AI  " and "AL AI" are recognised as one value and
          // Discord never receives padding it would reject.
          desired = normaliseCustomization(await deps.loadAppearance(guildId));
        } catch (error) {
          deps.onError?.(guildId, error);
          continue;
        }

        const key = keyOf(desired);
        if (applied.get(guildId) === key) continue;

        const ok = await deps.applyAppearance(guildId, desired).catch(error => {
          deps.onError?.(guildId, error);
          return false;
        });
        // Only remember a value Discord actually accepted, so a failed call is retried.
        if (ok) applied.set(guildId, key);
      }
    },

    /** Exposed for tests and for the shutdown path. */
    applied(guildId: string) {
      return applied.get(guildId);
    },

    forget(guildId: string) {
      applied.delete(guildId);
    }
  };
}

export type CustomizationSync = ReturnType<typeof createCustomizationSync>;
