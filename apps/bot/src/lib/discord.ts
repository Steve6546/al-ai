import {
  ActivityType as DiscordActivityType,
  ApplicationCommandOptionType,
  AuditLogEvent,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
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
import type { ActivityType, BotStatus, LogDestination, Severity } from "@al-ai/core";
import {
  activityTypeNumbers,
  BOT_ROLE_NAME,
  commandRegistry,
  groupPagesIntoMessages,
  planEmbedFields,
  SEVERITY_EMBED_COLOR,
  TIMEOUT_MAX_SECONDS
} from "@al-ai/core";
import { createRetractionRegistry } from "./retraction.js";

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

// `BOT_ROLE_NAME` lives in @al-ai/core, not here: the dashboard finds the role by
// the same name to colour it, and two copies of the literal would drift apart.
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
export function buildCoreCommands() {
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
  | { type: "member.role-add"; guildId: string; memberId: string; roleId: string }
  | { type: "member.role-remove"; guildId: string; memberId: string; roleId: string }
  | { type: "moderation.ban"; guildId: string; targetId: string; actorId: string; reason?: string }
  | { type: "moderation.unban"; guildId: string; targetId: string; actorId: string; reason?: string }
  | { type: "moderation.kick"; guildId: string; targetId: string; actorId: string; reason?: string }
  | { type: "moderation.timeout"; guildId: string; targetId: string; actorId: string; reason?: string }
  | { type: "moderation.untimeout"; guildId: string; targetId: string; actorId: string; reason?: string }
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

  client.on(Events.GuildMemberAdd, member => emit({ type: "member.join", guildId: member.guild.id, memberId: member.id }));
  client.on(Events.GuildMemberRemove, member => {
    emit({ type: "member.leave", guildId: member.guild.id, memberId: member.id });
    // Withdraw any reply that was waiting on this member's departure. Not
    // awaited on purpose: the withdrawal is cosmetic and the leave event is
    // what the rest of the pipeline acts on, so it must not be delayed by it.
    void retractions.retract(member.guild.id, member.id);
  });
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

  client.on(Events.GuildMemberUpdate, (before, after) => {
    const wasTimedOut = Boolean(before.communicationDisabledUntilTimestamp);
    const isTimedOut = Boolean(after.communicationDisabledUntilTimestamp);
    if (!wasTimedOut && isTimedOut) {
      void resolveAudit(after.guild, AuditLogEvent.MemberUpdate, after.id).then(({ actorId, reason }) =>
        emit({ type: "moderation.timeout", guildId: after.guild.id, targetId: after.id, actorId, ...(reason ? { reason } : {}) })
      );
      return;
    }
    // A timeout expiring on its own also lands here, and it is reported too. That
    // is the honest reading: the operator's log answers "when did this member
    // stop being silenced", and the answer is the same whether Discord's clock
    // ran out or a moderator lifted it — the actor line says which.
    if (wasTimedOut && !isTimedOut) {
      void resolveAudit(after.guild, AuditLogEvent.MemberUpdate, after.id).then(({ actorId, reason }) =>
        emit({ type: "moderation.untimeout", guildId: after.guild.id, targetId: after.id, actorId, ...(reason ? { reason } : {}) })
      );
    }
  });

  client.on(Events.VoiceStateUpdate, (before, after) => {
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

  client.on(Events.GuildRoleCreate, async role => emit({ type: "role.create", guildId: role.guild.id, roleId: role.id, actorId: await resolveActor(role.guild, AuditLogEvent.RoleCreate, role.id) }));
  client.on(Events.GuildRoleUpdate, async (_before, role) => emit({ type: "role.update", guildId: role.guild.id, roleId: role.id, actorId: await resolveActor(role.guild, AuditLogEvent.RoleUpdate, role.id) }));
  client.on(Events.GuildRoleDelete, async role => emit({ type: "role.delete", guildId: role.guild.id, roleId: role.id, actorId: await resolveActor(role.guild, AuditLogEvent.RoleDelete, role.id) }));

  client.on(Events.MessageCreate, message => {
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

  client.on(Events.ChannelCreate, async channel => {
    if (!("guild" in channel) || !channel.guild) return;
    emit({ type: "server.channel-create", guildId: channel.guild.id, channelId: channel.id, actorId: await resolveActor(channel.guild, AuditLogEvent.ChannelCreate, channel.id) });
  });
  client.on(Events.ChannelUpdate, async (_before, channel) => {
    if (!("guild" in channel) || !channel.guild) return;
    emit({ type: "server.channel-update", guildId: channel.guild.id, channelId: channel.id, actorId: await resolveActor(channel.guild, AuditLogEvent.ChannelUpdate, channel.id) });
  });
  client.on(Events.ChannelDelete, async channel => {
    if (!("guild" in channel) || !channel.guild) return;
    emit({ type: "server.channel-delete", guildId: channel.guild.id, channelId: channel.id, actorId: await resolveActor(channel.guild, AuditLogEvent.ChannelDelete, channel.id) });
  });

  client.on(Events.InviteCreate, async invite => {
    if (!invite.guild) return;
    emit({ type: "server.invite-create", guildId: invite.guild.id, inviteCode: invite.code, actorId: await resolveActor(invite.guild as Guild, AuditLogEvent.InviteCreate, invite.code) });
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
      targetId: target?.id ?? interaction.options.getString("user_id") ?? null,
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
