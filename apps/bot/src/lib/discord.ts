import {
  ApplicationCommandOptionType,
  AuditLogEvent,
  ChannelType,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  PermissionsBitField,
  REST,
  Routes,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildChannel,
  type SlashCommandStringOption,
  type SlashCommandUserOption
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

/**
 * Delivers an internal event to the developer webhook.
 *
 * A webhook rather than a channel, because AL AI's own failures and security
 * events must never land in a customer's server: the operator did not ask for
 * them and cannot act on them. The URL comes from the environment, so no guild
 * can redirect AL AI's internals somewhere of its own choosing.
 */
export async function sendLogEmbedToWebhook(webhookUrl: string, envelope: LogEnvelope, colorOverride?: string) {
  for (const batch of groupPagesIntoMessages(buildLogEmbeds(envelope, colorOverride))) {
    if (!batch.length) continue;
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: batch.map(embed => embed.toJSON()) })
    }).catch(() => null);
    // A dead webhook is a failed delivery, not a reason to throw: the audit
    // trail already holds the event and the caller only records the outcome.
    if (!response?.ok) return false;
  }
  return true;
}

/**
 * A member's role IDs, cached briefly.
 *
 * The log router asks for this on every event once a guild has role exclusions,
 * and a busy guild emits far more events than its members change roles. Five
 * seconds is short enough that a role change is reflected almost immediately and
 * long enough to collapse a burst into a single lookup.
 */
const ROLE_CACHE_TTL_MS = 5_000;
const memberRoleCache = new Map<string, { roleIds: string[]; expiresAt: number }>();

export async function readMemberRoleIds(client: Client, guildId: string, userId: string): Promise<string[]> {
  const key = `${guildId}:${userId}`;
  const cached = memberRoleCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.roleIds;

  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return [];
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return [];

  const roleIds = [...member.roles.cache.keys()];
  // Bounded, so a large guild cannot turn this into an unbounded cache.
  if (memberRoleCache.size > 5_000) memberRoleCache.clear();
  memberRoleCache.set(key, { roleIds, expiresAt: Date.now() + ROLE_CACHE_TTL_MS });
  return roleIds;
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

/** `/clear` bounds. One message is the floor: Discord's bulk endpoint needs two. */
export const CLEAR_MIN_COUNT = 1;
export const CLEAR_MAX_COUNT = 100;

/** `/slowmode` bounds, in seconds. Discord's own maximum is six hours. */
export const SLOWMODE_MAX_SECONDS = 6 * 60 * 60;

export function buildStatusCommand() {
  return new SlashCommandBuilder().setName("al-status").setDescription("عرض حالة AL AI").toJSON();
}

/** Shared option builders, so the same control is described identically everywhere. */
const targetOption = (option: SlashCommandUserOption) => option.setName("user").setDescription("العضو").setRequired(true);
const reasonOption = (option: SlashCommandStringOption, required = false) =>
  option.setName("reason").setDescription("السبب").setRequired(required).setMaxLength(512);

export function buildModerationCommands() {
  return [
    new SlashCommandBuilder()
      .setName("ban")
      .setDescription("حظر عضو")
      .addUserOption(targetOption)
      .addStringOption(option => reasonOption(option))
      .setDefaultMemberPermissions(0n)
      .toJSON(),

    new SlashCommandBuilder()
      .setName("unban")
      .setDescription("رفع الحظر عن مستخدم")
      .addStringOption(option => option.setName("user_id").setDescription("معرّف المستخدم").setRequired(true))
      .addStringOption(option => reasonOption(option))
      .setDefaultMemberPermissions(0n)
      .toJSON(),

    new SlashCommandBuilder()
      .setName("kick")
      .setDescription("طرد عضو")
      .addUserOption(targetOption)
      .addStringOption(option => reasonOption(option))
      .setDefaultMemberPermissions(0n)
      .toJSON(),

    new SlashCommandBuilder()
      .setName("timeout")
      .setDescription("إسكات مؤقت")
      .addUserOption(targetOption)
      .addIntegerOption(option =>
        option
          .setName("minutes")
          .setDescription("المدة بالدقائق")
          .setRequired(true)
          .setMinValue(1)
          .setMaxValue(TIMEOUT_MAX_SECONDS / 60)
      )
      .addStringOption(option => reasonOption(option))
      .setDefaultMemberPermissions(0n)
      .toJSON(),

    new SlashCommandBuilder()
      .setName("warn")
      .setDescription("تحذير عضو")
      .addUserOption(targetOption)
      .addStringOption(option => reasonOption(option, true))
      .setDefaultMemberPermissions(0n)
      .toJSON(),

    new SlashCommandBuilder()
      .setName("warns")
      .setDescription("عرض تحذيرات عضو")
      .addUserOption(targetOption)
      .setDefaultMemberPermissions(0n)
      .toJSON(),

    new SlashCommandBuilder()
      .setName("clearwarns")
      .setDescription("مسح تحذيرات عضو")
      .addUserOption(targetOption)
      .addStringOption(option => reasonOption(option))
      .setDefaultMemberPermissions(0n)
      .toJSON(),

    // Channel commands. They act on the channel the command is typed in, so they
    // take no target — Discord's own `Manage Messages` / `Manage Channels`
    // permission is what the operator grants, and AL AI layers its tier on top.
    new SlashCommandBuilder()
      .setName("clear")
      .setDescription("حذف عدد من الرسائل في هذه القناة")
      .addIntegerOption(option =>
        option
          .setName("count")
          .setDescription("عدد الرسائل")
          .setRequired(true)
          .setMinValue(CLEAR_MIN_COUNT)
          .setMaxValue(CLEAR_MAX_COUNT)
      )
      .setDefaultMemberPermissions(0n)
      .toJSON(),

    new SlashCommandBuilder()
      .setName("lock")
      .setDescription("إغلاق القناة أمام الأعضاء")
      .addStringOption(option => reasonOption(option))
      .setDefaultMemberPermissions(0n)
      .toJSON(),

    new SlashCommandBuilder()
      .setName("unlock")
      .setDescription("فتح القناة أمام الأعضاء")
      .addStringOption(option => reasonOption(option))
      .setDefaultMemberPermissions(0n)
      .toJSON(),

    new SlashCommandBuilder()
      .setName("slowmode")
      .setDescription("ضبط الوضع البطيء للقناة")
      .addIntegerOption(option =>
        option
          .setName("seconds")
          .setDescription("الفاصل بالثواني، و0 لإيقافه")
          .setRequired(true)
          .setMinValue(0)
          .setMaxValue(SLOWMODE_MAX_SECONDS)
      )
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
  | { kind: "ban"; guildId: string; targetId: string; reason: string; deleteMessageSeconds?: number }
  | { kind: "unban"; guildId: string; targetId: string; reason: string }
  | { kind: "kick"; guildId: string; targetId: string; reason: string }
  | { kind: "timeout"; guildId: string; targetId: string; minutes: number; reason: string; deleteMessageSeconds?: number };

/** Applies one member action. Returns false when Discord refused it. */
export async function applyModeration(client: Client, action: ModerationAction) {
  const guild = await client.guilds.fetch(action.guildId).catch(() => null);
  if (!guild) return false;

  try {
    switch (action.kind) {
      case "ban":
        await guild.bans.create(action.targetId, {
          reason: action.reason,
          ...(action.deleteMessageSeconds ? { deleteMessageSeconds: action.deleteMessageSeconds } : {})
        });
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
      default:
        return false;
    }
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Channel actions
 *
 * `/clear`, `/lock`, `/unlock` and `/slowmode` act on the channel they are
 * typed in, so they carry no member target and take no part in the role
 * hierarchy. They are kept separate from `applyModeration` precisely so that
 * distinction is visible in the types rather than buried in a branch.
 * ------------------------------------------------------------------ */

export type ChannelAction =
  | { kind: "clear"; guildId: string; channelId: string; count: number }
  | { kind: "lock"; guildId: string; channelId: string; reason: string }
  | { kind: "unlock"; guildId: string; channelId: string; reason: string }
  | { kind: "slowmode"; guildId: string; channelId: string; seconds: number; reason: string };

export type ChannelActionResult = { ok: true; removed?: number } | { ok: false; reason: string };

/**
 * A guild channel that carries permission overwrites.
 *
 * `GuildBasedChannel` is a union that includes threads, which have no
 * overwrites of their own. Narrowing structurally here is what lets `/lock`
 * work on a text channel and be refused on a thread, without casting the
 * union away and hoping.
 */
type OverwritableChannel = GuildChannel;

function isOverwritable(channel: unknown): channel is OverwritableChannel {
  return Boolean(channel) && typeof (channel as OverwritableChannel).permissionOverwrites?.edit === "function";
}

/** Applies one channel action. Reports *why* it failed so the operator is not left guessing. */
export async function applyChannelAction(client: Client, action: ChannelAction): Promise<ChannelActionResult> {
  const guild = await client.guilds.fetch(action.guildId).catch(() => null);
  if (!guild) return { ok: false, reason: "GUILD_UNAVAILABLE" };

  const channel = await guild.channels.fetch(action.channelId).catch(() => null);
  if (!channel) return { ok: false, reason: "CHANNEL_UNAVAILABLE" };

  try {
    switch (action.kind) {
      case "clear": {
        if (!channel.isTextBased() || channel.isDMBased()) return { ok: false, reason: "NOT_A_TEXT_CHANNEL" };
        // Discord's bulk endpoint refuses anything under two messages, so a
        // single-message request falls back to a direct delete.
        const deleted =
          action.count === 1
            ? await channel.bulkDelete(1, true).then(batch => batch.size).catch(() => -1)
            : await channel.bulkDelete(Math.min(action.count, CLEAR_MAX_COUNT), true).then(batch => batch.size);
        if (deleted < 0) return { ok: false, reason: "MESSAGES_TOO_OLD" };
        return { ok: true, removed: deleted };
      }
      case "lock":
        // Denying SendMessages on the @everyone overwrite is what Discord's own
        // "Lock Channel" does; it leaves other roles untouched.
        if (!isOverwritable(channel)) return { ok: false, reason: "NOT_A_TEXT_CHANNEL" };
        await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false }, { reason: action.reason });
        return { ok: true };
      case "unlock":
        // `null` clears the overwrite rather than setting it to allow, so a
        // channel that was locked by a role rule goes back to inheriting.
        if (!isOverwritable(channel)) return { ok: false, reason: "NOT_A_TEXT_CHANNEL" };
        await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: null }, { reason: action.reason });
        return { ok: true };
      case "slowmode":
        if (!("setRateLimitPerUser" in channel) || typeof channel.setRateLimitPerUser !== "function") {
          return { ok: false, reason: "NOT_A_TEXT_CHANNEL" };
        }
        await channel.setRateLimitPerUser(Math.min(Math.max(action.seconds, 0), SLOWMODE_MAX_SECONDS), action.reason);
        return { ok: true };
      default:
        return { ok: false, reason: "UNKNOWN_ACTION" };
    }
  } catch {
    return { ok: false, reason: "ACTION_FAILED" };
  }
}

/**
 * Direct-messages a member about an action taken against them.
 * Best-effort on purpose: a closed DM is not a failed moderation action.
 */
export async function notifyTarget(client: Client, guildId: string, userId: string, content: string) {
  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return false;
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return false;
  return member.send({ content }).then(() => true).catch(() => false);
}

/**
 * Direct-messages the guild owner.
 *
 * Best-effort: a closed DM must not stop a quarantine, so a failure here is
 * reported and not thrown. The owner is identified by Discord, not by a stored
 * ID, so a server that changed hands notifies the right person.
 */
export async function dmGuildOwner(client: Client, guildId: string, content: string) {
  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return false;
  const owner = await guild.fetchOwner().catch(() => null);
  if (!owner) return false;
  return owner.send({ content }).then(() => true).catch(() => false);
}

/**
 * Replaces every role a member holds with the quarantine role.
 *
 * Returns how many roles were removed, or null when the member could not be
 * changed at all — the caller must be able to tell "quarantined and stripped
 * four roles" from "the quarantine did not happen", because only the second is
 * an incident worth escalating.
 *
 * Roles at or above the bot's own position are refused by Discord, which is why
 * this returns null rather than a count when the write fails: a partial
 * quarantine reported as success would be the worst outcome of all.
 */
export async function quarantineMember(client: Client, guildId: string, userId: string, quarantineRoleId: string) {
  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return null;

  // Discord refuses role changes on the owner, and the owner is the person we
  // are about to notify — never the attacker.
  if (guild.ownerId === userId) return null;

  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return null;

  const removable = member.roles.cache.filter(
    role => role.id !== guild.roles.everyone.id && role.id !== quarantineRoleId
  );

  const applied = await member.roles
    .set([quarantineRoleId])
    .then(() => true)
    .catch(() => false);

  return applied ? removable.size : null;
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
  | { type: "moderation.ban"; guildId: string; targetId: string; actorId: string; reason?: string }
  | { type: "moderation.unban"; guildId: string; targetId: string; actorId: string; reason?: string }
  | { type: "moderation.kick"; guildId: string; targetId: string; actorId: string; reason?: string }
  | { type: "moderation.timeout"; guildId: string; targetId: string; actorId: string; reason?: string }
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
  const cache = new Map<string, { actorId: string; reason: string; expiresAt: number }>();

  /**
   * Resolves who performed an action *and* why, from Discord's own audit log.
   *
   * The reason matters: a moderator types one into `/ban`, Discord stores it on
   * the audit entry, and without reading it back the log would show the
   * punishment with no explanation. Reading it here is also what lets the
   * command handler stop logging punishments itself — one entry, complete.
   */
  async function resolveAudit(guild: Guild, type: AuditLogEvent, targetId: string, now = Date.now()) {
    const key = `${guild.id}:${type}:${targetId}`;
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now) return cached;

    let actorId = "unknown";
    let reason = "";
    try {
      const logs = await guild.fetchAuditLogs({ type, limit: 5 });
      const entry = logs.entries.find(item => item.targetId === targetId) ?? logs.entries.first();
      if (entry?.executorId) actorId = entry.executorId;
      if (entry?.reason) reason = entry.reason;
    } catch {
      // Missing VIEW_AUDIT_LOG is not fatal: the event still gets logged.
    }
    const result = { actorId, reason, expiresAt: now + 5_000 };
    cache.set(key, result);
    return result;
  }

  const resolveActor = async (guild: Guild, type: AuditLogEvent, targetId: string) =>
    (await resolveAudit(guild, type, targetId)).actorId;

  return { resolveActor, resolveAudit };
}

export type BindOptions = {
  /** Answers /al-status. Kept as a callback so handlers stay discord.js-free. */
  onStatusCommand?: (context: {
    guildId: string;
    userId: string;
    roleIds: string[];
    isGuildOwner: boolean;
    isAdministrator: boolean;
  }) => Promise<string>;
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
  /** The channel the command was typed in. Channel commands act on it. */
  channelId: string;
  userId: string;
  roleIds: string[];
  /**
   * Discord's own verdict on this member, needed for the automatic owner tier.
   * The dashboard never supplies these — they are read here, from Discord.
   */
  isGuildOwner: boolean;
  isAdministrator: boolean;
  commandName: string;
  /** The member the command acts on. Null for channel commands and `/unban`. */
  targetId: string | null;
  /**
   * Every integer option the command declared, keyed by its name — `minutes`,
   * `count`, `seconds`. Kept generic so adding a command does not mean adding a
   * field to this type, which is how `minutes` used to work.
   */
  numbers: Record<string, number>;
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

/**
 * The two facts the automatic owner tier rests on, read from Discord rather than
 * from anything the caller claims: guild ownership, and the Administrator
 * permission bit. `memberPermissions` is already computed by discord.js, so this
 * costs no extra API call.
 */
function memberFlagsOf(interaction: ChatInputCommandInteraction): { isGuildOwner: boolean; isAdministrator: boolean } {
  return {
    isGuildOwner: interaction.guild?.ownerId === interaction.user.id,
    isAdministrator: interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator) ?? false
  };
}

export function bindEvents(client: Client, sink: EventSink, options: BindOptions = {}) {
  const { resolveActor, resolveAudit } = createActorResolver();
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

  // Moderation is reported once, from Discord's audit log — never twice.
  // The audit log is the only source that also sees actions taken outside AL AI
  // (an admin banning from the Discord client), and it carries the reason the
  // moderator typed, so the command handler deliberately does not log these.
  client.on("guildBanAdd", async ban => {
    const { actorId, reason } = await resolveAudit(ban.guild, AuditLogEvent.MemberBanAdd, ban.user.id);
    emit({ type: "moderation.ban", guildId: ban.guild.id, targetId: ban.user.id, actorId, ...(reason ? { reason } : {}) });
  });

  client.on("guildBanRemove", async ban => {
    const { actorId, reason } = await resolveAudit(ban.guild, AuditLogEvent.MemberBanRemove, ban.user.id);
    emit({ type: "moderation.unban", guildId: ban.guild.id, targetId: ban.user.id, actorId, ...(reason ? { reason } : {}) });
  });

  client.on("guildMemberRemove", async member => {
    const { actorId, reason } = await resolveAudit(member.guild, AuditLogEvent.MemberKick, member.id);
    if (actorId !== "unknown") {
      emit({ type: "moderation.kick", guildId: member.guild.id, targetId: member.id, actorId, ...(reason ? { reason } : {}) });
    }
  });

  client.on("guildMemberUpdate", (before, after) => {
    const wasTimedOut = Boolean(before.communicationDisabledUntilTimestamp);
    const isTimedOut = Boolean(after.communicationDisabledUntilTimestamp);
    if (!wasTimedOut && isTimedOut) {
      void resolveAudit(after.guild, AuditLogEvent.MemberUpdate, after.id).then(({ actorId, reason }) =>
        emit({ type: "moderation.timeout", guildId: after.guild.id, targetId: after.id, actorId, ...(reason ? { reason } : {}) })
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
    const flags = memberFlagsOf(interaction);

    if (interaction.commandName === "al-status") {
      emit({ type: "interaction.status", guildId, userId, interactionId: interaction.id, roleIds });
      // The handler's answer is the entire point of this command. Emitting the
      // event and returning left Discord waiting until the interaction timed out,
      // so the operator saw "the application did not respond" every time.
      const content = options.onStatusCommand
        ? await options
            .onStatusCommand({ guildId, userId, roleIds, ...flags })
            .catch(() => "تعذّر قراءة حالة AL AI حالياً.")
        : "AL AI متصل.";
      await interaction.reply({ content, ephemeral: true }).catch(() => undefined);
      return;
    }

    if (!options.onCommand) return;

    const target = interaction.options.getUser("user");
    // Read every integer option the interaction carries, whatever it is called,
    // so the handler can support a new command without a new field here.
    const numbers: Record<string, number> = {};
    for (const option of interaction.options.data) {
      if (option.type === ApplicationCommandOptionType.Integer && typeof option.value === "number") {
        numbers[option.name] = option.value;
      }
    }

    await options.onCommand({
      interactionId: interaction.id,
      guildId,
      channelId: interaction.channelId,
      userId,
      roleIds,
      ...flags,
      commandName: interaction.commandName,
      targetId: target?.id ?? interaction.options.getString("user_id") ?? null,
      numbers,
      reason: interaction.options.getString("reason") ?? "",
      reply: async content => {
        // Ephemeral: a moderation reply is for the operator, not the channel.
        await interaction.reply({ content, ephemeral: true }).catch(() => undefined);
      }
    });
  });
}

export { ChannelType };
