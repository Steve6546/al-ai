import "dotenv/config";
import {
  applyBotAppearance,
  applyModeration,
  bindEvents,
  createDiscordClient,
  ensureBotRole,
  listLoggableChannels,
  readBotHighestPosition,
  readMemberPositions,
  sendLogEmbed
} from "./lib/discord.js";
import { requireCommand } from "@al-ai/core";
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
import { guardAuditWrite } from "./security/audit-trail.js";
import { createIntentUsageTracker } from "./compliance/intent-usage-tracker.js";
import { createCustomizationSync } from "./runtime/customization-sync.js";
import { assertChannelsMatchSchema, loadControlPlane, undecidedSettings } from "./config/control-plane.js";
import { startIntegrationAdapter } from "./integration-adapter.js";
import { logEvent, type LogRuntime } from "./logging/log-router.js";

const SOURCE_LAYER = "bot-runtime";

/* ------------------------------------------------------------------ *
 * GOVERNANCE rule 15 — operational state is loaded, validated, and never
 * guessed. A drifted config or an undecided value fails before Discord is
 * contacted, so a half-configured bot never runs in production.
 * ------------------------------------------------------------------ */
try {
  assertChannelsMatchSchema();
} catch (error) {
  console.error(`AL AI configuration is invalid: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}

const controlPlane = loadControlPlane();
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

const token = process.env.BOT_TOKEN!;
const databaseUrl = process.env.DATABASE_URL!;
const hmacSecret = process.env.EVENT_HMAC_SECRET!;
const encryptionKey = process.env.ENCRYPTION_KEY!;
const dashboardUrl = process.env.DASHBOARD_URL?.trim() || null;

const lock = acquireInstanceLock();
const database = createBotDatabase(databaseUrl);
const cache = new ConfigCache(guildId => database.loadLogging(guildId));
const messageCache = createMessageCache();
const pipeline = new EventPipeline();
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
  sourceLayer: SOURCE_LAYER,
  send: (channelId, envelope, colorOverride) => sendLogEmbed(client, channelId, envelope, colorOverride)
};

const dispatch = createDispatcher({
  pipeline,
  runtime,
  onHealth: state => console.log(`AL AI health: ${state}`),
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

bindEvents(client, dispatch, {
  messageCache,
  onStatusCommand: async ({ guildId, roleIds }) => {
    const tiers = await database.loadTierRoles(guildId);
    if (!tiers) return "AL AI متصل، لكن لم تُضبط رتب الإدارة لهذا السيرفر بعد.";
    const outcome = check(roleCarrierOf(roleIds), tiers, "moderator");

    // GOVERNANCE rule 12: a failed attempt is the signal, so it is reported even
    // though the user only ever sees a generic reply.
    if (!outcome.allowed) {
      const signal = detector.authorizationFailure({ guildId, actorId: roleIds[0] ?? "unknown", action: "al-status", reason: outcome.reason });
      await raiseSecurityEvent(signal.id, signal.data, guildId);
      return "AL AI متصل. لا تملك رتبة AL AI تسمح بعرض التفاصيل.";
    }

    const stats = pipeline.stats();
    return `AL AI متصل. رتبتك: ${outcome.tier}. أحداث آخر دقيقة: ${stats.eventsLastMinute}/${stats.ceiling}.`;
  },

  /**
   * GOVERNANCE rule 3: the tier is resolved from configured Role IDs, never from
   * the caller's claim, and the decision is re-made here on every command —
   * the dashboard switch is a convenience, not an authority.
   */
  onCommand: async ({ guildId, userId, roleIds, commandName, targetId, minutes, reason, reply }) => {
    const reject = async (message: string, detail: string) => {
      const signal = detector.authorizationFailure({ guildId, actorId: userId, action: commandName, reason: detail });
      await raiseSecurityEvent(signal.id, signal.data, guildId);
      await logEvent("bot.command-failure", { guildId, actorId: userId, data: { command: commandName, reason: detail } }, runtime).catch(() => undefined);
      await reply(message);
    };

    // 1. The command must exist in the registry, and be enabled for this guild.
    let definition;
    try {
      definition = requireCommand(commandName);
    } catch {
      await reject("هذا الأمر غير مسجل في AL AI.", "UNKNOWN_COMMAND");
      return;
    }

    const flags = await database.loadCommandFlags(guildId);
    const flag = flags.get(commandName);
    if (flag?.enabled === false) {
      await reject("هذا الأمر معطّل في هذا السيرفر.", "COMMAND_DISABLED");
      return;
    }

    // The operator may raise or lower a command's tier from the dashboard; the
    // stored override wins, and the registry value is only the fallback. Without
    // this the minimum_tier column was written and never enforced.
    const requiredTier = flag?.minimumTier ?? definition.minimumTier;

    // 2. The actor must hold a tier that outranks the command's requirement.
    const tiers = await database.loadTierRoles(guildId);
    if (!tiers) {
      await reject("لم تُضبط رتب الإدارة بعد.", "NO_TIER_CONFIG");
      return;
    }
    const outcome = check(roleCarrierOf(roleIds), tiers, requiredTier);
    if (!outcome.allowed) {
      await reject("صلاحيتك لا تسمح بهذا الإجراء.", outcome.reason);
      return;
    }

    if (!targetId) {
      await reject("حدّد العضو المطلوب.", "MISSING_TARGET");
      return;
    }

    // 3. Discord's own hierarchy rules, checked before the API call.
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

    // 4. Apply, then log. The reason is always an embed field, never a second entry.
    const applied = await applyModeration(client, {
      kind: commandName as "ban" | "unban" | "kick" | "timeout" | "mute" | "warn",
      guildId,
      targetId,
      reason,
      ...(minutes !== null ? { minutes } : {})
    } as Parameters<typeof applyModeration>[1]);

    if (!applied) {
      await reject("تعذّر تنفيذ الإجراء. تحقّق من صلاحيات البوت.", "ACTION_FAILED");
      return;
    }

    await logEvent(
      commandName === "warn" ? "moderation.warn" : `moderation.${commandName}`,
      { guildId, actorId: userId, data: { targetId, actorId: userId, reason: reason || "—", ...(minutes !== null ? { minutes } : {}) } },
      runtime
    ).catch(() => undefined);

    await logEvent("bot.command-success", { guildId, actorId: userId, data: { command: commandName } }, runtime).catch(() => undefined);
    await reply("تم تنفيذ الإجراء.");
  }
});

client.once("clientReady", async () => {
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
  await customization.run();
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
}, 30_000);
securityProbe.unref?.();

const supervisor = startSupervisor({
  pipeline,
  database,
  dashboardUrl,
  hmacSecret,
  guildIds: () => [...client.guilds.cache.keys()],
  uniqueUsers: () => intentUsage.stats().uniqueUsers
});

/* ------------------------------------------------------------------ *
 * GOVERNANCE rule 16 — the integration adapter binds to 127.0.0.1 only.
 * It stays off unless explicitly enabled.
 * ------------------------------------------------------------------ */
const adapter =
  process.env.INTEGRATION_ADAPTER_ENABLED === "true"
    ? startIntegrationAdapter({
        hmacSecret,
        sourceLayer: SOURCE_LAYER,
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
 * Customization sync
 *
 * The dashboard writes the nickname, role colour and role icon to the database;
 * the bot is what actually applies them to Discord. Polling keeps a dashboard
 * change effective without a restart, and the cache stops us re-sending a value
 * Discord already has.
 * ------------------------------------------------------------------ */
const customization = createCustomizationSync({
  guildIds: () => [...client.guilds.cache.keys()],
  loadAppearance: guildId => database.loadCustomization(guildId),
  applyAppearance: (guildId, appearance) => applyBotAppearance(client, guildId, appearance),
  onError: (guildId, error) => console.error(`AL AI could not apply the appearance for ${guildId}`, error)
});

const customizationTimer = setInterval(() => void customization.run(), 60_000);
customizationTimer.unref?.();

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
  clearInterval(customizationTimer);
  await adapter?.close().catch(() => undefined);
  const flushed = await pipeline.flush(5_000);
  if (!flushed) console.warn("AL AI shutdown with undelivered log jobs.");
  client.destroy();
  await database.close().catch(() => undefined);
  lock.release();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("unhandledRejection", reason => console.error("AL AI unhandled rejection", reason));

await client.login(token).catch(error => {
  console.error("Discord login failed", error);
  lock.release();
  process.exit(1);
});
