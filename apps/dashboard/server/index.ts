import { randomBytes, randomUUID } from "node:crypto";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import { join } from "node:path";
import {
  assertUniqueChannelAssignment,
  commandModules,
  commandRegistry,
  decryptSecret,
  DEFAULT_EMBED_COLOR,
  describeVerification,
  encryptSecret,
  isTier,
  LAYER_SIGNATURE_TTL_MS,
  MAX_NICKNAME_LENGTH,
  normaliseHexColor,
  normaliseIconUrl,
  normaliseNickname,
  requireCommand,
  SESSION_COOKIE_NAME,
  verifyLayerRequest,
  type CustomizationSettings,
  type LoggingSettings,
  type HealthSnapshot,
  type Tier
} from "@al-ai/core";
import { loadEnv } from "./env.js";
import { createDatabase, createPool } from "./db.js";
import { clearedCookieHeader, destroySession, issueSession, parseCookies, readSession, sessionAccessToken, sessionCookieHeader } from "./session.js";
import { assertTier, AuthorizationError, botIdentityPermissionStatus, resolveActorTier } from "./authorization.js";
import { appendAudit } from "./audit.js";
import {
  buildAuthorizeUrl,
  buildBotInviteUrl,
  exchangeCode,
  fetchBotGuildIds,
  fetchGuildChannels,
  fetchGuildRoles,
  fetchBotHighestRolePosition,
  fetchIdentity,
  fetchUserGuilds,
  guildIconUrl,
  USER_PERMISSIONS,
  userAvatarUrl,
  hasPermission
} from "./discord.js";

const env = loadEnv();
const pool = createPool(env.databaseUrl);
const db = createDatabase(pool);

const app = Fastify({ logger: true, trustProxy: true });

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

type Ctx = { session: Awaited<ReturnType<typeof readSession>>; guildId: string };

async function requireSession(request: FastifyRequest, reply: FastifyReply) {
  const session = await readSession(db, request as unknown as { headers: Record<string, unknown> });
  if (!session) {
    reply.code(401).send({ error: "UNAUTHENTICATED", message: "الجلسة منتهية أو غير موجودة. سجّل الدخول عبر Discord." });
    return null;
  }
  return session;
}

/** Re-resolves the caller's tier on the server for every write. */
async function requireTierForGuild(request: FastifyRequest, reply: FastifyReply, guildId: string, required: Tier = "admin") {
  const session = await requireSession(request, reply);
  if (!session) return null;

  const userGuilds = await fetchUserGuilds(sessionAccessToken(session, env));
  const membership = userGuilds.find(guild => guild.id === guildId);
  if (!membership) {
    reply.code(403).send({ error: "NOT_A_MEMBER", message: "لا تملك وصولاً إلى هذا السيرفر." });
    return null;
  }

  const tier = await resolveActorTier({
    db,
    botToken: env.botToken,
    guildId,
    discordUserId: session.discordUserId,
    userIsGuildOwner: membership.owner
  });

  try {
    assertTier(tier, required);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      await appendAudit(db, env, {
        guildId,
        severity: "warning",
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

/** A stored token is never displayed again: only this masked fingerprint is. */
function maskToken(token: string) {
  const [id, , signature] = token.split(".");
  const head = id ? id.slice(0, 6) : token.slice(0, 6);
  const tail = signature ? signature.slice(-4) : token.slice(-4);
  return `${head}••••••••${tail}`;
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
  try {
    await db.ping();
    guildCount = await db.countGuilds();
    uniqueUsers = await db.countUniqueUsers();
  } catch {
    database = "unreachable";
  }
  return {
    status: database === "reachable" ? "healthy" : "degraded",
    dashboard: "online",
    bot: env.botToken ? "connected" : "awaiting_secret",
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

app.get("/auth/discord/login", async (_request, reply) => {
  const state = randomBytes(16).toString("base64url");
  reply.header(
    "Set-Cookie",
    `${SESSION_COOKIE_NAME}_state=${state}; Path=/; Max-Age=600; HttpOnly; SameSite=Lax`
  );
  return reply.redirect(buildAuthorizeUrl({ clientId: env.clientId, redirectUri: env.redirectUri, state, scopes: ["identify", "guilds"] }));
});

app.get("/auth/discord/callback", async (request, reply) => {
  const query = request.query as { code?: string; state?: string; error?: string };
  if (query.error) return reply.redirect("/?auth=denied");
  const cookies = parseCookies(request.headers.cookie);
  if (!query.code || !query.state || cookies[`${SESSION_COOKIE_NAME}_state`] !== query.state) {
    return reply.redirect("/?auth=state_mismatch");
  }

  try {
    const tokens = await exchangeCode({ clientId: env.clientId, clientSecret: env.clientSecret, redirectUri: env.redirectUri, code: query.code });
    const identity = await fetchIdentity(tokens.access_token);
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
 * ------------------------------------------------------------------ */
app.get("/api/guilds", async (request, reply) => {
  const session = await readSession(db, request as unknown as { headers: Record<string, unknown> });

  // No session means no guilds. AL AI has no public read-only mode.
  if (!session) {
    return reply.code(401).send({ error: "UNAUTHENTICATED", message: "سجّل الدخول عبر Discord." });
  }

  const [userGuilds, botGuildIds] = await Promise.all([
    fetchUserGuilds(sessionAccessToken(session, env)),
    env.botToken ? fetchBotGuildIds(env.botToken) : Promise.resolve(new Set<string>())
  ]);

  // Only guilds where the account is present AND the bot is present are
  // manageable from AL AI.
  const managed = userGuilds.filter(guild => botGuildIds.has(guild.id) || guild.owner);

  const guilds = await Promise.all(
    managed.map(async guild => {
      await db.upsertGuild({ id: guild.id, name: guild.name, iconUrl: guild.icon, memberCount: 0, botPresent: botGuildIds.has(guild.id) });
      const tier = await resolveActorTier({
        db,
        botToken: env.botToken,
        guildId: guild.id,
        discordUserId: session.discordUserId,
        userIsGuildOwner: guild.owner
      });
      const record = await db.getGuild(guild.id);
      return {
        id: guild.id,
        name: guild.name,
        iconUrl: guildIconUrl(guild.id, guild.icon),
        memberCount: record?.memberCount ?? 0,
        tier,
        botPresent: botGuildIds.has(guild.id),
        canManageIdentity: tier !== null,
        canManageLogging: tier !== null,
        canManageCommands: tier !== null,
        canManageTiers: tier === "owner",
        canInvite: hasPermission(guild.permissions, USER_PERMISSIONS.MANAGE_GUILD)
      };
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
 */
app.get("/api/guilds/:guildId/invite", async (request, reply) => {
  const { guildId } = request.params as { guildId: string };
  const session = await requireSession(request, reply);
  if (!session) return;
  const target = normaliseSnowflake(guildId);
  if (!target) return reply.code(400).send({ error: "INVALID_GUILD_ID", message: "معرّف السيرفر غير صالح." });
  return reply.redirect(buildBotInviteUrl(env.clientId, target));
});

app.get("/api/guilds/:guildId/channels", async (request, reply) => {
  const { guildId } = request.params as { guildId: string };
  const session = await requireSession(request, reply);
  if (!session) return;
  if (!env.botToken) return reply.code(503).send({ error: "BOT_NOT_CONFIGURED", message: "البوت غير مهيأ لقراءة القنوات." });
  return { channels: await fetchGuildChannels(env.botToken, guildId) };
});

/* ------------------------------------------------------------------ *
 * Tier roles — GOVERNANCE rule 3
 *
 * Tiers bind to Role IDs, never User IDs. Until this is configured every actor
 * resolves to null and the dashboard denies access, so this screen is the one
 * that makes the rest of the product usable. It is therefore Owner-only, and
 * the Discord guild owner always passes (resolveActorTier short-circuits).
 * ------------------------------------------------------------------ */
app.get("/api/guilds/:guildId/tiers", async (request, reply) => {
  const { guildId } = request.params as { guildId: string };
  const context = await requireTierForGuild(request, reply, guildId, "owner");
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
  const context = await requireTierForGuild(request, reply, guildId, "owner");
  if (!context) return;

  const body = request.body as Partial<Record<Tier, string | null>> | undefined;
  if (!body || typeof body !== "object") {
    return reply.code(400).send({ error: "INVALID_BODY", message: "يتطلب تعيين الرتب الأربع." });
  }

  const tiers = {
    owner: normaliseSnowflake(body.owner),
    head_admin: normaliseSnowflake(body.head_admin),
    admin: normaliseSnowflake(body.admin),
    moderator: normaliseSnowflake(body.moderator)
  };

  if (!tiers.owner) {
    return reply.code(400).send({ error: "OWNER_ROLE_REQUIRED", message: "رتبة المالك إلزامية." });
  }

  // One role cannot hold two tiers: the resolution order would silently hide one.
  const assigned = (Object.entries(tiers) as [Tier, string | null][]).filter(([, id]) => id);
  const duplicates = assigned.filter(([, id], index) => assigned.findIndex(([, other]) => other === id) !== index);
  if (duplicates.length) {
    return reply.code(400).send({ error: "DUPLICATE_ROLE", message: "الرتبة نفسها لا تُسند إلى مستويين." });
  }

  await db.saveTierRoles(guildId, tiers);
  await appendAudit(db, env, {
    guildId,
    severity: "warning",
    eventId: "role.update",
    actorId: context.session!.discordUserId,
    payload: { action: "tier.assign", tiers }
  });

  return { configured: tiers };
});

/** Discord snowflakes are numeric strings; anything else is treated as unset. */
/** Discord snowflakes are 17-20 digits. Anything else is rejected before use. */
function normaliseSnowflake(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^\d{17,20}$/.test(trimmed) ? trimmed : null;
}

/* ------------------------------------------------------------------ *
 * General commands
 * ------------------------------------------------------------------ */
app.get("/api/guilds/:guildId/commands", async (request, reply) => {
  const { guildId } = request.params as { guildId: string };
  const session = await requireSession(request, reply);
  if (!session) return;
  const flags = await db.getCommandFlags(guildId);
  return {
    modules: commandModules,
    commands: commandRegistry.map(command => ({ ...command, enabled: flags.get(command.name) ?? true }))
  };
});

/**
 * Applies a batch of command changes.
 *
 * The body carries only the commands the operator actually edited. Both fields
 * are validated here: an unknown command name is rejected against the shared
 * registry, and the minimum tier is narrowed to a real tier so the stored value
 * can never be something the bot cannot interpret.
 */
app.put("/api/guilds/:guildId/commands", async (request, reply) => {
  const { guildId } = request.params as { guildId: string };
  const context = await requireTierForGuild(request, reply, guildId);
  if (!context) return;

  const body = request.body as { changes?: { command?: string; enabled?: boolean; minimumTier?: string }[] } | undefined;
  const changes = body?.changes;
  if (!Array.isArray(changes) || changes.length === 0) {
    return reply.code(400).send({ error: "INVALID_BODY", message: "أرسل قائمة التغييرات المطلوبة." });
  }

  const accepted: { name: string; enabled: boolean; minimumTier: Tier }[] = [];
  for (const change of changes) {
    if (typeof change?.command !== "string" || typeof change.enabled !== "boolean" || !isTier(change.minimumTier)) {
      return reply.code(400).send({ error: "INVALID_CHANGE", message: "كل تغيير يحتاج اسماً وحالة ورتبة صحيحة." });
    }
    try {
      accepted.push({ name: requireCommand(change.command).name, enabled: change.enabled, minimumTier: change.minimumTier });
    } catch {
      return reply.code(400).send({ error: "UNKNOWN_COMMAND", message: "هذا الأمر غير مسجل في AL AI." });
    }
  }

  for (const change of accepted) {
    await db.saveCommandFlag(guildId, change.name, change.enabled, change.minimumTier);
  }

  await appendAudit(db, env, {
    guildId,
    severity: "warning",
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
  const session = await requireSession(request, reply);
  if (!session) return;
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
  const session = await requireSession(request, reply);
  if (!session) return;
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
 * Bot tokens: write-only. A stored token is never returned again.
 * ------------------------------------------------------------------ */
app.get("/api/tokens", async (request, reply) => {
  const session = await requireSession(request, reply);
  if (!session) return;
  const rows = await db.listTokens();
  return {
    tokens: rows.map(row => ({
      id: row.id,
      label: row.label,
      masked: row.fingerprint,
      guildIds: row.guild_ids,
      createdAt: row.created_at
    }))
  };
});

app.post("/api/tokens", async (request, reply) => {
  const session = await requireSession(request, reply);
  if (!session) return;
  const body = request.body as { label?: string; token?: string; guildIds?: string[] } | undefined;
  const label = (body?.label ?? "").trim();
  const token = (body?.token ?? "").trim();
  if (!label || !token) return reply.code(400).send({ error: "INVALID_BODY", message: "يتطلب اسماً وتوكن." });

  const guildIds = Array.isArray(body?.guildIds) ? body!.guildIds!.filter(Boolean) : [];
  await db.createToken({
    id: randomUUID(),
    label,
    ciphertext: encryptSecret(token, env.encryptionKey),
    fingerprint: maskToken(token),
    guildIds
  });
  await appendAudit(db, env, {
    guildId: guildIds[0] ?? null,
    severity: "warning",
    eventId: "bot.command-success",
    actorId: session.discordUserId,
    payload: { action: "token.create", label }
  });
  return { created: true };
});

app.delete("/api/tokens/:tokenId", async (request, reply) => {
  const session = await requireSession(request, reply);
  if (!session) return;
  const { tokenId } = request.params as { tokenId: string };
  const removed = await db.deleteToken(tokenId);
  if (!removed) return reply.code(404).send({ error: "NOT_FOUND" });
  await appendAudit(db, env, {
    guildId: null,
    severity: "warning",
    eventId: "bot.command-success",
    actorId: session.discordUserId,
    payload: { action: "token.delete" }
  });
  return { deleted: true };
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
  const session = await requireSession(request, reply);
  if (!session) return;
  const settings = await db.getCustomization(guildId);
  const permissions = env.botToken ? await botIdentityPermissionStatus(env.botToken, guildId) : [];
  return { settings, permissions };
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

  const roleIconUrl = normaliseIconUrl(body?.roleIconUrl);
  if (body?.roleIconUrl && !roleIconUrl) {
    return reply.code(400).send({ error: "INVALID_ROLE_ICON", message: "أيقونة الرتبة يجب أن تكون رابط HTTPS صالحاً." });
  }

  // Refuse instead of performing an operation that is guaranteed to fail.
  if (env.botToken) {
    const statuses = await botIdentityPermissionStatus(env.botToken, guildId);
    const nicknamePermission = statuses.find(status => status.key === "change_nickname");
    if (nicknamePermission && !nicknamePermission.granted) {
      return reply.code(409).send({ error: "MISSING_PERMISSION", message: "البوت لا يملك صلاحية «تغيير الاسم المستعار» في هذا السيرفر." });
    }
  }

  const settings: CustomizationSettings = { nickname, roleColor, roleIconUrl };
  await db.saveCustomization(guildId, settings);
  await appendAudit(db, env, {
    guildId,
    severity: "warning",
    eventId: "bot.command-success",
    actorId: context.session!.discordUserId,
    payload: { action: "customization.save", nickname, roleColor, roleIconUrl }
  });
  return { settings, savedAt: new Date().toISOString() };
});

/* ------------------------------------------------------------------ *
 * Logging
 * ------------------------------------------------------------------ */
app.get("/api/guilds/:guildId/logging", async (request, reply) => {
  const { guildId } = request.params as { guildId: string };
  const session = await requireSession(request, reply);
  if (!session) return;
  return { settings: await db.getLogging(guildId) };
});

app.put("/api/guilds/:guildId/logging", async (request, reply) => {
  const { guildId } = request.params as { guildId: string };
  const context = await requireTierForGuild(request, reply, guildId);
  if (!context) return;

  const body = request.body as Partial<LoggingSettings> | undefined;
  const settings: LoggingSettings = {
    enabled: Boolean(body?.enabled),
    globalChannelId: body?.globalChannelId ?? null,
    ignoredChannelIds: Array.isArray(body?.ignoredChannelIds) ? body.ignoredChannelIds : [],
    embedColor: /^#[0-9a-f]{6}$/i.test(body?.embedColor ?? "") ? body!.embedColor! : DEFAULT_EMBED_COLOR,
    eventFlags: body?.eventFlags ?? {},
    categoryChannels: body?.categoryChannels ?? {}
  };

  // One destination may never resolve to two channels.
  try {
    assertUniqueChannelAssignment(settings.categoryChannels);
  } catch (error) {
    return reply.code(400).send({ error: "DUPLICATE_CHANNEL", message: (error as Error).message });
  }

  const ignored = new Set(settings.ignoredChannelIds);
  const conflict = Object.values(settings.categoryChannels).find(channelId => channelId && ignored.has(channelId));
  if (conflict) {
    return reply.code(400).send({ error: "IGNORED_CHANNEL_CONFLICT", message: "قناة مستثناة لا يمكن أن تكون وجهة سجل." });
  }

  await db.saveLogging(guildId, settings);
  await appendAudit(db, env, {
    guildId,
    severity: "warning",
    eventId: "bot.command-success",
    actorId: context.session!.discordUserId,
    payload: { action: "logging.save", enabled: settings.enabled, destinations: Object.keys(settings.categoryChannels).length }
  });
  return { settings, savedAt: new Date().toISOString() };
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
    const sessions = await db.purgeExpiredSessions();
    const nonces = await db.purgeExpiredNonces();
    if (sessions || nonces) app.log.info(`Purged ${sessions} expired sessions and ${nonces} expired nonces.`);
  } catch (error) {
    app.log.error(error, "Housekeeping failed");
  }
}, 5 * 60 * 1000);
housekeeping.unref();

await app.listen({ port: env.port, host: "0.0.0.0" });
