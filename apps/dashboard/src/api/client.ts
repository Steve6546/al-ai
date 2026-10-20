import type {
  AntiNukeConfig,
  AntiNukeSettings,
  AppearanceSaveResult,
  AuditEntry,
  BotPresenceSettings,
  GuildProfileSnapshot,
  ChannelOption,
  CommandCategory,
  CommandConfig,
  CommandFlag,
  CustomizationSettings,
  DiscordRole,
  Guild,
  GuildMetrics,
  HealthSnapshot,
  InviteSettings,
  WelcomeMessageSettings,
  LeaderboardPage,
  LevelConfigProblem,
  LevelRewardInput,
  LevelRoleReward,
  LevelSettings,
  LevelsStatus,
  LevelSyncJob,
  LoggingSettings,
  NetworkSnapshot,
  WelcomeSettings,
  PermissionStatus,
  RemoteAccessMode,
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
  // Content-Type only rides on requests that actually carry a body — Fastify
  // refuses an empty body that claims to be JSON, which is how a bare POST
  // (the sync button) used to die with 'Body cannot be empty'.
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string> | undefined) };
  if (init?.body !== undefined && init.body !== null) {
    headers["Content-Type"] = headers["Content-Type"] ?? "application/json";
  }
  const response = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers
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

/**
 * The list fields the board iterates over.
 *
 * A dashboard server answers 200 in whatever shape it was built with, so a
 * server that predates one of these fields omits it silently. The board then
 * iterates `undefined`, React reports "x is not iterable", and the screen goes
 * blank with a message that names neither the field nor the cause.
 *
 * That is not an exotic situation here: the dev server runs under `tsx`, which
 * has no hot reload, so serving an old server next to a newly built bundle is
 * an ordinary mistake. It therefore earns a message that says what is wrong and
 * what to do, instead of a blank screen.
 */
const commandListFields = [
  "allowedRoleIds",
  "deniedRoleIds",
  "allowedUserIds",
  "deniedUserIds",
  "allowedChannelIds",
  "deniedChannelIds",
  "presetReasons",
  // The alias list is iterated to render the shortcut chips, so a server that
  // predates it would hand the screen `undefined` and take the tree down —
  // the same failure the rest of this list exists to convert into a readable
  // message.
  "aliases"
] as const;

function assertCommandShape(commands: CommandFlag[]) {
  for (const command of commands) {
    const fields = command as unknown as Record<string, unknown>;
    for (const field of commandListFields) {
      if (!Array.isArray(fields[field])) {
        throw new ApiError(
          "STALE_SERVER",
          `الخادم لم يُرسل الحقل «${field}» للأمر «${command.name}». الأرجح أن اللوحة تعمل بكود أقدم من الحزمة المعروضة — أعد تشغيل خادم اللوحة.`,
          200
        );
      }
    }
  }
}

export const commands = async (guildId: string) => {
  const payload = await call<{
    /** The sections the screen groups commands into, in render order. */
    categories: { id: CommandCategory; label: string; description: string }[];
    commands: CommandFlag[];
    /** Scopes are chosen from these. Read once, alongside the commands. */
    roles: DiscordRole[];
    channels: ChannelOption[];
    /** Arabic names for the Discord permission each command asks for. */
    permissionLabels: Record<string, string>;
  }>(`/api/guilds/${guildId}/commands`);

  assertCommandShape(payload.commands);
  return payload;
};

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
export const customization = async (guildId: string) => {
  const payload = await call<{
    settings: CustomizationSettings;
    permissions: PermissionStatus[];
    /** Null when the guild's roles could not be read, so no verdict is claimed. */
    hierarchy: RoleHierarchyVerdict | null;
    roleIcon: RoleIconGate;
    /**
     * What Discord currently serves for the bot *in this guild*, or null when
     * the read failed.
     *
     * The preview needs it for the same reason it needs `settings`: the stored
     * row is what the operator last chose, and this is what members actually
     * see right now — including a nickname someone set outside the dashboard.
     * It is guild-scoped, so every viewer of this screen gets it; there is no
     * owner-gated half left to read.
     */
    profile: GuildProfileSnapshot | null;
  }>(`/api/guilds/${guildId}/customization`);

  /*
   * `settings` is what the form edits, so a dashboard server that predates the
   * current shape is worth naming rather than rendering around. A server built
   * before the per-guild bio and banner existed answers 200 without them, the
   * form binds `undefined`, and the screen reads as a form with two fields
   * missing rather than as a version mismatch. That is the ordinary
   * tsx-without-hot-reload situation the command board already guards.
   *
   * `profile` is deliberately not required: it is a live Discord read, and
   * "Discord did not answer" is a legitimate null rather than a stale server.
   */
  const settings = payload.settings as Partial<CustomizationSettings> | undefined;
  for (const field of ["bannerDataUrl", "bio"] as const) {
    if (!settings || !(field in settings)) {
      throw new ApiError(
        "STALE_SERVER",
        `الخادم لم يُرسل الحقل «${field}» مع إعدادات السيرفر، فالنموذج لن يعرضه. الأرجح أن اللوحة تعمل بكود أقدم من الحزمة المعروضة — أعد تشغيل خادم اللوحة.`,
        200
      );
    }
  }

  return payload;
};
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
 * Settings: the bot's presence
 *
 * Status and activity — and nothing else. Discord has no REST route for either:
 * a status lives on the gateway connection, so it is identical in every server
 * the bot is in, and the *bot* is what applies it. This route stores the choice
 * and the bot's presence sync picks it up within seconds.
 *
 * It has its own route rather than a corner of the identity screen because that
 * screen is now entirely server-scoped: a control that reaches every server
 * cannot sit on a form whose whole promise is «هذا ما يظهر به البوت هنا».
 *
 * `guildId` travels in the body even though the route is not guild-scoped:
 * access is still checked per guild, and a guild ID is not a secret (it is in
 * every invite link), so the guard has to be told which guild to check.
 * ------------------------------------------------------------------ */
export const botPresence = (guildId: string) =>
  call<{ settings: BotPresenceSettings }>(`/api/bot/presence?guildId=${encodeURIComponent(guildId)}`);

export const saveBotPresence = (guildId: string, settings: BotPresenceSettings) =>
  call<{ settings: BotPresenceSettings; savedAt: string } & AppearanceSaveResult>(`/api/bot/presence`, {
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

/** The shape both setup modes and the teardown answer with. */
export type ChannelSetupResult = {
  settings: LoggingSettings;
  savedAt: string;
  created?: { name: string; channelId: string }[];
  deleted?: string[];
  failed: { name?: string; channelId?: string; message: string }[];
};

/**
 * Creates the log category and its channels.
 *
 * This is a slow call by design: up to 107 channels, created one at a time so
 * Discord's rate limit is honoured. The screen waits rather than polling,
 * because there is no second endpoint to poll — the result is the response.
 */
export const setupLoggingChannels = (guildId: string, mode: "normal" | "detailed") =>
  call<ChannelSetupResult>(`/api/guilds/${guildId}/logging/setup`, {
    method: "POST",
    body: JSON.stringify({ mode })
  });

/**
 * Deletes the bound log channels and the category, and disables logging.
 */
export const deleteLoggingChannels = (guildId: string) =>
  call<ChannelSetupResult>(`/api/guilds/${guildId}/logging/channels`, { method: "DELETE" });

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

/* ------------------------------------------------------------------ *
 * Settings: welcome & auto-role
 * ------------------------------------------------------------------ */
export const welcome = (guildId: string) =>
  call<{ settings: WelcomeSettings; roles: DiscordRole[] }>(`/api/guilds/${guildId}/welcome`);
export const saveWelcome = (guildId: string, settings: WelcomeSettings) =>
  call<{ settings: WelcomeSettings; savedAt: string }>(`/api/guilds/${guildId}/welcome`, {
    method: "PUT",
    body: JSON.stringify(settings)
  });

/* ------------------------------------------------------------------ *
 * Levels system
 * ------------------------------------------------------------------ */
export const levelsSettings = (guildId: string) =>
  call<{ settings: LevelSettings; roles: DiscordRole[]; channels: ChannelOption[]; problems: LevelConfigProblem[] }>(
    `/api/guilds/${guildId}/levels/settings`
  );
export const saveLevelsSettings = (guildId: string, settings: LevelSettings) =>
  call<{ settings: LevelSettings; savedAt: string }>(`/api/guilds/${guildId}/levels/settings`, {
    method: "PUT",
    body: JSON.stringify(settings)
  });
export const levelsRewards = (guildId: string) =>
  call<{ rewards: LevelRoleReward[] }>(`/api/guilds/${guildId}/levels/rewards`);

/* ------------------------------------------------------------------ *
 * Invites (referrals) module
 * ------------------------------------------------------------------ */
export const invitesSettings = (guildId: string) =>
  call<{ settings: InviteSettings; roles: DiscordRole[]; problems: { code: string; message: string }[] }>(
    `/api/guilds/${guildId}/invites/settings`
  );
export const saveInvitesSettings = (guildId: string, settings: InviteSettings) =>
  call<{ settings: InviteSettings; savedAt: string }>(`/api/guilds/${guildId}/invites/settings`, {
    method: "PUT",
    body: JSON.stringify(settings)
  });
/* ------------------------------------------------------------------ *
 * Welcome messages (رسائل الترحيب)
 * ------------------------------------------------------------------ */
export const welcomeMessages = (guildId: string) =>
  call<{ settings: WelcomeMessageSettings; channels: ChannelOption[] }>(`/api/guilds/${guildId}/welcome-messages`);
export const saveWelcomeMessages = (guildId: string, settings: WelcomeMessageSettings) =>
  call<{ settings: WelcomeMessageSettings; savedAt: string }>(`/api/guilds/${guildId}/welcome-messages`, {
    method: "PUT",
    body: JSON.stringify(settings)
  });
export const createLevelReward = (guildId: string, reward: LevelRewardInput) =>
  call<{ reward: LevelRoleReward; savedAt: string }>(`/api/guilds/${guildId}/levels/rewards`, {
    method: "POST",
    body: JSON.stringify(reward)
  });
export const updateLevelReward = (guildId: string, rewardId: string, reward: LevelRewardInput) =>
  call<{ savedAt: string }>(`/api/guilds/${guildId}/levels/rewards/${rewardId}`, {
    method: "PATCH",
    body: JSON.stringify(reward)
  });
export const deleteLevelReward = (guildId: string, rewardId: string) =>
  call<{ savedAt: string }>(`/api/guilds/${guildId}/levels/rewards/${rewardId}`, { method: "DELETE" });
export const startLevelsSync = (guildId: string) =>
  call<{ job: LevelSyncJob }>(`/api/guilds/${guildId}/levels/sync`, { method: "POST" });
export const levelsMe = (guildId: string) =>
  call<{ levels: { textXp: number; voiceXp: number } | null }>(`/api/guilds/${guildId}/levels/me`);
export const levelsStatus = (guildId: string) => call<LevelsStatus>(`/api/guilds/${guildId}/levels/status`);
export const setMemberXp = (
  guildId: string,
  userId: string,
  values: { textXp: number | null; voiceXp: number | null }
) =>
  call<{ savedAt: string }>(`/api/guilds/${guildId}/levels/members/${userId}`, {
    method: "PATCH",
    body: JSON.stringify(values)
  });
export const resetMemberXp = (guildId: string, userId: string) =>
  call<{ savedAt: string }>(`/api/guilds/${guildId}/levels/members/${userId}/reset`, { method: "POST" });
export const setMemberLeaderboardHidden = (guildId: string, userId: string, hidden: boolean) =>
  call<{ savedAt: string }>(`/api/guilds/${guildId}/levels/members/${userId}/visibility`, {
    method: "PATCH",
    body: JSON.stringify({ hidden })
  });
export const levelsLeaderboard = (guildId: string, track: "text" | "voice", page: number, pageSize = 25) =>
  call<LeaderboardPage>(
    `/api/guilds/${guildId}/levels/leaderboard?track=${track}&limit=${pageSize}&offset=${(page - 1) * pageSize}`
  );

/* ------------------------------------------------------------------ *
 * System: network reach (instance-wide, not per guild)
 * ------------------------------------------------------------------ */
export const network = () => call<NetworkSnapshot>("/api/network");
export const saveNetwork = (mode: RemoteAccessMode) =>
  call<NetworkSnapshot>("/api/network", { method: "PUT", body: JSON.stringify({ mode }) });
