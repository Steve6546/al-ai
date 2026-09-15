import "dotenv/config";
import { randomUUID } from "node:crypto";
import {
  applyBotPresence,
  applyChannelAction,
  applyModeration,
  bindEvents,
  createDiscordClient,
  dmGuildOwner,
  ensureBotRole,
  Events,
  listLoggableChannels,
  notifyTarget,
  quarantineMember,
  readBotHighestPosition,
  readColourRoles,
  readMemberPositions,
  readMemberRoleIds,
  sendLogEmbed,
  sendLogEmbedToWebhook,
  type LogEnvelope
} from "./lib/discord.js";
import {
  assessCommandScope,
  commandCategories,
  commandCategoryLabels,
  commandDurationSeconds,
  CommandCooldowns,
  commandRegistry,
  cooldownKey,
  discordPermissionLabels,
  EMPTY_TIER_ROLES,
  isAdmittedByAllowList,
  normaliseCommandConfig,
  requireCommand,
  resolveCommandDuration,
  scopeReasonMessages,
  type CommandConfig
} from "@al-ai/core";
import { checkHierarchy, hierarchyMessages } from "./permissions/permission-guard.js";
import { createBotDatabase } from "./storage/database.js";
import { ConfigCache } from "./storage/config-cache.js";
import { createMessageCache } from "./logging/message-cache.js";
import { EventPipeline } from "./runtime/event-pipeline.js";
import { createDispatcher } from "./events/dispatch.js";
import { acquireInstanceLock, startSupervisor } from "./runtime/supervisor.js";
import { check, roleCarrierOf } from "./permissions/permission-guard.js";
import { createWatchdog, WATCHED_COMPONENTS } from "./security/watchdog.js";
import { createIntrusionDetector } from "./security/intrusion-detector.js";
import { createAntiNukeEngine } from "./security/anti-nuke.js";
import { guardAuditWrite } from "./security/audit-trail.js";
import { createIntentUsageTracker } from "./compliance/intent-usage-tracker.js";
import { createPresenceSync } from "./runtime/presence-sync.js";
import {
  assertChannelsMatchSchema,
  loadControlPlane,
  undecidedSettings,
  type ControlPlane
} from "./config/control-plane.js";
import { startIntegrationAdapter } from "./integration-adapter.js";
import { logEvent, type LogRuntime } from "./logging/log-router.js";

/* ------------------------------------------------------------------ *
 * GOVERNANCE rule 15 — operational state is loaded, validated, and never
 * guessed. A drifted config or an undecided value fails before Discord is
 * contacted, so a half-configured bot never runs in production.
 *
 * Both reads sit inside the guard, because both can throw. The control plane
 * validates itself as it loads, so a missing or mistyped field stops the boot
 * here instead of reaching the pipeline as `undefined` and letting a fallback
 * constant answer in its place.
 * ------------------------------------------------------------------ */
let controlPlane: ControlPlane;
try {
  assertChannelsMatchSchema();
  controlPlane = loadControlPlane();
} catch (error) {
  console.error(`AL AI configuration is invalid: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}

const undecided = undecidedSettings(controlPlane);
if (undecided.length) {
  const message = `AL AI has undecided operational settings: ${undecided.join(", ")} (see apps/bot/config/control-plane.json).`;
  if (process.env.NODE_ENV === "production") {
    console.error(message);
    process.exit(1);
  }
  console.warn(`${message} Development mode: continuing with nulls.`);
}

/* ------------------------------------------------------------------ *
 * Secret gate
 *
 * The bot must not connect to Discord when its secrets are absent. It exits
 * cleanly with a clear message instead of half-starting.
 * ------------------------------------------------------------------ */
const required = ["BOT_TOKEN", "DATABASE_URL", "EVENT_HMAC_SECRET", "ENCRYPTION_KEY"] as const;
const missing = required.filter(key => !process.env[key]?.trim());

if (missing.length) {
  console.warn(`AL AI bot is waiting for secrets; Discord connection intentionally skipped. Missing: ${missing.join(", ")}`);
  console.warn("Copy .env.example to .env and fill in real values, then start again.");
  process.exit(0);
}

/**
 * GOVERNANCE rule 19: the bot's credential comes from the environment and from
 * nowhere else. There is no code path that reads a token from the database or
 * accepts one over the wire — the dashboard authorises operators, it never
 * carries a credential that can act as the bot.
 */
const token = process.env.BOT_TOKEN!;
const databaseUrl = process.env.DATABASE_URL!;
const hmacSecret = process.env.EVENT_HMAC_SECRET!;
const encryptionKey = process.env.ENCRYPTION_KEY!;
const dashboardUrl = process.env.DASHBOARD_URL?.trim() || null;
/**
 * Where AL AI's own errors and security events are delivered. Deliberately an
 * environment value rather than a per-guild setting: a customer's server must
 * never receive the bot's internals, and no guild should be able to redirect
 * them. Unset means internal events are audited but not delivered anywhere.
 */
const developerWebhookUrl = process.env.DEVELOPER_WEBHOOK_URL?.trim() || null;

const lock = acquireInstanceLock();
const database = createBotDatabase(databaseUrl);
const cache = new ConfigCache(guildId => database.loadLogging(guildId));
const messageCache = createMessageCache();
// GOVERNANCE rule 15: the ceiling and the voice window come from config/, not
// from constants that happen to agree with it. Built without these arguments
// the pipeline silently used its own defaults, so editing
// `gateway.ceilingPerMinute` or `gateway.voiceDebounceMs` changed nothing.
const pipeline = new EventPipeline({
  ceiling: controlPlane.gateway.ceilingPerMinute,
  voiceDebounceMs: controlPlane.gateway.voiceDebounceMs
});
const client = createDiscordClient();

const detector = createIntrusionDetector();

/**
 * GOVERNANCE rule 12 — every security signal is critical and goes to bot-log and
 * the audit trail together. Nothing here may be downgraded by a caller.
 */
function raiseSecurityEvent(id: string, data: Record<string, unknown>, guildId = "*") {
  return logEvent(id, { guildId, actorId: "system", data }, runtime).catch(error =>
    console.error(`AL AI failed to record ${id}`, error)
  );
}

/**
 * GOVERNANCE rule 13 — the watchdog probes real liveness rather than trusting
 * that a component exists. A silent component becomes `security.watchdog-down`.
 */
const watchdog = createWatchdog({
  onSilent: (component, silentForMs) => {
    void raiseSecurityEvent("security.watchdog-down", { component, silentForMs });
  }
});

const intentUsage = createIntentUsageTracker({
  renewedAt: controlPlane.intents.renewedAt,
  warnAt: controlPlane.intents.warnAt,
  limit: controlPlane.intents.limit,
  renewalDays: controlPlane.intents.renewalDays
});

const runtime: LogRuntime = {
  database,
  cache,
  hmacSecret,
  encryptionKey,
  sourceLayer: controlPlane.instance.sourceLayer,
  send: (channelId, envelope, colorOverride) => sendLogEmbed(client, channelId, envelope, colorOverride),
  // Internal destinations (bot-log: the bot's own failures and every security.*
  // event) go to the developer webhook, never to a customer's server.
  ...(developerWebhookUrl
    ? { sendToDeveloper: (envelope: LogEnvelope) => sendLogEmbedToWebhook(developerWebhookUrl, envelope) }
    : {}),
  // Backs the operator's role exclusions. Wired to the cached reader so a burst
  // of events costs one member lookup rather than one per event.
  resolveMemberRoles: (guildId, userId) => readMemberRoleIds(client, guildId, userId)
};

const dispatch = createDispatcher({
  pipeline,
  runtime,
  /**
   * GOVERNANCE rule 13-adjacent, and the producer `bot.health` never had.
   *
   * The event is declared in `event-schema.ts` with `state` required, routed in
   * `config/channels.json` under bot-log, and delivered through the developer
   * webhook like every other internal event. Until this line existed nothing
   * emitted it: the dispatcher called this callback on `client.ready`, and the
   * callback wrote to `console.log` and discarded its `gatewayEvents` argument.
   *
   * `state` is the pipeline's own word for whether the gateway is keeping up,
   * and `gatewayEvents` is the count the health surface reports, so both are
   * carried into the payload rather than dropped. The console line stays: it is
   * the only signal available when the database or the webhook is the thing
   * that is broken.
   */
  onHealth: (state, gatewayEvents) => {
    console.log(`AL AI health: ${state}`);
    void logEvent("bot.health", { guildId: "*", actorId: "system", data: { state, gatewayEvents } }, runtime).catch(
      error => console.error("AL AI could not record its health", error)
    );
  },
  /**
   * Runs before the operator is offered any settings screen: the bot must own a
   * visible role in the guild so it can position the moderation roles it manages.
   */
  onGuildJoined: (guildId, name) => {
    void ensureBotRole(client, guildId)
      .then(result =>
        console.log(
          result.created
            ? `AL AI created its role in ${name} (${result.roleId}).`
            : `AL AI role already present in ${name} (${result.roleId}).`
        )
      )
      .catch(error => console.error(`AL AI could not create its role in ${name}`, error));
  }
});

/* ------------------------------------------------------------------ *
 * Anti-nuke
 *
 * GOVERNANCE rule 12 — wired in front of the logger, never through it. A muted
 * log channel cannot disarm the engine, and a failure inside it cannot stop an
 * event from being logged.
 * ------------------------------------------------------------------ */

const securityConfigs = new ConfigCache(guildId => database.loadSecurity(guildId));

const antiNuke = createAntiNukeEngine({
  configFor: guildId => securityConfigs.get(guildId),
  quarantine: (guildId, actorId, roleId) => quarantineMember(client, guildId, actorId, roleId),
  notifyOwner: (guildId, message) => dmGuildOwner(client, guildId, message),
  report: (incident, outcome) =>
    logEvent(
      "security.nuke-prevented",
      {
        guildId: incident.guildId,
        actorId: incident.actorId,
        data: {
          actorId: incident.actorId,
          action: incident.action,
          count: incident.count,
          limit: incident.limit,
          // Recorded so the trail shows whether the actor was actually stopped,
          // not merely detected.
          quarantined: outcome.quarantined,
          ownerNotified: outcome.ownerNotified
        }
      },
      runtime
    ).then(() => undefined),
  selfId: () => client.user?.id ?? null
});

/**
 * The sink the bot actually binds.
 *
 * The engine sees every event first, but does not delay it: `observe` is started
 * and the event is dispatched immediately, so the Discord writes that mitigation
 * performs can never slow the audit trail down.
 */
const guardedDispatch: typeof dispatch = event => {
  void antiNuke.observe(event);
  dispatch(event);
};

/* ------------------------------------------------------------------ *
 * Command-handler helpers
 * ------------------------------------------------------------------ */

/**
 * Sends the operator-configured DM, if they turned it on.
 *
 * Best-effort by design: a member with DMs closed must not turn a completed
 * punishment into a reported failure, so the result is deliberately dropped.
 */
async function maybeNotify(config: CommandConfig, guildId: string, targetId: string, content: string) {
  if (!config.dmOnAction) return;
  await notifyTarget(client, guildId, targetId, content).catch(() => false);
}

/** Operator-facing wording for every way a channel action can fail. */
const channelFailureMessages: Record<string, string> = {
  GUILD_UNAVAILABLE: "تعذّر الوصول إلى السيرفر.",
  CHANNEL_UNAVAILABLE: "تعذّر الوصول إلى القناة.",
  NOT_A_TEXT_CHANNEL: "هذا الأمر يعمل في القنوات النصية فقط.",
  MESSAGES_TOO_OLD: "لا يمكن حذف رسائل أقدم من 14 يوماً.",
  ACTION_FAILED: "تعذّر تنفيذ الإجراء. تحقّق من صلاحيات البوت في هذه القناة.",
  UNKNOWN_ACTION: "إجراء غير معروف."
};

function channelSuccessMessages(commandName: string, removed: number | undefined, numbers: Record<string, number>) {
  if (commandName === "clear") return `تم حذف ${removed ?? 0} رسالة.`;
  if (commandName === "lock") return "تم إغلاق القناة.";
  if (commandName === "unlock") return "تم فتح القناة.";
  const seconds = numbers.seconds ?? 0;
  return seconds === 0 ? "تم إيقاف الوضع البطيء." : `تم ضبط الوضع البطيء على ${seconds} ثانية.`;
}

/**
 * Per-command cooldowns, keyed by guild, command and member.
 *
 * In memory on purpose: a cooldown guards against spam, not against an attacker,
 * and losing it on restart costs nothing. Persisting it would add a write on
 * every command for a rule that lasts seconds.
 */
const commandCooldowns = new CommandCooldowns();

// `presetDurationFor` used to live here, deciding whether a preset reason's
// paired length applied. It moved into core as `resolveCommandDuration`, which
// now owns the whole order — a preset, then the stored default, then `custom`.
// The local copy was deleted rather than left beside it: two functions
// answering "which duration applies?" is exactly how the bot and its tests come
// to disagree about it.

bindEvents(client, guardedDispatch, {
  messageCache,

  /**
   * Serves the operator's ready-made reasons to Discord's autocomplete.
   *
   * Read from the cached configuration, never from Discord: an autocomplete
   * interaction has to be answered within three seconds or Discord shows the
   * operator an error, and a round trip to fetch a role list would not fit.
   */
  onAutocomplete: async ({ guildId, commandName, focusedOption, focusedValue }) => {
    if (focusedOption !== "reason") return [];
    let definition;
    try {
      definition = requireCommand(commandName);
    } catch {
      return [];
    }
    const configured = await database.loadCommandFlags(guildId).catch(() => new Map());
    const config = normaliseCommandConfig(definition, configured.get(commandName));
    const needle = focusedValue.trim().toLowerCase();
    return config.presetReasons
      .filter(preset => !needle || preset.label.toLowerCase().includes(needle))
      .map(preset => ({
        // Discord echoes the value back as the option's text, so it is the label
        // the operator sees and the string the handler matches a duration on.
        name: preset.duration ? `${preset.label} — ${preset.duration}` : preset.label,
        value: preset.label
      }));
  },

  /**
   * GOVERNANCE rule 3: the tier is resolved from configured Role IDs, never from
   * the caller's claim, and the decision is re-made here on every command —
   * the dashboard switch is a convenience, not an authority.
   *
   * A note on logging, because it is easy to get wrong: this handler logs a
   * punishment only when nothing else can. Ban, unban, kick and timeout are
   * reported once, by the gateway listener that reads Discord's own audit log —
   * which also carries the reason and catches actions taken outside AL AI.
   * Logging them here as well would put two entries in the operator's channel
   * for one action. Warnings and clearing them are the exception: they are
   * records, not Discord mutations, so nothing else reports them.
   */
  onCommand: async ({
    guildId,
    channelId,
    userId,
    roleIds,
    isGuildOwner,
    isAdministrator,
    commandName,
    targetId,
    numbers,
    strings,
    reason,
    reply
  }) => {
    const reject = async (message: string, detail: string) => {
      const signal = detector.authorizationFailure({ guildId, actorId: userId, action: commandName, reason: detail });
      await raiseSecurityEvent(signal.id, signal.data, guildId);
      await logEvent("bot.command-failure", { guildId, actorId: userId, data: { command: commandName, reason: detail } }, runtime).catch(() => undefined);
      await reply(message, { autoDeleteSeconds });
    };

    const succeed = async (message: string) => {
      await logEvent("bot.command-success", { guildId, actorId: userId, data: { command: commandName } }, runtime).catch(() => undefined);
      await reply(message, { autoDeleteSeconds });
    };

    // Raised as soon as the guild's configuration is known, so every reply —
    // including the refusals — honours the operator's tidiness setting.
    let autoDeleteSeconds = 0;

    // 1. The command must exist in the registry.
    let definition;
    try {
      definition = requireCommand(commandName);
    } catch {
      await reject("هذا الأمر غير مسجل في AL AI.", "UNKNOWN_COMMAND");
      return;
    }

    // 2. This guild's configuration, normalised against the definition so a
    //    control the command does not support can never be honoured — a purge
    //    setting on `/warn` would be a switch that does nothing.
    const configured = await database.loadCommandFlags(guildId);
    const config = normaliseCommandConfig(definition, configured.get(commandName));

    if (!config.enabled) {
      await reject("هذا الأمر معطّل في هذا السيرفر.", "COMMAND_DISABLED");
      return;
    }

    // Every reply from here on honours the operator's tidiness setting.
    autoDeleteSeconds = config.autoDeleteResponseSeconds;

    // 3. The actor must hold a tier that outranks the command's requirement, or
    //    be named by one of this command's own allow-lists — a role, or the
    //    member by hand. An unmapped guild is not a lockout: the owner tier is
    //    automatic, so the person who invited the bot can always undo anything.
    const tiers = (await database.loadTierRoles(guildId)) ?? EMPTY_TIER_ROLES;
    const carrier = roleCarrierOf(roleIds, { isGuildOwner, isAdministrator });
    const outcome = check(carrier, tiers, config.allowedLevel);
    if (!outcome.allowed && !isAdmittedByAllowList(config, { userId, roleIds })) {
      await reject("صلاحيتك لا تسمح بهذا الإجراء.", outcome.reason);
      return;
    }

    // 4. The member, role and channel scopes, applied after the tier check so a
    //    member without standing is told that, rather than being handed a hint
    //    about which channels the command is restricted to.
    const scope = assessCommandScope(config, { userId, roleIds, channelId });
    if (!scope.allowed) {
      await reject(scopeReasonMessages[scope.reason], scope.reason);
      return;
    }

    // 5. Cooldown. A plain refusal rather than an authorization signal: waiting
    //    out a cooldown is impatience, and reporting it as a security event would
    //    let an impatient moderator look like an intruder.
    const wait = commandCooldowns.remainingSeconds(cooldownKey(guildId, commandName, userId), Date.now());
    if (wait > 0) {
      await logEvent("bot.command-failure", { guildId, actorId: userId, data: { command: commandName, reason: "COOLDOWN" } }, runtime).catch(() => undefined);
      await reply(`انتظر ${wait} ثانية قبل استخدام هذا الأمر مجدداً.`, { autoDeleteSeconds });
      return;
    }
    if (config.cooldownSeconds > 0) commandCooldowns.start(cooldownKey(guildId, commandName, userId), config.cooldownSeconds, Date.now());

    const trimmedReason = reason.trim();
    // The requirement is the guild's setting, not the registry's shipped default:
    // the option is never marked required at Discord's end, so this is the only
    // place that decides — and the only way the switch can be turned off again.
    if (config.requireReason && !trimmedReason) {
      await reject("هذا الأمر يتطلب سبباً.", "MISSING_REASON");
      return;
    }

    // The preset list can be made exhaustive, which is how an operator gets a
    // clean, countable set of reasons without Discord's own choice list — whose
    // entries are frozen at registration and so could never follow a setting.
    // Checked here rather than at Discord's end for the same reason `required`
    // is: the switch has to be able to go back off.
    if (!config.allowCustomReason && config.presetReasons.length > 0) {
      const known = config.presetReasons.some(preset => preset.label === trimmedReason);
      if (!known) {
        const offered = config.presetReasons.map(preset => preset.label).slice(0, 10).join("، ");
        await reject(`هذا الأمر يقبل أسباباً محددة فقط: ${offered}`, "REASON_NOT_ALLOWED");
        return;
      }
    }

    /* ---------------- Informational ---------------- */
    // `/al-status` changes nothing, so it is answered here rather than through
    // the success log: recording a read-only check as a command success would
    // fill the operator's moderation log with noise.
    if (commandName === "al-status") {
      const stats = pipeline.stats();
      // A member who got in through an allowed role rather than a tier has no
      // tier to name, and reporting one would be a rank they do not hold.
      const tierLabel = outcome.allowed ? outcome.tier : "رتبة مخصّصة";
      await reply(`AL AI متصل. رتبتك: ${tierLabel}. أحداث آخر دقيقة: ${stats.eventsLastMinute}/${stats.ceiling}.`, {
        autoDeleteSeconds
      });
      return;
    }

    /**
     * Which commands this member may actually run right now.
     *
     * Evaluated against the same three gates the dispatch above applies — the
     * switch, the tier or allow-list, and the scopes — rather than against a
     * stored summary. A list built from anything else would eventually tell a
     * member they may run something the bot then refuses, which is the exact
     * "saved but not honoured" defect this project treats as its worst kind.
     *
     * The tier roles and the flags are read once here, not once per command.
     */
    const runnableFor = async (configured: Map<string, Partial<CommandConfig>>) =>
      commandRegistry.filter(entry => {
        const entryConfig = normaliseCommandConfig(entry, configured.get(entry.name));
        if (!entryConfig.enabled) return false;
        if (!check(carrier, tiers, entryConfig.allowedLevel).allowed && !isAdmittedByAllowList(entryConfig, { userId, roleIds })) {
          return false;
        }
        return assessCommandScope(entryConfig, { userId, roleIds, channelId }).allowed;
      });

    // `/help` is the catalogue and `/commands` is the shortlist. Keeping them as
    // two commands rather than one with a switch is deliberate: Discord's own
    // command list is the first thing a new member opens, and it should answer
    // "what can I do here" without an argument.
    if (commandName === "help" || commandName === "commands") {
      const configured = await database.loadCommandFlags(guildId).catch(() => new Map());
      const listed = commandName === "help" ? [...commandRegistry] : await runnableFor(configured);

      if (listed.length === 0) {
        await reply("لا يوجد أي أمر متاح لك في هذا السيرفر حالياً.", { autoDeleteSeconds });
        return;
      }

      const sections = commandCategories
        .map(category => {
          const inSection = listed.filter(entry => entry.category === category);
          if (inSection.length === 0) return null;
          const lines = inSection.map(entry => {
            const permission = entry.requiredPermission ? ` — يتطلب: ${discordPermissionLabels[entry.requiredPermission] ?? entry.requiredPermission}` : "";
            return `\`/${entry.name}\` — ${entry.description}${commandName === "help" ? permission : ""}`;
          });
          return `**${commandCategoryLabels[category]}**\n${lines.join("\n")}`;
        })
        .filter((section): section is string => section !== null);

      const heading =
        commandName === "help"
          ? `أوامر AL AI (${listed.length}) — يُنفَّذ منها ما تسمح به صلاحيتك وإعدادات السيرفر:`
          : `الأوامر المتاحة لك الآن (${listed.length}):`;
      await reply(`${heading}\n\n${sections.join("\n\n")}`.slice(0, 1900), { autoDeleteSeconds });
      return;
    }

    // `/settings` and `/dashboard` hand back a link rather than re-implementing
    // a screen: every panel route re-checks its own authorization, so a link is
    // safe to give to anyone the command's own gate already admitted.
    if (commandName === "settings" || commandName === "dashboard") {
      if (!dashboardUrl) {
        await reply("لم يُضبط عنوان اللوحة بعد. اطلب من مسؤول البوت ضبط DASHBOARD_URL.", { autoDeleteSeconds });
        return;
      }
      const base = dashboardUrl.replace(/\/$/, "");
      const link = commandName === "settings" ? `${base}/guilds/${guildId}/commands` : base;
      const label = commandName === "settings" ? "إعدادات أوامر هذا السيرفر" : "لوحة تحكم AL AI";
      await reply(`${label}: ${link}`, { autoDeleteSeconds });
      return;
    }

    // `/colors` answers from Discord every time rather than from a cache: a role
    // colour is changed in Discord's own settings, and a cached palette would go
    // on listing a colour the operator had already removed.
    if (commandName === "colors") {
      const colours = await readColourRoles(client, guildId);
      if (colours === null) {
        await reject("تعذّر قراءة رتب السيرفر من ديسكورد.", "ROLES_UNAVAILABLE");
        return;
      }
      if (colours.length === 0) {
        await reply("لا توجد رتب ملوّنة في هذا السيرفر.", { autoDeleteSeconds });
        return;
      }
      const lines = colours.slice(0, 40).map(role => `\`#${role.color.toString(16).padStart(6, "0")}\` — ${role.name}`);
      await reply(`ألوان السيرفر (${colours.length}):\n${lines.join("\n")}`.slice(0, 1900), { autoDeleteSeconds });
      return;
    }

    /* ---------------- Channel commands ---------------- */
    if (definition.target !== "member") {
      const action =
        commandName === "clear"
          ? { kind: "clear" as const, guildId, channelId, count: numbers.count ?? 1 }
          : commandName === "lock"
            ? { kind: "lock" as const, guildId, channelId, reason: trimmedReason || "إغلاق القناة" }
            : commandName === "unlock"
              ? { kind: "unlock" as const, guildId, channelId, reason: trimmedReason || "فتح القناة" }
              : { kind: "slowmode" as const, guildId, channelId, seconds: numbers.seconds ?? 0, reason: trimmedReason || "الوضع البطيء" };

      const result = await applyChannelAction(client, action);
      if (!result.ok) {
        await reject(channelFailureMessages[result.reason] ?? "تعذّر تنفيذ الإجراء.", result.reason);
        return;
      }
      // No log call here: Discord reports the channel update and the bulk delete
      // through the gateway, so the operator's log stays single-entry.
      await succeed(channelSuccessMessages(commandName, result.removed, numbers));
      return;
    }

    /* ---------------- Member commands ---------------- */
    if (!targetId) {
      await reject("حدّد العضو المطلوب.", "MISSING_TARGET");
      return;
    }

    // Reading a member's warnings and clearing them are records, not Discord
    // mutations, so they run before the hierarchy check — a moderator looking up
    // their own warnings must not be blocked by "you cannot act on yourself".
    if (commandName === "warns") {
      const warnings = await database.listWarnings(guildId, targetId, 10);
      const total = await database.countWarnings(guildId, targetId);
      if (warnings.length === 0) {
        await succeed(`لا توجد تحذيرات مسجّلة على <@${targetId}>.`);
        return;
      }
      const lines = warnings.map((warning, index) => {
        const when = warning.createdAt.slice(0, 10);
        return `**${index + 1}.** ${warning.reason} — <@${warning.moderatorId}> (${when})`;
      });
      await succeed(`تحذيرات <@${targetId}> (${total} إجمالاً، أحدث ${warnings.length}):\n${lines.join("\n")}`.slice(0, 1900));
      return;
    }

    // 4. Discord's own hierarchy rules, checked before any member mutation.
    const [actorPositions, targetPositions, botPosition] = await Promise.all([
      readMemberPositions(client, guildId, userId),
      readMemberPositions(client, guildId, targetId),
      readBotHighestPosition(client, guildId)
    ]);

    if (!actorPositions || !targetPositions || botPosition === null) {
      await reject("تعذّر التحقق من الرتب.", "HIERARCHY_UNAVAILABLE");
      return;
    }

    const hierarchy = checkHierarchy({
      actorId: userId,
      targetId,
      actorHighestPosition: actorPositions.highestPosition,
      targetHighestPosition: targetPositions.highestPosition,
      botHighestPosition: botPosition,
      actorIsGuildOwner: actorPositions.isGuildOwner,
      targetIsGuildOwner: targetPositions.isGuildOwner
    });
    if (!hierarchy.allowed) {
      await reject(hierarchyMessages[hierarchy.reason], hierarchy.reason);
      return;
    }

    if (commandName === "warn") {
      await database.addWarning({ id: randomUUID(), guildId, userId: targetId, moderatorId: userId, reason: trimmedReason });
      await logEvent("moderation.warn", { guildId, actorId: userId, data: { targetId, actorId: userId, reason: trimmedReason } }, runtime).catch(() => undefined);
      await maybeNotify(config, guildId, targetId, `تلقّيت تحذيراً في السيرفر. السبب: ${trimmedReason}`);
      const total = await database.countWarnings(guildId, targetId);
      await succeed(`تم تحذير <@${targetId}>. إجمالي تحذيراته: ${total}.`);
      return;
    }

    if (commandName === "clearwarns") {
      const removed = await database.clearWarnings(guildId, targetId);
      await logEvent(
        "moderation.clearwarns",
        { guildId, actorId: userId, data: { targetId, actorId: userId, removed, reason: trimmedReason || "—" } },
        runtime
      ).catch(() => undefined);
      await maybeNotify(config, guildId, targetId, "تم مسح تحذيراتك في السيرفر.");
      await succeed(removed ? `تم مسح ${removed} تحذيراً عن <@${targetId}>.` : `لا توجد تحذيرات مسجّلة على <@${targetId}>.`);
      return;
    }

    // `/delwarn` removes one record by the number `/warns` prints beside it.
    // Like `/warn` and `/clearwarns` it is a record rather than a Discord
    // mutation, so the gateway reports nothing and this handler writes the log
    // entry itself — otherwise a deleted warning would leave no trace at all.
    if (commandName === "delwarn") {
      const index = numbers.index ?? 0;
      const removedReason = await database.deleteWarningAt(guildId, targetId, index);
      if (removedReason === null) {
        // Not a failure worth a security signal: asking for a warning that is
        // not there is a miscount, not an intrusion.
        await succeed(`لا يوجد تحذير بالرقم ${index} على <@${targetId}>.`);
        return;
      }
      await logEvent(
        "moderation.delwarn",
        { guildId, actorId: userId, data: { targetId, actorId: userId, reason: trimmedReason || "—", removed: index } },
        runtime
      ).catch(() => undefined);
      const total = await database.countWarnings(guildId, targetId);
      await succeed(`تم حذف التحذير رقم ${index} عن <@${targetId}> («${removedReason}»). المتبقي: ${total}.`);
      return;
    }

    // 6. Where a duration is not given, the guild's default applies — and a
    //    preset reason carries its own length, which is the more specific
    //    instruction. `resolveCommandDuration` owns the order between the two, so
    //    the bot and its tests cannot disagree about it. A permanent fallback is
    //    not a duration: Discord has no permanent timeout, so it is refused with
    //    an explanation rather than silently turned into a minute.
    let timeoutMinutes: number | undefined;
    if (commandName === "timeout") {
      if (numbers.minutes !== undefined) {
        timeoutMinutes = numbers.minutes;
      } else {
        const seconds = commandDurationSeconds(definition, resolveCommandDuration(config, trimmedReason));
        if (seconds === null) {
          // Reached for both "دائم" and "مخصص" — neither supplies a length. The
          // two are still worth distinguishing to the operator, because the fix
          // differs: one wants a default, the other was asked for on purpose.
          const asked =
            config.defaultDuration === "custom"
              ? "هذا الأمر مضبوط على مدة مخصّصة"
              : "لم تُضبط مدة افتراضية لهذا الأمر";
          await reject(`${asked}، فحدّد المدة بالدقائق عند الاستخدام.`, "MISSING_DURATION");
          return;
        }
        // Discord takes whole minutes; anything shorter is still a minute.
        timeoutMinutes = Math.max(1, Math.round(seconds / 60));
      }
    }

    // 7. Apply the Discord mutation. The gateway logs it; we only report back.
    //    `/setnick` follows the same rule by a different route: the gateway
    //    reports the nickname change itself, as `member.nickname-change`.
    const applied = await applyModeration(client, {
      kind: commandName as "ban" | "unban" | "kick" | "timeout" | "untimeout" | "setnick",
      guildId,
      targetId,
      reason: trimmedReason,
      // An absent name means "clear it", which is what `/setnick` with no
      // nickname asks for — Discord takes `null` for "remove", never `""`.
      ...(commandName === "setnick" ? { nickname: strings.nickname?.trim() || null } : {}),
      ...(timeoutMinutes !== undefined ? { minutes: timeoutMinutes } : {}),
      // `deleteMessageDays` is the operator's purge setting, converted to the
      // seconds Discord actually accepts. Ignored for commands without purge.
      ...(config.deleteMessageDays > 0 && commandName !== "kick" && commandName !== "unban"
        ? { deleteMessageSeconds: config.deleteMessageDays * 86_400 }
        : {})
    } as Parameters<typeof applyModeration>[1]);

    if (!applied) {
      await reject("تعذّر تنفيذ الإجراء. تحقّق من صلاحيات البوت.", "ACTION_FAILED");
      return;
    }

    await maybeNotify(config, guildId, targetId, `تم تنفيذ إجراء إشرافي بحقك في السيرفر. السبب: ${trimmedReason || "غير محدد"}`);
    await succeed("تم تنفيذ الإجراء.");
  }
});

/* The `Events.*` constant rather than the bare literal.
 *
 * Both forms work here, and that is worth stating plainly because the
 * neighbouring case is the opposite: discord.js emits by *value*, and
 * `Events.ClientReady`'s value happens to be `clientReady`, so the literal this
 * replaced was never broken. The constant is still the right spelling, for a
 * reason that only shows up later — a literal is unverifiable. Nothing checks
 * that `"clientReady"` is still a real event name, so the v13→v14 rename
 * (`ready` → `clientReady`) is exactly the kind of change that would leave a
 * literal silently unmatched. With the constant, the same rename fails the
 * build instead.
 *
 * The emoji listeners in lib/discord.ts are the case where this *was* a live
 * defect: `"guildEmojiCreate"` is the constant's *key*, not its value
 * (`emojiCreate`), so those handlers never ran at all. */
client.once(Events.ClientReady, async () => {
  console.log(`AL AI connected as ${client.user?.tag}`);
  for (const guild of client.guilds.cache.values()) {
    await database
      .upsertGuild({
        id: guild.id,
        name: guild.name,
        iconUrl: guild.iconURL(),
        memberCount: guild.memberCount,
        botPresent: true
      })
      .catch(error => console.error(`Failed to upsert guild ${guild.id}`, error));
    const channels = await listLoggableChannels(client, guild.id).catch(() => []);
    if (channels.length) console.log(`AL AI can log to ${channels.length} channels in ${guild.name}.`);

    // Guilds the bot was already in when it started still need their role, so the
    // same guarantee holds after a restart as after a fresh invite.
    await ensureBotRole(client, guild.id).catch(error =>
      console.error(`AL AI could not ensure its role in ${guild.name}`, error)
    );

    // GOVERNANCE rule 14: member counts seed the unique-user budget.
    intentUsage.observeGuildSizes([guild.memberCount]);
    await guild.members
      .fetch()
      .then(members => intentUsage.observe(members.keys()))
      .catch(() => undefined);
  }
  console.log(`AL AI intent budget: ${intentUsage.describe()}`);
  await presence.run();
});

/* ------------------------------------------------------------------ *
 * Security liveness loop
 * ------------------------------------------------------------------ */
const securityProbe = setInterval(async () => {
  // The detector is alive if it can still evaluate a signal.
  detector.request({ endpoint: "__self-check" });
  watchdog.beat(WATCHED_COMPONENTS[0]);

  // The audit trail is alive only if a real read succeeds.
  const outcome = await guardAuditWrite(() => database.probeAuditTrail());
  if (outcome.ok) {
    watchdog.beat(WATCHED_COMPONENTS[1]);
  } else if (outcome.tamper) {
    const signal = detector.auditTamper({ attempt: outcome.attempt, target: "audit_trail" });
    await raiseSecurityEvent(signal.id, signal.data);
  }
  await database.pruneNonces().catch(() => undefined);
  // The anti-nuke counters are a sliding window keyed by guild:actor:action, and
  // nothing else ever removes a key whose window has closed. Without this the map
  // only grows: every distinct member who deletes a channel, issues a ban or
  // changes a role leaves an entry behind for the life of the process. The
  // dashboard never reads it, so the leak produces no symptom until memory runs
  // out — which is why it is easy to miss and cheap to fix here.
  antiNuke.tracker.prune();
}, 30_000);
securityProbe.unref?.();

const supervisor = startSupervisor({
  pipeline,
  database,
  dashboardUrl,
  hmacSecret,
  guildIds: () => [...client.guilds.cache.keys()],
  uniqueUsers: () => intentUsage.stats().uniqueUsers,
  // `ws.ping` is the live gateway heartbeat — the only latency figure that
  // describes the socket the bot actually runs on. It is -1 until the first
  // heartbeat lands; the supervisor normalises that to null.
  gatewayPingMs: () => client.ws.ping
});

/* ------------------------------------------------------------------ *
 * GOVERNANCE rule 16 — the integration adapter binds to 127.0.0.1 only.
 * It stays off unless explicitly enabled.
 * ------------------------------------------------------------------ */
const adapter =
  process.env.INTEGRATION_ADAPTER_ENABLED === "true"
    ? startIntegrationAdapter({
        hmacSecret,
        sourceLayer: controlPlane.instance.sourceLayer,
        consumeNonce: (nonce, expiresAt) => database.consumeNonce(nonce, "integration-adapter", expiresAt),
        handlers: {
          getStatus: async () => ({ ...pipeline.stats(), intents: intentUsage.stats(), watchdog: watchdog.snapshot() }),
          diagnose: async () => ({
            database: await database.ping().then(() => "reachable").catch(() => "unreachable"),
            watched: watchdog.snapshot(),
            undecidedSettings: undecidedSettings(controlPlane)
          }),
          readLogs: async () => ({ note: "GOVERNANCE rule 6: logs live in Discord and in the audit trail.", stats: pipeline.stats() }),
          suggestConfig: async () => ({ applyableKeys: ["logging.enabled", "logging.globalChannelId", "logging.embedColor"] }),
          applyConfig: async () => {
            throw new Error("CONFIG_WRITE_REQUIRES_DASHBOARD");
          },
          listChannels: async () => {
            const result: Record<string, { id: string; name: string }[]> = {};
            for (const guildId of client.guilds.cache.keys()) {
              result[guildId] = await listLoggableChannels(client, guildId).catch(() => []);
            }
            return result;
          }
        }
      })
    : null;

if (adapter) {
  await adapter.listen().then(
    ({ host, port }) => console.log(`AL AI integration adapter listening on http://${host}:${port}`),
    error => console.error("AL AI integration adapter failed to start", error)
  );
}

/* ------------------------------------------------------------------ *
 * Presence sync
 *
 * Status and activity are the only appearance fields the dashboard cannot apply:
 * they live on the gateway connection, and Discord has no REST route for them.
 * The dashboard writes them to `bot_identity`; this applies them without a
 * restart, and the cache stops us re-sending a value the gateway already has.
 *
 * Everything else — nickname, avatar, banner, role colour, bio — is applied by
 * the dashboard itself so it can report each field's result to the operator.
 * ------------------------------------------------------------------ */
const presence = createPresenceSync({
  loadIdentity: () => database.loadBotIdentity(),
  applyPresence: value => applyBotPresence(client, value),
  onError: error => console.error("AL AI could not apply the presence", error)
});

const presenceTimer = setInterval(() => void presence.run(), 15_000);
presenceTimer.unref?.();

/* ------------------------------------------------------------------ *
 * Graceful shutdown
 * ------------------------------------------------------------------ */
let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`AL AI received ${signal}; flushing pipeline.`);
  supervisor.stop();
  watchdog.stop();
  clearInterval(securityProbe);
  clearInterval(presenceTimer);
  await adapter?.close().catch(() => undefined);
  const flushed = await pipeline.flush(5_000);
  if (!flushed) console.warn("AL AI shutdown with undelivered log jobs.");
  client.destroy();
  await database.close().catch(() => undefined);
  lock.release();
  process.exit(0);
}

/**
 * Signals are the shutdown path. A crash is deliberately not.
 *
 * `SIGINT` and `SIGTERM` run the flush above because both mean "stop now, on
 * purpose" — a redeploy, a `docker stop`, an operator pressing Ctrl-C — and the
 * pipeline is holding events that were accepted but not yet delivered.
 *
 * `uncaughtException` is left to Node, which prints and exits. Two reasons, both
 * deliberate: continuing after one is exactly what Node's own documentation
 * warns against, and the code that threw is by definition the code that would
 * have to run the flush. Nothing is left behind by exiting this way — the
 * instance lock is reclaimed on the next boot because its owner is no longer
 * alive, which `instance-lock.test.ts` covers — and the loss is bounded to the
 * events still queued, which the rate-limiting pipeline caps at one window.
 *
 * A rejected promise is different: it is already handled where it happens, so
 * this only makes sure it is not silent.
 */
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("unhandledRejection", reason => console.error("AL AI unhandled rejection", reason));

await client.login(token).catch(error => {
  console.error("Discord login failed", error);
  lock.release();
  process.exit(1);
});
