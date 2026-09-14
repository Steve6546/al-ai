/**
 * Discord access for the dashboard.
 *
 * SCOPE BOUNDARY (see docs/GOVERNANCE.md rule 2):
 * - The bot's guild mutations stay in `apps/bot/src/lib/discord.ts`.
 * - This module is the BFF's only Discord entry point. It performs the user
 *   OAuth exchange and a small set of READ-ONLY bot-token lookups needed to
 *   authorize dashboard actions. It never mutates a guild and never returns a
 *   token to the browser.
 */

import { BOT_INVITE_SCOPES, type ChannelOption } from "@al-ai/core";
import { TtlCache } from "./cache.js";

const API = "https://discord.com/api/v10";
export const USER_PERMISSIONS = {
  /**
   * Administrator (bit 3). Holders get the automatic owner tier, because Discord
   * already treats them as fully trusted in that guild.
   */
  ADMINISTRATOR: 0x8n,
  MANAGE_GUILD: 0x20n,
  MANAGE_NICKNAMES: 0x8000000n,
  CHANGE_NICKNAME: 0x4000000n
} as const;

export type DiscordIdentity = { id: string; username: string; globalName: string | null; avatar: string | null };
export type DiscordUserGuild = { id: string; name: string; icon: string | null; owner: boolean; permissions: bigint };

/**
 * A non-OK answer from Discord, carrying the status so callers can tell the
 * three cases apart.
 *
 * They are not interchangeable, and the difference is what the operator feels:
 *
 * - **401** — Discord refused the stored token. Nothing can be done here; the
 *   only way forward is a fresh sign-in.
 * - **429** — AL AI asked too often. The session is perfectly valid and the
 *   same request succeeds in a moment.
 * - **anything else** — a transient fault on Discord's side.
 *
 * Collapsing them into one bare `Error` is what made a rate limit look like an
 * expired session, and so logged the operator out for pressing refresh too
 * quickly. The status has to survive to the caller for it to be handled right.
 */
export class DiscordApiError extends Error {
  constructor(
    public readonly status: number,
    path: string,
    body: string,
    /** Seconds Discord asked us to wait, when it said so. */
    public readonly retryAfterSeconds: number | null = null
  ) {
    super(`Discord ${path} failed with ${status}: ${body.slice(0, 200)}`);
    this.name = "DiscordApiError";
  }
}

/**
 * True when Discord rejected the *credential* rather than the request.
 *
 * Only 401 counts. 403 is deliberately excluded: on these endpoints it means
 * "this token may not call this route" (a permission problem) rather than "this
 * token is dead", and treating it as an auth failure would sign the operator
 * out over a misconfiguration that a new sign-in cannot fix.
 */
export function isAuthFailure(error: unknown): boolean {
  return error instanceof DiscordApiError && error.status === 401;
}

/** True when Discord is asking us to slow down. */
export function isRateLimited(error: unknown): boolean {
  return error instanceof DiscordApiError && error.status === 429;
}

/**
 * Discord's own "wait this long" hint.
 *
 * The JSON body carries `retry_after` in seconds; the header carries whole
 * seconds and is the fallback when the body is not JSON (a proxy error page,
 * for instance). Returning null means "no hint", which callers must not read as
 * zero.
 */
function readRetryAfter(body: string, headers: Headers): number | null {
  try {
    const parsed = JSON.parse(body) as { retry_after?: unknown };
    if (typeof parsed.retry_after === "number" && Number.isFinite(parsed.retry_after)) return parsed.retry_after;
  } catch {
    // Not JSON: fall through to the header.
  }
  const header = Number(headers.get("retry-after"));
  return Number.isFinite(header) && header >= 0 ? header : null;
}

async function request<T>(path: string, init: RequestInit & { token: string; scheme?: "Bot" | "Bearer" }): Promise<T> {
  const { token, scheme = "Bot", ...rest } = init;
  const response = await fetch(`${API}${path}`, {
    ...rest,
    headers: {
      Authorization: `${scheme} ${token}`,
      "Content-Type": "application/x-www-form-urlencoded",
      ...(rest.headers ?? {})
    }
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const retryAfter = response.status === 429 ? readRetryAfter(body, response.headers) : null;
    throw new DiscordApiError(response.status, path, body, retryAfter);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/**
 * A Discord call that sends and receives JSON.
 *
 * Separate from `request` above, which posts form-encoded bodies for the OAuth
 * token exchange. Both throw the same `DiscordApiError`, so the 401-versus-403
 * and 429-versus-everything-else classification stays in one place rather than
 * being re-derived by each caller.
 *
 * The error carries the raw body, because the appearance writer needs Discord's
 * `code` (50013 for a missing permission, 50035 for a rejected value) to say
 * something more useful than "the request failed".
 */
export async function requestJson<T>(
  path: string,
  init: { token: string; method: "GET" | "PATCH" | "POST"; body?: unknown }
): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    method: init.method,
    headers: { Authorization: `Bot ${init.token}`, "Content-Type": "application/json" },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) })
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const retryAfter = response.status === 429 ? readRetryAfter(text, response.headers) : null;
    throw new DiscordApiError(response.status, path, text, retryAfter);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export function buildAuthorizeUrl(input: { clientId: string; redirectUri: string; state: string; scopes: readonly string[] }) {
  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope: input.scopes.join(" "),
    state: input.state,
    prompt: "consent"
  });
  return `https://discord.com/oauth2/authorize?${params}`;
}

/**
 * Administrator (bit 3). AL AI creates roles, edits channels and moderates
 * members, so it needs the full bitfield rather than a hand-picked subset — the
 * previous value was 1 << 40 (MODERATE_MEMBERS), which silently left the bot
 * unable to perform most of its own commands.
 */
export const BOT_PERMISSIONS = "8";

/**
 * The bot invite. When a guild is known the invite is pinned to it and Discord's
 * server picker is hidden, so the operator can only add AL AI to the guild they
 * are actually configuring — never to every guild their account can reach.
 *
 * Passing `redirectUri` is what closes the loop. Without it Discord shows its
 * own "all done" page and strands the operator there, and the dashboard never
 * learns the bot arrived — so the guild they just added it to still reads
 * «غير مضاف». With it, Discord hands the browser back to the dashboard's OAuth
 * callback along with the `guild_id` it just joined.
 *
 * `response_type=code` is required for that return leg, and `state` is the same
 * CSRF guard the sign-in flow uses.
 */
export function buildBotInviteUrl(
  clientId: string,
  guildId?: string,
  returnTo?: { redirectUri: string; state: string }
) {
  const params = new URLSearchParams({
    client_id: clientId,
    // Read from the shared contract rather than repeated as a literal: the
    // scopes are frozen there, and a second copy is a second thing to update.
    scope: BOT_INVITE_SCOPES.join(" "),
    permissions: BOT_PERMISSIONS
  });
  if (guildId) {
    params.set("guild_id", guildId);
    params.set("disable_guild_select", "true");
  }
  if (returnTo) {
    params.set("response_type", "code");
    params.set("redirect_uri", returnTo.redirectUri);
    params.set("state", returnTo.state);
  }
  return `https://discord.com/oauth2/authorize?${params}`;
}

export async function exchangeCode(input: { clientId: string; clientSecret: string; redirectUri: string; code: string }) {
  const body = new URLSearchParams({
    client_id: input.clientId,
    client_secret: input.clientSecret,
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri
  });
  const response = await fetch(`${API}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  if (!response.ok) throw new Error(`Discord token exchange failed with ${response.status}.`);
  return (await response.json()) as { access_token: string; refresh_token?: string; scope: string; expires_in: number };
}

export async function fetchIdentity(accessToken: string) {
  return request<DiscordIdentity>("/users/@me", { token: accessToken, scheme: "Bearer" });
}

export async function fetchUserGuilds(accessToken: string) {
  const guilds = await request<{ id: string; name: string; icon: string | null; owner: boolean; permissions: string }[]>("/users/@me/guilds", {
    token: accessToken,
    scheme: "Bearer"
  });
  return guilds.map<DiscordUserGuild>(guild => ({
    id: guild.id,
    name: guild.name,
    icon: guild.icon,
    owner: guild.owner,
    permissions: BigInt(guild.permissions ?? "0")
  }));
}

/**
 * How long the caller's own guild list is trusted.
 *
 * Every guild-scoped route runs the same guard, and the guard's first question
 * is always "which guilds does this person belong to?" — so an uncached read
 * here meant one identical `/users/@me/guilds` request per guarded route. One
 * customization screen load runs three of them, and clicking a tab runs them
 * again; that is the request that actually tripped Discord's limit.
 *
 * Short, because a bot invited to a guild a moment ago must appear on the next
 * deliberate look — but measured against the same 429 window Discord applies to
 * this endpoint, which is far longer than a screen load.
 */
const USER_GUILD_CACHE_MS = 20_000;

/**
 * Keyed by *access token*, not by user.
 *
 * The token is what the request is authenticated with, so it is the only thing
 * that can distinguish two callers' answers. Keying by user id would serve one
 * session's guild list to another if a user re-authorised with different scopes,
 * and keying on nothing would hand every caller the first caller's guilds.
 */
const userGuildCache = new TtlCache<string, DiscordUserGuild[]>(USER_GUILD_CACHE_MS);

/**
 * The caller's guild list, cached and coalesced for the life of one screen load.
 *
 * `TtlCache.resolve` also coalesces concurrent callers, which matters here more
 * than the TTL: the routes a single screen fires overlap, so three callers ask
 * this question in the same tick and must share one request rather than race.
 */
export function fetchUserGuildsCached(accessToken: string): Promise<DiscordUserGuild[]> {
  return userGuildCache.resolve(accessToken, () => fetchUserGuilds(accessToken));
}

/**
 * How long the bot's guild list is trusted.
 *
 * Short on purpose: long enough to absorb a burst of refreshes, short enough
 * that a bot invited a moment ago shows up on the next look.
 */
const BOT_GUILD_CACHE_MS = 15_000;

/**
 * How long a guild's roles and channels are trusted.
 *
 * Roles and channels change on the scale of minutes, so 45 seconds removes
 * nearly every repeat call without the operator ever seeing a stale screen: the
 * one action that changes either list is performed in Discord, not here, and the
 * screen that shows it is reloaded by hand.
 */
const GUILD_READ_CACHE_MS = 45_000;

const botGuildCache = new TtlCache<string, Set<string>>(BOT_GUILD_CACHE_MS);
const guildChannelCache = new TtlCache<string, ChannelOption[]>(GUILD_READ_CACHE_MS);
const guildRoleCache = new TtlCache<string, DiscordRole[]>(GUILD_READ_CACHE_MS);

/**
 * The raw `/guilds/{id}/roles` payload, shared by every reader of it.
 *
 * `fetchGuildRoles` memoised the *mapped* list, which was not enough: the
 * permission check, the hierarchy check and the role picker each issue their own
 * raw request, so the identical list was pulled from Discord three times for a
 * single screen load. Measured before this cache existed: **one customization
 * page load cost 7 Discord calls, three of them the same role list** — enough to
 * trip the rate limit when an operator clicks through the tabs.
 *
 * The raw payload is what is shared, not the mapped one, because the two callers
 * want different shapes: the picker wants `DiscordRole[]`, while the permission
 * and hierarchy maths want `{ id, permissions }` and `{ id, position }`. Caching
 * the response keeps one copy of the truth and lets each reader project it.
 */
type RawGuildRole = { id: string; name: string; position: number; managed: boolean; color: number; permissions: string };
const guildRoleListCache = new TtlCache<string, RawGuildRole[]>(GUILD_READ_CACHE_MS);

/**
 * The in-flight member read per guild, so concurrent callers share one request.
 *
 * Deliberately narrower than the 45-second caches above. A member object is what
 * the *permission* check reads, and a permission can be revoked in Discord at
 * any moment — serving a 45-second-old bitfield to a write path would let the
 * dashboard claim the bot holds a permission it has since lost. Coalescing only
 * the in-flight request costs nothing in correctness: all callers within the
 * same tick are answering the same question at the same instant.
 *
 * Without this, one screen load spent two identical member reads (the permission
 * check and the hierarchy check race each other), which is half of why clicking
 * through the tabs hit Discord's rate limit.
 */
const botMemberInFlight = new Map<string, Promise<BotMember | null>>();

const BOT_GUILD_KEY = "bot-guilds";

/** Drop the memoised bot guild list. Used after an invite and by tests. */
export function invalidateBotGuildCache() {
  botGuildCache.clear();
}

/**
 * Drop the memoised roles and channels for one guild, or for all of them.
 *
 * Nothing in the dashboard edits either list, so this exists for the screens
 * that change what Discord would report next — and for tests, which must not
 * inherit another case's cache.
 */
export function invalidateGuildReadCache(guildId?: string) {
  if (guildId === undefined) {
    guildChannelCache.clear();
    guildRoleCache.clear();
    guildRoleListCache.clear();
    return;
  }
  guildChannelCache.clear(guildId);
  guildRoleCache.clear(guildId);
  guildRoleListCache.clear(guildId);
}

/**
 * Drop the memoised caller guild list.
 *
 * Called when a session ends, so the next sign-in cannot inherit the previous
 * caller's guilds, and after the bot-invite callback, so a guild the bot was
 * just added to is visible on the immediately following look rather than up to
 * twenty seconds later.
 */
export function invalidateUserGuildCache(accessToken?: string) {
  if (accessToken === undefined) {
    userGuildCache.clear();
    return;
  }
  userGuildCache.clear(accessToken);
}

/**
 * Read-only: the guild's raw role list, shared by every reader.
 *
 * One request, one cache entry, three consumers. See `guildRoleListCache` above
 * for why the raw payload is what gets cached.
 */
function fetchGuildRoleList(botToken: string, guildId: string): Promise<RawGuildRole[]> {
  return guildRoleListCache.resolve(guildId, () =>
    request<RawGuildRole[]>(`/guilds/${guildId}/roles`, { token: botToken })
  );
}

/**
 * Read-only: which guilds the AL AI bot is actually a member of.
 *
 * Memoised because this changes only when the bot joins or leaves a guild, yet
 * it was being fetched on *every* selector load — and the selector refetches on
 * every visit and every press of refresh. Together with the user's own guild
 * read that made two Discord calls per click, which tripped Discord's rate
 * limit within a few presses and surfaced to the operator as a 500.
 */
export async function fetchBotGuildIds(botToken: string): Promise<Set<string>> {
  return botGuildCache.resolve(BOT_GUILD_KEY, async () => {
    const guilds = await request<{ id: string }[]>("/users/@me/guilds", { token: botToken });
    return new Set(guilds.map(guild => guild.id));
  });
}

/** Read-only: the AL AI role IDs a user holds, used to resolve their tier. */
export async function fetchMemberRoleIds(botToken: string, guildId: string, userId: string) {
  const member = await request<{ roles: string[] }>(`/guilds/${guildId}/members/${userId}`, { token: botToken });
  return new Set(member.roles ?? []);
}

/* ------------------------------------------------------------------ *
 * The bot's own member object
 *
 * "Which roles and permissions do I myself hold in this guild?" is needed by
 * three screens: the tier picker (which roles can I assign), the customization
 * form (may I rename myself) and the hierarchy warning (am I above the roles I
 * am asked to manage).
 *
 * Discord answers that question only if the bot's own snowflake is in the path.
 * Two plausible-looking shortcuts are both dead ends, and both fail *quietly*
 * when their error is swallowed:
 *   - `GET /guilds/{id}/members/@me`        → 400 NUMBER_TYPE_COERCE
 *                                             ("Value \"@me\" is not snowflake")
 *   - `GET /users/@me/guilds/{id}/member`   → 403 "Bots cannot use this endpoint"
 *                                             (that route is OAuth2-only)
 * So the ID is resolved from `GET /users/@me` — the one `@me` route that does
 * accept a Bot token — and the plain member route is used with it.
 * ------------------------------------------------------------------ */

let cachedBotUserId: string | null = null;

/**
 * The in-flight `/users/@me` read, so concurrent callers share one request.
 *
 * Memoising only the *result* was not enough. On a cold cache the permission
 * check and the hierarchy check both call this in the same tick, both see
 * `cachedBotUserId === null`, and both issue the request — which is why one
 * screen load was measured at **two** `GET /users/@me`. Holding the promise
 * closes that window: the second caller awaits the first caller's promise
 * instead of starting its own.
 */
let botUserIdInFlight: Promise<string> | null = null;

/**
 * The bot application's own user ID.
 *
 * This is a property of the token rather than of any request, so it is memoised
 * for the life of the process. Rotating the token restarts the process.
 */
export async function resolveBotUserId(botToken: string): Promise<string> {
  if (cachedBotUserId) return cachedBotUserId;
  if (botUserIdInFlight) return botUserIdInFlight;

  botUserIdInFlight = (async () => {
    const me = await request<{ id: string }>("/users/@me", { token: botToken });
    cachedBotUserId = me.id;
    return me.id;
  })();

  try {
    return await botUserIdInFlight;
  } finally {
    // Released either way. Holding a rejected promise would poison every later
    // call for the life of the process, which is how a single transient 401
    // would take the dashboard down until a restart.
    botUserIdInFlight = null;
  }
}

/** Test seam: drop the memoised bot user ID so a fake token is re-resolved. */
export function resetBotUserIdCache() {
  cachedBotUserId = null;
  botUserIdInFlight = null;
}

/**
 * Test seam: drop every memoised guild read and the in-flight coalescers.
 *
 * A cache that survives between tests is a correctness hazard rather than a
 * convenience: the second test in a file sees the first test's guild roles and
 * its assertions pass or fail for reasons that have nothing to do with the code
 * under test. Two tests in `discord.test.ts` began failing exactly that way when
 * the role list was first shared. Tests call this in `beforeEach`.
 */
export function resetGuildReadCaches() {
  guildChannelCache.clear();
  guildRoleCache.clear();
  guildRoleListCache.clear();
  userGuildCache.clear();
  botMemberInFlight.clear();
}

export type BotMember = {
  /** Role IDs the bot holds. `@everyone` is omitted by Discord. */
  roles: string[];
  /** The bot's permission bitfield, as a decimal string. */
  permissions: string;
};

/**
 * Read-only: the bot's own member object, carrying both its role list and its
 * permission bitfield — so the screens above need one Discord call, not two.
 *
 * Returns null when the read fails, letting callers say "unknown" rather than
 * invent a position or a permission set.
 */
export async function fetchBotMember(botToken: string, guildId: string): Promise<BotMember | null> {
  const botUserId = await resolveBotUserId(botToken).catch(() => null);
  if (!botUserId) return null;
  return request<BotMember>(`/guilds/${guildId}/members/${botUserId}`, { token: botToken }).catch(() => null);
}

/**
 * The same read, with concurrent callers sharing one request.
 *
 * Deliberately *not* a 45-second cache like the role and channel lists. A member
 * object is what the permission check reads, and a permission can be revoked in
 * Discord at any moment — answering a write path from a 45-second-old bitfield
 * would let the dashboard claim the bot holds a permission it has since lost.
 * Coalescing only the in-flight request costs nothing in correctness: every
 * caller within the same tick is asking the same question at the same instant.
 *
 * Without this, one screen load spent two identical member reads, because the
 * permission check and the hierarchy check race each other before either
 * settles. That duplicate was half of why clicking through the tabs hit
 * Discord's rate limit.
 */
export async function fetchBotMemberShared(botToken: string, guildId: string): Promise<BotMember | null> {
  const running = botMemberInFlight.get(guildId);
  if (running) return running;

  const promise = fetchBotMember(botToken, guildId).finally(() => botMemberInFlight.delete(guildId));
  botMemberInFlight.set(guildId, promise);
  return promise;
}

/**
 * Read-only: text channels the operator can pick as log destinations.
 *
 * Memoised for 45 seconds per guild. The same list is asked for by the logging
 * screen, the command scopes and the anti-nuke quarantine picker, so switching
 * between them used to fire the same request three times.
 */
export async function fetchGuildChannels(botToken: string, guildId: string): Promise<ChannelOption[]> {
  return guildChannelCache.resolve(guildId, async () => {
    const channels = await request<{ id: string; name: string; type: number; position: number }[]>(
      `/guilds/${guildId}/channels`,
      { token: botToken }
    );
    const typeOf = (type: number): ChannelOption["type"] => (type === 2 ? "voice" : type === 4 ? "category" : "text");
    return channels
      .filter(channel => channel.type === 0 || channel.type === 2 || channel.type === 5)
      .sort((a, b) => a.position - b.position)
      .map(channel => ({ id: channel.id, name: channel.name, type: typeOf(channel.type) }));
  });
}

/**
 * Read-only: the bot's own base permissions inside a guild.
 *
 * Null means "could not be read", which is deliberately distinct from `0n`
 * ("read successfully, holds nothing"). Callers must not collapse the two: a
 * failed read reported as an empty bitfield turns into a false "the bot lacks
 * this permission" warning, and — for the customization form — a save that is
 * refused for a reason that was never true.
 */
export async function fetchBotPermissions(botToken: string, guildId: string): Promise<bigint | null> {
  const [member, roles] = await Promise.all([
    fetchBotMemberShared(botToken, guildId),
    fetchGuildRoleList(botToken, guildId).catch(() => null)
  ]);
  if (!member || !roles) return null;
  return computeBasePermissions(guildId, roles, member.roles ?? []);
}

/**
 * Discord's base-permission calculation for a member of a guild.
 *
 * The member object's own `permissions` field cannot be used for this. Discord
 * leaves it at `0` on a bot-token member read — including for a bot holding
 * Administrator — so it reports nothing rather than something, and trusting it
 * is what made the dashboard declare an Administrator bot permissionless.
 *
 * The base set is the union of `@everyone` and every role the member holds,
 * which is why the role list has to be read alongside the member.
 */
export function computeBasePermissions(
  guildId: string,
  roles: { id: string; permissions: string }[],
  memberRoleIds: readonly string[]
): bigint {
  const held = new Set(memberRoleIds);
  let bits = 0n;
  for (const role of roles) {
    // `@everyone` carries the guild's own ID and is never listed in member.roles.
    if (role.id !== guildId && !held.has(role.id)) continue;
    bits |= BigInt(role.permissions ?? "0");
  }
  return bits;
}

export type DiscordRole = {
  id: string;
  name: string;
  position: number;
  managed: boolean;
  /** True for the @everyone role, which cannot carry a tier. */
  isDefault: boolean;
  /** Discord's packed RGB integer. 0 means "no colour" (the default grey). */
  color: number;
};

/**
 * Read-only: assignable roles, used by the tier screen, the command scopes and
 * the anti-nuke quarantine picker.
 *
 * `managed` roles belong to an integration and can never be granted to a human,
 * so they are excluded from the picker rather than offered and then rejected.
 *
 * The colour travels with the role so the picker can render each role the way
 * Discord does, instead of showing a flat list of names.
 *
 * Memoised for 45 seconds per guild, for the same reason as the channel list:
 * three screens read the identical list and each one used to cost a call.
 */
export async function fetchGuildRoles(botToken: string, guildId: string): Promise<DiscordRole[]> {
  return guildRoleCache.resolve(guildId, async () => {
    const roles = await fetchGuildRoleList(botToken, guildId);
    return roles
      .filter(role => !role.managed && role.id !== guildId)
      .sort((a, b) => b.position - a.position)
      .map<DiscordRole>(role => ({
        id: role.id,
        name: role.name,
        position: role.position,
        managed: role.managed,
        isDefault: false,
        color: role.color ?? 0
      }));
  });
}

/**
 * Read-only: the highest role position the bot itself holds.
 * Discord refuses any assignment at or above this position, so the tier screen
 * warns about it instead of letting the operator save something that will fail.
 */
export async function fetchBotHighestRolePosition(botToken: string, guildId: string) {
  const [member, roles] = await Promise.all([
    fetchBotMemberShared(botToken, guildId),
    fetchGuildRoleList(botToken, guildId).catch((): RawGuildRole[] | null => null)
  ]);
  if (!member || !roles) return null;
  const byId = new Map(roles.map(role => [role.id, role.position]));
  const positions = (member.roles ?? []).map(id => byId.get(id) ?? 0);
  return positions.length ? Math.max(...positions) : 0;
}

/**
 * Whether a permission bitfield grants a permission.
 *
 * ADMINISTRATOR is tested first because it supersedes every other permission:
 * Discord gives its holder the entire set, yet the bitfield itself only has bit
 * 3 set. A plain `bits & permission` test therefore answers "no" for a user or
 * bot that can in fact do anything — which is how the dashboard came to tell an
 * Administrator bot that it lacked MANAGE_GUILD and refused its saves.
 */
export function hasPermission(bits: bigint, permission: bigint) {
  if ((bits & USER_PERMISSIONS.ADMINISTRATOR) === USER_PERMISSIONS.ADMINISTRATOR) return true;
  return (bits & permission) === permission;
}

export type GuildHierarchy = {
  /** Position of the bot's own highest role in this guild. */
  botPosition: number;
  /** Every role in the guild, by ID, with its position. */
  rolePositions: Map<string, number>;
};

/**
 * Read-only: the bot's standing plus every role position, in one round trip.
 *
 * The customization screen needs both — the bot's position to warn about the
 * hierarchy, and each configured admin/moderator role's position to compare
 * against it. Fetching the role list once and reusing it keeps that screen to
 * two Discord calls instead of one per configured role.
 *
 * Returns null when either read fails, so the caller can say "unknown" rather
 * than guess a position and warn about a problem that may not exist.
 */
export async function fetchGuildHierarchy(botToken: string, guildId: string): Promise<GuildHierarchy | null> {
  const [member, roles] = await Promise.all([
    fetchBotMemberShared(botToken, guildId),
    fetchGuildRoleList(botToken, guildId).catch((): RawGuildRole[] | null => null)
  ]);
  if (!member || !roles) return null;

  const rolePositions = new Map(roles.map(role => [role.id, role.position] as const));
  // `@everyone` is not listed in a member's role array, so an empty result means
  // the bot holds no role — position 0, which every configured role outranks.
  const positions = (member.roles ?? []).map(id => rolePositions.get(id) ?? 0);
  return {
    botPosition: positions.length ? Math.max(...positions) : 0,
    rolePositions
  };
}

/* ------------------------------------------------------------------ *
 * Metrics reads
 * ------------------------------------------------------------------ */

/**
 * Read-only: the guild's boost level, which gates the role-icon feature.
 *
 * Discord rejects a role icon with a 400 when the guild is below level 2, so the
 * dashboard checks this before offering the field instead of letting the
 * operator fill it in and fail on save. The threshold itself lives in
 * `@al-ai/core` as `ROLE_ICON_MIN_PREMIUM_TIER`, next to the gate that applies
 * it, so the two can never disagree.
 */
export async function fetchGuildPremiumTier(botToken: string, guildId: string) {
  const guild = await request<{ premium_tier?: number }>(`/guilds/${guildId}`, { token: botToken });
  return guild.premium_tier ?? 0;
}

export type WidgetPresence = { online: number } | { online: null; reason: "widget-disabled" | "unavailable" };

/**
 * Read-only: how many members Discord itself reports as online.
 *
 * GOVERNANCE rule 8 forbids the GUILD_PRESENCES intent, so AL AI never tracks a
 * member's own presence. The guild widget is a different thing: Discord
 * publishes one aggregate number that anyone may read, with no intent and no
 * per-member state. When the operator has not enabled the widget Discord answers
 * 403 and this returns null with a reason, so the screen can explain itself
 * rather than show a misleading zero.
 */
export async function fetchWidgetPresence(guildId: string): Promise<WidgetPresence> {
  try {
    const response = await fetch(`https://discord.com/api/v10/guilds/${guildId}/widget.json`, {
      headers: { "User-Agent": "AL-AI-Dashboard" }
    });
    // 403 is Discord's answer when the Server Widget is switched off.
    if (response.status === 403) return { online: null, reason: "widget-disabled" };
    if (!response.ok) return { online: null, reason: "unavailable" };
    const body = (await response.json()) as { presence_count?: number };
    if (typeof body.presence_count !== "number") return { online: null, reason: "unavailable" };
    return { online: body.presence_count };
  } catch {
    return { online: null, reason: "unavailable" };
  }
}

/* ------------------------------------------------------------------ *
 * CDN URLs
 *
 * Discord returns bare hashes, never URLs. These helpers are the only place
 * that knows how to turn a hash into a CDN address, so the UI never has to
 * assemble one (and can never get the size or the fallback wrong).
 * ------------------------------------------------------------------ */

/**
 * Discord marks an animated asset by prefixing its hash with `a_`, and serves
 * the animation only from the `.gif` extension.
 *
 * This matters more than it looks: asking for `.png` on an `a_` hash is a
 * perfectly valid request that returns the **first frame**, so an animated
 * avatar renders as a frozen still with no error anywhere. The operator sees
 * "my animated picture is not moving" and nothing in the logs disagrees.
 */
function assetExtension(hash: string): "gif" | "png" {
  return hash.startsWith("a_") ? "gif" : "png";
}

/**
 * A user's avatar. Accounts without a custom avatar get one of Discord's six
 * default images, chosen by `(id >> 22) % 6`.
 *
 * The default size is 128 because the avatar is drawn at up to 56 CSS pixels
 * and a HiDPI screen needs two device pixels for each of them; 64 arrived
 * visibly soft on any modern display.
 */
export function userAvatarUrl(userId: string, avatarHash: string | null, size = 128): string {
  if (avatarHash) {
    return `https://cdn.discordapp.com/avatars/${userId}/${avatarHash}.${assetExtension(avatarHash)}?size=${size}`;
  }
  let index = 0;
  try {
    index = Number((BigInt(userId) >> 22n) % 6n);
  } catch {
    index = 0;
  }
  // Discord's default avatars are fixed PNGs; they take no size parameter.
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

/** A guild's icon, or null when the guild has none set. Animated icons use `.gif`. */
export function guildIconUrl(guildId: string, iconHash: string | null, size = 128): string | null {
  if (!iconHash) return null;
  return `https://cdn.discordapp.com/icons/${guildId}/${iconHash}.${assetExtension(iconHash)}?size=${size}`;
}

/**
 * A user's profile banner, or null when they have none.
 *
 * Banners follow the same animated-hash rule as avatars, and asking for `.png`
 * on an `a_` hash silently returns the first frame — so this shares
 * `assetExtension` rather than spelling the rule a second time.
 *
 * Discord serves banners from a separate route and the size must be one of its
 * powers of two; 600 is the largest width it will honour for a banner.
 */
export function userBannerUrl(userId: string, bannerHash: string | null, size = 600): string | null {
  if (!bannerHash) return null;
  return `https://cdn.discordapp.com/banners/${userId}/${bannerHash}.${assetExtension(bannerHash)}?size=${size}`;
}
