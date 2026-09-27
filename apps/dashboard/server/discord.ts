/**
 * Discord access for the dashboard.
 *
 * SCOPE BOUNDARY (see docs/GOVERNANCE.md rule 2):
 * - The bot's gateway-driven mutations stay in `apps/bot/src/lib/discord.ts`,
 *   the only module allowed to import discord.js. Handlers receive normalised
 *   plain objects, never Discord classes.
 * - This module is the BFF's only Discord entry point. It performs the user
 *   OAuth exchange, the read-only bot-token lookups the screens authorise
 *   against, and the small set of operator-driven writes that must report their
 *   own outcome back to the form — the bot identity (see `appearance.ts`) and
 *   the log-channel setup below. It never returns a token to the browser.
 */

import {
  BOT_INVITE_PERMISSIONS,
  BOT_INVITE_SCOPES,
  DISCORD_PERMISSION_BITS,
  type ChannelOption,
  type DiscordRoleWire
} from "@al-ai/core";
import { TtlCache } from "./cache.js";

const API = "https://discord.com/api/v10";

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
  init: { token: string; method: "GET" | "PATCH" | "POST" | "DELETE"; body?: unknown }
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
 *
 * The request asks for Administrator (bit 3): AL AI creates roles, edits channels
 * and moderates members, so it needs the full bitfield rather than a hand-picked
 * subset. An earlier invite requested MODERATE_MEMBERS (1 << 40) instead, which
 * silently left the bot unable to perform most of its own commands. The number
 * lives in the shared contract, so the invite and the authorisation checks cannot
 * disagree about what Administrator means.
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
    permissions: BOT_INVITE_PERMISSIONS
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
 * Roles and channels change on the scale of minutes, so a minute removes nearly
 * every repeat call without the operator ever seeing a stale screen: the one
 * action that changes either list is performed in Discord, not here, and the
 * screen that shows it is reloaded by hand. `invalidateGuildReadCache` runs
 * after every dashboard write, so the dashboard's own edits are never stale.
 */
const GUILD_READ_CACHE_MS = 60_000;

const botGuildCache = new TtlCache<string, Set<string>>(BOT_GUILD_CACHE_MS);
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
 * Display names for the members named in per-command scopes, keyed by guild+user.
 *
 * Memoised for the same reason every other guild read is: the operator opens
 * this screen repeatedly, and without a cache each visit would spend one Discord
 * call per named member for a name that changes at most a few times a year. It
 * also collapses the burst — a screen with twenty scoped members would otherwise
 * fire twenty requests in the same tick.
 *
 * `null` is cached as a value rather than treated as a miss: a member who has
 * left stays gone, and re-asking on every render would be the one case where
 * this cache made things worse instead of better.
 */
const guildMemberCache = new TtlCache<string, { id: string; name: string; avatarUrl: string | null } | null>(GUILD_READ_CACHE_MS);

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
 * The role list is never edited from here, but the channel list now is — the
 * log setup and teardown routes create and delete channels, and the next reader
 * must see the result rather than the cached pre-change list. Tests call it too,
 * so one case does not inherit another's channels.
 */
export function invalidateGuildReadCache(guildId?: string) {
  if (guildId === undefined) {
    guildRawChannelCache.clear();
    guildRoleCache.clear();
    guildRoleListCache.clear();
    return;
  }
  guildRawChannelCache.clear(guildId);
  guildRoleCache.clear(guildId);
  guildRoleListCache.clear(guildId);
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

/**
 * Read-only: a member's display name and avatar, for the per-command user scopes.
 *
 * The screen stores user IDs — a name is not an identifier, and Discord lets two
 * members share one — but showing the operator a wall of snowflakes would make
 * the list unreadable and the feature unusable. So the ID is what is stored and
 * this is what is displayed.
 *
 * Returns `null` rather than throwing for a member who has left, or an ID that
 * was never real: both are ordinary states for a stored scope, and neither is a
 * reason to fail the whole screen. The caller renders the bare ID in that case.
 *
 * Deliberately a per-ID lookup rather than a member list. Listing a guild's
 * members needs the privileged `GUILD_MEMBERS` intent, returns thousands of rows
 * to render at most fifty, and would turn opening this screen into the heaviest
 * request the dashboard makes.
 */
export async function fetchGuildMember(token: string, guildId: string, userId: string): Promise<{ id: string; name: string; avatarUrl: string | null } | null> {
  const member = await request<{
    user?: { id?: string; username?: string; global_name?: string | null; avatar?: string | null };
    nick?: string | null;
  }>(`/guilds/${guildId}/members/${userId}`, { token }).catch(() => null);
  if (!member?.user?.id) return null;
  // Nickname, then global name, then username — the same order Discord's own
  // client shows, so the operator recognises the person they picked.
  const name = member.nick || member.user.global_name || member.user.username || member.user.id;
  const avatarUrl = member.user.avatar ? userAvatarUrl(member.user.id, member.user.avatar, 64) : null;
  return { id: member.user.id, name, avatarUrl };
}

/** `fetchGuildMember` behind the shared guild-read cache. */
export function fetchGuildMemberCached(botToken: string, guildId: string, userId: string) {
  return guildMemberCache.resolve(`${guildId}:${userId}`, () => fetchGuildMember(botToken, guildId, userId));
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
  guildRawChannelCache.clear();
  guildRoleCache.clear();
  guildRoleListCache.clear();
  userGuildCache.clear();
  guildMemberCache.clear();
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
async function fetchBotMember(botToken: string, guildId: string): Promise<BotMember | null> {
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
async function fetchBotMemberShared(botToken: string, guildId: string): Promise<BotMember | null> {
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
 *
 * Categories are deliberately absent: a destination picker offers places to read,
 * and a category is not one. The setup and teardown routes read the raw list
 * underneath (`fetchRawChannels`) when they need the category itself.
 */
export async function fetchGuildChannels(botToken: string, guildId: string): Promise<ChannelOption[]> {
  const channels = await fetchRawChannels(botToken, guildId);
  const typeOf = (type: number): ChannelOption["type"] => (type === 2 ? "voice" : type === 4 ? "category" : "text");
  return channels
    .filter(channel => channel.type === 0 || channel.type === 2 || channel.type === 5)
    .sort((a, b) => a.position - b.position)
    .map(channel => ({ id: channel.id, name: channel.name, type: typeOf(channel.type) }));
}

/** The raw `/guilds/{id}/channels` payload, memoised and shared by every reader. */
type RawChannel = { id: string; name: string; type: number; position: number; parent_id?: string | null };
const guildRawChannelCache = new TtlCache<string, RawChannel[]>(GUILD_READ_CACHE_MS);

/**
 * Discord caps a guild at 500 channels, categories counted in. It is a fact
 * about Discord rather than about this app, so it lives next to the channel
 * helpers — the setup route reads it before promising a build it cannot finish.
 */
export const DISCORD_GUILD_CHANNEL_CAP = 500;

export async function fetchRawChannels(botToken: string, guildId: string): Promise<RawChannel[]> {
  return guildRawChannelCache.resolve(guildId, () => request<RawChannel[]>(`/guilds/${guildId}/channels`, { token: botToken }));
}

/**
 * Read-only: the id of one category by name, or null when it is not there.
 *
 * Teardown needs this because the log category's id is stored nowhere — only the
 * channels are bound in `guild_logging`. A missing category means "nothing to
 * delete", which is a success and not an error.
 */
export async function findGuildCategory(botToken: string, guildId: string, name: string): Promise<string | null> {
  const channels = await fetchRawChannels(botToken, guildId);
  return channels.find(channel => channel.type === 4 && channel.name === name)?.id ?? null;
}

/**
 * Read-only: the ids of the channels that currently exist.
 *
 * Teardown deletes a bound channel only if it is still there: a channel the
 * operator removed by hand in Discord is already gone, and reporting it as a
 * failure would describe a problem that does not exist.
 */
export async function fetchExistingChannelIds(botToken: string, guildId: string): Promise<Set<string>> {
  const channels = await fetchRawChannels(botToken, guildId);
  return new Set(channels.map(channel => channel.id));
}

/**
 * Read-only: whether a category still holds channels.
 *
 * Teardown will not delete a category that has children. Discord does not refuse
 * the delete — it orphans them, leaving them visible but parentless — so the
 * operator would lose the grouping of channels they filed under it themselves
 * while asking only for the log setup to go.
 */
export async function categoryHasChildren(botToken: string, guildId: string, categoryId: string): Promise<boolean> {
  const channels = await fetchRawChannels(botToken, guildId);
  return channels.some(channel => channel.parent_id === categoryId);
}

/* ------------------------------------------------------------------ *
 * Log channel setup — the one guild-structure write
 *
 * Creating a log category and its channels changes the guild itself, which is
 * a different thing from the reads above and from the bot-identity writes in
 * `appearance.ts`. It lives here rather than in the bot for the same reason the
 * appearance does: the operator pressed the button and needs to be told *which*
 * of the thirteen channels Discord refused, not that "setup" failed.
 *
 * Two constraints shape the implementation:
 *
 *   - **Sequential.** Discord rate-limits channel creation per guild, so a
 *     parallel batch of thirteen turns into twelve 429s. One at a time, a 429
 *     waits `retry_after` and tries again.
 *   - **Reported, never swallowed.** A channel that did not appear must not
 *     become a routing entry pointing at nothing, and must not be silently
 *     dropped from the response either.
 * ------------------------------------------------------------------ */

export type CreatedChannel = { id: string; name: string };

/** Discord's channel-type numbers. The gateway enum is not importable here. */
const CHANNEL_TYPE_TEXT = 0;
const CHANNEL_TYPE_CATEGORY = 4;

/**
 * Creates one channel — a text channel under a category, or a category itself.
 *
 * The name is validated by Discord, not by us: it lowercases, strips spaces and
 * rejects an empty result, and that is the authority the operator's request
 * should meet. Our own mapping ships names that are already valid.
 */
export async function createGuildChannel(
  botToken: string,
  guildId: string,
  input: { name: string; type: "text" | "category"; parentId?: string }
): Promise<CreatedChannel> {
  const channel = await requestJson<{ id: string; name: string }>(`/guilds/${guildId}/channels`, {
    token: botToken,
    method: "POST",
    body: {
      name: input.name,
      type: input.type === "category" ? CHANNEL_TYPE_CATEGORY : CHANNEL_TYPE_TEXT,
      parent_id: input.parentId
    }
  });
  return { id: channel.id, name: channel.name };
}

/** Deletes one channel or category by its ID. Discord answers 204. */
export async function deleteGuildChannel(botToken: string, channelId: string): Promise<void> {
  await requestJson<void>(`/channels/${channelId}`, { token: botToken, method: "DELETE" });
}

/** A 429's `retry_after` in milliseconds, floored and ceilinged. */
function rateLimitDelayMs(error: DiscordApiError): number {
  // `retryAfterSeconds` may be fractional; a small floor stops us from re-hitting
  // a bucket at exactly the instant it reopens, and the ceiling stops one wedged
  // route from holding the request hostage.
  const ms = Math.ceil((error.retryAfterSeconds ?? 1) * 1000) + 250;
  return Math.min(Math.max(ms, 250), 10_000);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * One Discord write, retried once after a rate limit and never more.
 *
 * A 429 is the expected outcome of a thirteen-channel sequence, and the honest
 * response is to wait and try the *same* call again. A second 429 after the wait
 * is a saturated bucket — it is raised so the caller can report the channel as
 * not created and move on, rather than looping until the request times out.
 */
export async function writeWithRetry<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (!isRateLimited(error)) throw error;
    await sleep(rateLimitDelayMs(error as DiscordApiError));
    return await call();
  }
}

/**
 * The Arabic reason a Discord refusal becomes for the operator.
 *
 * 403 with code 50013 is a missing permission — the bot needs MANAGE_CHANNELS,
 * and that is fixable from Discord's own role screen. A 400 that names the
 * guild's channel cap is reported as exactly that, because "setup failed" over
 * seventy channels in a row is not an answer an operator can act on. Anything
 * else quotes Discord's own wording — `requestJson` embeds the response body in
 * the error message, and pulling the `message` field back out of it beats both
 * discarding it and guessing a reason.
 */
export function describeChannelFailure(error: unknown): { status: number; message: string } {
  if (!(error instanceof DiscordApiError)) return { status: 503, message: "تعذّر الوصول إلى Discord. أعد المحاولة." };
  if (error.status === 403 || /"code"\s*:\s*50013/.test(error.message)) {
    return {
      status: 403,
      message: "البوت لا يملك صلاحية «إدارة القنوات» (Manage Channels) في هذا السيرفر، أو رتبته أقل من القنوات المطلوبة."
    };
  }
  if (error.status === 429) {
    return { status: 429, message: "وصلنا إلى حد Discord لإنشاء القنوات. انتظر دقيقة ثم أعد المحاولة." };
  }
  if (/maximum number of channels/i.test(error.message)) {
    return {
      status: 502,
      message: "وصل السيرفر إلى الحد الأقصى لعدد القنوات في Discord (500). احذف قنوات غير مستعملة ثم أعد المحاولة."
    };
  }
  const quoted = /failed with \d+:\s*(.+)$/s.exec(error.message)?.[1]?.trim();
  let reason = quoted;
  if (quoted) {
    try {
      reason = (JSON.parse(quoted) as { message?: string }).message ?? quoted;
    } catch {
      // The body was truncated at 200 characters or was never JSON; the raw text
      // is still closer to the truth than no reason at all.
    }
  }
  return { status: 502, message: `رفض Discord إنشاء القناة (${error.status})${reason ? `: ${reason}` : "."}` };
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
function computeBasePermissions(
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

export type DiscordRole = DiscordRoleWire;

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
  if ((bits & DISCORD_PERMISSION_BITS.ADMINISTRATOR) === DISCORD_PERMISSION_BITS.ADMINISTRATOR) return true;
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
    // GOVERNANCE rule 26 — the one numeric conversion of a snowflake that is
    // allowed, because the result is bounded: the shift and the modulo happen in
    // BigInt, so precision is already irrelevant by the time `Number` sees it.
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
