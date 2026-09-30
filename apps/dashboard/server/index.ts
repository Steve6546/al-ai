import { randomBytes } from "node:crypto";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import { join } from "node:path";
import {
  assertDisjointTierRoles,
  assertUniqueChannelAssignment,
  ANTI_NUKE_ACTION_LABELS,
  ANTI_NUKE_ACTIONS,
  ANTI_NUKE_LIMIT_KEYS,
  assessRoleHierarchy,
  assessRoleIconGate,
  commandFlagsFor,
  commandCategories,
  commandCategoryDescriptions,
  commandCategoryLabels,
  decryptSecret,
  DEFAULT_EMBED_COLOR,
  DEFAULT_LOGGING_MODE,
  describeVerification,
  deriveBotStatus,
  discordPermissionLabels,
  imageRejectionReason,
  isHeartbeatFresh,
  isLoggingMode,
  INTERNAL_DESTINATIONS,
  LAYER_SIGNATURE_TTL_MS,
  logDestinations,
  LOG_CATEGORY_NAME,
  MAX_ACTIVITY_TEXT_LENGTH,
  MAX_BIO_LENGTH,
  MAX_IMAGE_DATA_URL_LENGTH,
  MAX_NICKNAME_LENGTH,
  durationToMs,
  isBotStatusDuration,
  isTimedBotStatus,
  normaliseBotIdentity,
  normaliseCommandConfig,
  eventSchema,
  normaliseHexColor,
  normaliseImageDataUrl,
  normaliseImageValue,
  normaliseNickname,
  normaliseRoleIds,
  normaliseSnowflake,
  normaliseTierRoles,
  normaliseAntiNukeConfig,
  normaliseWelcomeSettings,
  requireCommand,
  SESSION_COOKIE_NAME,
  summarisePunishments,
  verifyLayerRequest,
  widgetOnlineNote,
  type ActivityEntry,
  type AntiNukeConfig,
  type WelcomeSettings,
  type BotIdentitySettings,
  type ChannelOption,
  type CommandConfig,
  type CustomizationSettings,
  type GuildMetrics,
  type LogDestination,
  type LoggingMode,
  type LoggingSettings,
  type HealthSnapshot,
  type PermissionStatus,
  type Tier,
  DISCORD_PERMISSION_BITS,
  LOGIN_SCOPES
} from "@al-ai/core";
import { loadEnv } from "./env.js";
import { createDatabase, createPool } from "./db.js";
import { clearedCookieHeader, destroySession, issueSession, parseCookies, policyCookieHeader, readSession, sessionAccessToken, sessionCookieHeader } from "./session.js";
import { assertTier, AuthorizationError, botIdentityPermissionStatus, resolveActorTier } from "./authorization.js";
import { appendAudit } from "./audit.js";
import {
  buildAuthorizeUrl,
  buildBotInviteUrl,
  exchangeCode,
  fetchBotGuildIds,
  fetchGuildChannels,
  fetchBotPermissions,
  fetchGuildHierarchy,
  fetchGuildMemberCached,
  fetchGuildPremiumTier,
  fetchGuildRoles,
  fetchBotHighestRolePosition,
  fetchIdentity,
  fetchUserGuildsCached,
  fetchWidgetPresence,
  invalidateBotGuildCache,
  invalidateGuildReadCache,
  isAuthFailure,
  isRateLimited,
  resolveBotUserId,
  userAvatarUrl,
  userBannerUrl,
  hasPermission,
  createGuildChannel,
  deleteGuildChannel,
  describeChannelFailure,
  categoryHasChildren,
  findGuildCategory,
  fetchRawChannels,
  DISCORD_GUILD_CHANNEL_CAP,
  fetchExistingChannelIds,
  writeWithRetry,
  type DiscordApiError,
  type DiscordRole
} from "./discord.js";
import { clientKey, RequestThrottle } from "./cache.js";
import { describeGuildAccess, isAdministrable } from "./guild-access.js";
import { createNetworkManager, packOAuthState, unpackOAuthState } from "./network.js";
import {
  applyAppearance,
  invalidateAppearanceSnapshot,
  readAppearanceSnapshot,
  resolveRoleIconWrite,
  type AppearanceField,
  type AppearanceSnapshot,
  type FieldOutcome
} from "./appearance.js";

const env = loadEnv();
const pool = createPool(env.databaseUrl);
const db = createDatabase(pool);

const app = Fastify({ logger: true, trustProxy: true });

/**
 * The deployment's network reach. Loaded from `instance_settings` at boot, so
 * the mode the operator chose survives a restart and a tunnel mode resumes its
 * `cloudflared` process on its own. The gate hook below consults this on every
 * request.
 */
const network = createNetworkManager({
  port: env.port,
  getMode: () => db.getSetting("remote_access_mode"),
  setMode: value => db.setSetting("remote_access_mode", value),
  log: app.log
});
await network.boot();

/* ------------------------------------------------------------------ *
 * Request throttle
 *
 * A ceiling on how fast one client may hit the API, so a flood cannot consume
 * the Discord budget AL AI needs for its own reads — a 429 from Discord is what
 * makes the dashboard look broken, and the operator has no way to see why.
 *
 * The rule that matters most: **a real session is never throttled in
 * practice.** The operator must not be locked out of their own dashboard by a
 * protection meant for strangers. The limit below is sized so a dashboard
 * session cannot reach it — a screen load is a handful of calls and the
 * slowest poll is one every 30 seconds — while still bounding a flood to a
 * rate the BFF and Discord can absorb.
 *
 * Exempting any request whose cookie header merely *contains* the session name
 * was the earlier approach, and it was bypassable: the exemption ran in an
 * `onRequest` hook before the cookie was ever validated, so a forged or empty
 * `al_ai_session=` bought a free ride for exactly the traffic this exists to
 * bound. The session is verified by `requireSession` inside each route, which
 * is *after* this hook, so it cannot be the thing the exemption leans on.
 *
 * `/internal/` is exempt for the same reason from the other side — it is the
 * bot's own signed heartbeat, arriving every 30 seconds from loopback.
 * ------------------------------------------------------------------ */
const API_THROTTLE_WINDOW_MS = 60_000;
const API_THROTTLE_MAX = 120;
const throttle = new RequestThrottle(API_THROTTLE_WINDOW_MS, API_THROTTLE_MAX);

/**
 * The reach gate: which origins this dashboard answers at all.
 *
 * The mode is an instance-wide setting («الوصول للشبكة»), and "off" is the
 * deployment default — the dashboard then answers loopback only, so a LAN
 * address typed into another device gets a plain refusal rather than a login
 * screen. The Host header is the origin the browser actually believes it is
 * talking to, and the allowlist is exact (loopback, the machine's own
 * addresses, and the one tunnel host) rather than "any private address", so a
 * crafted Host cannot slip past. Runs before the throttle: an unreachable
 * visitor should learn why in one response, not be metered first.
 */
app.addHook("onRequest", async (request, reply) => {
  if (network.isHostAllowed(request.headers.host)) return;
  return reply.code(403).send({
    error: "REMOTE_ACCESS_DISABLED",
    message: "الوصول إلى هذه اللوحة من خارج الجهاز المضيف معطّل. شغّل «الوصول للشبكة» من شاشة النظام داخل اللوحة."
  });
});

app.addHook("onRequest", async (request, reply) => {
  const url = request.url;
  // Static assets are not throttled: a single page load legitimately fetches a
  // handful of them, and none of them touch Discord.
  if (!url.startsWith("/api/") && !url.startsWith("/auth/")) return;
  if (url.startsWith("/internal/")) return;

  // The socket peer, not `request.ip`: `trustProxy` makes `request.ip` whatever
  // the caller put in `x-forwarded-for`, which would hand the flood its own key.
  const verdict = throttle.check(clientKey(request.socket.remoteAddress), Date.now());
  if (verdict.allowed) return;

  return reply
    .code(429)
    .header("retry-after", String(verdict.retryAfterSeconds))
    .send({
      error: "TOO_MANY_REQUESTS",
      message: `عدد كبير من الطلبات. أعد المحاولة بعد ${verdict.retryAfterSeconds} ثانية.`
    });
});

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

async function requireSession(request: FastifyRequest, reply: FastifyReply) {
  const session = await readSession(db, request as unknown as { headers: Record<string, unknown> });
  if (!session) {
    reply.code(401).send({ error: "UNAUTHENTICATED", message: "الجلسة منتهية أو غير موجودة. سجّل الدخول عبر Discord." });
    return null;
  }
  return session;
}

/**
 * Reads the caller's Discord guild list, or answers the request itself when the
 * read cannot be satisfied.
 *
 * The three failures are answered differently, because they mean different
 * things to the operator — and conflating them is what made pressing refresh
 * too fast sign people out:
 *
 * - **The token was refused (401).** Authentication is over. The session is
 *   destroyed so the UI falls back to the sign-in screen instead of showing
 *   "unexpected error" forever with no way forward.
 * - **Discord is rate limiting us (429).** The session is perfectly valid and
 *   the same request works in a moment. The session is deliberately **not**
 *   touched; answering with a retry hint is the whole fix.
 * - **Anything else.** A transient fault on Discord's side, reported as such.
 *
 * Every caller reads through here so the list route and the per-guild guards
 * cannot disagree about what a given failure means.
 */
/**
 * Turn a chosen status duration into the instant it lapses, or null.
 *
 * Three cases, and they are genuinely different:
 *
 * - **The status carries no duration.** Discord offers no sub-menu for `online`,
 *   so there is nothing to expire and the stored expiry is cleared. Leaving a
 *   stale timestamp here is what would make a later `dnd` appear pre-expired.
 * - **`forever`.** A real choice with no end, stored as a null expiry. It is
 *   *not* the same as "no duration": the popover has to show the tick beside
 *   `دائم` when it reopens, and only a stored duration can do that.
 * - **A real window.** Now plus the duration. Computed server-side because the
 *   client's clock is not authoritative.
 */
function statusExpiryFor(
  status: unknown,
  duration: unknown,
  previousExpiry: string | null,
  now: number
): string | null {
  if (!isTimedBotStatus(status) || !isBotStatusDuration(duration)) return null;

  const ms = durationToMs(duration);
  if (ms === null) return null;

  // Re-saving the same window without touching the duration keeps the original
  // deadline rather than silently restarting the clock. Otherwise pressing save
  // to change the nickname would hand the operator a fresh 8 hours, which is a
  // change they did not ask for.
  if (previousExpiry !== null && Date.parse(previousExpiry) > now) return previousExpiry;

  return new Date(now + ms).toISOString();
}

async function loadUserGuilds(
  request: FastifyRequest,
  reply: FastifyReply,
  session: NonNullable<Awaited<ReturnType<typeof readSession>>>
) {
  try {
    return await fetchUserGuildsCached(sessionAccessToken(session, env));
  } catch (error) {
    if (isAuthFailure(error)) {
      await destroySession(db, request as unknown as { headers: Record<string, unknown> }).catch(() => undefined);
      reply
        .code(401)
        .header("set-cookie", clearedCookieHeader())
        .send({ error: "SESSION_EXPIRED", message: "انتهت صلاحية الدخول عبر Discord. سجّل الدخول من جديد." });
      return null;
    }

    if (isRateLimited(error)) {
      const wait = Math.max(1, Math.ceil((error as DiscordApiError).retryAfterSeconds ?? 1));
      reply
        .code(429)
        .header("retry-after", String(wait))
        .send({ error: "RATE_LIMITED", message: `Discord يحدّ عدد الطلبات مؤقتاً. أعد المحاولة بعد ${wait} ثانية.` });
      return null;
    }

    app.log.error(error, "Discord guild list read failed");
    reply.code(503).send({ error: "DISCORD_UNAVAILABLE", message: "تعذّر الوصول إلى Discord. أعد المحاولة." });
    return null;
  }
}

/**
 * Resolves the caller's membership of one guild, or answers the request itself.
 *
 * Shared by the read guard and the write guard so the two cannot disagree about
 * who may reach a guild: a route that reads a guild and a route that writes to
 * it must give the same answer to "does this caller belong here?".
 */
async function resolveGuildMembership(request: FastifyRequest, reply: FastifyReply, guildId: string) {
  const session = await requireSession(request, reply);
  if (!session) return null;

  const userGuilds = await loadUserGuilds(request, reply, session);
  if (!userGuilds) return null;

  const membership = userGuilds.find(guild => guild.id === guildId);
  if (!membership) {
    reply.code(403).send({ error: "NOT_A_MEMBER", message: "لا تملك وصولاً إلى هذا السيرفر." });
    return null;
  }

  return { session, membership };
}

/**
 * Read guard for every guild-scoped route.
 *
 * Being signed in is not the same as being entitled to a guild. Without this,
 * any authenticated account could read any guild's channels, audit trail and
 * settings by pasting a guild id into the URL — the id is not a secret, it is
 * visible in every invite link. The check is the same one the selector applies
 * (`isAdministrable`), so a guild cannot be listed as manageable and then
 * refuse to open, nor be openable while hidden from the list.
 */
async function requireGuildAccess(request: FastifyRequest, reply: FastifyReply, guildId: string) {
  const context = await resolveGuildMembership(request, reply, guildId);
  if (!context) return null;

  if (!isAdministrable(context.membership.permissions)) {
    reply.code(403).send({ error: "FORBIDDEN", message: "صلاحيتك لا تسمح بالوصول إلى هذا السيرفر." });
    return null;
  }

  return context;
}

/** Re-resolves the caller's tier on the server for every write. */
async function requireTierForGuild(request: FastifyRequest, reply: FastifyReply, guildId: string, required: Tier = "admin") {
  const context = await resolveGuildMembership(request, reply, guildId);
  if (!context) return null;
  const { session, membership } = context;

  const tier = await resolveActorTier({
    db,
    botToken: env.botToken,
    guildId,
    discordUserId: session.discordUserId,
    userIsGuildOwner: membership.owner,
    // Discord's own permission bitfield, not a claim from the browser: an
    // Administrator holds the top tier with no configuration.
    userIsAdministrator: hasPermission(membership.permissions, DISCORD_PERMISSION_BITS.ADMINISTRATOR)
  });

  try {
    assertTier(tier, required);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      await appendAudit(db, env, {
        guildId,
        eventId: "bot.security-rejection",
        actorId: session.discordUserId,
        payload: { action: request.url, reason: `TIER_BELOW_${required.toUpperCase()}` }
      });
      reply.code(403).send({ error: error.code, message: error.message });
      return null;
    }
    throw error;
  }

  return { session, tier, membership };
}

/**
 * Decrypts an audit payload for an authorized reader.
 * A payload that cannot be decrypted (for example after a key rotation that
 * dropped the old key) is reported as unavailable rather than thrown, so one
 * unreadable row never breaks the whole trail view.
 */
function safeDecrypt(ciphertext: string, key: string): Record<string, unknown> | null {
  try {
    return JSON.parse(decryptSecret(ciphertext, key)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
  // Security failures never leak internals to the browser.
  const status = error instanceof AuthorizationError ? 403 : (error.statusCode ?? 500);
  if (status >= 500) app.log.error(error);
  reply.code(status).send({ error: status === 403 ? "FORBIDDEN" : "INTERNAL", message: status >= 500 ? "حدث خطأ غير متوقع." : error.message });
});

/* ------------------------------------------------------------------ *
 * Layer-to-layer guard (HMAC + single-use nonce, 5 minute window)
 * ------------------------------------------------------------------ */
async function verifyLayerCall(request: FastifyRequest, reply: FastifyReply) {
  const nonce = request.headers["x-al-nonce"] as string | undefined;
  const timestamp = request.headers["x-al-timestamp"] as string | undefined;
  const signature = request.headers["x-al-signature"] as string | undefined;
  if (!nonce || !timestamp || !signature) {
    reply.code(401).send({ error: "LAYER_SIGNATURE_MISSING" });
    return false;
  }
  try {
    await verifyLayerRequest(
      { nonce, timestamp, signature, body: JSON.stringify(request.body ?? {}) },
      env.eventHmacSecret,
      async () => db.consumeNonce(nonce, "bot", LAYER_SIGNATURE_TTL_MS),
      Date.now()
    );
    return true;
  } catch (error) {
    reply.code(401).send({ error: (error as Error).message });
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Health
 * ------------------------------------------------------------------ */
app.get("/api/health", async (): Promise<HealthSnapshot> => {
  let database: "reachable" | "unreachable" = "reachable";
  let guildCount = 0;
  let uniqueUsers = 0;
  let heartbeatAt: Date | null = null;
  try {
    await db.ping();
    guildCount = await db.countGuilds();
    uniqueUsers = await db.countUniqueUsers();
    heartbeatAt = await db.latestHeartbeatAt();
  } catch {
    database = "unreachable";
  }

  // A configured token says the bot *could* run; only a heartbeat inside the
  // staleness window says it *is* running. Deriving this from `env.botToken`
  // alone is how this endpoint used to report "connected" for a bot that had
  // been gone for hours — the same class of lie as a ping of 0.
  //
  // The window is `isHeartbeatFresh`, the same rule the guild metrics route
  // reaches through `deriveBotStatus`. This route used to carry its own copy of
  // the comparison over the same constant, so the overview and the health
  // endpoint could have disagreed about whether the bot was live.
  const heartbeatFresh = isHeartbeatFresh(heartbeatAt?.toISOString() ?? null, Date.now());
  const bot: HealthSnapshot["bot"] = !env.botToken
    ? "awaiting_secret"
    : heartbeatFresh
      ? "connected"
      : "configured";

  return {
    status: database === "reachable" ? "healthy" : "degraded",
    dashboard: "online",
    bot,
    database,
    gateway: { eventsLastMinute: 0, ceiling: 120 },
    // Discord's review threshold counts guilds, while its warning threshold counts
    // unique users. describeVerification owns both so the two units cannot be
    // compared against each other again.
    verification: describeVerification({ guildCount, uniqueUsers })
  };
});

/** Called by the bot's supervisor. Signed, nonce-protected, never public. */
app.post("/internal/layer/health", async (request, reply) => {
  if (!(await verifyLayerCall(request, reply))) return;
  const body = request.body as
    | { guildId?: string; state?: string; botPresent?: boolean; gatewayEvents?: number; uniqueUsers?: number }
    | undefined;
  if (!body?.guildId) return reply.code(400).send({ error: "GUILD_ID_REQUIRED" });
  await db.upsertHealth(
    body.guildId,
    body.state ?? "unknown",
    Boolean(body.botPresent),
    body.gatewayEvents ?? 0,
    Math.max(0, Math.trunc(body.uniqueUsers ?? 0) || 0)
  );
  return { accepted: true };
});

/* ------------------------------------------------------------------ *
 * Auth
 * ------------------------------------------------------------------ */

/**
 * The OAuth `state` cookie.
 *
 * Set on every leg that leaves for Discord — signing in and inviting the bot
 * alike — and checked on the way back. `SameSite=Lax` is what lets it survive
 * Discord's cross-site redirect while still being withheld from cross-site
 * POSTs. The value is single-use in effect: the callback compares it and the
 * next leg overwrites it. Built on the shared policy serializer so it inherits
 * the session cookie's `Secure` flag instead of hand-rolling a second copy.
 */
function stateCookieHeader(state: string) {
  return policyCookieHeader(`${SESSION_COOKIE_NAME}_state`, state, 600);
}

function newOAuthState() {
  return randomBytes(16).toString("base64url");
}

/**
 * The origin this request's browser believes it is on, e.g.
 * `http://192.168.1.195:3000`. `trustProxy` is on, so behind the tunnel
 * `request.protocol` reads the `x-forwarded-proto` Cloudflare sets rather than
 * the tunnel's own cleartext hop.
 */
function requestOrigin(request: FastifyRequest): string {
  return `${request.protocol}://${request.headers.host ?? ""}`;
}

/**
 * The redirect URI for an OAuth leg that starts at `origin`, or the configured
 * default when that origin is not one this deployment serves. The default is
 * the safe fallback, not a hole: Discord compares the token-exchange redirect
 * URI against the authorize leg's, so an origin that was never allowed fails
 * at Discord instead of minting a session.
 */
function redirectUriForOrigin(origin: string): string {
  if (network.isOriginAllowed(origin)) return `${origin}/auth/discord/callback`;
  return env.redirectUri;
}

app.get("/api/session", async request => {
  const session = await readSession(db, request as unknown as { headers: Record<string, unknown> });
  if (!session) return { authenticated: false, user: null };
  return {
    authenticated: true,
    user: {
      id: session.discordUserId,
      username: session.discordUsername,
      // Resolved server-side so the browser never builds a CDN URL itself.
      avatarUrl: userAvatarUrl(session.discordUserId, session.discordAvatar),
      expiresAt: session.expiresAt
    }
  };
});

/**
 * Write guard for instance-wide deployment settings.
 *
 * Remote access does not belong to a guild, so the usual per-guild tier check
 * does not apply. The honest equivalent: the caller must administer at least
 * one guild *this deployment's bot actually serves*. Owning an unrelated server
 * elsewhere on Discord must not buy the keys to somebody else's deployment.
 */
async function requireInstanceAdmin(request: FastifyRequest, reply: FastifyReply) {
  const session = await requireSession(request, reply);
  if (!session) return null;
  const userGuilds = await loadUserGuilds(request, reply, session);
  if (!userGuilds) return null;
  const botGuildIds = env.botToken
    ? await fetchBotGuildIds(env.botToken).catch(() => new Set<string>())
    : new Set<string>();
  const administrates = userGuilds.some(
    guild => botGuildIds.has(guild.id) && isAdministrable(guild.permissions)
  );
  if (!administrates) {
    reply.code(403).send({ error: "FORBIDDEN", message: "إعدادات النظام لمشرفي سيرفرات يعمل فيها هذا البوت." });
    return null;
  }
  return session;
}

/** Read: the current reach, for the «الوصول للشبكة» screen. */
app.get("/api/network", async (request, reply) => {
  if (!(await requireSession(request, reply))) return;
  return network.snapshot();
});

app.put("/api/network", async (request, reply) => {
  const session = await requireInstanceAdmin(request, reply);
  if (!session) return;

  const body = request.body as { mode?: unknown } | undefined;
  const snapshot = await network.setMode(body?.mode);

  await appendAudit(db, env, {
    guildId: null,
    eventId: "bot.command-success",
    actorId: session.discordUserId,
    payload: { action: "network.mode", mode: snapshot.mode, tunnelUrl: snapshot.tunnelUrl }
  });

  return snapshot;
});

app.get("/auth/discord/login", async (request, reply) => {
  // The state cookie stores the packed value — random plus origin — so the
  // byte-for-byte comparison at the callback covers the origin too.
  const origin = requestOrigin(request);
  const state = packOAuthState(origin, newOAuthState());
  reply.header("Set-Cookie", stateCookieHeader(state));
  return reply.redirect(
    buildAuthorizeUrl({
      clientId: env.clientId,
      redirectUri: redirectUriForOrigin(origin),
      state,
      scopes: LOGIN_SCOPES
    })
  );
});

app.get("/auth/discord/callback", async (request, reply) => {
  const query = request.query as { code?: string; state?: string; error?: string; guild_id?: string };
  if (query.error) return reply.redirect("/?auth=denied");
  const cookies = parseCookies(request.headers.cookie);
  if (!query.code || !query.state || cookies[`${SESSION_COOKIE_NAME}_state`] !== query.state) {
    return reply.redirect("/?auth=state_mismatch");
  }

  // Discord returns `guild_id` only when this leg was a bot authorization — the
  // operator added AL AI to a server — and it answers that leg with an
  // *application-level* code, not the operator's. Exchanging it would mint a
  // session whose Discord identity is the bot application itself, and whose
  // `/users/@me/guilds` read returns every guild the bot occupies carrying the
  // Administrator permissions the invite requests: owner-tier dashboard access
  // to servers the operator does not run. This leg never needed a session at
  // all — only a fresh bot-guild list, so the selector flips from «غير مضاف»
  // to «نشط» instead of waiting for the TTL. The `state` check above is still
  // what guards the redirect.
  if (query.guild_id) {
    invalidateBotGuildCache();
    return reply.redirect("/?auth=bot_added");
  }

  try {
    // Unpack the origin the login leg started from and repeat its redirect URI.
    // A state that does not carry one (a leg from a previous deployment) falls
    // back to the configured default, matching what that leg would have sent.
    const origin = unpackOAuthState(query.state);
    const redirectUri = origin ? redirectUriForOrigin(origin) : env.redirectUri;
    const tokens = await exchangeCode({ clientId: env.clientId, clientSecret: env.clientSecret, redirectUri, code: query.code });

    // The token must actually grant the login scopes. A code issued for any
    // other authorization does not carry them, and trusting it would let a
    // wrong-legged code through the front door.
    const granted = tokens.scope.split(/\s+/).filter(Boolean);
    if (!LOGIN_SCOPES.every(scope => granted.includes(scope))) {
      app.log.warn({ scope: tokens.scope }, "Discord token does not cover the dashboard login scopes");
      return reply.redirect("/?auth=denied");
    }

    const identity = await fetchIdentity(tokens.access_token);
    // The resolved identity must be a user, never this application. A code that
    // somehow reaches here on application credentials would make the bot itself
    // the signed-in operator.
    if (env.botToken && identity.id === (await resolveBotUserId(env.botToken))) {
      app.log.warn({ userId: identity.id }, "OAuth callback resolved the bot's own application id");
      return reply.redirect("/?auth=denied");
    }

    // A sign-in always begins a new session. Any session the browser was still
    // carrying is destroyed first, for two reasons: a second account must never
    // inherit the first one's cached guild list, and an old row must not survive
    // as a usable session once the operator has moved on. Destroying it even for
    // the same account is the standard defence against a fixated session id.
    const previous = await readSession(db, request as unknown as { headers: Record<string, unknown> });
    if (previous) {
      await destroySession(db, request as unknown as { headers: Record<string, unknown> }).catch(() => undefined);
      if (previous.discordUserId !== identity.id) {
        app.log.info(
          { previousUserId: previous.discordUserId, nextUserId: identity.id },
          "Discord account switched; the previous session was destroyed"
        );
      }
    }

    const { id } = await issueSession(db, env, {
      discordUserId: identity.id,
      discordUsername: identity.globalName ?? identity.username,
      discordAvatar: identity.avatar,
      accessToken: tokens.access_token,
      scopes: tokens.scope
    });
    reply.header("Set-Cookie", sessionCookieHeader(id));
    return reply.redirect("/?auth=ok");
  } catch (error) {
    app.log.error(error, "Discord OAuth callback failed");
    return reply.redirect("/?auth=failed");
  }
});

app.post("/auth/logout", async (request, reply) => {
  await destroySession(db, request as unknown as { headers: Record<string, unknown> });
  reply.header("Set-Cookie", clearedCookieHeader());
  return { ok: true };
});

/* ------------------------------------------------------------------ *
 * Guilds
 *
 * One endpoint feeds two screens: the selector lists what the caller may act on,
 * and the shell uses the same rows for its guild switcher. Both need the same
 * verdict, so the classification is decided here once rather than re-derived in
 * the browser from a permission bitfield it should never have to interpret.
 *
 * A guild appears if the caller can administer it — ADMINISTRATOR or
 * MANAGE_GUILD, and `hasPermission` already treats Administrator as holding
 * everything. Guilds where the caller has no standing are dropped rather than
 * listed and then refused: an entry that leads to a 403 is worse than no entry.
 * ------------------------------------------------------------------ */
app.get("/api/guilds", async (request, reply) => {
  const session = await readSession(db, request as unknown as { headers: Record<string, unknown> });

  // No session means no guilds. AL AI has no public read-only mode.
  if (!session) {
    return reply.code(401).send({ error: "UNAUTHENTICATED", message: "سجّل الدخول عبر Discord." });
  }

  // `allSettled`, not `all`. The bot's guild list is an independent second read
  // and its failure must not reject the route *after* `loadUserGuilds` has
  // already answered the request — that produced a 500 and a "reply was already
  // sent" error stacked on top of the real message, which is what made a rate
  // limit look like a crash. The login read itself never rejects: it catches
  // every failure class and answers with its own status, so the settled pair's
  // left half is always fulfilled — the `allSettled` is for the right half.
  const [userGuilds, botGuilds] = await Promise.allSettled([
    loadUserGuilds(request, reply, session),
    env.botToken ? fetchBotGuildIds(env.botToken) : Promise.resolve(new Set<string>())
  ]);

  // A dead token or a rate limit has already been answered with its own status.
  if (userGuilds.status !== "fulfilled" || !userGuilds.value) return;

  // Without the bot's guild list we cannot tell "AL AI is not here yet" from
  // "AL AI is here". Guessing the former would badge a guild «غير مضاف» and
  // offer an invite for a server the bot already sits in, so say we could not
  // read it instead of inventing an answer.
  if (botGuilds.status === "rejected") {
    app.log.error(botGuilds.reason, "Discord bot guild list read failed");
    return reply.code(503).send({ error: "DISCORD_UNAVAILABLE", message: "تعذّر الوصول إلى Discord. أعد المحاولة." });
  }

  const botGuildIds = botGuilds.value;
  const guildList = userGuilds.value;

  const administrable = guildList.filter(guild => isAdministrable(guild.permissions));

  const guilds = await Promise.all(
    administrable.map(async guild => {
      const botPresent = botGuildIds.has(guild.id);

      // The member count belongs to the bot, the only layer that can see it. It
      // is `null` — "unknown", not zero — for a guild the bot has not joined,
      // because reporting 0 would be a number we made up. Same reason no row is
      // seeded here: a placeholder for a guild the bot has never seen would look
      // like data on the next screen that reads it.
      let memberCount: number | null = null;
      if (botPresent) {
        await db.ensureGuild({ id: guild.id, name: guild.name, iconUrl: guild.icon });
        memberCount = (await db.getGuild(guild.id))?.memberCount ?? null;
      }

      // Resolved only where it can mean something. Without the bot in the guild
      // there is no role list to resolve against, and the answer would be a
      // "no tier" that says nothing about the operator's standing.
      const tier = botPresent
        ? await resolveActorTier({
            db,
            botToken: env.botToken,
            guildId: guild.id,
            discordUserId: session.discordUserId,
            userIsGuildOwner: guild.owner,
            userIsAdministrator: hasPermission(guild.permissions, DISCORD_PERMISSION_BITS.ADMINISTRATOR)
          })
        : null;

      // `describeGuildAccess` also re-asserts that an absent bot means no count
      // and no tier, so the rule survives a caller that forgets it.
      return describeGuildAccess({ guild, botPresent, memberCount, tier });
    })
  );

  return { guilds };
});

/**
 * Invite link for AL AI.
 *
 * Redirects rather than returning JSON: this URL is used as a plain link in the
 * UI, so a JSON body would have shown the operator a raw payload instead of the
 * Discord authorise screen.
 *
 * It also opens the return leg. The `state` cookie is set here so the callback
 * can verify the round trip, and Discord is told to hand the browser back to it
 * once the bot is added — otherwise the operator finishes on Discord's own page
 * and the guild they just added AL AI to still reads «غير مضاف».
 */
app.get("/api/guilds/:guildId/invite", async (request, reply) => {
  const { guildId } = request.params as { guildId: string };
  const context = await requireGuildAccess(request, reply, guildId);
  if (!context) return;
  const target = normaliseSnowflake(guildId);
  if (!target) return reply.code(400).send({ error: "INVALID_GUILD_ID", message: "معرّف السيرفر غير صالح." });

  const origin = requestOrigin(request);
  const state = packOAuthState(origin, newOAuthState());
  reply.header("Set-Cookie", stateCookieHeader(state));
  return reply.redirect(
    buildBotInviteUrl(env.clientId, target, {
      redirectUri: redirectUriForOrigin(origin),
      state
    })
  );
});

app.get("/api/guilds/:guildId/channels", async (request, reply) => {
  const { guildId } = request.params as { guildId: string };
  const context = await requireGuildAccess(request, reply, guildId);
  if (!context) return;
  if (!env.botToken) return reply.code(503).send({ error: "BOT_NOT_CONFIGURED", message: "البوت غير مهيأ لقراءة القنوات." });
  return { channels: await fetchGuildChannels(env.botToken, guildId) };
});

/* ------------------------------------------------------------------ *
 * Role mapping — GOVERNANCE rule 3
 *
 * Tiers bind to Role IDs, never User IDs. Only two lists are configurable:
 * `admin` and `moderator`. The `owner` tier has no list at all — it is derived
 * from Discord's own guild ownership and the Administrator permission, so a
 * fresh guild works immediately and there is nothing to leave unconfigured.
 *
 * Editable at the admin tier and above, because this screen decides who can do
 * everything else.
 * ------------------------------------------------------------------ */
app.get("/api/guilds/:guildId/tiers", async (request, reply) => {
  const { guildId } = request.params as { guildId: string };
  const context = await requireTierForGuild(request, reply, guildId, "admin");
  if (!context) return;

  const configured = await db.getTierRoles(guildId);
  if (!env.botToken) {
    return { roles: [], configured, botHighestRolePosition: null, warning: "البوت غير مهيأ لقراءة الرتب." };
  }

  const [roles, botHighestRolePosition] = await Promise.all([
    fetchGuildRoles(env.botToken, guildId).catch(() => []),
    fetchBotHighestRolePosition(env.botToken, guildId).catch(() => null)
  ]);

  // A role at or above the bot's own position can never be assigned, so the UI
  // is told about it up front rather than failing at save time.
  const unassignable = botHighestRolePosition === null
    ? []
    : roles.filter(role => role.position >= botHighestRolePosition).map(role => role.id);

  return { roles, configured, botHighestRolePosition, unassignable };
});

app.put("/api/guilds/:guildId/tiers", async (request, reply) => {
  const { guildId } = request.params as { guildId: string };
  const context = await requireTierForGuild(request, reply, guildId, "admin");
  if (!context) return;

  const body = request.body as { adminRoleIds?: unknown; moderatorRoleIds?: unknown } | undefined;
  if (!body || typeof body !== "object") {
    return reply.code(400).send({ error: "INVALID_BODY", message: "يتطلب قائمتي رتب الإدارة والمشرفين." });
  }

  // Normalised with the same helper the bot uses on read, so a stored list
  // cannot mean two different things on the two sides of the database.
  const roles = normaliseTierRoles(body);

  // A role in both lists would resolve to admin and leave the moderator entry
  // dead in a way the operator cannot see. Rejected rather than silently hidden.
  try {
    assertDisjointTierRoles(roles);
  } catch {
    return reply.code(400).send({ error: "DUPLICATE_ROLE", message: "الرتبة نفسها لا تُسند إلى مجموعتين." });
  }

  await db.saveTierRoles(guildId, roles);
  await appendAudit(db, env, {
    guildId,
    eventId: "role.update",
    actorId: context.session!.discordUserId,
    payload: { action: "tier.assign", ...roles }
  });

  return { configured: roles };
});

/* ------------------------------------------------------------------ *
 * Commands
 *
 * One read feeds the whole screen: the registry joined to this guild's stored
 * configuration, plus the two Discord lists the scopes are chosen from. The
 * roles and channels come from the memoised reads in `discord.ts`, so opening
 * the screen repeatedly — or alongside the tier screen — costs no Discord calls
 * at all inside the TTL.
 * ------------------------------------------------------------------ */
app.get("/api/guilds/:guildId/commands", async (request, reply) => {
  const { guildId } = request.params as { guildId: string };
  const context = await requireGuildAccess(request, reply, guildId);
  if (!context) return;

  const configured = await db.getCommandFlags(guildId);

  // Both lists are advisory: a Discord outage must not stop the operator from
  // seeing and editing the switches, which live entirely in our own database.
  const [roles, channels] = env.botToken
    ? await Promise.all([
        fetchGuildRoles(env.botToken, guildId).catch(() => []),
        fetchGuildChannels(env.botToken, guildId).catch(() => [])
      ])
    : [[] as DiscordRole[], [] as ChannelOption[]];

  // `commandFlagsFor` joins the registry to what the guild stored and fills
  // every gap with the shipped default, so the dashboard shows exactly what the
  // bot will do — including for a command nobody has ever touched.
  return {
    categories: commandCategories.map(category => ({
      id: category,
      label: commandCategoryLabels[category],
      description: commandCategoryDescriptions[category]
    })),
    commands: commandFlagsFor(configured),
    roles,
    channels,
    // The badge text, resolved on the server. `discord-permissions.ts` is the one
    // module that restates Discord's constants and its values are `bigint`, which
    // is why it is deliberately absent from the browser surface of core — so the
    // label is sent rather than imported, exactly as the category labels are.
    permissionLabels: discordPermissionLabels
  };
});

/**
 * Resolves the members named in per-command scopes to something readable.
 *
 * A separate call rather than part of the commands read, because it is the only
 * part that can fail slowly: the scopes live in our own database and must render
 * even when Discord does not answer. The screen shows the raw ID for any member
 * this does not resolve, which is why a failure here degrades rather than breaks.
 *
 * The id list is bounded and de-duplicated before any request is made: a screen
 * cannot ask for more names than a scope can hold, so an oversized query is a
 * hand-crafted request rather than a real one.
 */
app.get("/api/guilds/:guildId/members", async (request, reply) => {
  const { guildId } = request.params as { guildId: string };
  const context = await requireGuildAccess(request, reply, guildId);
  if (!context) return;

  const raw = (request.query as { ids?: string } | undefined)?.ids ?? "";
  const ids = [...new Set(raw.split(",").map(id => id.trim()).filter(id => /^\d{17,20}$/.test(id)))].slice(0, 100);
  if (ids.length === 0 || !env.botToken) return { members: [] };

  const resolved = await Promise.all(
    ids.map(id => fetchGuildMemberCached(env.botToken!, guildId, id).catch(() => null))
  );
  return { members: resolved.filter((member): member is NonNullable<typeof member> => member !== null) };
});

/**
 * Applies a batch of command changes.
 *
 * The body carries only the commands the operator actually edited. Each change
 * is normalised against its registry definition, which is what keeps a control
 * the command does not support from being stored and then silently ignored —
 * a purge setting on `/warn` would be a switch that does nothing.
 */
app.put("/api/guilds/:guildId/commands", async (request, reply) => {
  const { guildId } = request.params as { guildId: string };
  const context = await requireTierForGuild(request, reply, guildId);
  if (!context) return;

  const body = request.body as { changes?: Partial<CommandConfig>[] } | undefined;
  const changes = body?.changes;
  if (!Array.isArray(changes) || changes.length === 0) {
    return reply.code(400).send({ error: "INVALID_BODY", message: "أرسل قائمة التغييرات المطلوبة." });
  }

  const accepted: CommandConfig[] = [];
  for (const change of changes) {
    if (typeof change?.name !== "string") {
      return reply.code(400).send({ error: "INVALID_CHANGE", message: "كل تغيير يحتاج اسم أمر صحيح." });
    }
    try {
      accepted.push(normaliseCommandConfig(requireCommand(change.name), change));
    } catch {
      return reply.code(400).send({ error: "UNKNOWN_COMMAND", message: "هذا الأمر غير مسجل في AL AI." });
    }
  }

  for (const change of accepted) {
    await db.saveCommandFlag(guildId, change);
  }

  await appendAudit(db, env, {
    guildId,
    eventId: "bot.command-success",
    actorId: context.session!.discordUserId,
    payload: { action: "command.update", changes: accepted }
  });

  return { saved: accepted.length };
});

/* ------------------------------------------------------------------ *
 * Audit trail (read-only by contract)
 * ------------------------------------------------------------------ */
app.get("/api/guilds/:guildId/audit", async (request, reply) => {
  const { guildId } = request.params as { guildId: string };
  const context = await requireGuildAccess(request, reply, guildId);
  if (!context) return;
  const rows = await db.listAudit(guildId, 100);
  const counts = await db.countAudit(guildId);
  return {
    counts,
    entries: rows.map(row => ({
      id: row.id,
      severity: row.severity,
      eventId: row.event_id,
      correlationId: row.correlation_id,
      actorHash: row.actor_hash.slice(0, 16),
      sourceLayer: row.source_layer,
      createdAt: row.created_at,
      payload: safeDecrypt(row.payload_ciphertext, env.encryptionKey)
    }))
  };
});

app.get("/api/guilds/:guildId/security", async (request, reply) => {
  const { guildId } = request.params as { guildId: string };
  const context = await requireGuildAccess(request, reply, guildId);
  if (!context) return;
  const rows = await db.listSecurityEvents(guildId, 50);
  return {
    events: rows.map(row => ({
      id: row.id,
      eventId: row.event_id,
      correlationId: row.correlation_id,
      sourceLayer: row.source_layer,
      createdAt: row.created_at,
      payload: safeDecrypt(row.payload_ciphertext, env.encryptionKey)
    }))
  };
});

/* ------------------------------------------------------------------ *
 * Anti-nuke configuration
 *
 * The engine itself runs in the bot; this is only its settings. Reading needs
 * access to the guild and writing needs the admin tier — disarming the engine
 * is exactly the change an attacker holding a moderator account would want to
 * make, so the two are deliberately not the same check.
 * ------------------------------------------------------------------ */

app.get("/api/guilds/:guildId/security/config", async (request, reply) => {
  const { guildId } = request.params as { guildId: string };
  const context = await requireGuildAccess(request, reply, guildId);
  if (!context) return;

  const config = await db.getSecurity(guildId);

  // The quarantine role is chosen from roles that exist, so the picker is fed
  // from Discord rather than free text — a stored ID matching nothing would
  // leave mitigation silently doing half its job.
  const roles = env.botToken ? await fetchGuildRoles(env.botToken, guildId).catch(() => []) : [];

  return {
    config,
    roles,
    actions: ANTI_NUKE_ACTIONS.map(action => ({
      action,
      label: ANTI_NUKE_ACTION_LABELS[action],
      limit: config.limits[ANTI_NUKE_LIMIT_KEYS[action]]
    }))
  };
});

app.put("/api/guilds/:guildId/security/config", async (request, reply) => {
  const { guildId } = request.params as { guildId: string };
  const context = await requireTierForGuild(request, reply, guildId);
  if (!context) return;

  const body = request.body as Partial<AntiNukeConfig> | undefined;
  // Without this the route would fall through to the normaliser's defaults —
  // armed, with the tuned limits and the quarantine role replaced by null —
  // and an empty PUT would silently reset the engine instead of refusing.
  if (!body || typeof body !== "object") {
    return reply.code(400).send({ error: "INVALID_BODY", message: "يلزم جسم الطلب يحتوي إعدادات الحماية." });
  }
  // Normalised, not trusted: the same helper the bot reads through, so a value
  // that survives here means the same thing on both sides of the database.
  const config = normaliseAntiNukeConfig(body);

  // Arming the engine without a quarantine role is allowed — it still detects,
  // notifies and logs — but the operator is told plainly what it will not do.
  await db.saveSecurity(guildId, config);
  await appendAudit(db, env, {
    guildId,
    eventId: "bot.command-success",
    actorId: context.session!.discordUserId,
    payload: {
      action: "security.config.save",
      enabled: config.enabled,
      quarantineRoleId: config.quarantineRoleId,
      limits: config.limits
    }
  });

  return { config, savedAt: new Date().toISOString() };
});

/* ------------------------------------------------------------------ *
 * Welcome & auto-role
 * ------------------------------------------------------------------ */

app.get("/api/guilds/:guildId/welcome", async (request, reply) => {
  const { guildId } = request.params as { guildId: string };
  const context = await requireGuildAccess(request, reply, guildId);
  if (!context) return;

  const settings = await db.getWelcome(guildId);
  // The pickers are fed from Discord, so a stored id can only name a role that
  // was selectable when it was saved. `botHighestRolePosition` is what makes a
  // role grantable at all: anything at or above it is refused by Discord's own
  // hierarchy, and offering it would be offering a setting that cannot work.
  const [roles, botHighestRolePosition] = await Promise.all([
    env.botToken ? fetchGuildRoles(env.botToken, guildId).catch(() => []) : Promise.resolve([]),
    env.botToken ? fetchBotHighestRolePosition(env.botToken, guildId).catch(() => null) : Promise.resolve(null)
  ]);

  return {
    settings,
    roles: roles.filter(
      role => !role.managed && !role.isDefault && botHighestRolePosition !== null && role.position < botHighestRolePosition
    )
  };
});

app.put("/api/guilds/:guildId/welcome", async (request, reply) => {
  const { guildId } = request.params as { guildId: string };
  const context = await requireTierForGuild(request, reply, guildId);
  if (!context) return;

  const body = request.body as Partial<WelcomeSettings> | undefined;
  if (!body || typeof body !== "object") {
    return reply.code(400).send({ error: "INVALID_BODY", message: "يلزم جسم الطلب يحتوي إعدادات الترحيب." });
  }
  const settings = normaliseWelcomeSettings(body);

  // Each chosen role is re-checked against Discord at save time, not trusted
  // from the picker: the roles list the screen saw can be minutes old, and a
  // role deleted or raised in between would store a setting that silently does
  // nothing on the first join.
  if (settings.memberRoleId || settings.botRoleId) {
    const [roles, botHighestRolePosition] = await Promise.all([
      env.botToken ? fetchGuildRoles(env.botToken, guildId).catch(() => []) : Promise.resolve([]),
      env.botToken ? fetchBotHighestRolePosition(env.botToken, guildId).catch(() => null) : Promise.resolve(null)
    ]);
    const grantable = (roleId: string | null) =>
      roleId === null ||
      (botHighestRolePosition !== null &&
        roles.some(role => role.id === roleId && !role.managed && !role.isDefault && role.position < botHighestRolePosition));
    if (!grantable(settings.memberRoleId) || !grantable(settings.botRoleId)) {
      return reply.code(409).send({
        error: "ROLE_NOT_GRANTABLE",
        message: "إحدى الرتب المختارة محذوفة، أو مُدارة بواسطة تكامل، أو فوق أعلى رتبة البوت — ولا يمكن منحها."
      });
    }
  }

  await db.saveWelcome(guildId, settings);
  await appendAudit(db, env, {
    guildId,
    eventId: "bot.command-success",
    actorId: context.session!.discordUserId,
    payload: {
      action: "welcome.save",
      enabled: settings.enabled,
      memberRoleId: settings.memberRoleId,
      botRoleId: settings.botRoleId
    }
  });

  return { settings, savedAt: new Date().toISOString() };
});

/* ------------------------------------------------------------------ *
 * Bot tokens — retired
 *
 * The dashboard used to accept additional bot tokens from the operator and
 * store them encrypted. That is gone by design, not by accident: AL AI runs on
 * exactly one master token held in the server environment (BOT_TOKEN), and no
 * endpoint may accept a credential from the browser. See GOVERNANCE rule 19.
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * Appearance writes — the shared plumbing
 *
 * Every appearance field, per-guild or global, is written by `applyAppearance`
 * in `appearance.ts`, and every one of them can fail on its own. Three rules
 * hold across both scopes:
 *
 *  - **A failed field is reported, never swallowed.** `FieldOutcome` carries the
 *    field name and an actionable message, so the operator learns which of six
 *    changes Discord refused instead of watching a save report "done".
 *  - **A save that wrote nothing is not a success.** If not one field reached
 *    Discord, the response is an error the toast can show in red; a 200 there
 *    would be the "محفوظ ≠ منفّذ" defect in its purest form.
 *  - **What was stored is what was applied.** The row is written from the same
 *    values handed to Discord, so a partial failure cannot leave the database
 *    claiming something the bot never received.
 * ------------------------------------------------------------------ */

/**
 * Answers for a Discord token that was refused, so every write path says the
 * same thing: the credential is dead, not the request.
 *
 * Deliberately *not* used for 403. Discord answers 403 when the bot lacks a
 * permission, which `describeAppearanceFailure` turns into the specific hint
 * for that field — replacing it with a generic auth message would throw away
 * the one piece of information that tells the operator what to fix.
 */
function answerBotTokenRefused(reply: FastifyReply, error: unknown) {
  app.log.error(error, "Discord refused the bot token during an appearance write");
  return reply.code(503).send({
    error: "BOT_TOKEN_INVALID",
    message: "رفض Discord توكن البوت. تحقّق من قيمة BOT_TOKEN ثم أعد تشغيل الخدمة."
  });
}

/** The body shape every appearance save answers with. */
type AppearanceSaveResponse = {
  savedAt: string;
  applied: AppearanceField[];
  failed: Extract<FieldOutcome, { ok: false }>[];
};

/**
 * Runs a plan and turns its outcomes into a response.
 *
 * A partial failure is a 200 whose `failed` array is not empty: the fields that
 * succeeded really are saved, and answering 500 would tell the operator their
 * whole edit was lost when most of it was not. Only a save where *nothing*
 * landed — and something was attempted — becomes an error.
 */
function appearanceResponse(
  reply: FastifyReply,
  outcomes: FieldOutcome[],
  attempted: AppearanceField[],
  successMessage: string
): AppearanceSaveResponse | undefined {
  const failed = outcomes.filter((outcome): outcome is Extract<FieldOutcome, { ok: false }> => !outcome.ok);
  const applied = outcomes.filter(outcome => outcome.ok).map(outcome => outcome.field);

  if (attempted.length > 0 && applied.length === 0) {
    const first = failed[0];
    return reply.code(first.code === "RATE_LIMITED" ? 429 : 502).send({
      error: first.code,
      message: first.message,
      failed
    }) as unknown as undefined;
  }

  app.log.info({ applied, failed: failed.map(entry => entry.code) }, successMessage);
  return { savedAt: new Date().toISOString(), applied, failed };
}

/* ------------------------------------------------------------------ *
 * Global bot identity — avatar, banner, bio, presence
 *
 * The half of the appearance that is the same in every guild. Reading and
 * writing need no guild at all, which is why this route lives under
 * `/api/bot/identity` rather than nested inside a guild: an avatar that only
 * changed for one server would be the fake setting this project removed.
 *
 * The tier check still needs a guild — "may this account edit AL AI's own
 * profile?" is a question about standing somewhere — so the write takes an
 * optional `guildId` and resolves the caller's tier inside it. It asks for the
 * admin tier rather than owner because an Administrator already reaches this
 * screen, and the write is reversible from the same form: the worst an admin
 * can do here is change a picture and a status back.
 * ------------------------------------------------------------------ */

/** The fields the global form owns. Presence is excluded: see the PUT route. */
const GLOBAL_APPEARANCE_FIELDS = new Set<AppearanceField>(["avatarDataUrl", "bannerDataUrl", "bio"]);

app.get("/api/bot/identity", async (request, reply) => {
  const session = await readSession(db, request as unknown as { headers: Record<string, unknown> });
  if (!session) {
    return reply.code(401).send({ error: "UNAUTHENTICATED", message: "الجلسة منتهية أو غير موجودة. سجّل الدخول عبر Discord." });
  }

  const identity = await db.getBotIdentity();

  // The bot's own snowflake, needed to build its CDN avatar address — Discord
  // serves avatars from `/avatars/{user_id}/{hash}`, so a hash alone is not
  // enough to address one. Memoised for the life of the process by
  // `resolveBotUserId`, so this costs nothing after the first call.
  const botUserId = env.botToken ? await resolveBotUserId(env.botToken).catch(() => null) : null;

  // Advisory, exactly like the per-guild screen's reads. A Discord outage must
  // not stop the operator from seeing and editing the stored identity, so every
  // read degrades to "unknown" and an unknown never becomes a warning.
  const live: AppearanceSnapshot | null = env.botToken
    ? await readAppearanceSnapshot(env.botToken).catch(() => null)
    : null;

  // Discord returns hashes, never URLs. Resolved here so the browser never
  // assembles a CDN address and can never get the animated-asset extension or
  // the size parameter wrong. Without the bot's ID there is no address to
  // build, so the fields are null rather than a URL pointing at nothing.
  const snapshot =
    live && botUserId
      ? {
          username: live.username,
          bio: live.bio,
          avatarUrl: userAvatarUrl(botUserId, live.avatar),
          bannerUrl: userBannerUrl(botUserId, live.banner)
        }
      : null;

  // `settings` rather than `identity`, matching every other settings route in
  // this file. The dashboard's client reads `result.settings`, so the earlier
  // name was a silent contract break: the screen crashed on a null draft
  // (`Object.keys(null)`) rather than showing an error, because the response
  // was a perfectly valid 200 carrying a key nobody looked at.
  return { settings: identity, snapshot };
});

app.put("/api/bot/identity", async (request, reply) => {
  const body = request.body as (Partial<BotIdentitySettings> & { guildId?: unknown }) | undefined;

  // The tier is resolved in the guild the caller is looking at. It cannot come
  // from the body as a claim — only as a *location* to check.
  const guildId = normaliseSnowflake(body?.guildId);
  if (!guildId) {
    return reply.code(400).send({
      error: "GUILD_ID_REQUIRED",
      message: "أرسل معرّف السيرفر الذي تُعدّ منه الهوية العالمية، ليُتحقق من صلاحيتك فيه."
    });
  }

  const context = await requireTierForGuild(request, reply, guildId, "admin");
  if (!context) return;

  const previous = await db.getBotIdentity();

  // Rejected rather than silently dropped. An image that failed validation and
  // became `null` would *wipe* the avatar the operator meant to replace — the
  // database would agree, the form would look saved, and the picture would be
  // gone. So a value that was sent and did not survive is a 400.
  if (body?.avatarDataUrl) {
    if (!normaliseImageDataUrl(body.avatarDataUrl)) {
      return reply.code(400).send({
        error: "INVALID_AVATAR",
        message:
          imageRejectionReason(body.avatarDataUrl) === "TOO_LARGE"
            ? `حجم الصورة يتجاوز الحد المسموح (${Math.round(MAX_IMAGE_DATA_URL_LENGTH / 1000)} كيلوبايت تقريباً). قصّها أو صغّرها ثم أعد المحاولة.`
            : "صيغة الصورة غير مدعومة. استخدم PNG أو JPEG أو WEBP أو GIF."
      });
    }
  }
  if (body?.bannerDataUrl) {
    if (!normaliseImageDataUrl(body.bannerDataUrl)) {
      return reply.code(400).send({
        error: "INVALID_BANNER",
        message:
          imageRejectionReason(body.bannerDataUrl) === "TOO_LARGE"
            ? `حجم البانر يتجاوز الحد المسموح (${Math.round(MAX_IMAGE_DATA_URL_LENGTH / 1000)} كيلوبايت تقريباً). قصّه أو صغّره ثم أعد المحاولة.`
            : "صيغة صورة البانر غير مدعومة. استخدم PNG أو JPEG أو WEBP أو GIF."
      });
    }
  }
  // A bio that is too long is truncated by `normaliseBio`, so the raw length is
  // checked first — truncating here would hide the mistake instead of reporting it.
  const rawBio = typeof body?.bio === "string" ? body.bio.trim() : "";
  if (rawBio.length > MAX_BIO_LENGTH) {
    return reply.code(400).send({ error: "INVALID_BIO", message: `النبذة يجب ألا تتجاوز ${MAX_BIO_LENGTH} حرفاً.` });
  }
  const rawActivity = typeof body?.activityText === "string" ? body.activityText.trim() : "";
  if (rawActivity.length > MAX_ACTIVITY_TEXT_LENGTH) {
    return reply.code(400).send({
      error: "INVALID_ACTIVITY",
      message: `نص النشاط يجب ألا يتجاوز ${MAX_ACTIVITY_TEXT_LENGTH} حرفاً.`
    });
  }

  const next = normaliseBotIdentity({
    // Fields absent from the body keep their stored value: a PUT that only
    // carries the presence must not clear the avatar as a side effect of
    // `undefined` normalising to null.
    avatarDataUrl: body?.avatarDataUrl === undefined ? previous.avatarDataUrl : body.avatarDataUrl,
    bannerDataUrl: body?.bannerDataUrl === undefined ? previous.bannerDataUrl : body.bannerDataUrl,
    bio: body?.bio === undefined ? previous.bio : body.bio,
    status: body?.status === undefined ? previous.status : body.status,
    // The client sends the *choice*; the expiry is derived here. A client clock
    // can be wrong by hours, and letting it set the instant would mean a window
    // that is already over — or one that never ends — decided by whichever
    // machine happened to press save.
    statusDuration: body?.statusDuration === undefined ? previous.statusDuration : body.statusDuration,
    statusExpiresAt: statusExpiryFor(
      body?.status === undefined ? previous.status : body.status,
      body?.statusDuration === undefined ? previous.statusDuration : body.statusDuration,
      previous.statusExpiresAt,
      Date.now()
    ),
    activityType: body?.activityType === undefined ? previous.activityType : body.activityType,
    activityText: body?.activityText === undefined ? previous.activityText : body.activityText
  });

  if (!env.botToken) {
    return reply.code(503).send({ error: "BOT_NOT_CONFIGURED", message: "البوت غير مهيأ لتعديل هويته." });
  }

  const outcomes: FieldOutcome[] = [];
  try {
    // Only the three fields this route can reach Discord with. The presence is
    // still stored below, but `applyAppearance` deliberately does not write it:
    // a status lives on the gateway, so this is the one value whose writer is
    // the bot. Claiming it here would be the fourth column of a promise nobody
    // keeps.
    // Read once: nothing between the two slots can change it, and a second
    // round trip per save is a query this route does not need.
    const customization = await db.getCustomization(guildId);
    outcomes.push(
      ...(await applyAppearance({
        token: env.botToken,
        guildId,
        previous: { customization, identity: previous },
        next: { customization, identity: next }
      }))
    );
  } catch (error) {
    if (isAuthFailure(error)) return answerBotTokenRefused(reply, error);
    app.log.error(error, "Appearance write failed before any field was attempted");
    return reply.code(503).send({ error: "DISCORD_UNAVAILABLE", message: "تعذّر الوصول إلى Discord. أعد المحاولة." });
  }

  const attempted = outcomes.map(outcome => outcome.field).filter(field => GLOBAL_APPEARANCE_FIELDS.has(field));

  // Storage happens even when Discord refused: the stored row is what the bot
  // reads on its next tick, and a rate limit is momentary. Refusing to store
  // would make the operator retype an image that `applyAppearance` may well
  // accept a second later. The response says plainly what did not land, so
  // "stored" and "applied" never get conflated.
  await db.saveBotIdentity(next);

  // The snapshot cache would otherwise keep showing the previous avatar and
  // bio for up to a minute after a save that already succeeded — the "saved
  // but nothing changed" reading this project treats as a defect.
  invalidateAppearanceSnapshot();

  const response = appearanceResponse(reply, outcomes, attempted, "Global bot identity saved");
  if (!response) return;

  await appendAudit(db, env, {
    guildId,
    eventId: "bot.command-success",
    actorId: context.session!.discordUserId,
    payload: {
      action: "bot.identity.save",
      applied: response.applied,
      failed: response.failed.map(entry => entry.code)
    }
  });

  // `settings` for the reason given on the GET route above: one key, everywhere.
  return { settings: next, ...response };
});

/* ------------------------------------------------------------------ *
 * Customization — the bot's per-guild identity
 *
 * Discord gives an application one global avatar, so this screen only ever
 * writes what the bot can actually apply per guild: the nickname and the colour
 * and icon of its own role. Everything is normalised with the shared helpers in
 * @al-ai/core, which the bot also uses on read, so a value can never mean two
 * different things on the two sides of the database.
 * ------------------------------------------------------------------ */
app.get("/api/guilds/:guildId/customization", async (request, reply) => {
  const { guildId } = request.params as { guildId: string };
  if (!(await requireGuildAccess(request, reply, guildId))) return;

  const settings = await db.getCustomization(guildId);
  const token = env.botToken;

  // Each of these is advisory. A Discord outage must not stop the operator from
  // seeing their saved settings, so every read degrades to "unknown" instead of
  // failing the request — and an unknown never becomes a warning about a problem
  // that may not exist.
  const [permissions, premiumTier, hierarchy] = token
    ? await Promise.all([
        botIdentityPermissionStatus(token, guildId).catch((): PermissionStatus[] => []),
        fetchGuildPremiumTier(token, guildId).catch(() => null),
        fetchGuildHierarchy(token, guildId).catch(() => null)
      ])
    : [[] as PermissionStatus[], null, null];

  const tierRoles = await db.getTierRoles(guildId).catch(() => null);
  const managedRoleIds = [...(tierRoles?.adminRoleIds ?? []), ...(tierRoles?.moderatorRoleIds ?? [])];
  // A configured role the bot can no longer see (deleted, or renamed away) is
  // skipped rather than counted as position 0, which would report a false pass.
  const managedPositions = hierarchy
    ? managedRoleIds
        .map(roleId => hierarchy.rolePositions.get(roleId))
        .filter((position): position is number => position !== undefined)
    : [];

  return {
    settings,
    permissions,
    hierarchy: hierarchy ? assessRoleHierarchy(hierarchy.botPosition, managedPositions) : null,
    roleIcon: assessRoleIconGate(premiumTier)
  };
});

app.put("/api/guilds/:guildId/customization", async (request, reply) => {
  const { guildId } = request.params as { guildId: string };
  const context = await requireTierForGuild(request, reply, guildId);
  if (!context) return;

  const body = request.body as Partial<CustomizationSettings> | undefined;

  // A nickname is optional (empty means "use the application name"), but when one
  // is supplied it must be one Discord will accept. The raw length is checked
  // before normalisation, because normalisation truncates — and truncating here
  // would hide the mistake instead of reporting it.
  const rawNickname = typeof body?.nickname === "string" ? body.nickname.trim() : "";
  if (rawNickname.length > MAX_NICKNAME_LENGTH) {
    return reply.code(400).send({ error: "INVALID_NICKNAME", message: `الاسم المستعار يجب ألا يتجاوز ${MAX_NICKNAME_LENGTH} حرفاً.` });
  }
  const nickname = normaliseNickname(rawNickname);

  // A value that was sent but did not survive normalisation is rejected rather
  // than quietly dropped, so the operator is told instead of guessing.
  const roleColor = normaliseHexColor(body?.roleColor);
  if (body?.roleColor && !roleColor) {
    return reply.code(400).send({ error: "INVALID_ROLE_COLOR", message: "لون الرتبة يجب أن يكون بصيغة #RRGGBB." });
  }

  // Absent means "leave it alone"; `null` means "clear it". The screen omits the
  // icon entirely below boost level 2, and reading an absent field as null would
  // wipe a stored icon the moment it did.
  const iconSent = body?.roleIconUrl !== undefined;
  const current = await db.getCustomization(guildId);
  const normalisedIcon = iconSent ? normaliseImageValue(body?.roleIconUrl) : null;

  // A data URL (uploaded through the cropper) or an https link (a value stored
  // by an older build). Anything else is refused rather than quietly dropped,
  // so the operator is told instead of guessing.
  if (iconSent && body?.roleIconUrl && !normalisedIcon) {
    return reply.code(400).send({
      error: "INVALID_ROLE_ICON",
      message:
        imageRejectionReason(body.roleIconUrl) === "TOO_LARGE"
          ? `حجم أيقونة الرتبة يتجاوز الحد المسموح (${Math.round(MAX_IMAGE_DATA_URL_LENGTH / 1000)} كيلوبايت تقريباً). قصّها أو صغّرها ثم أعد المحاولة.`
          : "أيقونة الرتبة يجب أن تكون صورة مرفوعة (PNG/JPEG/WEBP/GIF) أو رابط HTTPS صالحاً."
    });
  }

  // Below boost level 2 Discord refuses a role icon — but refusing the *request*
  // took the nickname and the colour down with it, so a valid edit was lost to a
  // control the operator was not allowed to touch. That was the 409 the operator
  // kept meeting. The icon is dropped and reported as a field outcome instead,
  // the same shape a Discord refusal takes. `resolveRoleIconWrite` owns the rule
  // and is unit-tested on its own; the boost level is only worth a Discord call
  // when the icon actually changes.
  const iconChanged = iconSent && normalisedIcon !== current.roleIconUrl;
  const iconGate =
    iconChanged && env.botToken
      ? assessRoleIconGate(await fetchGuildPremiumTier(env.botToken, guildId).catch(() => null))
      : null;

  const icon = resolveRoleIconWrite({
    sent: iconSent,
    value: normalisedIcon,
    stored: current.roleIconUrl,
    locked: iconGate?.locked ?? false,
    reason: iconGate?.reason ?? null
  });
  const roleIconUrl = icon.value;
  const roleIconDeferred = icon.deferred;

  // Refuse instead of performing an operation that is guaranteed to fail — but
  // only on a *known* absence, and only when the nickname is actually being
  // changed. `null` means the permission read failed, and blocking on that would
  // make an unreadable permission indistinguishable from a missing one,
  // refusing saves the bot can perform. The bot re-checks before it writes and
  // reports Discord's own error if the permission really is absent.
  //
  // The "only when it changes" half matters for the same reason the icon gate
  // does: a colour-only save was refused because the bot happened to lack Manage
  // Nicknames, which is one field's problem failing a form that would otherwise
  // have saved. It also spends two Discord calls less on the common case.
  if (env.botToken && nickname !== current.nickname) {
    const statuses = await botIdentityPermissionStatus(env.botToken, guildId);
    const nicknamePermission = statuses.find(status => status.key === "change_nickname");
    if (nicknamePermission?.granted === false) {
      return reply.code(409).send({ error: "MISSING_PERMISSION", message: "البوت لا يملك صلاحية «تغيير الاسم المستعار» في هذا السيرفر." });
    }
  }

  const settings: CustomizationSettings = { nickname, roleColor, roleIconUrl };
  const previous = current;

  // Save first, then apply. The row is the source of truth the bot reads on its
  // sync tick, and a Discord outage must not lose an edit the operator has
  // already made — a rate limit is momentary, a lost form is not. What each
  // field actually did is reported below, so "محفوظ" and "منفّذ" stay distinct.
  await db.saveCustomization(guildId, settings);

  // AL AI's own role just changed colour, icon or name, so the memoised role
  // list every picker reads is now stale. Dropping it here is what makes the
  // tier and command screens show the new colour instead of waiting out the TTL.
  invalidateGuildReadCache(guildId);

  let outcomes: FieldOutcome[] = [];
  if (env.botToken) {
    try {
      // Read once: nothing between the two slots can change it, and a second
      // round trip per save is a query this route does not need.
      const identity = await db.getBotIdentity();
      outcomes = await applyAppearance({ token: env.botToken, guildId, previous: { customization: previous, identity }, next: { customization: settings, identity } });
    } catch (error) {
      if (isAuthFailure(error)) return answerBotTokenRefused(reply, error);
      app.log.error(error, "Per-guild appearance write failed before any field was attempted");
      return reply.code(503).send({ error: "DISCORD_UNAVAILABLE", message: "تعذّر الوصول إلى Discord. أعد المحاولة." });
    }
  } else {
    // Nothing was attempted, so nothing is claimed. The settings are stored and
    // the screen says so; the bot will apply them on its next tick.
    app.log.warn({ guildId }, "BOT_TOKEN is unset; the appearance was stored but not applied");
  }

  await appendAudit(db, env, {
    guildId,
    eventId: "bot.command-success",
    actorId: context.session!.discordUserId,
    payload: { action: "customization.save", nickname, roleColor, roleIconUrl }
  });

  // The deferred icon is a policy refusal, not a Discord outage, so it must not
  // be allowed to trip the "nothing landed" branch and answer 502 — the service
  // is fine and the rest of the form saved. It is still reported in `failed`,
  // which is what tells the operator which field did not apply.
  const deferred: Extract<FieldOutcome, { ok: false }> | null = roleIconDeferred
    ? { field: "roleIconUrl", ok: false, code: roleIconDeferred.code, message: roleIconDeferred.message }
    : null;
  const reported = deferred ? [...outcomes, deferred] : outcomes;

  const response = appearanceResponse(
    reply,
    reported,
    reported.filter(outcome => outcome !== deferred).map(outcome => outcome.field),
    "Per-guild customization saved"
  );
  if (!response) return;

  return { settings, ...response };
});

/* ------------------------------------------------------------------ *
 * Overview metrics
 *
 * Everything here is a real value: Discord's own gateway heartbeat reported by
 * the bot, Discord's aggregate widget presence, and counts read from the
 * append-only audit trail. Nothing is estimated or carried over from the
 * dashboard's own internals.
 * ------------------------------------------------------------------ */
app.get("/api/guilds/:guildId/metrics", async (request, reply) => {
  const { guildId } = request.params as { guildId: string };
  if (!(await requireGuildAccess(request, reply, guildId))) return;

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [health, counts, rows, widget, record] = await Promise.all([
    db.getGuildHealth(guildId).catch(() => null),
    db.countPunishmentsSince(guildId, since).catch(() => []),
    db.listRecentModeration(guildId, 8).catch(() => []),
    // The widget is unauthenticated and independent of our bot token.
    fetchWidgetPresence(guildId).catch(() => ({ online: null, reason: "unavailable" }) as const),
    db.getGuild(guildId).catch(() => null)
  ]);

  const metrics: GuildMetrics = {
    bot: deriveBotStatus(health, Date.now()),
    members: {
      total: record?.memberCount ?? 0,
      online: widget.online,
      onlineNote: widgetOnlineNote(widget)
    },
    punishments24h: summarisePunishments(counts),
    recentActivity: rows.map(row => {
      const payload = safeDecrypt(row.payload_ciphertext, env.encryptionKey) as Record<string, unknown> | null;
      const text = (value: unknown) => (typeof value === "string" && value && value !== "—" ? value : null);
      return {
        id: row.id,
        eventId: row.event_id,
        severity: (row.severity === "critical" || row.severity === "warning" ? row.severity : "info") as ActivityEntry["severity"],
        actorId: text(payload?.actorId) ?? text(payload?.moderatorId),
        targetId: text(payload?.targetId) ?? text(payload?.memberId),
        reason: text(payload?.reason),
        createdAt: row.created_at.toISOString()
      };
    })
  };

  return metrics;
});

/* ------------------------------------------------------------------ *
 * Logging
 * ------------------------------------------------------------------ */

/**
 * Keeps only the destinations an operator is allowed to bind a channel to.
 *
 * `bot-log` is internal — it is delivered to the developer webhook, so a value
 * arriving for it is either a stale client or a hand-crafted request. Either
 * way it must not reach the routing table, where it would let a customer
 * redirect AL AI's own errors into their server.
 */
function normaliseCategoryChannels(value: unknown): Partial<Record<LogDestination, string>> {
  if (!value || typeof value !== "object") return {};
  const result: Partial<Record<LogDestination, string>> = {};
  for (const destination of logDestinations) {
    const channelId = (value as Record<string, unknown>)[destination];
    if (typeof channelId === "string" && channelId) result[destination] = channelId;
  }
  return result;
}

/**
 * Keeps only a valid "#rrggbb" colour, and only for a destination that exists.
 *
 * Shares the colour rule with `embedColor` rather than restating it, so a
 * short-form "#rgb" the global field accepts is accepted here too — and a key
 * the dashboard no longer offers is dropped instead of lingering in the row.
 */
function normaliseCategoryColors(value: unknown): Partial<Record<LogDestination, string>> {
  if (!value || typeof value !== "object") return {};
  const result: Partial<Record<LogDestination, string>> = {};
  for (const destination of logDestinations) {
    const colour = normaliseHexColor((value as Record<string, unknown>)[destination]);
    if (colour) result[destination] = colour;
  }
  return result;
}

/**
 * Keeps only a binding for an event the schema actually declares.
 *
 * The event map is keyed by ID rather than by destination, so the validator here
 * is the schema itself: a key the schema no longer lists is dropped rather than
 * stored, which is what keeps a retired event from holding a channel hostage.
 * `bot-log`'s events cannot appear here at all — they are not in the operator
 * surface — so this never opens the internal surface to a customer's room.
 */
function normaliseEventChannels(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  const result: Record<string, string> = {};
  for (const eventId of eventSchema.keys()) {
    const channelId = (value as Record<string, unknown>)[eventId];
    if (typeof channelId === "string" && channelId) result[eventId] = channelId;
  }
  return result;
}

/**
 * Keeps only a valid "#rrggbb" colour, and only for an event that exists.
 * Same rule as `normaliseCategoryColors`, keyed by event ID.
 */
function normaliseEventColors(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  const result: Record<string, string> = {};
  for (const eventId of eventSchema.keys()) {
    const colour = normaliseHexColor((value as Record<string, unknown>)[eventId]);
    if (colour) result[eventId] = colour;
  }
  return result;
}

app.get("/api/guilds/:guildId/logging", async (request, reply) => {
  const { guildId } = request.params as { guildId: string };
  if (!(await requireGuildAccess(request, reply, guildId))) return;
  return { settings: await db.getLogging(guildId) };
});

app.put("/api/guilds/:guildId/logging", async (request, reply) => {
  const { guildId } = request.params as { guildId: string };
  const context = await requireTierForGuild(request, reply, guildId);
  if (!context) return;

  const body = request.body as Partial<LoggingSettings> | undefined;
  const settings: LoggingSettings = {
    enabled: Boolean(body?.enabled),
    mode: isLoggingMode(body?.mode) ? body.mode : DEFAULT_LOGGING_MODE,
    globalChannelId: body?.globalChannelId ?? null,
    ignoredChannelIds: Array.isArray(body?.ignoredChannelIds) ? body.ignoredChannelIds : [],
    // Only snowflake-shaped IDs are kept: anything else would be written to the
    // database and then silently never match a role the bot sees.
    ignoredRoleIds: normaliseRoleIds(body?.ignoredRoleIds),
    embedColor: /^#[0-9a-f]{6}$/i.test(body?.embedColor ?? "") ? body!.embedColor! : DEFAULT_EMBED_COLOR,
    // Only a colour the shared validator accepts is kept, and only for a
    // destination that exists: a key the dashboard no longer offers would
    // otherwise persist and colour an embed nobody sees.
    categoryColors: normaliseCategoryColors(body?.categoryColors),
    eventFlags: body?.eventFlags ?? {},
    categoryChannels: normaliseCategoryChannels(body?.categoryChannels),
    // Per-record bindings. A record with neither inherits its section, which is
    // what every record does in normal mode — these only carry weight when the
    // operator has switched to detailed and given one record a room of its own.
    eventChannels: normaliseEventChannels(body?.eventChannels),
    eventColors: normaliseEventColors(body?.eventColors)
  };

  // One channel may never serve two purposes, whether those are two sections, two
  // records, or one of each.
  try {
    assertUniqueChannelAssignment(settings.categoryChannels, settings.eventChannels);
  } catch (error) {
    return reply.code(400).send({ error: "DUPLICATE_CHANNEL", message: (error as Error).message });
  }

  const bindings = [...Object.values(settings.categoryChannels), ...Object.values(settings.eventChannels)];
  const ignored = new Set(settings.ignoredChannelIds);
  const conflict = bindings.find(channelId => channelId && ignored.has(channelId));
  if (conflict) {
    return reply.code(400).send({ error: "IGNORED_CHANNEL_CONFLICT", message: "قناة مستثناة لا يمكن أن تكون وجهة سجل." });
  }

  await db.saveLogging(guildId, settings);
  await appendAudit(db, env, {
    guildId,
    eventId: "bot.command-success",
    actorId: context.session!.discordUserId,
    payload: {
      action: "logging.save",
      enabled: settings.enabled,
      mode: settings.mode,
      destinations: Object.keys(settings.categoryChannels).length,
      eventBindings: Object.keys(settings.eventChannels).length,
      ignoredRoles: settings.ignoredRoleIds.length
    }
  });
  return { settings, savedAt: new Date().toISOString() };
});

/* ------------------------------------------------------------------ *
 * One-click log channel setup and teardown
 *
 * These two are the only guild-structure mutations in the dashboard, and they
 * are held to three rules:
 *
 *  - **The bot's permission is checked, not assumed.** Creating up to 107
 *    channels without MANAGE_CHANNELS would answer the operator with 107
 *    identical refusals they cannot act on, so the read happens first. A read
 *    that fails is *unknown*, never "no" (rule 22), and the route refuses to
 *    proceed on an unknown rather than discovering the truth a hundred calls in.
 *  - **Creation is sequential, honouring `retry_after`.** Discord rate-limits
 *    channel creation per guild, so a parallel batch of 107 answers 106 of
 *    them with a 429. Each rate-limited call waits as long as Discord asks
 *    and tries once more; a channel that still fails is reported and the
 *    sequence moves on.
 *  - **Both are idempotent.** A channel that already carries the name is reused
 *    rather than duplicated, so a second press repairs a partial setup instead
 *    of doubling the list — and teardown deletes only what is still there.
 * ------------------------------------------------------------------ */

/**
 * The channels one setup mode creates, and the routing keys they bind to.
 *
 * `normal` gives each of the thirteen sections its own room. `detailed` gives
 * each of the 107 records its own, which is the maximum the schema offers: a
 * section is not created for itself, and every record belongs to exactly one.
 *
 * Discord forbids anything but lowercase letters, digits, dashes and underscores
 * in a channel name, and an event ID carries a dot, so the name is a slug of the
 * ID. The pair is carried together rather than re-derived on the way back,
 * because two IDs cannot be allowed to collapse onto one slug: `a.b-c` and
 * `a.b.c` would both become `a-b-c` and silently share a room. No two schema IDs
 * differ only by dots and dashes, which the pairing keeps true by construction
 * rather than by hope.
 */
function plannedBindings(mode: LoggingMode): { key: string; name: string }[] {
  if (mode === "normal") return logDestinations.map(destination => ({ key: destination, name: destination }));
  // The internal destination is delivered to the developer webhook and cannot be
  // routed to a customer channel, so building rooms for it would spend the
  // guild's channel budget on channels the registry refuses to use. Version 5
  // also made this matter arithmetically: detailed was trying to create 125
  // rooms for a 107-record panel, which is how a full guild hit Discord's cap
  // partway through and left fifty rooms of failure behind it.
  return [...eventSchema.keys()]
    .filter(eventId => !INTERNAL_DESTINATIONS.includes(eventSchema.get(eventId)!.category))
    .map(eventId => ({ key: eventId, name: slugifyEvent(eventId) }));
}

function slugifyEvent(eventId: string): string {
  return eventId.replace(/\./g, "-");
}

type ChannelOutcome = { name: string; ok: true; channelId: string } | { name: string; ok: false; message: string };

app.post("/api/guilds/:guildId/logging/setup", async (request, reply) => {
  const { guildId } = request.params as { guildId: string };
  const context = await requireTierForGuild(request, reply, guildId);
  if (!context) return;

  const body = request.body as { mode?: unknown } | undefined;
  const mode = isLoggingMode(body?.mode) ? body.mode : DEFAULT_LOGGING_MODE;

  if (!env.botToken) {
    return reply.code(503).send({ error: "BOT_NOT_CONFIGURED", message: "البوت غير مهيأ لإنشاء القنوات." });
  }

  const permissions = await fetchBotPermissions(env.botToken, guildId);
  if (permissions === null) {
    return reply
      .code(503)
      .send({ error: "PERMISSION_UNKNOWN", message: "تعذّر قراءة صلاحيات البوت في هذا السيرفر. أعد المحاولة." });
  }
  if (!hasPermission(permissions, DISCORD_PERMISSION_BITS.MANAGE_CHANNELS)) {
    return reply.code(409).send({
      error: "MISSING_PERMISSION",
      message: "البوت لا يملك صلاحية «إدارة القنوات» (Manage Channels) في هذا السيرفر."
    });
  }

  // Idempotency: reuse a channel that already carries the name. A second press
  // of the same button repairs what a rate limit interrupted instead of adding a
  // second `member-log` beside the first.
  const existing = await fetchGuildChannels(env.botToken, guildId).catch(() => [] as ChannelOption[]);
  const existingByName = new Map(
    existing.filter(channel => channel.type === "text").map(channel => [channel.name, channel.id] as const)
  );

  // Discord caps a guild at 500 channels, categories included. Failing at the
  // half-way mark leaves fifty rooms behind and a screen of identical errors;
  // counting first turns that into one refusal before anything is built. The
  // count reads the raw list because the cap counts categories too, and the
  // reuse credit matters because a retry after a partial run creates only the
  // missing remainder.
  const planned = plannedBindings(mode);
  const rawCount = (await fetchRawChannels(env.botToken, guildId).catch(() => [] as { id: string }[])).length;
  const stillToCreate = planned.filter(binding => !existingByName.has(binding.name)).length;
  const needsCategory = (await findGuildCategory(env.botToken, guildId, LOG_CATEGORY_NAME)) === null;
  if (rawCount + stillToCreate + (needsCategory ? 1 : 0) > DISCORD_GUILD_CHANNEL_CAP) {
    return reply.code(409).send({
      error: "GUILD_CHANNEL_CAP",
      message: `سيرفرك فيه ${rawCount} قناة من حد Discord البالغ 500. هذا الإعداد يحتاج إنشاء ${stillToCreate + (needsCategory ? 1 : 0)} قناة إضافية — احذف القنوات غير المستعملة أولاً.`
    });
  }

  let categoryId = await findGuildCategory(env.botToken, guildId, LOG_CATEGORY_NAME);
  if (!categoryId) {
    try {
      const category = await writeWithRetry(() =>
        createGuildChannel(env.botToken!, guildId, { name: LOG_CATEGORY_NAME, type: "category" })
      );
      categoryId = category.id;
    } catch (error) {
      const failure = describeChannelFailure(error);
      return reply.code(failure.status).send({ error: "CATEGORY_FAILED", message: failure.message });
    }
  }

  // Sequential on purpose: see the section comment on rate limits.
  const outcomes: ChannelOutcome[] = [];
  for (const binding of planned) {
    const reused = existingByName.get(binding.name);
    if (reused) {
      outcomes.push({ name: binding.name, ok: true, channelId: reused });
      continue;
    }
    try {
      const channel = await writeWithRetry(() =>
        createGuildChannel(env.botToken!, guildId, { name: binding.name, type: "text", parentId: categoryId })
      );
      outcomes.push({ name: binding.name, ok: true, channelId: channel.id });
    } catch (error) {
      outcomes.push({ name: binding.name, ok: false, message: describeChannelFailure(error).message });
    }
  }

  const created = outcomes.filter((outcome): outcome is Extract<ChannelOutcome, { ok: true }> => outcome.ok);
  const failed = outcomes.filter((outcome): outcome is Extract<ChannelOutcome, { ok: false }> => !outcome.ok);

  // Nothing landed: the routing table would be bound to channels that do not
  // exist, and logging would be announced enabled while delivering nowhere. A
  // partial setup is a 200 whose `failed` list names what to retry. The read
  // cache is dropped even here: the category this run may have created lives in
  // it, and a fast retry served from the stale list would build a second
  // «AL AI» beside the first.
  if (created.length === 0) {
    invalidateGuildReadCache(guildId);
    return reply
      .code(502)
      .send({ error: "CHANNEL_SETUP_FAILED", message: failed[0]?.message ?? "لم يُنشأ أي قسم.", failed });
  }

  const byName = new Map(created.map(outcome => [outcome.name, outcome.channelId]));
  const previous = await db.getLogging(guildId);
  // The mode the operator just chose owns the layout outright: a channel bound
  // by the other mode is not carried over, because a `normal` room and a
  // `detailed` room for the same section are not the same operator intent.
  // The global channel is cleared in both modes — every section gets its own
  // room now, so a leftover global would only be the room events fall into when
  // the section above them failed to bind.
  const settings: LoggingSettings = {
    ...previous,
    enabled: true,
    mode,
    globalChannelId: null,
    categoryChannels: mode === "normal" ? Object.fromEntries(plannedBindings("normal").map(binding => [binding.key, byName.get(binding.name)!]).filter(([, id]) => id)) : {},
    eventChannels: mode === "detailed" ? Object.fromEntries(plannedBindings("detailed").map(binding => [binding.key, byName.get(binding.name)!]).filter(([, id]) => id)) : {}
  };

  await db.saveLogging(guildId, settings);
  // The channel list this screen and every other picker reads is now stale.
  invalidateGuildReadCache(guildId);

  await appendAudit(db, env, {
    guildId,
    eventId: "bot.command-success",
    actorId: context.session!.discordUserId,
    payload: {
      action: "logging.setup",
      mode,
      created: created.map(outcome => outcome.name),
      failed: failed.map(outcome => outcome.name)
    }
  });

  return { settings, created, failed, savedAt: new Date().toISOString() };
});

app.delete("/api/guilds/:guildId/logging/channels", async (request, reply) => {
  const { guildId } = request.params as { guildId: string };
  const context = await requireTierForGuild(request, reply, guildId);
  if (!context) return;

  if (!env.botToken) {
    return reply.code(503).send({ error: "BOT_NOT_CONFIGURED", message: "البوت غير مهيأ لحذف القنوات." });
  }

  const previous = await db.getLogging(guildId);
  const bound = new Set<string>([
    ...(previous.globalChannelId ? [previous.globalChannelId] : []),
    ...Object.values(previous.categoryChannels),
    ...Object.values(previous.eventChannels)
  ]);

  // The category is looked up first, because the delete set is wider than the
  // bindings: a partial setup — the kind that stops halfway against Discord's
  // channel cap — leaves created-but-unbound rooms behind, and a teardown that
  // removed only the bound ones would strand them inside «AL AI» forever (the
  // category then never empties, so it is never deleted either). Every channel
  // the bot's own category holds goes with the setup; that is what pressing
  // «حذف قنوات السجلات» asks for, and the count the confirm dialog shows comes
  // from the same union on the client.
  const categoryId = await findGuildCategory(env.botToken, guildId, LOG_CATEGORY_NAME);
  const raw = await fetchRawChannels(env.botToken, guildId).catch(() => []);
  const orphans = categoryId
    ? raw.filter(channel => channel.parent_id === categoryId && !bound.has(channel.id)).map(channel => channel.id)
    : [];
  if (bound.size === 0 && orphans.length === 0) {
    return reply.code(404).send({ error: "NO_LOG_CHANNELS", message: "لا توجد قنوات سجلات مربوطة بهذا السيرفر." });
  }

  const existing = await fetchExistingChannelIds(env.botToken, guildId);
  const deleted: string[] = [];
  const failed: { channelId: string; message: string }[] = [];

  for (const channelId of [...bound, ...orphans]) {
    // A channel the operator removed by hand in Discord is already gone; counting
    // it as a failure would describe a problem that does not exist.
    if (!existing.has(channelId)) {
      deleted.push(channelId);
      continue;
    }
    try {
      await writeWithRetry(() => deleteGuildChannel(env.botToken!, channelId));
      deleted.push(channelId);
    } catch (error) {
      failed.push({ channelId, message: describeChannelFailure(error).message });
    }
  }

  // The category goes last and only when nothing refused: Discord orphans a
  // category's children rather than refusing the delete, so removing it while
  // channels remain would leave them visible but parentless. After the sweep
  // above the only children left are ones a failure just refused to release.
  if (categoryId) {
    invalidateGuildReadCache(guildId);
    const remaining = await categoryHasChildren(env.botToken, guildId, categoryId);
    if (!remaining && failed.length === 0) {
      try {
        await writeWithRetry(() => deleteGuildChannel(env.botToken!, categoryId));
      } catch (error) {
        failed.push({ channelId: categoryId, message: describeChannelFailure(error).message });
      }
    }
  }

  // Logging is disabled and the routing table cleared, even when some channels
  // survived: the operator asked for the setup to go, and a half-deleted set of
  // destinations is not a working logging configuration. What survived is in
  // `failed` for them to remove by hand.
  const settings: LoggingSettings = {
    ...previous,
    enabled: false,
    globalChannelId: null,
    categoryChannels: {},
    eventChannels: {}
  };

  await db.saveLogging(guildId, settings);
  invalidateGuildReadCache(guildId);

  await appendAudit(db, env, {
    guildId,
    eventId: "bot.command-success",
    actorId: context.session!.discordUserId,
    payload: { action: "logging.teardown", deleted: deleted.length, failed: failed.map(entry => entry.channelId) }
  });

  return { settings, deleted, failed, savedAt: new Date().toISOString() };
});

/* ------------------------------------------------------------------ *
 * Static dashboard + SPA fallback
 * ------------------------------------------------------------------ */
await app.register(fastifyStatic, { root: join(process.cwd(), "dist") });
app.setNotFoundHandler((request, reply) => {
  if (request.url.startsWith("/api/") || request.url.startsWith("/auth/") || request.url.startsWith("/internal/")) {
    return reply.code(404).send({ error: "NOT_FOUND" });
  }
  return reply.sendFile("index.html");
});

/* ------------------------------------------------------------------ *
 * Housekeeping
 * ------------------------------------------------------------------ */
const housekeeping = setInterval(async () => {
  try {
    // Keys with nothing left in the window are dropped, so the throttle cannot
    // grow one entry per address that has ever called the dashboard.
    throttle.sweep(Date.now());
    const sessions = await db.purgeExpiredSessions();
    const nonces = await db.purgeExpiredNonces();
    if (sessions || nonces) app.log.info(`Purged ${sessions} expired sessions and ${nonces} expired nonces.`);
  } catch (error) {
    app.log.error(error, "Housekeeping failed");
  }
}, 5 * 60 * 1000);
housekeeping.unref();

await app.listen({ port: env.port, host: "0.0.0.0" });

/**
 * Graceful shutdown.
 *
 * SIGTERM is how the container orchestrator stops this process and SIGINT is how
 * a developer does, and neither is an error. Closing the server first drains the
 * listening socket so in-flight requests get a reply rather than a reset, then
 * the pool ends its connections instead of leaving them for the OS to notice.
 * Without this the housekeeping interval and the pool were simply abandoned on
 * every stop — `db.close()` existed and nothing called it.
 */
async function shutdown(signal: NodeJS.Signals) {
  app.log.info({ signal }, "AL AI dashboard is shutting down");
  try {
    network.stop();
    await app.close();
    await db.close();
  } catch (error) {
    app.log.error(error, "Shutdown failed");
  }
  process.exit(0);
}

process.on("SIGTERM", signal => void shutdown(signal));
process.on("SIGINT", signal => void shutdown(signal));
