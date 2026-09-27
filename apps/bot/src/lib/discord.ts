import {
  ActivityType as DiscordActivityType,
  ApplicationCommandOptionType,
  AuditLogEvent,
  AutoModerationActionType,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  GuildScheduledEventStatus,
  PermissionsBitField,
  REST,
  Routes,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildChannel,
  type Integration,
  type MessageReaction,
  type PartialMessageReaction,
  type SlashCommandStringOption,
  type SlashCommandUserOption
} from "discord.js";
import type { ActivityType, BotStatus, LogDestination, Severity } from "@al-ai/core";
import {
  activityTypeNumbers,
  BOT_ROLE_NAME,
  commandRegistry,
  groupPagesIntoMessages,
  normaliseSnowflake,
  planEmbedFields,
  SEVERITY_EMBED_COLOR,
  TIMEOUT_MAX_SECONDS
} from "@al-ai/core";
import { createRetractionRegistry } from "./retraction.js";
import { classifyIntegrations, classifyWebhooks, createDerivedState, type DerivedStateStore } from "../logging/derived-state.js";
import { describeSuspiciousAccount, isSuspiciousAccount } from "../logging/suspicious-account.js";
import type { InviteTracker } from "../logging/invite-tracker.js";

// GOVERNANCE rule 2: This is the only file allowed to import discord.js.
// Every Discord API call the bot makes must be expressed as a function here.
//
// GOVERNANCE rule 24: every call below is written against the official
// documentation — discord-api-docs for the endpoint's behaviour, discord.js for
// the wrapper — and uses the library's own enums and builders rather than a
// hand-rolled request. A new call is added the same way: read the docs first,
// then look for the function the library already provides.

/**
 * Re-exported so a lifecycle listener can be registered outside this module
 * without importing discord.js a second time.
 *
 * `index.ts` binds `client.once(Events.ClientReady, ...)` for the startup pass.
 * Spelling that as the bare string `"clientReady"` also works — discord.js emits
 * by *value*, and that is the value — but a literal cannot be checked: nothing
 * verifies that the name is still real after a library upgrade, which is how the
 * v13→v14 `ready` → `clientReady` rename would slip through silently. Importing
 * the constant keeps the registration checkable by the scan in
 * `test/discord-standards.test.ts`, and re-exporting it from here keeps
 * GOVERNANCE rule 2 intact rather than carving an exception into it.
 *
 * Contrast the emoji listeners below, where the literal was not merely fragile
 * but wrong: `"guildEmojiCreate"` is the constant's key while its value is
 * `emojiCreate`, so those two handlers never ran.
 */
export { Events };

/**
 * Intents are frozen by the AL AI governance contract.
 * GUILD_PRESENCES is deliberately absent: AL AI does not track online/idle state.
 * Emoji and sticker events require GUILD_EXPRESSIONS.
 */
const AL_AI_INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMembers,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
  GatewayIntentBits.GuildVoiceStates,
  GatewayIntentBits.GuildModeration,
  GatewayIntentBits.GuildInvites,
  // Reactions feed `message.reaction-*`. These are the highest-volume events the
  // bot subscribes to, so they travel the pipeline's throttle rather than
  // reaching Discord directly, and an operator can mute them per section.
  GatewayIntentBits.GuildMessageReactions,
  GatewayIntentBits.GuildExpressions,
  // Webhooks and integrations: `webhook.*`, `bot.join/leave`, `bot.role-*`.
  GatewayIntentBits.GuildWebhooks,
  GatewayIntentBits.GuildIntegrations,
  GatewayIntentBits.GuildScheduledEvents,
  GatewayIntentBits.AutoModerationConfiguration,
  GatewayIntentBits.AutoModerationExecution
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
function buildLogEmbeds(envelope: LogEnvelope, colorOverride?: string) {
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

// `BOT_ROLE_NAME` lives in @al-ai/core, not here: the dashboard finds the role by
// the same name to colour it, and two copies of the literal would drift apart.
export type BotRoleResult = { roleId: string; created: boolean };

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

  const needsAssign = !me.roles.cache.has(role.id);
  if (needsAssign) await me.roles.add(role, "AL AI assigns its own role on join.");

  return { roleId: role.id, created };
}

/**
 * Applies the bot's global presence: its status and its activity.
 *
 * This is the one appearance field the dashboard cannot write. A status lives on
 * the gateway connection and Discord exposes no REST route for it, so the bot
 * reads the value from the database and sets it here.
 *
 * The division is deliberate and each stored field has exactly one writer: the
 * dashboard performs the REST writes (nickname, avatar, banner, role colour, bio)
 * because it can report their per-field outcome straight back to the operator,
 * and the bot performs the presence write because only it holds a gateway
 * connection. Two writers for one field would mean the two fighting.
 *
 * Returns false when the gateway is not ready, so the sync retries rather than
 * recording a presence it never sent.
 */
export async function applyBotPresence(
  client: Client,
  presence: { status: BotStatus; activityType: ActivityType; activityText: string }
): Promise<boolean> {
  if (!client.isReady() || !client.user) return false;

  client.user.setPresence({
    status: presence.status,
    // An empty text means "no activity", not an activity with a blank name —
    // Discord would otherwise render a bare "Playing" with nothing after it.
    activities: presence.activityText
      ? [{ name: presence.activityText, type: activityTypeNumbers[presence.activityType] as DiscordActivityType }]
      : []
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

/**
 * Discord's own ceiling for a timeout, and the minimum Discord accepts.
 *
 * The maximum is re-exported from `@al-ai/core` rather than repeated: the
 * registry entry for `/timeout` carries it as `maxDurationSeconds`, and the
 * dashboard reads the same constant to explain the cap. A second copy here is a
 * second number to keep in step.
 */
export const TIMEOUT_MIN_SECONDS = 60;
export { TIMEOUT_MAX_SECONDS };

/** `/clear` bounds. One message is the floor: Discord's bulk endpoint needs two. */
export const CLEAR_MIN_COUNT = 1;
export const CLEAR_MAX_COUNT = 100;

/** `/slowmode` bounds, in seconds. Discord's own maximum is six hours. */
export const SLOWMODE_MAX_SECONDS = 6 * 60 * 60;

/**
 * `/down`'s ceiling, in minutes.
 *
 * Discord imposes nothing here — `/down` strips roles with our own call, not
 * through a timed Discord API — so the cap is ours. It exists because the value
 * becomes a timer, and an unbounded one would let a typo schedule a restore
 * further out than the process could ever be expected to live. Thirty days is
 * the longest duration `/timeout` can express, so it is also the longest an
 * operator can already reason about.
 */
const DOWN_MAX_MINUTES = 30 * 24 * 60;

export function buildStatusCommand() {
  return new SlashCommandBuilder().setName("al-status").setDescription("عرض حالة AL AI").toJSON();
}

/**
 * The core commands: what AL AI is, what it can do, and how to reach the panel.
 *
 * `/help`, `/commands`, `/dashboard` and `/colors` carry no default member
 * permission, and that is a deliberate exception to how every other command is
 * published. The rule elsewhere is "hidden from everyone, AL AI decides" — but a
 * help command nobody can see is not a gate, it is a missing feature, and a new
 * member has no way to learn what the bot does without one. These four only ever
 * answer a question, so showing them costs nothing.
 *
 * `/settings` is the exception among the exceptions: it is an operator tool that
 * hands back a link into a screen, so it stays hidden like the moderation
 * commands and is granted per role in Discord's own integrations page.
 */
function buildCoreCommands() {
  return [
    new SlashCommandBuilder().setName("help").setDescription("عرض قائمة الأوامر وشرح كل أمر").toJSON(),
    new SlashCommandBuilder().setName("commands").setDescription("عرض الأوامر المتاحة لك في هذا السيرفر").toJSON(),
    new SlashCommandBuilder().setName("settings").setDescription("الحصول على رابط إعدادات البوت في اللوحة").setDefaultMemberPermissions(0n).toJSON(),
    new SlashCommandBuilder().setName("dashboard").setDescription("الحصول على رابط لوحة التحكم").toJSON(),
    new SlashCommandBuilder().setName("colors").setDescription("عرض ألوان الرتب المتاحة في السيرفر").toJSON()
  ];
}

/** Shared option builders, so the same control is described identically everywhere. */
const targetOption = (option: SlashCommandUserOption) => option.setName("user").setDescription("العضو").setRequired(true);

/**
 * The shared `reason` option.
 *
 * Deliberately never marked `required`, even for `/warn`, whose registry entry
 * ships with `requiresReason`. Discord freezes `required` at registration time
 * while the guild's setting can change at any moment, so a hard-required option
 * would make "السبب مطلوب" a switch that cannot be turned off — the exact
 * "saved but not honoured" defect this project treats as its worst kind. The bot
 * enforces the requirement instead, and says so in the reply.
 *
 * Autocomplete is on so the operator's ready-made reasons (with their paired
 * durations) can be offered without re-registering the command.
 */
const reasonOption = (option: SlashCommandStringOption) =>
  option.setName("reason").setDescription("السبب").setMaxLength(512).setAutocomplete(true);

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
          .setDescription("المدة بالدقائق (اتركها فارغة لاستخدام المدة الافتراضية)")
          // Optional so the guild's `defaultDuration` has something to fill in.
          // A hard-required option would make that setting unreachable.
          .setRequired(false)
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
      // Not `.setRequired(true)`: the registry ships `requiresReason` for `/warn`,
      // but the guild owns that setting, and Discord freezes `required` at
      // registration. The bot enforces it per guild instead.
      .addStringOption(option => reasonOption(option))
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

    new SlashCommandBuilder()
      .setName("untimeout")
      .setDescription("رفع الإسكات المؤقت عن عضو")
      .addUserOption(targetOption)
      .addStringOption(option => reasonOption(option))
      .setDefaultMemberPermissions(0n)
      .toJSON(),

    // `/delwarn` removes one record rather than all of them, so it has to say
    // which. The number is the one `/warns` prints beside each entry, which makes
    // it the only identifier the operator has actually seen — a raw UUID would
    // be unusable without copying it out of the list first.
    new SlashCommandBuilder()
      .setName("delwarn")
      .setDescription("حذف تحذير واحد بعينه حسب رقمه في قائمة التحذيرات")
      .addUserOption(targetOption)
      .addIntegerOption(option =>
        option.setName("index").setDescription("رقم التحذير كما يظهر في /warns (1 = الأحدث)").setRequired(true).setMinValue(1)
      )
      .addStringOption(option => reasonOption(option))
      .setDefaultMemberPermissions(0n)
      .toJSON(),

    // An absent `nickname` clears the member's nickname rather than doing
    // nothing. Discord has no way to send "the empty string" as a meaningful
    // value here, so the absence has to carry the meaning — and "reset it" is
    // the only useful reading, since `/setnick` with no new name is otherwise a
    // command that does nothing at all.
    new SlashCommandBuilder()
      .setName("setnick")
      .setDescription("تغيير الاسم المستعار لعضو، واترك الاسم فارغاً لإزالته")
      .addUserOption(targetOption)
      .addStringOption(option => option.setName("nickname").setDescription("الاسم الجديد (اتركه فارغاً لإزالة الاسم)").setMaxLength(32).setRequired(false))
      .addStringOption(option => reasonOption(option))
      .setDefaultMemberPermissions(0n)
      .toJSON(),

    /* ---- The state-based punishments ----
     *
     * These take a member into a condition rather than applying an event, which
     * is why none of them takes a duration: a mute with a timer is `/timeout`.
     * `/down` is the exception and is the only one with a length.
     *
     * `/blacklist` and `/mute` take no role option on purpose. The role they
     * apply is a guild setting on the command's own card, so the operator names
     * it once instead of every time the command runs. */
    new SlashCommandBuilder()
      .setName("mute")
      .setDescription("كتم عضو عبر رتبة المكتوم")
      .addUserOption(targetOption)
      .addStringOption(option => reasonOption(option))
      .setDefaultMemberPermissions(0n)
      .toJSON(),

    new SlashCommandBuilder()
      .setName("unmute")
      .setDescription("فك الكتم عن عضو")
      .addUserOption(targetOption)
      .addStringOption(option => reasonOption(option))
      .setDefaultMemberPermissions(0n)
      .toJSON(),

    new SlashCommandBuilder()
      .setName("prison")
      .setDescription("عزل عضو في رتبة وقناة السجن")
      .addUserOption(targetOption)
      .addStringOption(option => reasonOption(option))
      .setDefaultMemberPermissions(0n)
      .toJSON(),

    new SlashCommandBuilder()
      .setName("unprison")
      .setDescription("إخراج عضو من السجن وإعادة رتبه")
      .addUserOption(targetOption)
      .addStringOption(option => reasonOption(option))
      .setDefaultMemberPermissions(0n)
      .toJSON(),

    new SlashCommandBuilder()
      .setName("blacklist")
      .setDescription("إدراج عضو في القائمة السوداء")
      .addUserOption(targetOption)
      .addStringOption(option => reasonOption(option))
      .setDefaultMemberPermissions(0n)
      .toJSON(),

    new SlashCommandBuilder()
      .setName("unblacklist")
      .setDescription("فك القائمة السوداء عن عضو")
      .addUserOption(targetOption)
      .addStringOption(option => reasonOption(option))
      .setDefaultMemberPermissions(0n)
      .toJSON(),

    // The role comes from Discord's own picker, not a fixed choice list: a
    // choice list is frozen at registration and this one has to follow a guild
    // setting. `blockableRoleIds` is enforced when the command runs, which is
    // the only moment the current setting is known.
    new SlashCommandBuilder()
      .setName("block")
      .setDescription("منع عضو من الحصول على رتبة")
      .addUserOption(targetOption)
      .addRoleOption(option => option.setName("role").setDescription("الرتبة الممنوعة").setRequired(true))
      .addStringOption(option => reasonOption(option))
      .setDefaultMemberPermissions(0n)
      .toJSON(),

    new SlashCommandBuilder()
      .setName("unblock")
      .setDescription("فك المنع عن رتبة لعضو، واترك الرتبة فارغة لفك الكل")
      .addUserOption(targetOption)
      .addRoleOption(option =>
        option.setName("role").setDescription("الرتبة (اتركها فارغة لفك كل المنع)").setRequired(false)
      )
      .addStringOption(option => reasonOption(option))
      .setDefaultMemberPermissions(0n)
      .toJSON(),

    new SlashCommandBuilder()
      .setName("down")
      .setDescription("سحب الرتب الإدارية من عضو لمدة محددة")
      .addUserOption(targetOption)
      .addIntegerOption(option =>
        option
          .setName("minutes")
          .setDescription("المدة بالدقائق (اتركها فارغة لاستخدام المدة الافتراضية)")
          // Optional for the same reason `/timeout`'s is: a hard-required option
          // would make the guild's `defaultDuration` setting unreachable.
          .setRequired(false)
          .setMinValue(1)
          .setMaxValue(DOWN_MAX_MINUTES)
      )
      .addStringOption(option => reasonOption(option))
      .setDefaultMemberPermissions(0n)
      .toJSON(),

    new SlashCommandBuilder()
      .setName("undown")
      .setDescription("استعادة الرتب الإدارية المسحوبة")
      .addUserOption(targetOption)
      .addStringOption(option => reasonOption(option))
      .setDefaultMemberPermissions(0n)
      .toJSON(),

    new SlashCommandBuilder()
      .setName("remove")
      .setDescription("حذف عقوبة محددة من سجلات عضو حسب رقمها في قائمة عقوباته")
      .addUserOption(targetOption)
      .addIntegerOption(option =>
        option.setName("index").setDescription("رقم العقوبة في القائمة (1 = الأحدث)").setRequired(true).setMinValue(1)
      )
      .addStringOption(option => reasonOption(option))
      .setDefaultMemberPermissions(0n)
      .toJSON(),

    // Server-wide, so there is no member option at all. Asking for a target and
    // then ignoring it would be worse than not asking — and these two are the
    // only commands in the section with nobody to name.
    new SlashCommandBuilder()
      .setName("clearallwarns")
      .setDescription("مسح جميع التحذيرات في السيرفر")
      .addStringOption(option => reasonOption(option))
      .setDefaultMemberPermissions(0n)
      .toJSON(),

    new SlashCommandBuilder()
      .setName("clearallpunishments")
      .setDescription("تصفير سجل العقوبات في السيرفر")
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
  return [buildStatusCommand(), ...buildCoreCommands(), ...buildModerationCommands()];
}

/**
 * GOVERNANCE rule 1: the registry is the authority for what gets published.
 *
 * This is the single comparison, used by both the deploy script and its test.
 * They used to carry separate copies of this logic, each with its own
 * `al-status` exception left over from when `/al-status` was published without
 * being registered. Once the registry gained `/al-status` that exception turned
 * into a false mismatch — but only in the script: the test's copy filtered the
 * same name for the same stale reason, so it kept passing while deployment had
 * become impossible. A guard that re-implements the thing it guards inherits
 * that thing's blind spots; sharing the code is what makes it a guard.
 */
export function compareCommandRegistry(
  published: readonly unknown[] = buildAllCommands()
): { missing: string[]; extra: string[] } {
  const registered = commandRegistry.map(command => command.name);
  const names = published.map(command => (command as { name: string }).name);
  return {
    missing: registered.filter(name => !names.includes(name)),
    extra: names.filter(name => !registered.includes(name))
  };
}

/**
 * The alias commands to register in one guild.
 *
 * Discord has no alias mechanism at all: `/باند` exists only because a command
 * *named* `باند` was published. So each alias is registered as a real command
 * carrying its canonical command's options verbatim — `/باند @عضو سبب` has to
 * parse exactly as `/ban @عضو سبب` does, or the alias is a trap rather than a
 * shortcut.
 *
 * The map is expected to come from `buildAliasMap`, which has already refused
 * any alias that would shadow a published command or collide with another
 * alias. That guarantee is assumed here rather than re-derived: two sources of
 * truth for the same rule is how they drift apart.
 */
export function buildAliasCommands(
  aliasMap: ReadonlyMap<string, string>,
  canonical: readonly unknown[] = buildAllCommands()
): unknown[] {
  const byName = new Map(
    canonical.map(command => [(command as { name: string }).name, command as Record<string, unknown>])
  );
  const built: unknown[] = [];
  for (const [alias, target] of aliasMap) {
    const source = byName.get(target);
    // A map entry naming a command that is not published is dropped rather than
    // published as a broken shell with no options.
    if (!source) continue;
    built.push({ ...source, name: alias });
  }
  return built;
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

/** One of a guild's coloured roles, as `/colors` lists it. */
export type ColourRole = { id: string; name: string; color: number; position: number };

/**
 * The guild's coloured roles, highest first.
 *
 * Three exclusions, each for a reason rather than for tidiness: `@everyone` has
 * no colour of its own, a managed role belongs to an integration and cannot be
 * given to anybody by hand, and `color === 0` is Discord's "no colour" — listing
 * those would fill the reply with grey names and hide the ones that mean
 * something. Returns `null` when the guild or its role list cannot be read, so
 * the caller can tell "no colours configured" from "Discord did not answer".
 */
export async function readColourRoles(client: Client, guildId: string): Promise<ColourRole[] | null> {
  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return null;
  const roles = await guild.roles.fetch().catch(() => null);
  if (!roles) return null;
  return [...roles.values()]
    .filter(role => role.id !== guild.roles.everyone.id && !role.managed && role.color !== 0)
    .sort((a, b) => b.position - a.position)
    .map(role => ({ id: role.id, name: role.name, color: role.color, position: role.position }));
}

export type ModerationAction =
  | { kind: "ban"; guildId: string; targetId: string; reason: string; deleteMessageSeconds?: number }
  | { kind: "unban"; guildId: string; targetId: string; reason: string }
  | { kind: "kick"; guildId: string; targetId: string; reason: string }
  | { kind: "timeout"; guildId: string; targetId: string; minutes: number; reason: string; deleteMessageSeconds?: number }
  | { kind: "untimeout"; guildId: string; targetId: string; reason: string }
  /** `nickname: null` clears it. Discord takes `null` for "remove", not `""`. */
  | { kind: "setnick"; guildId: string; targetId: string; nickname: string | null; reason: string };

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
      case "untimeout": {
        const member = await guild.members.fetch(action.targetId);
        // `null` is Discord's own "no timeout"; `0` is not accepted and would be
        // silently clamped to a minimum, leaving the member silenced.
        await member.timeout(null, action.reason);
        return true;
      }
      case "setnick": {
        const member = await guild.members.fetch(action.targetId);
        await member.setNickname(action.nickname, action.reason);
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
 * Role actions
 *
 * Every state-based punishment in the penalties section comes down to adding or
 * removing roles: `/mute`, `/prison`, `/blacklist` and `/down` take something
 * away or put something on, and their inverses put it back. They are kept out of
 * `applyModeration` for the same reason the channel actions are kept out of it —
 * `applyModeration` asks Discord to apply an event that is over when it returns,
 * and these change what a member *is*. Keeping them apart means that difference
 * is visible in the types instead of buried in a branch.
 * ------------------------------------------------------------------ */

export type RoleAction = {
  kind: "grant" | "revoke";
  guildId: string;
  targetId: string;
  roleIds: readonly string[];
  reason: string;
};

export type RoleActionResult =
  | { ok: true; changed: string[]; failed: string[] }
  | { ok: false; reason: "GUILD_UNREACHABLE" | "MEMBER_NOT_FOUND" | "NO_ROLE_APPLIED" };

/**
 * Adds or removes roles on one member.
 *
 * One role per call rather than a single bulk call. Discord rejects the *whole*
 * request when one role sits above the bot in the hierarchy, so a bulk call
 * would let a single unreachable role cancel every other one — and would report
 * nothing about which. Applying them one at a time costs a few requests and
 * turns that into "these worked, these did not", which is the answer the
 * operator needs.
 *
 * `failed` is returned rather than swallowed. A caller that reports "تم الكتم"
 * while half the roles were refused is the failure this whole section exists to
 * avoid, so the list travels back and the reply names it.
 */
export async function applyRoleChange(client: Client, action: RoleAction): Promise<RoleActionResult> {
  const guild = await client.guilds.fetch(action.guildId).catch(() => null);
  if (!guild) return { ok: false, reason: "GUILD_UNREACHABLE" };

  const member = await guild.members.fetch(action.targetId).catch(() => null);
  if (!member) return { ok: false, reason: "MEMBER_NOT_FOUND" };

  // Fetched rather than read from cache: a role deleted a moment ago would
  // otherwise still look present here and every call would fail with an error
  // that blames the bot's permissions instead of the missing role.
  await guild.roles.fetch().catch(() => undefined);

  const changed: string[] = [];
  const failed: string[] = [];

  for (const roleId of action.roleIds) {
    if (!guild.roles.cache.has(roleId)) {
      failed.push(roleId);
      continue;
    }
    const applied =
      action.kind === "grant"
        ? await member.roles.add(roleId, action.reason).then(() => true).catch(() => false)
        : await member.roles.remove(roleId, action.reason).then(() => true).catch(() => false);
    if (applied) changed.push(roleId);
    else failed.push(roleId);
  }

  // Nothing applied is a refusal, not a success with an empty list — otherwise a
  // `/mute` that reached no role would report that it muted.
  if (action.roleIds.length > 0 && changed.length === 0) return { ok: false, reason: "NO_ROLE_APPLIED" };

  return { ok: true, changed, failed };
}

/**
 * The roles `/down` should take off a member.
 *
 * Two readings, decided by whether the operator curated a list. A non-empty
 * `configured` list is honoured as given. An empty one means "the roles that
 * carry a permission", which is the only useful reading of "strip the
 * administrative roles" on a server where nobody has written down which ones
 * those are — and a list that meant "strip nothing" would be a punishment that
 * punishes nobody, with nothing on screen to say so.
 *
 * Two roles are never in the answer even when named. `@everyone` cannot be
 * removed from anyone, and a `managed` role belongs to an integration — Discord
 * refuses to remove either, so including them would turn a working `/down` into
 * a refusal that blames the bot's permissions.
 */
export async function readStrippableRoleIds(
  client: Client,
  options: { guildId: string; targetId: string; configured: readonly string[] }
): Promise<string[]> {
  const guild = await client.guilds.fetch(options.guildId).catch(() => null);
  if (!guild) return [];

  const member = await guild.members.fetch(options.targetId).catch(() => null);
  if (!member) return [];

  await guild.roles.fetch().catch(() => undefined);

  const candidates =
    options.configured.length > 0
      ? [...options.configured]
      : [...member.roles.cache.values()]
          .filter(role => role.id !== guild.id && !role.managed && role.permissions.bitfield !== 0n)
          .map(role => role.id);

  return candidates.filter(roleId => {
    const role = guild.roles.cache.get(roleId);
    // `!== undefined` rather than `Boolean(role)`: a truthiness check does not
    // narrow the type, so the two reads after it would still be on a possibly
    // absent role.
    return role !== undefined && role.id !== guild.id && !role.managed;
  });
}

/**
 * Moves a member into a voice channel, if they are in one.
 *
 * Only voice. There is no "move" for a text channel — confinement there is a
 * role's channel overwrites, which is the prison role's job and not this
 * function's. Returning `false` when the member is not in voice is the honest
 * answer rather than a failure: `/prison` still jailed them.
 */
export async function moveMemberToChannel(
  client: Client,
  options: { guildId: string; targetId: string; channelId: string; reason: string }
) {
  const guild = await client.guilds.fetch(options.guildId).catch(() => null);
  if (!guild) return false;

  const member = await guild.members.fetch(options.targetId).catch(() => null);
  if (!member?.voice.channelId) return false;

  const channel = await guild.channels.fetch(options.channelId).catch(() => null);
  if (!channel?.isVoiceBased()) return false;

  return member.voice.setChannel(channel, options.reason).then(() => true).catch(() => false);
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
        // `bulkDelete(count, true)` is one call for every size: discord.js fetches
        // the range, drops anything older than Discord's 14-day bulk window, sends
        // a lone survivor through the message endpoint and the rest through the
        // bulk one — so the special case `count === 1` used to have was already
        // done for it. Its `.catch` is what misattributed failures: a refused
        // permission or a rate limit on that one path answered MESSAGES_TOO_OLD,
        // while the same error on a multi-message delete reached the outer handler
        // as ACTION_FAILED — the same failure, two reasons, one of them wrong.
        // An error now propagates as the generic failure it is; only an empty
        // result is the age window, which is what this reason exists to name.
        const removed = await channel
          .bulkDelete(Math.min(action.count, CLEAR_MAX_COUNT), true)
          .then(batch => batch.size);
        if (removed === 0) return { ok: false, reason: "MESSAGES_TOO_OLD" };
        return { ok: true, removed };
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
/**
 * The single deploy entry point, reached only from scripts/deploy-commands.ts.
 *
 * Global registration propagates for up to an hour and applies to every guild.
 * Guild registration is immediate and applies to exactly one guild, which is
 * what makes it the only workable route for aliases: an alias is a per-guild
 * preference, and a shortcut that appears an hour after it was saved reads as a
 * broken feature rather than a slow one.
 *
 * A guild deploy republishes the whole canonical set alongside the aliases.
 * Registering the aliases alone would be enough on paper, since global commands
 * still apply inside a guild — but then a guild would show nothing at all until
 * the global set finished propagating.
 */
export async function deploySlashCommands(
  token: string,
  clientId: string,
  options: { guildId?: string; aliases?: readonly unknown[] } = {}
) {
  const body = [...buildAllCommands(), ...(options.aliases ?? [])];
  const route = options.guildId
    ? Routes.applicationGuildCommands(clientId, options.guildId)
    : Routes.applicationCommands(clientId);
  await new REST({ version: "10" }).setToken(token).put(route, { body });
  return { scope: options.guildId ? ("guild" as const) : ("global" as const), count: body.length };
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
  | { type: "member.username-change"; guildId: string; memberId: string; before: string; after: string }
  | { type: "member.avatar-change"; guildId: string; memberId: string }
  | { type: "member.boost-add"; guildId: string; memberId: string }
  | { type: "member.boost-remove"; guildId: string; memberId: string }
  | { type: "member.suspicious-account"; guildId: string; memberId: string; reason: string }
  | { type: "member.role-add"; guildId: string; memberId: string; roleId: string }
  | { type: "member.role-remove"; guildId: string; memberId: string; roleId: string }
  | { type: "moderation.ban"; guildId: string; targetId: string; actorId: string; reason?: string }
  | { type: "moderation.unban"; guildId: string; targetId: string; actorId: string; reason?: string }
  | { type: "moderation.kick"; guildId: string; targetId: string; actorId: string; reason?: string }
  | { type: "moderation.timeout"; guildId: string; targetId: string; actorId: string; reason?: string }
  | { type: "moderation.untimeout"; guildId: string; targetId: string; actorId: string; reason?: string }
  | { type: "voice.join"; guildId: string; memberId: string; toChannelId: string }
  | { type: "voice.leave"; guildId: string; memberId: string; fromChannelId: string }
  // The gateway reports a channel change and nothing about who caused it, so a
  // moderator's drag and a member's own click look identical here. The handler
  // probes the audit log to tell them apart; a probe that finds nothing is read
  // as the member's own action, which is the common case and the one that needs
  // no actor attribution.
  | { type: "voice.move"; guildId: string; memberId: string; fromChannelId: string; toChannelId: string; actorId?: string }
  | { type: "voice.self-move"; guildId: string; memberId: string; fromChannelId: string; toChannelId: string }
  // Leaving a channel is the same problem one step on: MEMBER_DISCONNECT in the
  // audit log means a moderator ended the call for the member, its absence means
  // they left on their own.
  | { type: "voice.disconnect"; guildId: string; memberId: string; fromChannelId: string; actorId: string }
  | { type: "voice.server-mute"; guildId: string; memberId: string; channelId: string }
  | { type: "voice.server-unmute"; guildId: string; memberId: string; channelId: string }
  | { type: "voice.server-deafen"; guildId: string; memberId: string; channelId: string }
  | { type: "voice.server-undeafen"; guildId: string; memberId: string; channelId: string }
  | { type: "voice.self-mute"; guildId: string; memberId: string; channelId: string }
  | { type: "voice.self-unmute"; guildId: string; memberId: string; channelId: string }
  | { type: "voice.self-deafen"; guildId: string; memberId: string; channelId: string }
  | { type: "voice.self-undeafen"; guildId: string; memberId: string; channelId: string }
  // Going live and turning the camera on are reported on the voice state, so a
  // member streaming and a member in video raise these alongside the mute pair.
  | { type: "voice.stream-start"; guildId: string; memberId: string; channelId: string }
  | { type: "voice.stream-end"; guildId: string; memberId: string; channelId: string }
  | { type: "voice.camera-on"; guildId: string; memberId: string; channelId: string }
  | { type: "voice.camera-off"; guildId: string; memberId: string; channelId: string }
  | { type: "role.create"; guildId: string; roleId: string; actorId: string }
  | { type: "role.update"; guildId: string; roleId: string; actorId: string }
  | { type: "role.delete"; guildId: string; roleId: string; actorId: string }
  // A change to a role an integration owns: reported under التكاملات rather than
  // الرتب, so "a bot changed this" stays separable from "a person changed this".
  | { type: "role.managed-change"; guildId: string; roleId: string; actorId: string }
  | { type: "message.delete"; guildId: string; messageId: string; channelId: string; authorId?: string; content?: string; attachments?: string[] }
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
  // Discord gives no notice for a deleted file; the names come from the cache.
  | { type: "message.delete-attachment"; guildId: string; messageId: string; channelId: string; authorId?: string; attachments: string[] }
  | { type: "message.pin"; guildId: string; channelId: string; messageId: string }
  | { type: "message.unpin"; guildId: string; channelId: string; messageId: string }
  | { type: "message.reaction-add"; guildId: string; messageId: string; channelId: string; memberId: string; emoji: string }
  | { type: "message.reaction-remove"; guildId: string; messageId: string; channelId: string; memberId: string; emoji: string }
  | { type: "message.reaction-clear"; guildId: string; messageId: string; channelId: string }
  | { type: "server.channel-create"; guildId: string; channelId: string; actorId: string }
  | { type: "server.channel-update"; guildId: string; channelId: string; actorId: string }
  | { type: "server.channel-delete"; guildId: string; channelId: string; actorId: string }
  // The seven `GuildUpdate` transitions. `name` and the boost tier carry a
  // before and after because both are short values an operator reads as a
  // change rather than as a state; the rest are reported as the fact that they
  // moved, and `settings-change` names which keys moved so it is not a bare
  // "something was different".
  | { type: "server.name-change"; guildId: string; before: string; after: string }
  | { type: "server.icon-change"; guildId: string }
  | { type: "server.settings-change"; guildId: string; changes: string[] }
  | { type: "server.vanity-url-change"; guildId: string }
  // The tier is reported with its direction: a tier rising and a tier falling
  // are different news for an operator, though Discord reports one field.
  | { type: "server.boost-tier-up"; guildId: string; before: number; after: number }
  | { type: "server.boost-tier-down"; guildId: string; before: number; after: number }
  | { type: "server.banner-change"; guildId: string }
  | { type: "server.afk-change"; guildId: string }
  | { type: "server.system-channel-change"; guildId: string }
  // Reported alongside `server.channel-update` when the change touched the
  // permission overwrites. Discord reports both, and each answers a different
  // question for the operator.
  | { type: "channel.permission-update"; guildId: string; channelId: string; actorId: string }
  | { type: "thread.create"; guildId: string; threadId: string; channelId: string }
  | { type: "thread.update"; guildId: string; threadId: string }
  | { type: "thread.delete"; guildId: string; threadId: string }
  | { type: "server.invite-create"; guildId: string; inviteCode: string; actorId: string }
  | { type: "invite.delete"; guildId: string; inviteCode: string }
  | { type: "invite.use"; guildId: string; inviteCode: string; memberId: string }
  | { type: "server.expression-create"; guildId: string; expressionId: string; actorId: string }
  | { type: "server.expression-delete"; guildId: string; expressionId: string; actorId: string }
  | { type: "emoji.update"; guildId: string; expressionId: string }
  | { type: "sticker.create"; guildId: string; expressionId: string }
  | { type: "sticker.update"; guildId: string; expressionId: string }
  | { type: "sticker.delete"; guildId: string; expressionId: string }
  | { type: "scheduled-event.create"; guildId: string; eventId: string }
  | { type: "scheduled-event.delete"; guildId: string; eventId: string }
  | { type: "scheduled-event.update"; guildId: string; eventId: string }
  | { type: "scheduled-event.start"; guildId: string; eventId: string }
  | { type: "scheduled-event.complete"; guildId: string; eventId: string }
  | { type: "scheduled-event.user-add"; guildId: string; eventId: string; memberId: string }
  | { type: "scheduled-event.user-remove"; guildId: string; eventId: string; memberId: string }
  | { type: "bot.join"; guildId: string; memberId: string }
  | { type: "bot.leave"; guildId: string; memberId: string }
  | { type: "integration.update"; guildId: string; integrationId: string }
  | { type: "webhook.create"; guildId: string; webhookId: string; channelId: string }
  | { type: "webhook.update"; guildId: string; webhookId: string; channelId: string }
  | { type: "webhook.delete"; guildId: string; webhookId: string; channelId: string }
  | { type: "bot.role-create"; guildId: string; roleId: string }
  | { type: "bot.role-remove"; guildId: string; roleId: string }
  | { type: "automod.rule-create"; guildId: string; ruleId: string }
  | { type: "automod.rule-update"; guildId: string; ruleId: string }
  | { type: "automod.rule-delete"; guildId: string; ruleId: string }
  | { type: "automod.block-message"; guildId: string; memberId: string; channelId: string; ruleId: string }
  | { type: "automod.alert"; guildId: string; memberId: string; channelId: string; ruleId: string }
  | { type: "automod.timeout"; guildId: string; memberId: string; channelId: string; ruleId: string }
  | { type: "automod.member-block"; guildId: string; memberId: string; ruleId: string }
  | { type: "stage.create"; guildId: string; stageId: string; channelId: string }
  | { type: "stage.update"; guildId: string; stageId: string }
  | { type: "stage.delete"; guildId: string; stageId: string }
  | { type: "stage.speaker"; guildId: string; stageId: string; memberId: string }
  | { type: "stage.request-speak"; guildId: string; stageId: string; memberId: string }
  | { type: "stage.suppress"; guildId: string; stageId: string; memberId: string }
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

  /**
   * Strictly answers "did a moderator cause this, and who are they".
   *
   * `resolveAudit` falls back to the newest entry of that type when it cannot
   * match the target, which is right for attribution — a ban's entry is the only
   * candidate — and wrong for a yes/no question. Two members can be moved in the
   * same second, and the fallback would read the other member's entry as proof a
   * moderator moved this one. This probe takes no fallback: no strict match means
   * the member acted on their own.
   */
  async function resolveModerator(
    guild: Guild,
    type: AuditLogEvent.MemberMove | AuditLogEvent.MemberDisconnect,
    targetId: string
  ): Promise<{ actorId: string | null }> {
    try {
      const logs = await guild.fetchAuditLogs({ type, limit: 10 });
      const entry = logs.entries.find(item => item.targetId === targetId);
      return { actorId: entry?.executorId ?? null };
    } catch {
      // Missing VIEW_AUDIT_LOG: fall through to the self-action reading. That is
      // the common case, so a blind guild degrades towards the right answer.
      return { actorId: null };
    }
  }

  return { resolveActor, resolveAudit, resolveModerator };
}

export type BindOptions = {
  /**
   * Handles a moderation slash command. The orchestration (tier check,
   * hierarchy check, logging) lives outside this module; Discord-specific work
   * — reading options and replying — happens here.
   */
  onCommand?: (context: CommandContext) => Promise<void>;
  /**
   * Supplies the ready-made reasons for the focused option.
   *
   * Answers an autocomplete interaction, which Discord expects within three
   * seconds — so the handler must read from a cache, never from Discord.
   */
  onAutocomplete?: (context: {
    guildId: string;
    commandName: string;
    focusedOption: string;
    focusedValue: string;
  }) => Promise<{ name: string; value: string }[]>;
  /**
   * Short-lived cache that lets message.delete / message.edit recover the body.
   * Discord only sends content on messageCreate, so without this the log can
   * only say "a message was deleted".
   */
  messageCache?: {
    put(message: {
      id: string;
      guildId: string;
      channelId: string;
      authorId: string;
      content: string;
      attachments: string[];
      createdAt: number;
    }): void;
    get(channelId: string, messageId: string): { content: string; authorId: string; attachments: string[] } | undefined;
  };
  /**
   * Snapshot store for invite attribution. Discord names no invite on a join,
   * so the tracker holds one snapshot per guild and the member-join handler
   * diffs a fresh fetch against it to produce `invite.use`.
   *
   * Absent means joins are logged but never attributed — never a wrong code.
   */
  inviteTracker?: InviteTracker;
  /**
   * Snapshot store for the events Discord announces without detail. Absent means
   * `webhooksUpdate` and `guildIntegrationsUpdate` are reported as a bare change
   * if at all; the listeners consult the store, so absence degrades rather than
   * throwing.
   */
  derivedState?: DerivedStateStore;
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
   * `count`, `seconds`, `index`. Kept generic so adding a command does not mean
   * adding a field to this type, which is how `minutes` used to work.
   */
  numbers: Record<string, number>;
  /**
   * Every string option the command declared, keyed by its name — `nickname`,
   * `user_id`. Generic for the same reason `numbers` is: `/setnick` needed a
   * second string option, and a field per option would have made this type grow
   * with the registry.
   */
  strings: Record<string, string>;
  reason: string;
  /**
   * Answers the interaction.
   *
   * `autoDeleteSeconds` is the guild's tidiness setting: when set, the reply is
   * removed after that many seconds so a moderation channel does not fill up
   * with bot confirmations.
   */
  reply: (content: string, options?: { autoDeleteSeconds?: number }) => Promise<void>;
  /**
   * Withdraws this command's own reply once the member it acted on leaves.
   *
   * Only ever the bot's own message: a human's messages are not AL AI's to
   * delete, and a punishment log entry is an audit record rather than a reply.
   *
   * The reply is ephemeral, so Discord permits withdrawing it only while the
   * interaction token lives — fifteen minutes. A member who leaves later than
   * that has already lost the message along with the token, so the request is
   * dropped rather than queued: from outside, a withdrawal that cannot happen
   * and one that silently failed look identical, and pretending otherwise would
   * be the worse answer.
   */
  retractOnLeave: (targetMemberId: string) => void;
};

/**
 * The message a reaction landed on, fetched when Discord sent only a partial.
 *
 * A reaction event carries the emoji and the user but a message that is partial
 * outside a cached channel, and the log needs the channel and the message id
 * both. Falling back to `undefined` rather than a partial's empty string keeps a
 * reaction the bot cannot resolve out of the log instead of writing a row that
 * points at nothing.
 */
async function resolveReactionMessage(
  reaction: MessageReaction | PartialMessageReaction
): Promise<{ id: string; channelId: string; guildId: string } | null> {
  const raw = reaction.message;
  const message = raw.partial ? await raw.fetch().catch(() => null) : raw;
  if (!message || !message.guildId) return null;
  return { id: message.id, channelId: message.channelId, guildId: message.guildId };
}

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
  const { resolveActor, resolveAudit, resolveModerator } = createActorResolver();
  const cache = options.messageCache;
  // The derived-state store is created here when the caller did not supply one,
  // so the webhook and integration listeners can always read a snapshot. A caller
  // supplies its own only to test the diff at the boundary.
  const derived = options.derivedState ?? createDerivedState();
  const inviteTracker = options.inviteTracker;
  const emit = (event: BotEvent) => {
    try {
      sink(event);
    } catch (error) {
      console.error("AL AI event sink failed", error);
    }
  };

  /**
   * Bot replies waiting to be withdrawn when the member they acted on leaves.
   *
   * The window and the (guild, member) key live in `retraction.ts` rather than
   * here, so both can be tested at their boundary without waiting fifteen
   * minutes. This only supplies the withdrawal.
   */
  const retractions = createRetractionRegistry();

  client.once(Events.ClientReady, () => emit({ type: "client.ready", tag: client.user?.tag ?? "unknown", guildCount: client.guilds.cache.size }));
  client.on(Events.Error, error => emit({ type: "client.error", message: error.message }));
  // Emitted so the runtime can create the bot's own role before the operator is
  // offered any settings screen.
  client.on(Events.GuildCreate, guild => emit({ type: "guild.joined", guildId: guild.id, name: guild.name }));

  client.on(Events.GuildMemberAdd, member => {
    // A bot joining is a member event where the member is an application: it is
    // reported under التكاملات, next to the webhooks and integrations it brings,
    // rather than as an ordinary member arrival.
    if (member.user.bot) {
      emit({ type: "bot.join", guildId: member.guild.id, memberId: member.id });
      return;
    }
    emit({ type: "member.join", guildId: member.guild.id, memberId: member.id });
    // Which invite brought the member in is a diff, not a field: Discord names
    // no invite on the join, so the guild's invites are fetched once here and
    // compared against the snapshot the tracker holds — the one whose use count
    // rose is the one used. Without MANAGE_GUILD the fetch fails and the join is
    // still logged, only unattributed; without a first snapshot there is nothing
    // to diff, so the fetch is stored as the baseline and the next join carries
    // the attribution.
    if (inviteTracker) {
      void member.guild.invites
        .fetch()
        .then(fetched =>
          inviteTracker.observe(
            member.guild.id,
            fetched.map(invite => ({ code: invite.code, inviterId: invite.inviterId ?? null, uses: invite.uses ?? 0 }))
          )
        )
        .then(code => {
          if (code) emit({ type: "invite.use", guildId: member.guild.id, inviteCode: code, memberId: member.id });
        })
        .catch(() => undefined);
    }
    // A brand-new account is worth an operator's attention, reported as its own
    // line rather than folded into the join: the join happened either way, and
    // "this account is new" is a separate thing an operator acts on.
    if (isSuspiciousAccount(member.user.createdTimestamp, Date.now())) {
      emit({
        type: "member.suspicious-account",
        guildId: member.guild.id,
        memberId: member.id,
        reason: describeSuspiciousAccount(member.user.createdTimestamp, Date.now())
      });
    }
  });
  client.on(Events.GuildMemberRemove, member => {
    if (member.user.bot) {
      emit({ type: "bot.leave", guildId: member.guild.id, memberId: member.id });
    } else {
      emit({ type: "member.leave", guildId: member.guild.id, memberId: member.id });
    }
    // Withdraw any reply that was waiting on this member's departure. Not
    // awaited on purpose: the withdrawal is cosmetic and the leave event is
    // what the rest of the pipeline acts on, so it must not be delayed by it.
    void retractions.retract(member.guild.id, member.id);
  });
  // One handler for the whole member update: nickname, roles, boosts and timeouts
  // all arrive on this event, and splitting them made each update dispatch twice.
  // The audit log is consulted only for the timeout half, because that is the
  // half a moderator performed — the rest is reported as it happened.
  client.on(Events.GuildMemberUpdate, (before, after) => {
    if (before.nickname !== after.nickname) {
      emit({ type: "member.nickname-change", guildId: after.guild.id, memberId: after.id, before: before.nickname ?? "", after: after.nickname ?? "" });
    }
    for (const roleId of after.roles.cache.keys()) {
      if (!before.roles.cache.has(roleId)) emit({ type: "member.role-add", guildId: after.guild.id, memberId: after.id, roleId });
    }
    for (const roleId of before.roles.cache.keys()) {
      if (!after.roles.cache.has(roleId)) emit({ type: "member.role-remove", guildId: after.guild.id, memberId: after.id, roleId });
    }

    // Boosting is a per-member subscription window, so a member starting or
    // stopping is a change to this member rather than to the server's settings —
    // the tier itself is reported separately, split by direction as
    // `server.boost-tier-up` / `server.boost-tier-down`.
    const wasBoosting = Boolean(before.premiumSinceTimestamp);
    const isBoosting = Boolean(after.premiumSinceTimestamp);
    if (!wasBoosting && isBoosting) emit({ type: "member.boost-add", guildId: after.guild.id, memberId: after.id });
    else if (wasBoosting && !isBoosting) emit({ type: "member.boost-remove", guildId: after.guild.id, memberId: after.id });

    const wasTimedOut = Boolean(before.communicationDisabledUntilTimestamp);
    const isTimedOut = Boolean(after.communicationDisabledUntilTimestamp);
    if (!wasTimedOut && isTimedOut) {
      void resolveAudit(after.guild, AuditLogEvent.MemberUpdate, after.id).then(({ actorId, reason }) =>
        emit({ type: "moderation.timeout", guildId: after.guild.id, targetId: after.id, actorId, ...(reason ? { reason } : {}) })
      );
    } else if (wasTimedOut && !isTimedOut) {
      // A timeout expiring on its own also lands here, and it is reported too. That
      // is the honest reading: the operator's log answers "when did this member
      // stop being silenced", and the answer is the same whether Discord's clock
      // ran out or a moderator lifted it — the actor line says which.
      void resolveAudit(after.guild, AuditLogEvent.MemberUpdate, after.id).then(({ actorId, reason }) =>
        emit({ type: "moderation.untimeout", guildId: after.guild.id, targetId: after.id, actorId, ...(reason ? { reason } : {}) })
      );
    }
  });

  // A username or avatar change is global, not per-guild: one user arrives here
  // and the change is reported once per guild the bot can see them in. Only the
  // guilds whose member cache holds this user get an entry — a guild that never
  // cached the member did not observe the change, and guessing its membership
  // would mean a REST call per guild per edit.
  client.on(Events.UserUpdate, (before, after) => {
    if (before.username !== after.username) {
      for (const guild of client.guilds.cache.values()) {
        if (!guild.members.cache.has(after.id)) continue;
        emit({ type: "member.username-change", guildId: guild.id, memberId: after.id, before: before.username ?? "", after: after.username ?? "" });
      }
    }
    if (before.avatar !== after.avatar) {
      for (const guild of client.guilds.cache.values()) {
        if (!guild.members.cache.has(after.id)) continue;
        emit({ type: "member.avatar-change", guildId: guild.id, memberId: after.id });
      }
    }
  });

  // Moderation is reported once, from Discord's audit log — never twice.
  // The audit log is the only source that also sees actions taken outside AL AI
  // (an admin banning from the Discord client), and it carries the reason the
  // moderator typed, so the command handler deliberately does not log these.
  client.on(Events.GuildBanAdd, async ban => {
    const { actorId, reason } = await resolveAudit(ban.guild, AuditLogEvent.MemberBanAdd, ban.user.id);
    emit({ type: "moderation.ban", guildId: ban.guild.id, targetId: ban.user.id, actorId, ...(reason ? { reason } : {}) });
  });

  client.on(Events.GuildBanRemove, async ban => {
    const { actorId, reason } = await resolveAudit(ban.guild, AuditLogEvent.MemberBanRemove, ban.user.id);
    emit({ type: "moderation.unban", guildId: ban.guild.id, targetId: ban.user.id, actorId, ...(reason ? { reason } : {}) });
  });

  client.on(Events.GuildMemberRemove, async member => {
    const { actorId, reason } = await resolveAudit(member.guild, AuditLogEvent.MemberKick, member.id);
    if (actorId !== "unknown") {
      emit({ type: "moderation.kick", guildId: member.guild.id, targetId: member.id, actorId, ...(reason ? { reason } : {}) });
    }
  });

  client.on(Events.VoiceStateUpdate, async (before, after) => {
    const memberId = after.id || before.id;
    const guild = after.guild ?? before.guild;
    const guildId = guild.id;
    if (before.channelId !== after.channelId) {
      if (!before.channelId && after.channelId) {
        emit({ type: "voice.join", guildId, memberId, toChannelId: after.channelId });
      } else if (before.channelId && !after.channelId) {
        // A moderator ending the call for a member and the member leaving on
        // their own both arrive as this one transition. Only the audit log
        // separates them, and only when it is readable; unreadable is read as
        // the member's own departure, which needs no actor attribution.
        const { actorId } = await resolveModerator(guild, AuditLogEvent.MemberDisconnect, memberId);
        if (actorId) {
          emit({ type: "voice.disconnect", guildId, memberId, fromChannelId: before.channelId, actorId });
        } else {
          emit({ type: "voice.leave", guildId, memberId, fromChannelId: before.channelId });
        }
      } else if (before.channelId && after.channelId) {
        const { actorId } = await resolveModerator(guild, AuditLogEvent.MemberMove, memberId);
        if (actorId) {
          emit({ type: "voice.move", guildId, memberId, fromChannelId: before.channelId, toChannelId: after.channelId, actorId });
        } else {
          emit({ type: "voice.self-move", guildId, memberId, fromChannelId: before.channelId, toChannelId: after.channelId });
        }
      }
      return;
    }

    // Same channel, something else changed. Discord reports server-side and
    // self-side toggles as separate fields, and each true transition is its own
    // event: a moderator's server mute and a member's own mute need different
    // follow-up, so they must not share a log line.
    //
    // Only the changed half fires, and it fires only when it actually changed —
    // a member joining a channel already server-muted raised `voice.join` above
    // and returns before reaching here.
    const channelId = after.channelId ?? "";
    if (before.serverMute !== after.serverMute) {
      emit({ type: after.serverMute ? "voice.server-mute" : "voice.server-unmute", guildId, memberId, channelId });
    }
    if (before.serverDeaf !== after.serverDeaf) {
      emit({ type: after.serverDeaf ? "voice.server-deafen" : "voice.server-undeafen", guildId, memberId, channelId });
    }
    if (before.selfMute !== after.selfMute) {
      emit({ type: after.selfMute ? "voice.self-mute" : "voice.self-unmute", guildId, memberId, channelId });
    }
    if (before.selfDeaf !== after.selfDeaf) {
      emit({ type: after.selfDeaf ? "voice.self-deafen" : "voice.self-undeafen", guildId, memberId, channelId });
    }

    // Going live and opening the camera. Both are member actions reported on the
    // voice state, and each is its own entry: a stream starting is not a camera
    // coming on, and an operator watching for one is not watching for the other.
    // `streaming` is the member's own go-live flag — a stage broadcast by the
    // server is a different field and a different event.
    if (before.streaming !== after.streaming) {
      emit({ type: after.streaming ? "voice.stream-start" : "voice.stream-end", guildId, memberId, channelId });
    }
    if (before.selfVideo !== after.selfVideo) {
      emit({ type: after.selfVideo ? "voice.camera-on" : "voice.camera-off", guildId, memberId, channelId });
    }

    // Stage speaker transitions. Discord reports these on the voice state rather
    // than on the stage instance: `suppressed` flips when a member is moved
    // between the audience and the speakers, and `requestToSpeakTimestamp` when
    // they raise a hand. Reporting them here keeps each change in one event;
    // reporting them under `platform-log` keeps them out of the voice room.
    if (after.channelId) {
      const channel = after.guild.channels.cache.get(after.channelId);
      if (channel?.type === ChannelType.GuildStageVoice) {
        if (before.suppress && !after.suppress) {
          emit({ type: "stage.speaker", guildId, stageId: after.channelId, memberId });
        } else if (!before.suppress && after.suppress) {
          emit({ type: "stage.suppress", guildId, stageId: after.channelId, memberId });
        }
        if (!before.requestToSpeakTimestamp && after.requestToSpeakTimestamp) {
          emit({ type: "stage.request-speak", guildId, stageId: after.channelId, memberId });
        }
      }
    }
  });

  // A role owned by an integration or bot is reported under التكاملات: its
  // arrival and departure are part of what that integration did, and an operator
  // reading الرتب wants the roles *people* manage. A change to one is still
  // `role.managed-change` under الرتب, because "this role's permissions moved"
  // is a question about the role rather than about the integration.
  client.on(Events.GuildRoleCreate, async role => {
    if (!role.guild) return;
    if (role.managed) {
      emit({ type: "bot.role-create", guildId: role.guild.id, roleId: role.id });
    } else {
      emit({ type: "role.create", guildId: role.guild.id, roleId: role.id, actorId: await resolveActor(role.guild, AuditLogEvent.RoleCreate, role.id) });
    }
  });
  client.on(Events.GuildRoleUpdate, async (_before, role) =>
    emit({
      type: role.managed ? "role.managed-change" : "role.update",
      guildId: role.guild.id,
      roleId: role.id,
      actorId: await resolveActor(role.guild, AuditLogEvent.RoleUpdate, role.id)
    })
  );
  client.on(Events.GuildRoleDelete, async role => {
    if (!role.guild) return;
    if (role.managed) {
      emit({ type: "bot.role-remove", guildId: role.guild.id, roleId: role.id });
    } else {
      emit({ type: "role.delete", guildId: role.guild.id, roleId: role.id, actorId: await resolveActor(role.guild, AuditLogEvent.RoleDelete, role.id) });
    }
  });

  client.on(Events.MessageCreate, message => {
    if (!cache || !message.guildId || message.author.bot) return;
    cache.put({
      id: message.id,
      guildId: message.guildId,
      channelId: message.channelId,
      authorId: message.author.id,
      content: message.content ?? "",
      // Filenames only: a URL is dead by the time anyone reads a delete entry,
      // and the name is what identifies the file that was lost.
      attachments: [...message.attachments.values()].map(attachment => attachment.name),
      createdAt: message.createdTimestamp || Date.now()
    });
  });

  client.on(Events.MessageDelete, message => {
    if (!message.guildId) return;
    const cached = cache?.get(message.channelId, message.id);
    emit({
      type: "message.delete",
      guildId: message.guildId,
      messageId: message.id,
      channelId: message.channelId,
      ...(cached ? { authorId: cached.authorId, content: cached.content } : {})
    });
    // Discord never announces a deleted file. The names were held in the cache
    // while the message lived, so a message that carried any gets its own entry
    // here — otherwise an attachment would vanish from the log as though it was
    // never there.
    if (cached && cached.attachments.length) {
      emit({
        type: "message.delete-attachment",
        guildId: message.guildId,
        messageId: message.id,
        channelId: message.channelId,
        authorId: cached.authorId,
        attachments: cached.attachments
      });
    }
  });
  client.on(Events.MessageUpdate, (before, after) => {
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
  client.on(Events.MessageBulkDelete, (messages, channel) => {
    if (!channel.guildId) return;
    emit({ type: "message.bulk-delete", guildId: channel.guildId, channelId: channel.id, count: messages.size });
  });

  // `channelPinsUpdate` says "the pinned set changed" and not which way, so the
  // current set is fetched and diffed against the last one. One REST call per
  // pins update — pinning is rare, so this is the cheap path, and it is the only
  // way to keep "pinned" and "unpinned" honest rather than guessing from a count.
  const pinnedByChannel = new Map<string, Set<string>>();
  client.on(Events.ChannelPinsUpdate, async channel => {
    if (!("guildId" in channel) || !channel.guildId) return;
    const key = `${channel.guildId}:${channel.id}`;
    const textChannel = channel;
    let pinned: Set<string>;
    try {
      const messages = await textChannel.messages.fetchPinned();
      pinned = new Set(messages.keys());
    } catch {
      // Missing READ_MESSAGE_HISTORY is not fatal: nothing is reported, and the
      // snapshot is left alone rather than cleared.
      return;
    }
    const previous = pinnedByChannel.get(key);
    pinnedByChannel.set(key, pinned);
    if (!previous) return;
    for (const messageId of pinned) {
      if (!previous.has(messageId)) emit({ type: "message.pin", guildId: channel.guildId, channelId: channel.id, messageId });
    }
    for (const messageId of previous) {
      if (!pinned.has(messageId)) emit({ type: "message.unpin", guildId: channel.guildId, channelId: channel.id, messageId });
    }
  });

  // Reactions are the highest-volume surface the bot subscribes to, so these
  // travel the pipeline's throttle and can be muted per section. `reactionRemoveAll`
  // carries no emoji for the same reason it carries no user: the whole set went,
  // and inventing either would be a fabricated field.
  client.on(Events.MessageReactionAdd, async (reaction, user) => {
    const message = await resolveReactionMessage(reaction);
    if (!message) return;
    emit({
      type: "message.reaction-add",
      guildId: message.guildId,
      messageId: message.id,
      channelId: message.channelId,
      memberId: user.id,
      emoji: reaction.emoji.name ?? "?"
    });
  });
  client.on(Events.MessageReactionRemove, async (reaction, user) => {
    const message = await resolveReactionMessage(reaction);
    if (!message) return;
    emit({
      type: "message.reaction-remove",
      guildId: message.guildId,
      messageId: message.id,
      channelId: message.channelId,
      memberId: user.id,
      emoji: reaction.emoji.name ?? "?"
    });
  });
  client.on(Events.MessageReactionRemoveAll, async message => {
    if (!message.guildId) return;
    emit({ type: "message.reaction-clear", guildId: message.guildId, messageId: message.id, channelId: message.channelId });
  });

  client.on(Events.ChannelCreate, async channel => {
    if (!("guild" in channel) || !channel.guild) return;
    emit({ type: "server.channel-create", guildId: channel.guild.id, channelId: channel.id, actorId: await resolveActor(channel.guild, AuditLogEvent.ChannelCreate, channel.id) });
  });
  client.on(Events.ChannelUpdate, async (before, channel) => {
    if (!("guild" in channel) || !channel.guild) return;
    emit({ type: "server.channel-update", guildId: channel.guild.id, channelId: channel.id, actorId: await resolveActor(channel.guild, AuditLogEvent.ChannelUpdate, channel.id) });
    // "A channel was edited" and "who may see it changed" are different
    // questions, so a change to the permission overwrites is reported alongside
    // rather than inside the update above. Discord sends one event for both, and
    // this is the half an operator reads separately.
    if ("permissionOverwrites" in before && "permissionOverwrites" in channel) {
      const beforeIds = [...before.permissionOverwrites.cache.keys()].sort().join(",");
      const afterIds = [...channel.permissionOverwrites.cache.keys()].sort().join(",");
      if (beforeIds !== afterIds) {
        emit({
          type: "channel.permission-update",
          guildId: channel.guild.id,
          channelId: channel.id,
          actorId: await resolveActor(channel.guild, AuditLogEvent.ChannelOverwriteCreate, channel.id)
        });
      }
    }
  });
  client.on(Events.ChannelDelete, async channel => {
    if (!("guild" in channel) || !channel.guild) return;
    emit({ type: "server.channel-delete", guildId: channel.guild.id, channelId: channel.id, actorId: await resolveActor(channel.guild, AuditLogEvent.ChannelDelete, channel.id) });
  });

  // Threads are channels, but an operator reads them apart from the channel list:
  // a thread appearing is a conversation starting, not a room being built. All
  // three carry the thread alone, because Discord does not name a creator on
  // `threadCreate` and the audit log's thread entries only appear for a slow-mode
  // forum — guessing an actor would put a fabricated id in the log.
  client.on(Events.ThreadCreate, thread =>
    emit({ type: "thread.create", guildId: thread.guildId, threadId: thread.id, channelId: thread.parentId ?? thread.id })
  );
  client.on(Events.ThreadUpdate, thread => emit({ type: "thread.update", guildId: thread.guildId, threadId: thread.id }));
  client.on(Events.ThreadDelete, thread => emit({ type: "thread.delete", guildId: thread.guildId, threadId: thread.id }));

  // The seven whole-guild transitions. `GuildUpdate` arrives with the guild in
  // both states, so each is a comparison rather than a fetch — and each is its
  // own event because an operator reads "the server was renamed" and "the AFK
  // room moved" as different things, even though Discord reports them together.
  client.on(Events.GuildUpdate, (before, after) => {
    if (before.name !== after.name) {
      emit({ type: "server.name-change", guildId: after.id, before: before.name, after: after.name });
    }
    if (before.icon !== after.icon) emit({ type: "server.icon-change", guildId: after.id });
    if (before.banner !== after.banner) emit({ type: "server.banner-change", guildId: after.id });
    if (before.vanityURLCode !== after.vanityURLCode) emit({ type: "server.vanity-url-change", guildId: after.id });
    if (before.premiumTier !== after.premiumTier) {
      // Direction is the news: the two tiers-moving events exist so the operator
      // can celebrate one and investigate the other without reading numbers.
      const tier = { guildId: after.id, before: before.premiumTier, after: after.premiumTier };
      emit(after.premiumTier > before.premiumTier ? { type: "server.boost-tier-up", ...tier } : { type: "server.boost-tier-down", ...tier });
    }
    if (before.afkChannelId !== after.afkChannelId) emit({ type: "server.afk-change", guildId: after.id });
    if (before.systemChannelId !== after.systemChannelId) emit({ type: "server.system-channel-change", guildId: after.id });

    // Everything else Discord groups under one event: verification level, the
    // content filter, the rules and updates channels, features, the AFK timeout.
    // Named individually so the entry says what actually moved rather than
    // reporting a bare "something was different".
    const changes: string[] = [];
    if (before.verificationLevel !== after.verificationLevel) changes.push("verificationLevel");
    if (before.explicitContentFilter !== after.explicitContentFilter) changes.push("explicitContentFilter");
    if (before.afkTimeout !== after.afkTimeout) changes.push("afkTimeout");
    if (before.rulesChannelId !== after.rulesChannelId) changes.push("rulesChannel");
    if (before.publicUpdatesChannelId !== after.publicUpdatesChannelId) changes.push("publicUpdatesChannel");
    if (before.description !== after.description) changes.push("description");
    const featuresChanged =
      before.features.length !== after.features.length || before.features.some(feature => !after.features.includes(feature));
    if (featuresChanged) changes.push("features");
    if (changes.length) emit({ type: "server.settings-change", guildId: after.id, changes });
  });

  client.on(Events.InviteCreate, async invite => {
    if (!invite.guild) return;
    emit({ type: "server.invite-create", guildId: invite.guild.id, inviteCode: invite.code, actorId: await resolveActor(invite.guild as Guild, AuditLogEvent.InviteCreate, invite.code) });
    // Tracked so the join it brings can be attributed. The snapshot the tracker
    // holds is what the member-join diff reads — see the GuildMemberAdd handler.
    inviteTracker?.remember(invite.guild.id, {
      code: invite.code,
      inviterId: invite.inviterId ?? null,
      uses: invite.uses ?? 0
    });
  });
  client.on(Events.InviteDelete, async invite => {
    if (!invite.guild) return;
    inviteTracker?.forget(invite.guild.id, invite.code);
    emit({ type: "invite.delete", guildId: invite.guild.id, inviteCode: invite.code });
  });

  // The constants, not string literals. discord.js ignores a listener whose name
  // it does not recognise — no throw, no warning — so `client.on("guildEmojiCreate")`
  // registered a handler that could never run, and the emoji log the operator can
  // switch on in the dashboard was unreachable. `Events` makes a rename a build
  // error instead of a silent no-op.
  client.on(Events.GuildEmojiCreate, async emoji => {
    if (!emoji.guild) return;
    emit({ type: "server.expression-create", guildId: emoji.guild.id, expressionId: emoji.id, actorId: await resolveActor(emoji.guild, AuditLogEvent.EmojiCreate, emoji.id) });
  });
  client.on(Events.GuildEmojiDelete, async emoji => {
    if (!emoji.guild) return;
    emit({ type: "server.expression-delete", guildId: emoji.guild.id, expressionId: emoji.id, actorId: await resolveActor(emoji.guild, AuditLogEvent.EmojiDelete, emoji.id) });
  });
  // `emojiUpdate` hands back the emoji's two states, so a rename is a diff
  // rather than a fetch. A partial `before` carries no name to compare against,
  // so it is reported as an update rather than guessed at.
  client.on(Events.GuildEmojiUpdate, (before, after) => {
    if (!after.guild) return;
    if (before.name === after.name) return;
    emit({ type: "emoji.update", guildId: after.guild.id, expressionId: after.id });
  });
  client.on(Events.GuildStickerCreate, sticker => {
    if (!sticker.guild) return;
    emit({ type: "sticker.create", guildId: sticker.guild.id, expressionId: sticker.id });
  });
  client.on(Events.GuildStickerUpdate, (_before, sticker) => {
    if (!sticker.guild) return;
    emit({ type: "sticker.update", guildId: sticker.guild.id, expressionId: sticker.id });
  });
  client.on(Events.GuildStickerDelete, sticker => {
    if (!sticker.guild) return;
    emit({ type: "sticker.delete", guildId: sticker.guild.id, expressionId: sticker.id });
  });

  // Scheduled events. `guildScheduledEventUpdate` carries the status transition
  // in its two halves: Scheduled→Active is the event starting, and either state
  // reaching Completed or Canceled is it ending.
  client.on(Events.GuildScheduledEventCreate, event => emit({ type: "scheduled-event.create", guildId: event.guildId, eventId: event.id }));
  client.on(Events.GuildScheduledEventDelete, event => emit({ type: "scheduled-event.delete", guildId: event.guildId, eventId: event.id }));
  client.on(Events.GuildScheduledEventUpdate, (before, after) => {
    // A null `before` means the event was created, which its own event already
    // reported — reporting it here too would write the entry twice.
    if (!before) {
      emit({ type: "scheduled-event.update", guildId: after.guildId, eventId: after.id });
      return;
    }
    if (before.status === after.status) {
      emit({ type: "scheduled-event.update", guildId: after.guildId, eventId: after.id });
      return;
    }
    // The operator reads "the event started" and "the event ended", not Discord's
    // state names, so the transition is turned into those two.
    if (after.status === GuildScheduledEventStatus.Active) {
      emit({ type: "scheduled-event.start", guildId: after.guildId, eventId: after.id });
    } else if (after.status === GuildScheduledEventStatus.Completed || after.status === GuildScheduledEventStatus.Canceled) {
      emit({ type: "scheduled-event.complete", guildId: after.guildId, eventId: after.id });
    } else {
      emit({ type: "scheduled-event.update", guildId: after.guildId, eventId: after.id });
    }
  });
  client.on(Events.GuildScheduledEventUserAdd, (event, user) =>
    emit({ type: "scheduled-event.user-add", guildId: event.guildId, eventId: event.id, memberId: user.id })
  );
  client.on(Events.GuildScheduledEventUserRemove, (event, user) =>
    emit({ type: "scheduled-event.user-remove", guildId: event.guildId, eventId: event.id, memberId: user.id })
  );

  // `webhooksUpdate` and `guildIntegrationsUpdate` say only that something in the
  // guild changed, so both are answered the same way: fetch the truth, diff it
  // against the last fetch, report the difference. See `derived-state.ts` for why
  // the snapshot starts empty rather than being seeded at boot.
  client.on(Events.WebhooksUpdate, async webhook => {
    const guild = webhook.guild;
    let current: { id: string; channelId: string | null }[];
    try {
      const fetched = await guild.fetchWebhooks();
      current = [...fetched.values()].map(item => ({ id: item.id, channelId: item.channelId }));
    } catch {
      // Missing MANAGE_WEBHOOKS means the bot cannot see them at all: reporting
      // nothing is the only honest option, and the snapshot is left untouched.
      return;
    }
    const previous = derived.webhooks.get(guild.id);
    derived.webhooks.set(guild.id, new Map(current.map(item => [item.id, item])));
    const diff = classifyWebhooks(current, previous);
    for (const created of diff.created) emit({ type: "webhook.create", guildId: guild.id, webhookId: created.id, channelId: created.channelId ?? "" });
    for (const updated of diff.updated) emit({ type: "webhook.update", guildId: guild.id, webhookId: updated.id, channelId: updated.channelId ?? "" });
    for (const removed of diff.deleted) emit({ type: "webhook.delete", guildId: guild.id, webhookId: removed.id, channelId: removed.channelId ?? "" });
  });
  client.on(Events.GuildIntegrationsUpdate, async guild => {
    let current: Integration[];
    try {
      current = [...(await guild.fetchIntegrations()).values()];
    } catch {
      return;
    }
    const mapped = current.map(item => ({ id: item.id, name: item.name }));
    const previous = derived.integrations.get(guild.id);
    derived.integrations.set(guild.id, new Map(mapped.map(item => [item.id, item])));
    const diff = classifyIntegrations(mapped, previous);
    // An integration arriving or leaving is the bot's own join or leave, which
    // `GuildMemberAdd`/`GuildMemberRemove` already report — so only the *change*
    // is reported here, to avoid two entries for one addition.
    for (const changed of [...diff.added, ...diff.changed, ...diff.removed]) {
      emit({ type: "integration.update", guildId: guild.id, integrationId: changed.id });
    }
  });

  // Auto-moderation. The three rule events carry the rule itself; the execution
  // event carries which of Discord's four actions the rule took, and is mapped to
  // the event an operator reads as that action.
  client.on(Events.AutoModerationRuleCreate, rule => {
    if (!rule?.guild) return;
    emit({ type: "automod.rule-create", guildId: rule.guild.id, ruleId: rule.id });
  });
  client.on(Events.AutoModerationRuleUpdate, rule => {
    if (!rule?.guild) return;
    emit({ type: "automod.rule-update", guildId: rule.guild.id, ruleId: rule.id });
  });
  client.on(Events.AutoModerationRuleDelete, rule => {
    if (!rule?.guild) return;
    emit({ type: "automod.rule-delete", guildId: rule.guild.id, ruleId: rule.id });
  });
  client.on(Events.AutoModerationActionExecution, execution => {
    const base = {
      guildId: execution.guild.id,
      memberId: execution.userId,
      channelId: execution.channelId ?? "",
      ruleId: execution.ruleId
    };
    switch (execution.action.type) {
      case AutoModerationActionType.BlockMessage:
        emit({ type: "automod.block-message", ...base });
        break;
      case AutoModerationActionType.SendAlertMessage:
        emit({ type: "automod.alert", ...base });
        break;
      case AutoModerationActionType.Timeout:
        emit({ type: "automod.timeout", ...base });
        break;
      // Discord suppresses the member across the server for this one, so it
      // carries no channel — the schema agrees and the field is absent.
      case AutoModerationActionType.BlockMemberInteraction:
        emit({ type: "automod.member-block", guildId: base.guildId, memberId: base.memberId, ruleId: base.ruleId });
        break;
    }
  });

  // Stage channels. A stage instance is the room itself: created when the stage
  // opens and deleted when it closes. Speaker transitions arrive on the voice
  // state instead — see `VoiceStateUpdate` above.
  client.on(Events.StageInstanceCreate, stage =>
    emit({ type: "stage.create", guildId: stage.guildId, stageId: stage.id, channelId: stage.channelId })
  );
  client.on(Events.StageInstanceUpdate, (before, after) => {
    // A null `before` means the instance was created, which `stageInstanceCreate`
    // already reports — reporting it here too would write the entry twice.
    if (!before) return;
    if (before.topic === after.topic && before.privacyLevel === after.privacyLevel) return;
    emit({ type: "stage.update", guildId: after.guildId, stageId: after.id });
  });
  client.on(Events.StageInstanceDelete, stage =>
    emit({ type: "stage.delete", guildId: stage.guildId, stageId: stage.id })
  );

  client.on(Events.InteractionCreate, async interaction => {
    if (!interaction.guildId) return;

    // Autocomplete arrives as its own interaction type, and Discord wants an
    // answer within three seconds — so this is served from the caller's cached
    // configuration and never reaches Discord.
    if (interaction.isAutocomplete()) {
      const focused = interaction.options.getFocused(true);
      const choices = options.onAutocomplete
        ? await options
            .onAutocomplete({
              guildId: interaction.guildId,
              commandName: interaction.commandName,
              focusedOption: focused.name,
              focusedValue: String(focused.value ?? "")
            })
            .catch(() => [])
        : [];
      // Discord accepts at most 25 choices, and truncates silently beyond that.
      await interaction.respond(choices.slice(0, 25)).catch(() => undefined);
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    const guildId = interaction.guildId;
    const userId = interaction.user.id;
    const roleIds = roleIdsOf(interaction.member);
    const flags = memberFlagsOf(interaction);

    if (!options.onCommand) return;

    // `/al-status` used to be answered right here, before the configuration
    // pipeline ran — which meant its switch, cooldown, scopes and preset reasons
    // could not apply to it, and the dashboard could not honestly offer them.
    // It is an ordinary command now and takes the same path as every other one;
    // only the pipeline counter still needs its event.
    if (interaction.commandName === "al-status") {
      emit({ type: "interaction.status", guildId, userId, interactionId: interaction.id, roleIds });
    }

    const target = interaction.options.getUser("user");
    // Read every option the interaction carries, whatever it is called, so the
    // handler can support a new command without a new field here.
    const numbers: Record<string, number> = {};
    const strings: Record<string, string> = {};
    for (const option of interaction.options.data) {
      if (option.type === ApplicationCommandOptionType.Integer && typeof option.value === "number") {
        numbers[option.name] = option.value;
      }
      if (option.type === ApplicationCommandOptionType.String && typeof option.value === "string") {
        strings[option.name] = option.value;
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
      targetId: target?.id ?? normaliseSnowflake(interaction.options.getString("user_id")) ?? null,
      numbers,
      strings,
      reason: interaction.options.getString("reason") ?? "",
      reply: async (content, replyOptions) => {
        // Ephemeral: a moderation reply is for the operator, not the channel.
        await interaction.reply({ content, ephemeral: true }).catch(() => undefined);
        const seconds = replyOptions?.autoDeleteSeconds ?? 0;
        if (seconds <= 0) return;
        // Ephemeral replies are private to the caller, so removing one after a
        // delay is a tidiness setting rather than a moderation action.
        const timer = setTimeout(() => {
          void interaction.deleteReply().catch(() => undefined);
        }, seconds * 1000);
        // Never hold the process open for a cosmetic cleanup.
        timer.unref?.();
      },
      retractOnLeave: (targetMemberId: string) => {
        // An interaction outside a guild has no member to leave, and a member
        // with no id cannot be matched to a departure.
        if (!guildId || !targetMemberId) return;
        retractions.remember(guildId, targetMemberId, () => interaction.deleteReply());
      }
    });
  });
}

export { ChannelType };
