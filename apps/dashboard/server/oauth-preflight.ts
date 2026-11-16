/**
 * Does Discord actually know the callback this deployment will send?
 *
 * The dashboard builds `redirect_uri` from `DISCORD_REDIRECT_URI` (or the
 * request origin, when that origin is allowlisted), and Discord matches it
 * byte-for-byte against the list registered in the Developer Portal. When the
 * deployment's public hostname is not in that list — a new platform subdomain,
 * a renamed tunnel, a fresh clone pointed at a new domain — nothing fails at
 * build time, nothing fails at boot, and the first symptom is the operator
 * clicking «تسجيل الدخول» and landing on Discord's `Invalid OAuth2 redirect_uri`.
 * The server log says nothing at all, because the request never came back.
 *
 * This was a live production defect: the registered list held `localhost` and a
 * stale ngrok hostname while the deployment had moved to its platform domain,
 * so sign-in could not complete. `scripts/oauth-preflight.mjs` catches it, but a
 * script only helps whoever remembers to run it; the check below runs at boot,
 * where the mismatch is a fact the process already knows.
 *
 * Two deliberate limits:
 *
 *   - The registered list is readable with the bot token but **not writable**
 *     (a `PATCH` is accepted and silently ignored), so this can only report.
 *     It never throws: an unreachable Discord or a token that cannot read the
 *     application must not stop a dashboard that is otherwise healthy.
 *   - An absent `redirect_uris` field means "could not tell", never "nothing is
 *     registered" — treating the two alike would warn every operator whose
 *     token cannot read the field.
 */

const DISCORD_API = "https://discord.com/api/v10";

/** Discord's documented User-Agent shape; a bare `fetch` sends none. */
const USER_AGENT = "DiscordBot (https://github.com/Steve6546/al-ai, 0.1.0)";

/**
 * The operator-facing sentence for a missing registration, or null when the
 * callback is registered (or when Discord did not report the list at all).
 *
 * Pure on purpose: the wording is the part that has to be right, and it is
 * cheaper to pin in a test than to discover in production.
 */
export function redirectRegistrationWarning(
  registered: readonly string[] | null,
  redirectUri: string
): string | null {
  if (!registered) return null;
  if (registered.includes(redirectUri)) return null;
  const listed = registered.length ? registered.join(", ") : "(none)";
  return (
    `Discord has not registered this deployment's OAuth callback: ${redirectUri}. ` +
    `Sign-in fails with «Invalid OAuth2 redirect_uri» until it is added in the ` +
    `Developer Portal → OAuth2 → Redirects (the API reads the list but cannot write it). ` +
    `Currently registered: ${listed}.`
  );
}

/**
 * Ask Discord for the application's registered callbacks and compare.
 *
 * Returns the warning to log, or null when there is nothing to say. Never
 * throws: a failed lookup is reported as null, because "Discord did not answer"
 * is not evidence that the deployment is misconfigured.
 */
export async function checkRedirectRegistration(input: {
  botToken: string | null;
  redirectUri: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<string | null> {
  if (!input.botToken) return null;
  const doFetch = input.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 5_000);
  try {
    const response = await doFetch(`${DISCORD_API}/applications/@me`, {
      headers: { Authorization: `Bot ${input.botToken}`, "User-Agent": USER_AGENT },
      signal: controller.signal
    });
    if (!response.ok) return null;
    const application = (await response.json()) as { redirect_uris?: unknown };
    const registered = Array.isArray(application.redirect_uris)
      ? application.redirect_uris.filter((value): value is string => typeof value === "string")
      : null;
    return redirectRegistrationWarning(registered, input.redirectUri);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
