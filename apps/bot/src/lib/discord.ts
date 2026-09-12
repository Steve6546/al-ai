import {
  AuditLogEvent,
  ChannelType,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  PermissionsBitField,
  REST,
  Routes,
  SlashCommandBuilder,
  type Guild
} from "discord.js";
import type { LogDestination, Severity } from "@al-ai/core";
import { groupPagesIntoMessages, planEmbedFields, SEVERITY_EMBED_COLOR } from "@al-ai/core";

// GOVERNANCE rule 2: This is the only file allowed to import discord.js.
// Every Discord API call the bot makes must be expressed as a function here.

/**
 * Intents are frozen by the AL AI governance contract.
 * GUILD_PRESENCES is deliberately absent: AL AI does not track online/idle state.
 * Emoji and sticker events require GUILD_EXPRESSIONS.
 */
export const AL_AI_INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMembers,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
  GatewayIntentBits.GuildVoiceStates,
  GatewayIntentBits.GuildModeration,
  GatewayIntentBits.GuildInvites,
  GatewayIntentBits.GuildExpressions
];

export function createDiscordClient() {
  return new Client({ intents: AL_AI_INTENTS });
}

// Severity colours come from @al-ai/core so the bot and the dashboard agree.
const severityColor: Record<Severity, number> = SEVERITY_EMBED_COLOR;

export type LogEnvelope = {
  correlationId: string;
  timestampUTC: string;
  actorHash: string;
  sourceLayer: string;
  eventId: string;
  category: LogDestination;
  severity: Severity;
  guildId: string;
  data: Record<string, unknown>;
};

export function buildLogEmbed(envelope: LogEnvelope, colorOverride?: string) {
  return buildLogEmbeds(envelope, colorOverride)[0];
}

/**
 * GOVERNANCE rule 11 — an oversized event is split, never truncated.
 * Every page keeps the same correlationId so the record can be reassembled,
 * and pages are numbered when there is more than one.
 */
export function buildLogEmbeds(envelope: LogEnvelope, colorOverride?: string) {
  const color = colorOverride ? Number.parseInt(colorOverride.replace("#", ""), 16) : severityColor[envelope.severity];
  const plan = planEmbedFields(envelope.data);

  return plan.pages.map((fields, index) => {
    const embed = new EmbedBuilder()
      .setColor(color)
      .setTitle(plan.pages.length > 1 ? `${envelope.eventId} (${index + 1}/${plan.pages.length})` : envelope.eventId)
      .setDescription(`الفئة: \`${envelope.category}\``)
      .addFields(fields)
      .setFooter({ text: `${envelope.sourceLayer} · ${envelope.correlationId}` })
      .setTimestamp(new Date(envelope.timestampUTC));

    if (plan.overflowed && index === plan.pages.length - 1) {
      embed.addFields({ name: "تنبيه", value: `الحدث تجاوز الحد الآمن (${plan.totalFields} حقلاً) — التفاصيل الكاملة في سجل التدقيق.` });
    }
    return embed;
  });
}

/**
 * The single delivery primitive used by the log router.
 * A large event becomes several messages of at most 10 embeds each.
 */
export async function sendLogEmbed(client: Client, channelId: string, envelope: LogEnvelope, colorOverride?: string) {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased() || channel.isDMBased()) return false;

  const embeds = buildLogEmbeds(envelope, colorOverride);
  for (const batch of groupPagesIntoMessages(embeds)) {
    if (batch.length) await channel.send({ embeds: batch });
  }
  return true;
}

/** Name of the role AL AI creates for itself, shown next to its name in the member list. */
export const BOT_ROLE_NAME = "AL AI";

export type BotRoleResult = { roleId: string; created: boolean; assigned: boolean };

/**
 * Ensures AL AI has its own role in a guild.
 *
 * The invite grants Administrator, but a bare managed role makes the bot
 * indistinguishable from any other app in the member list and leaves it with
 * nothing to position moderation roles against. This creates a visible, hoisted
 * role that carries Administrator, then assigns it to the bot member.
 *
 * Returns what actually happened instead of throwing, so a missing MANAGE_ROLES
 * degrades to a logged warning rather than blocking the whole join flow.
 */
export async function ensureBotRole(client: Client, guildId: string): Promise<BotRoleResult> {
  const guild = await client.guilds.fetch(guildId);
  const me = await guild.members.fetchMe();

  let role = guild.roles.cache.find(item => item.name === BOT_ROLE_NAME && !item.managed);
  let created = false;
  if (!role) {
    role = await guild.roles.create({
      name: BOT_ROLE_NAME,
      // Administrator: the bot manages roles, channels and members, so a partial
      // bitfield would leave parts of its own feature set unreachable.
      permissions: PermissionsBitField.Flags.Administrator,
      hoist: true,
      mentionable: false,
      reason: "AL AI creates its own role on join."
    });
    created = true;
  }

  const assigned = !me.roles.cache.has(role.id);
  if (assigned) await me.roles.add(role, "AL AI assigns its own role on join.");

  return { roleId: role.id, created, assigned };
}

/** Discord's ceiling for a role icon. Anything larger is refused by the API. */
const MAX_ROLE_ICON_BYTES = 256 * 1024;

/**
 * Downloads a role icon so it can be sent to Discord.
 *
 * The API takes image *data*, not a link, and discord.js treats a bare string as
 * a local file path — so a URL has to be fetched here. Returns null when the
 * value cannot be used, which the caller reports rather than silently dropping.
 */
async function fetchRoleIcon(url: string): Promise<Buffer | null> {
  try {
    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok) return null;
    if (!(response.headers.get("content-type") ?? "").startsWith("image/")) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    return buffer.byteLength > 0 && buffer.byteLength <= MAX_ROLE_ICON_BYTES ? buffer : null;
  } catch {
    return null;
  }
}

/**
 * Applies the operator's per-guild appearance to Discord.
 *
 * Discord gives an application a single global avatar and banner, so the only
 * per-guild visual identity that exists is the bot's nickname plus the colour
 * and icon of its own role. All three are written here, together, because this
 * is the one place that knows how the appearance contract maps onto Discord —
 * the dashboard stores the values and never talks to Discord itself.
 *
 * Throws when Discord or the icon download refuses the change, so the sync treats
 * it as "not yet applied" and retries, rather than recording a success that never
 * happened.
 */
export async function applyBotAppearance(
  client: Client,
  guildId: string,
  appearance: { nickname: string; roleColor: string | null; roleIconUrl: string | null }
): Promise<boolean> {
  const guild = await client.guilds.fetch(guildId);
  const me = await guild.members.fetchMe();

  // An empty nickname means "fall back to the application's own name", which is
  // how Discord spells a cleared nickname.
  await me.setNickname(appearance.nickname || null);

  // The role is the only per-guild surface that can carry a colour and an icon.
  // ensureBotRole is idempotent: it returns the existing role, and recreates it
  // if an operator deleted the role by hand.
  const { roleId } = await ensureBotRole(client, guildId);
  const role = await guild.roles.fetch(roleId);
  // The role existed a moment ago, so its disappearance is a real failure rather
  // than a reason to report a success that never happened.
  if (!role) throw new Error(`BOT_ROLE_MISSING:${guildId}`);

  // A stored icon that cannot be downloaded is a failure, not a detail: letting
  // it pass would leave the operator looking at a saved value with no effect.
  let icon: Buffer | null = null;
  if (appearance.roleIconUrl) {
    icon = await fetchRoleIcon(appearance.roleIconUrl);
    if (!icon) throw new Error(`ROLE_ICON_UNUSABLE:${appearance.roleIconUrl}`);
  }

  await role.edit({
    // Colour 0 is Discord's "no colour", which is what a cleared value means.
    colors: { primaryColor: appearance.roleColor ? Number.parseInt(appearance.roleColor.slice(1), 16) : 0 },
    // null clears the icon, which is what an emptied field means.
    icon
  });

  return true;
}

/** Text channels that can host logs, with the operator-facing name. */
export async function listLoggableChannels(client: Client, guildId: string) {
  const guild = await client.guilds.fetch(guildId);
  const channels = await guild.channels.fetch();
  return channels
    .filter(channel => channel !== null && (channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement))
    .map(channel => ({ id: channel!.id, name: channel!.name }));
}

/* ------------------------------------------------------------------ *
 * Slash commands
 *
 * GOVERNANCE rule 1: slash commands only, and every builder here corresponds to
 * an entry in packages/core/src/command-registry.ts. Nothing else may be
 * published — the registry is the authority on what exists.
 * ------------------------------------------------------------------ */

/** Discord's own ceiling for a timeout, and the minimum Discord accepts. */
export const TIMEOUT_MIN_SECONDS = 60;
export const TIMEOUT_MAX_SECONDS = 28 * 24 * 60 * 60;

export function buildStatusCommand() {
  return new SlashCommandBuilder().setName("al-status").setDescription("عرض حالة AL AI").toJSON();
}

export function buildModerationCommands() {
  return [
    new SlashCommandBuilder()
      .setName("ban")
      .setDescription("حظر عضو")
      .addUserOption(option => option.setName("user").setDescription("العضو").setRequired(true))
      .addStringOption(option => option.setName("reason").setDescription("السبب").setMaxLength(512))
      .setDefaultMemberPermissions(0n)
      .toJSON(),

    new SlashCommandBuilder()
      .setName("unban")
      .setDescription("رفع الحظر عن مستخدم")
      .addStringOption(option => option.setName("user_id").setDescription("معرّف المستخدم").setRequired(true))
      .addStringOption(option => option.setName("reason").setDescription("السبب").setMaxLength(512))
      .setDefaultMemberPermissions(0n)
      .toJSON(),

    new SlashCommandBuilder()
      .setName("kick")
      .setDescription("طرد عضو")
      .addUserOption(option => option.setName("user").setDescription("العضو").setRequired(true))
      .addStringOption(option => option.setName("reason").setDescription("السبب").setMaxLength(512))
      .setDefaultMemberPermissions(0n)
      .toJSON(),

    new SlashCommandBuilder()
      .setName("timeout")
      .setDescription("إسكات مؤقت")
      .addUserOption(option => option.setName("user").setDescription("العضو").setRequired(true))
      .addIntegerOption(option =>
        option
          .setName("minutes")
          .setDescription("المدة بالدقائق")
          .setRequired(true)
          .setMinValue(1)
          .setMaxValue(TIMEOUT_MAX_SECONDS / 60)
      )
      .addStringOption(option => option.setName("reason").setDescription("السبب").setMaxLength(512))
      .setDefaultMemberPermissions(0n)
      .toJSON(),

    new SlashCommandBuilder()
      .setName("mute")
      .setDescription("كتم عضو في القنوات الصوتية")
      .addUserOption(option => option.setName("user").setDescription("العضو").setRequired(true))
      .addStringOption(option => option.setName("reason").setDescription("السبب").setMaxLength(512))
      .setDefaultMemberPermissions(0n)
      .toJSON(),

    new SlashCommandBuilder()
      .setName("warn")
      .setDescription("تحذير عضو")
      .addUserOption(option => option.setName("user").setDescription("العضو").setRequired(true))
      .addStringOption(option => option.setName("reason").setDescription("السبب").setRequired(true).setMaxLength(512))
      .setDefaultMemberPermissions(0n)
      .toJSON()
  ];
}

/** Everything AL AI publishes. Used by scripts/deploy-commands.ts. */
export function buildAllCommands() {
  return [buildStatusCommand(), ...buildModerationCommands()];
}

/* ------------------------------------------------------------------ *
 * Moderation actions
 *
 * GOVERNANCE rule 2: these are the only functions that mutate a guild, and they
 * are reached exclusively through the command handler.
 * ------------------------------------------------------------------ */

export type MemberPositions = { highestPosition: number; isGuildOwner: boolean };

export async function readMemberPositions(client: Client, guildId: string, userId: string): Promise<MemberPositions | null> {
  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return null;
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return null;
  return { highestPosition: member.roles.highest.position, isGuildOwner: guild.ownerId === userId };
}

export async function readBotHighestPosition(client: Client, guildId: string) {
  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return null;
  const me = await guild.members.fetchMe().catch(() => null);
  return me ? me.roles.highest.position : null;
}

export type ModerationAction =
  | { kind: "ban"; guildId: string; targetId: string; reason: string }
  | { kind: "unban"; guildId: string; targetId: string; reason: string }
  | { kind: "kick"; guildId: string; targetId: string; reason: string }
  | { kind: "timeout"; guildId: string; targetId: string; minutes: number; reason: string }
  | { kind: "mute"; guildId: string; targetId: string; reason: string }
  | { kind: "warn"; guildId: string; targetId: string; reason: string };

/** Applies one moderation action. Returns false when Discord refused it. */
export async function applyModeration(client: Client, action: ModerationAction) {
  const guild = await client.guilds.fetch(action.guildId).catch(() => null);
  if (!guild) return false;

  try {
    switch (action.kind) {
      case "ban":
        await guild.bans.create(action.targetId, { reason: action.reason });
        return true;
      case "unban":
        await guild.bans.remove(action.targetId, action.reason);
        return true;
      case "kick": {
        const member = await guild.members.fetch(action.targetId);
        await member.kick(action.reason);
        return true;
      }
      case "timeout": {
        const member = await guild.members.fetch(action.targetId);
        const seconds = Math.min(Math.max(action.minutes * 60, TIMEOUT_MIN_SECONDS), TIMEOUT_MAX_SECONDS);
        await member.timeout(seconds * 1000, action.reason);
        return true;
      }
      case "mute": {
        const member = await guild.members.fetch(action.targetId);
        await member.voice.setMute(true, action.reason);
        return true;
      }
      case "warn":
        // A warning is a record, not a Discord mutation: it is written to the
        // moderation log by the caller and needs no API call here.
        return true;
      default:
        return false;
    }
  } catch {
    return false;
  }
}

/**
 * Deployment is intentionally separate from runtime.
 * Calling this from the bot process is a governance violation (rule 9).
 */
export async function deploySlashCommands(token: string, clientId: string) {
  await new REST({ version: "10" }).setToken(token).put(Routes.applicationCommands(clientId), { body: buildAllCommands() });
}

/* ------------------------------------------------------------------ *
 * Normalised event surface
 *
 * Handlers must not import discord.js, so this module converts Discord
 * payloads into plain objects and hands them to a sink.
 * ------------------------------------------------------------------ */

export type BotEvent =
  | { type: "client.ready"; tag: string; guildCount: number }
  | { type: "client.error"; message: string }
  | { type: "guild.joined"; guildId: string; name: string }
  | { type: "member.join"; guildId: string; memberId: string }
  | { type: "member.leave"; guildId: string; memberId: string }
  | { type: "member.nickname-change"; guildId: string; memberId: string; before: string; after: string }
  | { type: "member.role-add"; guildId: string; memberId: string; roleId: string }
  | { type: "member.role-remove"; guildId: string; memberId: string; roleId: string }
  | { type: "moderation.ban"; guildId: string; targetId: string; actorId: string }
  | { type: "moderation.unban"; guildId: string; targetId: string; actorId: string }
  | { type: "moderation.kick"; guildId: string; targetId: string; actorId: string }
  | { type: "moderation.timeout"; guildId: string; targetId: string; actorId: string }
  | { type: "voice.join"; guildId: string; memberId: string; toChannelId: string }
  | { type: "voice.leave"; guildId: string; memberId: string; fromChannelId: string }
  | { type: "voice.move"; guildId: string; memberId: string; fromChannelId: string; toChannelId: string }
  | { type: "voice.state-change"; guildId: string; memberId: string; channelId: string; change: string }
  | { type: "role.create"; guildId: string; roleId: string; actorId: string }
  | { type: "role.update"; guildId: string; roleId: string; actorId: string }
  | { type: "role.delete"; guildId: string; roleId: string; actorId: string }
  | { type: "message.delete"; guildId: string; messageId: string; channelId: string; authorId?: string; content?: string }
  | {
      type: "message.edit";
      guildId: string;
      messageId: string;
      channelId: string;
      authorId?: string;
      before?: string;
      after?: string;
    }
  | { type: "message.bulk-delete"; guildId: string; channelId: string; count: number }
  | { type: "server.channel-create"; guildId: string; channelId: string; actorId: string }
  | { type: "server.channel-update"; guildId: string; channelId: string; actorId: string }
  | { type: "server.channel-delete"; guildId: string; channelId: string; actorId: string }
  | { type: "server.invite-create"; guildId: string; inviteCode: string; actorId: string }
  | { type: "server.expression-create"; guildId: string; expressionId: string; actorId: string }
  | { type: "server.expression-delete"; guildId: string; expressionId: string; actorId: string }
  | { type: "interaction.status"; guildId: string; userId: string; interactionId: string; roleIds: string[] };

export type EventSink = (event: BotEvent) => void;

/**
 * Best-effort actor resolution from the guild audit log.
 * Cached for 5 seconds because a burst of related events shares one entry.
 * Falls back to "unknown" when the bot lacks VIEW_AUDIT_LOG.
 */
function createActorResolver() {
  const cache = new Map<string, { actorId: string; expiresAt: number }>();

  return async function resolveActor(guild: Guild, type: AuditLogEvent, targetId: string, now = Date.now()) {
    const key = `${guild.id}:${type}:${targetId}`;
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now) return cached.actorId;

    let actorId = "unknown";
    try {
      const logs = await guild.fetchAuditLogs({ type, limit: 5 });
      const entry = logs.entries.find(item => item.targetId === targetId) ?? logs.entries.first();
      if (entry?.executorId) actorId = entry.executorId;
    } catch {
      // Missing VIEW_AUDIT_LOG is not fatal: the event still gets logged.
    }
    cache.set(key, { actorId, expiresAt: now + 5_000 });
    return actorId;
  };
}

export type BindOptions = {
  /** Answers /al-status. Kept as a callback so handlers stay discord.js-free. */
  onStatusCommand?: (context: { guildId: string; userId: string; roleIds: string[] }) => Promise<string>;
  /**
   * Handles a moderation slash command. The orchestration (tier check,
   * hierarchy check, logging) lives outside this module; Discord-specific work
   * — reading options and replying — happens here.
   */
  onCommand?: (context: CommandContext) => Promise<void>;
  /**
   * Short-lived cache that lets message.delete / message.edit recover the body.
   * Discord only sends content on messageCreate, so without this the log can
   * only say "a message was deleted".
   */
  messageCache?: {
    put(message: { id: string; guildId: string; channelId: string; authorId: string; content: string; createdAt: number }): void;
    get(channelId: string, messageId: string): { content: string; authorId: string } | undefined;
  };
};

/** A slash command as the handler sees it: plain data plus a reply function. */
export type CommandContext = {
  interactionId: string;
  guildId: string;
  userId: string;
  roleIds: string[];
  commandName: string;
  targetId: string | null;
  minutes: number | null;
  reason: string;
  reply: (content: string) => Promise<void>;
};

/** Roles are a manager on a cached member and a raw array on an API payload. */
function roleIdsOf(member: unknown): string[] {
  if (!member || typeof member !== "object") return [];
  const roles = (member as { roles?: unknown }).roles;
  if (Array.isArray(roles)) return roles.filter((id): id is string => typeof id === "string");
  const cache = (roles as { cache?: Map<string, unknown> } | undefined)?.cache;
  return cache ? [...cache.keys()] : [];
}

export function bindEvents(client: Client, sink: EventSink, options: BindOptions = {}) {
  const resolveActor = createActorResolver();
  const cache = options.messageCache;
  const emit = (event: BotEvent) => {
    try {
      sink(event);
    } catch (error) {
      console.error("AL AI event sink failed", error);
    }
  };

  client.once("clientReady", () => emit({ type: "client.ready", tag: client.user?.tag ?? "unknown", guildCount: client.guilds.cache.size }));
  client.on("error", error => emit({ type: "client.error", message: error.message }));
  // Emitted so the runtime can create the bot's own role before the operator is
  // offered any settings screen.
  client.on("guildCreate", guild => emit({ type: "guild.joined", guildId: guild.id, name: guild.name }));

  client.on("guildMemberAdd", member => emit({ type: "member.join", guildId: member.guild.id, memberId: member.id }));
  client.on("guildMemberRemove", member => emit({ type: "member.leave", guildId: member.guild.id, memberId: member.id }));
  client.on("guildMemberUpdate", (before, after) => {
    if (before.nickname !== after.nickname) {
      emit({ type: "member.nickname-change", guildId: after.guild.id, memberId: after.id, before: before.nickname ?? "", after: after.nickname ?? "" });
    }
    for (const roleId of after.roles.cache.keys()) {
      if (!before.roles.cache.has(roleId)) emit({ type: "member.role-add", guildId: after.guild.id, memberId: after.id, roleId });
    }
    for (const roleId of before.roles.cache.keys()) {
      if (!after.roles.cache.has(roleId)) emit({ type: "member.role-remove", guildId: after.guild.id, memberId: after.id, roleId });
    }
  });

  client.on("guildBanAdd", async ban => emit({ type: "moderation.ban", guildId: ban.guild.id, targetId: ban.user.id, actorId: await resolveActor(ban.guild, AuditLogEvent.MemberBanAdd, ban.user.id) }));
  client.on("guildBanRemove", async ban => emit({ type: "moderation.unban", guildId: ban.guild.id, targetId: ban.user.id, actorId: await resolveActor(ban.guild, AuditLogEvent.MemberBanRemove, ban.user.id) }));

  client.on("guildMemberRemove", async member => {
    const actorId = await resolveActor(member.guild, AuditLogEvent.MemberKick, member.id);
    if (actorId !== "unknown") emit({ type: "moderation.kick", guildId: member.guild.id, targetId: member.id, actorId });
  });

  client.on("guildMemberUpdate", (before, after) => {
    const wasTimedOut = Boolean(before.communicationDisabledUntilTimestamp);
    const isTimedOut = Boolean(after.communicationDisabledUntilTimestamp);
    if (!wasTimedOut && isTimedOut) {
      void resolveActor(after.guild, AuditLogEvent.MemberUpdate, after.id).then(actorId =>
        emit({ type: "moderation.timeout", guildId: after.guild.id, targetId: after.id, actorId })
      );
    }
  });

  client.on("voiceStateUpdate", (before, after) => {
    const memberId = after.id || before.id;
    const guildId = (after.guild ?? before.guild).id;
    if (before.channelId === after.channelId) {
      if (before.selfMute !== after.selfMute) emit({ type: "voice.state-change", guildId, memberId, channelId: after.channelId ?? "", change: "mute" });
      else if (before.selfDeaf !== after.selfDeaf) emit({ type: "voice.state-change", guildId, memberId, channelId: after.channelId ?? "", change: "deaf" });
      else if (before.streaming !== after.streaming) emit({ type: "voice.state-change", guildId, memberId, channelId: after.channelId ?? "", change: "stream" });
      return;
    }
    if (!before.channelId && after.channelId) emit({ type: "voice.join", guildId, memberId, toChannelId: after.channelId });
    else if (before.channelId && !after.channelId) emit({ type: "voice.leave", guildId, memberId, fromChannelId: before.channelId });
    else if (before.channelId && after.channelId) emit({ type: "voice.move", guildId, memberId, fromChannelId: before.channelId, toChannelId: after.channelId });
  });

  client.on("roleCreate", async role => emit({ type: "role.create", guildId: role.guild.id, roleId: role.id, actorId: await resolveActor(role.guild, AuditLogEvent.RoleCreate, role.id) }));
  client.on("roleUpdate", async (_before, role) => emit({ type: "role.update", guildId: role.guild.id, roleId: role.id, actorId: await resolveActor(role.guild, AuditLogEvent.RoleUpdate, role.id) }));
  client.on("roleDelete", async role => emit({ type: "role.delete", guildId: role.guild.id, roleId: role.id, actorId: await resolveActor(role.guild, AuditLogEvent.RoleDelete, role.id) }));

  client.on("messageCreate", message => {
    if (!cache || !message.guildId || message.author.bot) return;
    cache.put({
      id: message.id,
      guildId: message.guildId,
      channelId: message.channelId,
      authorId: message.author.id,
      content: message.content ?? "",
      createdAt: message.createdTimestamp || Date.now()
    });
  });

  client.on("messageDelete", message => {
    if (!message.guildId) return;
    const cached = cache?.get(message.channelId, message.id);
    emit({
      type: "message.delete",
      guildId: message.guildId,
      messageId: message.id,
      channelId: message.channelId,
      ...(cached ? { authorId: cached.authorId, content: cached.content } : {})
    });
  });
  client.on("messageUpdate", (before, after) => {
    if (!after.guildId) return;
    const cached = cache?.get(after.channelId, after.id);
    const beforeContent = cached?.content ?? (typeof before.content === "string" ? before.content : "");
    const afterContent = after.content ?? "";
    if (beforeContent === afterContent) return;
    emit({
      type: "message.edit",
      guildId: after.guildId,
      messageId: after.id,
      channelId: after.channelId,
      ...(cached ? { authorId: cached.authorId } : {}),
      before: beforeContent,
      after: afterContent
    });
  });
  client.on("messageDeleteBulk", (messages, channel) => {
    if (!channel.guildId) return;
    emit({ type: "message.bulk-delete", guildId: channel.guildId, channelId: channel.id, count: messages.size });
  });

  client.on("channelCreate", async channel => {
    if (!("guild" in channel) || !channel.guild) return;
    emit({ type: "server.channel-create", guildId: channel.guild.id, channelId: channel.id, actorId: await resolveActor(channel.guild, AuditLogEvent.ChannelCreate, channel.id) });
  });
  client.on("channelUpdate", async (_before, channel) => {
    if (!("guild" in channel) || !channel.guild) return;
    emit({ type: "server.channel-update", guildId: channel.guild.id, channelId: channel.id, actorId: await resolveActor(channel.guild, AuditLogEvent.ChannelUpdate, channel.id) });
  });
  client.on("channelDelete", async channel => {
    if (!("guild" in channel) || !channel.guild) return;
    emit({ type: "server.channel-delete", guildId: channel.guild.id, channelId: channel.id, actorId: await resolveActor(channel.guild, AuditLogEvent.ChannelDelete, channel.id) });
  });

  client.on("inviteCreate", async invite => {
    if (!invite.guild) return;
    emit({ type: "server.invite-create", guildId: invite.guild.id, inviteCode: invite.code, actorId: await resolveActor(invite.guild as Guild, AuditLogEvent.InviteCreate, invite.code) });
  });

  client.on("guildEmojiCreate", async emoji => {
    if (!emoji.guild) return;
    emit({ type: "server.expression-create", guildId: emoji.guild.id, expressionId: emoji.id, actorId: await resolveActor(emoji.guild, AuditLogEvent.EmojiCreate, emoji.id) });
  });
  client.on("guildEmojiDelete", async emoji => {
    if (!emoji.guild) return;
    emit({ type: "server.expression-delete", guildId: emoji.guild.id, expressionId: emoji.id, actorId: await resolveActor(emoji.guild, AuditLogEvent.EmojiDelete, emoji.id) });
  });

  client.on("interactionCreate", async interaction => {
    if (!interaction.isChatInputCommand() || !interaction.guildId) return;

    const guildId = interaction.guildId;
    const userId = interaction.user.id;
    const roleIds = roleIdsOf(interaction.member);

    if (interaction.commandName === "al-status") {
      emit({ type: "interaction.status", guildId, userId, interactionId: interaction.id, roleIds });
      return;
    }

    if (!options.onCommand) return;

    const target = interaction.options.getUser("user");
    const minutes = interaction.options.getInteger("minutes");

    await options.onCommand({
      interactionId: interaction.id,
      guildId,
      userId,
      roleIds,
      commandName: interaction.commandName,
      targetId: target?.id ?? interaction.options.getString("user_id") ?? null,
      minutes,
      reason: interaction.options.getString("reason") ?? "",
      reply: async content => {
        // Ephemeral: a moderation reply is for the operator, not the channel.
        await interaction.reply({ content, ephemeral: true }).catch(() => undefined);
      }
    });
  });
}

export { ChannelType };
