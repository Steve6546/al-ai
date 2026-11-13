#!/usr/bin/env node
/**
 * Pre-flight check: does Discord know this redirect URI?
 *
 * The dashboard builds `redirect_uri` from the incoming origin, so a new tunnel
 * address — a quick tunnel, a renamed static domain, a different port — sends a
 * URI Discord has never been told about, and the operator finds out by clicking
 * sign-in and landing on an error page.
 *
 * Discord does expose the list: `GET /applications/@me` with the bot's own token
 * returns `redirect_uris`. (It is worth stating because the dashboard's own
 * comment claims no such API exists, and because the obvious alternative —
 * loading the authorize page in a browser — was measured to be useless while
 * logged out: a registered URI and a nonsense one both render the same login
 * wall, so only a session can tell them apart.)
 *
 *   node scripts/oauth-preflight.mjs [--origin https://host]... [--callback-path /auth/discord/callback]
 *   npm run check:oauth:preflight
 *
 * Reads DISCORD_CLIENT_ID / DASHBOARD_URL / DISCORD_REDIRECT_URI from .env when
 * no origin is given. The bot token is sent to Discord and nowhere else, and is
 * never printed; redirect URIs are not secret and are listed as findings.
 *
 * Exit codes: 0 every origin registered · 1 at least one missing · 2 could not ask.
 */
const API = "https://discord.com/api/v10";

// Discord's documented User-Agent shape. A request without one "may be blocked
// and return a Cloudflare error", and a bare `fetch` from Node sends none.
const USER_AGENT = "DiscordBot (https://github.com/Steve6546/al-ai, 0.1.0)";

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function argAll(name) {
  return process.argv
    .map((value, index) => (value === `--${name}` ? process.argv[index + 1] : null))
    .filter(Boolean);
}

/**
 * Discord matches a redirect URI exactly — scheme, host, port, path and the
 * trailing slash all matter. So the comparison is on the whole URI, never on the
 * host alone, and a registered `…/callback` must not be read as covering `…/callback/`.
 */
function isRedirectUriRegistered(registered, uri) {
  return new Set(registered).has(uri);
}

function originOf(value) {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

async function main() {
  const token = process.env.BOT_TOKEN;
  if (!token) {
    console.log("SKIP  BOT_TOKEN is not set in the environment — the check asks Discord for the app's own record");
    return 2;
  }
  const path = arg("callback-path", "/auth/discord/callback");
  const clientId = process.env.DISCORD_CLIENT_ID ?? "(unknown)";

  const envOrigins = [originOf(process.env.DASHBOARD_URL ?? ""), originOf(process.env.DISCORD_REDIRECT_URI ?? "")].filter(Boolean);
  const given = argAll("origin").map(originOf).filter(Boolean);
  const origins = [...new Set(given.length ? given : envOrigins)];
  if (origins.length === 0) {
    console.log("SKIP  nothing to check: pass --origin https://your-host");
    return 2;
  }

  const response = await fetch(`${API}/applications/@me`, {
    headers: { Authorization: `Bot ${token}`, "User-Agent": USER_AGENT }
  });
  if (!response.ok) {
    console.log(`UNKNOWN  Discord answered ${response.status} — the registered list could not be read`);
    return 2;
  }
  const app = await response.json();
  // `redirect_uris` on this endpoint is what the check reads, and it is not in
  // the official docs for a bot token — the documented shape is
  // `GET /oauth2/applications/@me` with a user Bearer token. So a payload that
  // has no such field is reported as undetermined, never as "nothing is
  // registered": treating an absent field as an empty list would send every
  // operator to add URIs that are already there.
  if (!Array.isArray(app.redirect_uris)) {
    console.log(`UNKNOWN  Discord returned no redirect_uris field (keys: ${Object.keys(app).slice(0, 10).join(",")})`);
    console.log("the documented alternative is GET /oauth2/applications/@me with a user token");
    return 2;
  }
  const registered = app.redirect_uris;

  console.log(`application ${app.id} (${app.name}) — ${registered.length} redirect URI(s) registered`);
  for (const uri of registered) console.log(`   registered: ${uri}`);
  console.log("");

  const missing = [];
  for (const origin of origins) {
    const uri = `${origin}${path}`;
    const ok = isRedirectUriRegistered(registered, uri);
    console.log(`${ok ? "REGISTERED " : "MISSING    "} ${uri}`);
    if (!ok) missing.push(uri);
  }

  console.log("");
  if (missing.length === 0) {
    console.log(`every origin can complete sign-in (client id ${clientId})`);
    return 0;
  }
  console.log(`${missing.length} URI(s) are not registered. Add them in the Developer Portal → OAuth2 → Redirects;`);
  console.log("the API reads the list but does not write it.");
  return 1;
}

process.exitCode = await main();
