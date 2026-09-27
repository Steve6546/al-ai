/**
 * Discord snowflake validation.
 *
 * Every layer of AL AI accepts a Discord id from somewhere it does not fully
 * trust: the router sees a URL segment, the command registry sees a stored
 * scope list, the anti-nuke engine sees a quarantine role id, the deploy script
 * sees a CLI flag. Each of those used to carry its own copy of the same
 * expression, which is how they would eventually disagree — one accepting a
 * 16-digit id, another rejecting a 21-digit one, and the difference surfacing
 * only as an id that one layer kept and another dropped.
 *
 * The rule is defined once here so a snowflake is the same shape everywhere it
 * is checked.
 *
 * Snowflakes are 17–20 decimal digits. Discord has never issued a shorter one,
 * and the epoch means a longer one is not imminent — but the floor is what
 * matters: this is what stops a mention, a username or the string "abc" from
 * becoming a guild id that reaches Discord's API.
 */

export const SNOWFLAKE_PATTERN = /^\d{17,20}$/;

/** True for a string shaped like a Discord id. `null` and numbers are not. */
export function isSnowflake(value: unknown): value is string {
  return typeof value === "string" && SNOWFLAKE_PATTERN.test(value.trim());
}

/**
 * Returns the trimmed id, or `null` if it is not snowflake-shaped.
 *
 * `null` rather than `undefined`: the callers store the result next to
 * "not configured", and `null` is what that column already means.
 */
export function normaliseSnowflake(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return SNOWFLAKE_PATTERN.test(trimmed) ? trimmed : null;
}

/**
 * Strips `<@>` and `<@!>` mention wrapping, leaving the bare id.
 *
 * The operator copies a mention from Discord because that is what they have to
 * hand; the raw mention is not snowflake-shaped, so it has to be reduced before
 * `isSnowflake` can judge it.
 *
 * Deliberately does **not** strip the `&` of a role mention (`<@&123>`): the
 * only caller is a *member* scope, where a role id would be accepted as a
 * member id and then fail to resolve to a name. Leaving the `&` in place keeps
 * that rejected, which is what the field's own validation already did.
 */
export function mentionToSnowflake(value: string): string {
  return value.trim().replace(/[<@!>]/g, "");
}

/**
 * Keeps only the unique, snowflake-shaped ids, at most `limit` of them.
 *
 * The limit is the caller's contract with Discord, not a convenience: a scope
 * list that grows without bound is a list that stops being reviewable.
 */
export function filterSnowflakes(values: unknown[], limit: number): string[] {
  return [...new Set(values.filter((id): id is string => isSnowflake(id)))].slice(0, limit);
}
