/**
 * Shared environment accessors.
 *
 * The bot and the dashboard had each grown their own copy of the same two
 * steps — trim the value, and treat an empty string as absent — plus their own
 * versions of "which values are required" and "are we in production". The
 * duplication is small, but the semantics are load-bearing: a value that trims
 * to "" has to count as *missing*, never as present, or the bot connects to
 * Discord with an empty token while the dashboard boots on an empty session
 * key. One implementation is one place for that rule to be right.
 *
 * `source` is passed in rather than defaulting to `process.env`, so the module
 * holds no global state, stays trivially testable, and keeps the browser-safe
 * surface free of any dependency on a Node-only global.
 */

/** Anything the values can be read from — `process.env` in both apps. */
export type EnvSource = Record<string, string | undefined>;

/**
 * The value of `key`, trimmed, or null when it is unset or blank.
 *
 * Blank counts as absent on purpose. `BOT_TOKEN=` is the normal state of a
 * freshly copied `.env`, and the failure it has to produce is the bot's clean
 * "waiting for secrets" exit — not a gateway login with an empty token.
 */
export function readEnv(source: EnvSource, key: string): string | null {
  const value = source[key];
  return value && value.trim().length > 0 ? value.trim() : null;
}

/** The subset of `keys` that are unset or blank, in the order given. */
export function missingEnv(source: EnvSource, keys: readonly string[]): string[] {
  return keys.filter(key => readEnv(source, key) === null);
}

/**
 * Whether this process runs as production.
 *
 * Read through `readEnv`, so `" production "` counts. A value that was meant to
 * be production but picked up whitespace must not silently downgrade the
 * deployment to development — that is precisely the state that logs an
 * undecided setting and continues, where production would refuse to start.
 */
export function isProduction(source: EnvSource): boolean {
  return readEnv(source, "NODE_ENV") === "production";
}
