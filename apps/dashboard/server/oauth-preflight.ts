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
 * This was a live production defect, and it had a second layer that made it
 * nearly invisible from the outside: the redirect *had* been added, but to a
 * **different application** than the one `DISCORD_CLIENT_ID` and `BOT_TOKEN`
 * name. The portal looked correct; the deployment was still broken. So the check
 * reports *which* application answered, not just whether the URI matched — two
 * applications side by side is the shape that misleads.
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

/** The application Discord answered with, for the operator to compare. */
export type DiscordApplication = { id: string; name: string };

/**
 * The verdict, as a value rather than a string.
 *
 * `unknown` is a first-class answer: it is what a missing token, a refused
 * request or a Discord outage produce, and it must never be rendered as
 * "misconfigured". Only `missing` is evidence.
 *
 * The application identity is carried in *every* answer, not only the failing
 * one, because the two-application trap produces a "registered" verdict too: the
 * callback can be registered on the token's application while
 * `DISCORD_CLIENT_ID` names a different one, and then the authorize URL asks an
 * application that has never heard of the callback.
 */
export type RedirectRegistration = {
  status: "registered" | "missing" | "unknown";
  redirectUri: string;
  registered: string[];
  application: DiscordApplication | null;
  /** Present only for `unknown`: why the question could not be answered. */
  reason?: string;
};

/** The operator-facing sentence for a missing registration. */
export function describeMissingRegistration(state: RedirectRegistration): string {
  const app = state.application ? `application ${state.application.id} (${state.application.name})` : "the application";
  const listed = state.registered.length ? state.registered.join(", ") : "(none)";
  return (
    `Discord has not registered this deployment's OAuth callback on ${app}: ${state.redirectUri}. ` +
    `Sign-in fails with «Invalid OAuth2 redirect_uri» until it is added in the ` +
    `Developer Portal → OAuth2 → Redirects (the API reads the list but cannot write it). ` +
    `Currently registered: ${listed}.`
  );
}

/**
 * Ask Discord for the application's registered callbacks and compare.
 *
 * Never throws: a failed lookup is `unknown`, because "Discord did not answer"
 * is not evidence that the deployment is misconfigured.
 */
export async function checkRedirectRegistration(input: {
  botToken: string | null;
  redirectUri: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<RedirectRegistration> {
  const blank: RedirectRegistration = { status: "unknown", redirectUri: input.redirectUri, registered: [], application: null };
  if (!input.botToken) return { ...blank, reason: "BOT_TOKEN is not set" };
  const doFetch = input.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 5_000);
  try {
    const response = await doFetch(`${DISCORD_API}/applications/@me`, {
      headers: { Authorization: `Bot ${input.botToken}`, "User-Agent": USER_AGENT },
      signal: controller.signal
    });
    if (!response.ok) return { ...blank, reason: `Discord answered ${response.status}` };
    const application = (await response.json()) as { id?: unknown; name?: unknown; redirect_uris?: unknown };
    if (!Array.isArray(application.redirect_uris)) {
      return { ...blank, reason: "the application payload carried no redirect_uris" };
    }
    const registered = application.redirect_uris.filter((value): value is string => typeof value === "string");
    const identity =
      typeof application.id === "string"
        ? { id: application.id, name: typeof application.name === "string" ? application.name : "" }
        : null;
    return {
      status: registered.includes(input.redirectUri) ? "registered" : "missing",
      redirectUri: input.redirectUri,
      registered,
      application: identity
    };
  } catch (error) {
    return { ...blank, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether `DISCORD_CLIENT_ID` names the same application the token belongs to.
 *
 * A mismatch is a different failure with the same symptom: the authorize URL is
 * built from `DISCORD_CLIENT_ID`, the callback is registered on the *token's*
 * application, and Discord rejects the pair. Nothing else in the deployment
 * compares the two, so copying one variable without the other is invisible
 * until sign-in.
 */
export function clientIdMismatch(clientId: string | null, application: DiscordApplication | null): string | null {
  if (!clientId || !application) return null;
  if (clientId === application.id) return null;
  return (
    `DISCORD_CLIENT_ID is ${clientId}, but BOT_TOKEN belongs to application ${application.id} (${application.name}). ` +
    `The authorize URL is built from DISCORD_CLIENT_ID while the callback is registered on the token's application, ` +
    `so Discord rejects the pair. Point both at the same application.`
  );
}
