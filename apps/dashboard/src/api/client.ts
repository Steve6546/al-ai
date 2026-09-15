import type {
  AntiNukeConfig,
  AntiNukeSettings,
  AppearanceSaveResult,
  AuditEntry,
  BotIdentitySettings,
  BotIdentitySnapshot,
  ChannelOption,
  CommandCategory,
  CommandConfig,
  CommandFlag,
  CustomizationSettings,
  DiscordRole,
  Guild,
  GuildMetrics,
  HealthSnapshot,
  LoggingSettings,
  PermissionStatus,
  RoleHierarchyVerdict,
  RoleIconGate,
  SecurityEvent,
  SessionInfo,
  TierConfig,
  TierRoles
} from "@/types";

/**
 * The dashboard's network layer.
 *
 * Every request goes through `call()` so credentials, headers and error shapes
 * are identical everywhere. Views never call `fetch` directly, and no endpoint
 * path is written outside this file.
 */

/** An error the BFF reported in its `{ error, message }` envelope. */
export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  return request<T>(path, init, true);
}

/** Longest we will silently wait for a rate limit before giving the error back. */
const MAX_RETRY_WAIT_MS = 5_000;

/**
 * One request, with a single retry when Discord is rate limiting us.
 *
 * The BFF forwards Discord's own `retry-after`, and a 429 here is momentary by
 * definition — so waiting it out once turns "press refresh again in a second"
 * into a load that simply succeeds. The wait is capped so a large
 * `retry-after` can never freeze the screen, and the retry happens once only:
 * a second 429 is real information and belongs in front of the operator.
 */
async function request<T>(path: string, init: RequestInit | undefined, mayRetry: boolean): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    ...init
  });

  if (!response.ok) {
    if (response.status === 429 && mayRetry) {
      const hint = Number(response.headers.get("retry-after"));
      const waitMs = Number.isFinite(hint) && hint > 0 ? Math.min(hint * 1000, MAX_RETRY_WAIT_MS) : 1_000;
      await new Promise(resolve => setTimeout(resolve, waitMs));
      return request<T>(path, init, false);
    }
    const body = (await response.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new ApiError(body.error ?? "REQUEST_FAILED", body.message ?? "تعذّر إكمال الطلب.", response.status);
  }
  return (await response.json()) as T;
}

/* ------------------------------------------------------------------ *
 * Session and health
 * ------------------------------------------------------------------ */
export const session = () => call<SessionInfo>("/api/session");
export const logout = () => call<{ ok: boolean }>("/auth/logout", { method: "POST" });
export const health = () => call<HealthSnapshot>("/api/health");
export const guilds = () => call<{ guilds: Guild[] }>("/api/guilds");

/* ------------------------------------------------------------------ *
 * Per-guild reads
 * ------------------------------------------------------------------ */
export const channels = (guildId: string) => call<{ channels: ChannelOption[] }>(`/api/guilds/${guildId}/channels`);
export const metrics = (guildId: string) => call<GuildMetrics>(`/api/guilds/${guildId}/metrics`);

/* ------------------------------------------------------------------ *
 * Settings: tiers
 * ------------------------------------------------------------------ */
export const tiers = (guildId: string) => call<TierConfig>(`/api/guilds/${guildId}/tiers`);
export const saveTiers = (guildId: string, values: TierRoles) =>
  call<{ configured: TierRoles }>(`/api/guilds/${guildId}/tiers`, { method: "PUT", body: JSON.stringify(values) });

/* ------------------------------------------------------------------ *
 * Settings: commands
 * ------------------------------------------------------------------ */

/** A member named in a per-command scope, resolved to something readable. */
export type ScopedMember = { id: string; name: string; avatarUrl: string | null };

export const commands = (guildId: string) =>
  call<{
    /** The sections the screen groups commands into, in render order. */
    categories: { id: CommandCategory; label: string; description: string }[];
    commands: CommandFlag[];
    /** Scopes are chosen from these. Read once, alongside the commands. */
    roles: DiscordRole[];
    channels: ChannelOption[];
    /** Arabic names for the Discord permission each command asks for. */
    permissionLabels: Record<string, string>;
  }>(`/api/guilds/${guildId}/commands`);

/**
 * Resolves the members a scope names, so the screen shows a name rather than a
 * snowflake. Separate from `commands` on purpose: the scopes live in our own
 * database and must render even when Discord does not answer.
 */
export const resolveMembers = (guildId: string, ids: string[]) =>
  ids.length === 0
    ? Promise.resolve({ members: [] as ScopedMember[] })
    : call<{ members: ScopedMember[] }>(`/api/guilds/${guildId}/members?ids=${ids.join(",")}`);

/**
 * One entry per changed command. Unchanged commands are not sent at all, and
 * the server normalises each one against its registry definition — a control
 * the command does not support is dropped rather than stored and ignored.
 */
export type CommandChange = Partial<CommandConfig> & { name: string };

export const saveCommands = (guildId: string, changes: CommandChange[]) =>
  call<{ saved: number }>(`/api/guilds/${guildId}/commands`, { method: "PUT", body: JSON.stringify({ changes }) });

/* ------------------------------------------------------------------ *
 * Settings: customization
 * ------------------------------------------------------------------ */
export const customization = (guildId: string) =>
  call<{
    settings: CustomizationSettings;
    permissions: PermissionStatus[];
    /** Null when the guild's roles could not be read, so no verdict is claimed. */
    hierarchy: RoleHierarchyVerdict | null;
    roleIcon: RoleIconGate;
  }>(`/api/guilds/${guildId}/customization`);
/**
 * Partial on purpose: a field the operator cannot edit must be omitted rather
 * than echoed back. The server reads an absent field as "leave it alone" and a
 * `null` as "clear it", so omitting the gated role icon keeps a stored one while
 * still letting the rest of the form save.
 */
export const saveCustomization = (guildId: string, settings: Partial<CustomizationSettings>) =>
  call<{ settings: CustomizationSettings; savedAt: string } & AppearanceSaveResult>(
    `/api/guilds/${guildId}/customization`,
    { method: "PUT", body: JSON.stringify(settings) }
  );

/* ------------------------------------------------------------------ *
 * Settings: global bot identity
 *
 * Avatar, banner, bio, status and activity. Discord gives an application one of
 * each, so these follow the bot into every server — which is why they live on
 * their own route rather than on the per-guild customization one.
 *
 * `guildId` travels in the body even though the route is not guild-scoped:
 * access is still checked per guild, and a guild ID is not a secret (it is in
 * every invite link), so the guard has to be told which guild to check.
 * ------------------------------------------------------------------ */
export const botIdentity = (guildId: string) =>
  call<{ settings: BotIdentitySettings; snapshot: BotIdentitySnapshot }>(
    `/api/bot/identity?guildId=${encodeURIComponent(guildId)}`
  );

export const saveBotIdentity = (guildId: string, settings: BotIdentitySettings) =>
  call<{ settings: BotIdentitySettings; savedAt: string } & AppearanceSaveResult>(`/api/bot/identity`, {
    method: "PUT",
    body: JSON.stringify({ guildId, ...settings })
  });

/* ------------------------------------------------------------------ *
 * Settings: logging
 * ------------------------------------------------------------------ */
export const logging = (guildId: string) => call<{ settings: LoggingSettings }>(`/api/guilds/${guildId}/logging`);
export const saveLogging = (guildId: string, settings: LoggingSettings) =>
  call<{ settings: LoggingSettings; savedAt: string }>(`/api/guilds/${guildId}/logging`, {
    method: "PUT",
    body: JSON.stringify(settings)
  });

/* ------------------------------------------------------------------ *
 * Read-only views
 * ------------------------------------------------------------------ */
export const audit = (guildId: string) =>
  call<{ counts: { total: number; critical: number }; entries: AuditEntry[] }>(`/api/guilds/${guildId}/audit`);
export const security = (guildId: string) =>
  call<{ events: SecurityEvent[] }>(`/api/guilds/${guildId}/security`);

/* ------------------------------------------------------------------ *
 * Settings: anti-nuke
 * ------------------------------------------------------------------ */
export const securityConfig = (guildId: string) =>
  call<AntiNukeSettings>(`/api/guilds/${guildId}/security/config`);
export const saveSecurityConfig = (guildId: string, config: AntiNukeConfig) =>
  call<{ config: AntiNukeConfig; savedAt: string }>(`/api/guilds/${guildId}/security/config`, {
    method: "PUT",
    body: JSON.stringify(config)
  });
