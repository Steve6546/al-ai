import type {
  AntiNukeConfig,
  AntiNukeSettings,
  AuditEntry,
  ChannelOption,
  CommandConfig,
  CommandFlag,
  CustomizationSettings,
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
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    ...init
  });
  if (!response.ok) {
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
export const commands = (guildId: string) =>
  call<{ modules: string[]; commands: CommandFlag[] }>(`/api/guilds/${guildId}/commands`);

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
export const saveCustomization = (guildId: string, settings: CustomizationSettings) =>
  call<{ settings: CustomizationSettings; savedAt: string }>(`/api/guilds/${guildId}/customization`, {
    method: "PUT",
    body: JSON.stringify(settings)
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
