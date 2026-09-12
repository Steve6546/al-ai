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

const API = "https://discord.com/api/v10";

export const USER_PERMISSIONS = {
  MANAGE_GUILD: 0x20n,
  MANAGE_NICKNAMES: 0x8000000n,
  CHANGE_NICKNAME: 0x4000000n
} as const;

export type DiscordIdentity = { id: string; username: string; globalName: string | null; avatar: string | null };
export type DiscordUserGuild = { id: string; name: string; icon: string | null; owner: boolean; permissions: bigint };

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
    throw new Error(`Discord ${path} failed with ${response.status}: ${body.slice(0, 200)}`);
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
 */
export function buildBotInviteUrl(clientId: string, guildId?: string) {
  const params = new URLSearchParams({
    client_id: clientId,
    scope: "bot applications.commands",
    permissions: BOT_PERMISSIONS
  });
  if (guildId) {
    params.set("guild_id", guildId);
    params.set("disable_guild_select", "true");
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

/** Read-only: which guilds the AL AI bot is actually a member of. */
export async function fetchBotGuildIds(botToken: string) {
  const guilds = await request<{ id: string }[]>("/users/@me/guilds", { token: botToken });
  return new Set(guilds.map(guild => guild.id));
}

/** Read-only: the AL AI role IDs a user holds, used to resolve their tier. */
export async function fetchMemberRoleIds(botToken: string, guildId: string, userId: string) {
  const member = await request<{ roles: string[] }>(`/guilds/${guildId}/members/${userId}`, { token: botToken });
  return new Set(member.roles ?? []);
}

/** Read-only: text channels the operator can pick as log destinations. */
export async function fetchGuildChannels(botToken: string, guildId: string) {
  const channels = await request<{ id: string; name: string; type: number; position: number }[]>(`/guilds/${guildId}/channels`, { token: botToken });
  const typeOf = (type: number): "text" | "voice" | "category" => (type === 2 ? "voice" : type === 4 ? "category" : "text");
  return channels
    .filter(channel => channel.type === 0 || channel.type === 2 || channel.type === 5)
    .sort((a, b) => a.position - b.position)
    .map(channel => ({ id: channel.id, name: channel.name, type: typeOf(channel.type) }));
}

/** Read-only: the bot's own permission bitfield inside a guild. */
export async function fetchBotPermissions(botToken: string, guildId: string) {
  const member = await request<{ permissions: string }>(`/users/@me/guilds/${guildId}/member`, { token: botToken });
  return BigInt(member.permissions ?? "0");
}

export type DiscordRole = {
  id: string;
  name: string;
  position: number;
  managed: boolean;
  /** True for the @everyone role, which cannot carry a tier. */
  isDefault: boolean;
};

/**
 * Read-only: assignable roles, used by the tier configuration screen.
 * `managed` roles belong to an integration and can never be granted to a human,
 * so they are excluded from the picker rather than offered and then rejected.
 */
export async function fetchGuildRoles(botToken: string, guildId: string) {
  const roles = await request<{ id: string; name: string; position: number; managed: boolean }[]>(`/guilds/${guildId}/roles`, {
    token: botToken
  });
  return roles
    .filter(role => !role.managed && role.id !== guildId)
    .sort((a, b) => b.position - a.position)
    .map<DiscordRole>(role => ({ id: role.id, name: role.name, position: role.position, managed: role.managed, isDefault: false }));
}

/**
 * Read-only: the highest role position the bot itself holds.
 * Discord refuses any assignment at or above this position, so the tier screen
 * warns about it instead of letting the operator save something that will fail.
 */
export async function fetchBotHighestRolePosition(botToken: string, guildId: string) {
  const [member, roles] = await Promise.all([
    request<{ roles: string[] }>(`/guilds/${guildId}/members/@me`, { token: botToken }).catch(() => null),
    request<{ id: string; position: number }[]>(`/guilds/${guildId}/roles`, { token: botToken })
  ]);
  if (!member) return null;
  const byId = new Map(roles.map(role => [role.id, role.position]));
  const positions = member.roles.map(id => byId.get(id) ?? 0);
  return positions.length ? Math.max(...positions) : 0;
}

export function hasPermission(bits: bigint, permission: bigint) {
  return (bits & permission) === permission;
}

/* ------------------------------------------------------------------ *
 * CDN URLs
 *
 * Discord returns bare hashes, never URLs. These helpers are the only place
 * that knows how to turn a hash into a CDN address, so the UI never has to
 * assemble one (and can never get the size or the fallback wrong).
 * ------------------------------------------------------------------ */

/**
 * A user's avatar. Accounts without a custom avatar get one of Discord's six
 * default images, chosen by `(id >> 22) % 6`.
 */
export function userAvatarUrl(userId: string, avatarHash: string | null, size = 64): string {
  if (avatarHash) return `https://cdn.discordapp.com/avatars/${userId}/${avatarHash}.png?size=${size}`;
  let index = 0;
  try {
    index = Number((BigInt(userId) >> 22n) % 6n);
  } catch {
    index = 0;
  }
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

/** A guild's icon, or null when the guild has none set. */
export function guildIconUrl(guildId: string, iconHash: string | null, size = 128): string | null {
  return iconHash ? `https://cdn.discordapp.com/icons/${guildId}/${iconHash}.png?size=${size}` : null;
}
