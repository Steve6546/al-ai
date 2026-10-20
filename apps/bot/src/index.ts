import "dotenv/config";
import { randomUUID } from "node:crypto";
import {
  applyBotPresence,
  applyChannelAction,
  applyModeration,
  applyRoleChange,
  bindEvents,
  buildInviteLeaderboardMessage,
  createDiscordClient,
  createPersonalInvite,
  dmGuildOwner,
  ensureBotRole,
  Events,
  INVITES_LEADERBOARD_PER_PAGE,
  INVITES_PAGER_PREFIX,
  listLoggableChannels,
  moveMemberToChannel,
  notifyTarget,
  quarantineMember,
  readBotHighestPosition,
  readColourRoles,
  readMemberPositions,
  readMemberRoleIds,
  readStrippableRoleIds,
  sendLogEmbed,
  allowedMentionsFor,
  sendWelcomePayload,
  sendLogEmbedToWebhook,
  type APIEmbed,
  type GuildMember,
  type LogEnvelope
} from "./lib/discord.js";
import {
  applyXpMultipliers,
  classifyInviteJoin,
  formatAccountAge,
  isProduction,
  missingEnv,
  readEnv,
  inviteNet,
  inviteTotal,
  MAX_LEVEL_CAP,
  UNLIMITED_LEVEL_CAP,
  planMilestoneRoleChanges,
  renderInviteTemplate,
  assessCommandScope,
  buildAliasMap,
  commandCategories,
  commandCategoryLabels,
  commandDurationSeconds,
  CommandCooldowns,
  commandRegistry,
  cooldownKey,
  discordPermissionLabels,
  EMPTY_TIER_ROLES,
  isAdmittedByAllowList,
  levelFromXp,
  levelProgress,
  normaliseCommandConfig,
  renderLevelMessage,
  renderWelcomeMessage,
  requireCommand,
  resolveCommandDuration,
  scopeReasonMessages,
  type CommandConfig,
  type InviteMilestone,
  type InviteStats,
  type WelcomeEmbed,
  type WelcomeMessageSettings,
  type LevelRoleReward,
  type LevelSettings
} from "@al-ai/core";
import { checkHierarchy, hierarchyMessages } from "./permissions/permission-guard.js";
import { createBotDatabase } from "./storage/database.js";
import { ConfigCache } from "./storage/config-cache.js";
import {
  TextCooldownGate,
  VoiceSessionTracker,
  countEligibleVoiceMembers,
  voiceXpGain,
  desiredLevelRoles,
  isVoiceEligible,
  levelStep,
  planLevelRoleChanges,
  shouldEarnTextXp,
  textXpGain,
  voiceMemberMeetsRules
} from "./runtime/levels.js";
import { createMessageCache } from "./logging/message-cache.js";
import { createInviteTracker } from "./logging/invite-tracker.js";
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
import { APPLYABLE_KEYS, startIntegrationAdapter } from "./integration-adapter.js";
import { sweepExpiredDowns } from "./punishments/expiry.js";
import { dataUrlToBuffer, fetchImageBytes, renderWelcomeImage } from "./runtime/welcome-image.js";
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
  if (isProduction(process.env)) {
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
 *
 * The blank-is-absent rule and the "which are missing" answer come from
 * `@al-ai/core`, shared with the dashboard, so the two services cannot drift on
 * what counts as a configured secret.
 * ------------------------------------------------------------------ */
const required = ["BOT_TOKEN", "DATABASE_URL", "EVENT_HMAC_SECRET", "ENCRYPTION_KEY"] as const;
const missing = missingEnv(process.env, required);

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
const token = readEnv(process.env, "BOT_TOKEN")!;
const databaseUrl = readEnv(process.env, "DATABASE_URL")!;
const hmacSecret = readEnv(process.env, "EVENT_HMAC_SECRET")!;
const encryptionKey = readEnv(process.env, "ENCRYPTION_KEY")!;
const dashboardUrl = readEnv(process.env, "DASHBOARD_URL");
/**
 * Where AL AI's own errors and security events are delivered. Deliberately an
 * environment value rather than a per-guild setting: a customer's server must
 * never receive the bot's internals, and no guild should be able to redirect
 * them. Unset means internal events are audited but not delivered anywhere.
 */
const developerWebhookUrl = readEnv(process.env, "DEVELOPER_WEBHOOK_URL");

const lock = acquireInstanceLock();
const database = createBotDatabase(databaseUrl);
const cache = new ConfigCache(guildId => database.loadLogging(guildId));
// Autocomplete only. The command handler reads `loadCommandFlags` directly: a
// setting saved a moment ago has to change how the next command executes, and a
// stale read there would be a silent regression. Autocomplete offers preset
// reasons, where a 30 second lag is the same trade the logging and anti-nuke
// caches already make, and it is the read that fires on every keystroke.
const autocompleteFlags = new ConfigCache(guildId => database.loadCommandFlags(guildId));
const messageCache = createMessageCache();
// Discord names no invite on a join, so the invites the gateway reports are
// held here as one snapshot per guild and a member join is attributed by
// diffing a fresh fetch against it. Created once and shared with `bindEvents`
// so the snapshot the diff reads is the one the listeners wrote to.
const inviteTracker = createInviteTracker();
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
    // Through the detector rather than built by hand: that module owns every
    // `security.*` id, and hand-building one here is how a signal and its
    // builder quietly drift apart — the sibling `auditTamper` call in the probe
    // loop already goes through it.
    const signal = detector.watchdogDown({ component, silentForMs });
    void raiseSecurityEvent(signal.id, signal.data);
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
// The welcome screen's settings, cached on the same 30 second terms: a join is
// the trigger, joins burst, and a dashboard save should land within half a
// minute rather than within a round trip.
const welcomeFlags = new ConfigCache(guildId => database.loadWelcome(guildId));

/**
 * Grants the welcome auto-role, re-checking Discord's hierarchy at assign time.
 *
 * The dashboard validated the role when the setting was saved, but ranks move:
 * a role raised above the bot's since then is refused by Discord, and a role an
 * integration owns cannot be granted at all. Every guard here mirrors a Discord
 * refusal rather than a guess, so a silent `return` always means "Discord would
 * have refused this anyway" — never "we skipped it for no reason".
 */
async function grantAutoRole(member: GuildMember, roleId: string | null, reason: string): Promise<void> {
  if (!roleId) return;
  const role = member.guild.roles.cache.get(roleId);
  const me = member.guild.members.me;
  if (!role || role.managed || !me || role.position >= me.roles.highest.position) return;
  if (member.roles.cache.has(roleId)) return;
  await member.roles.add(roleId, `AL AI — ${reason}`);
}

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

/* ------------------------------------------------------------------ *
 * Levels system — text/voice XP and the role-reward engine.
 *
 * The decision rules live in runtime/levels.ts (pure, unit-tested); this
 * section is the Discord side of the same contract: it reads live state,
 * mutates member roles under the same hierarchy re-check `grantAutoRole`
 * runs, and posts level-up notifications. The settings ride the same 30s
 * ConfigCache terms as every other feature, so a dashboard save lands
 * within half a minute rather than within a restart.
 *
 * The pipeline is one flow for every entry point — message, voice tick,
 * leave-delta, sync: eligibility (core policy) → atomic XP write → level
 * diff → role reconciliation → notification. No path keeps private rules.
 * ------------------------------------------------------------------ */

const levelFlags = new ConfigCache(guildId => database.loadLevelSettings(guildId));
const levelRewards = new ConfigCache(guildId => database.loadLevelRewards(guildId));
// The invites module rides the same 30 second terms: a dashboard save arms —
// or disarms — the scoring within half a minute rather than within a restart.
const inviteFlags = new ConfigCache(guildId => database.loadInviteSettings(guildId));
// رسائل الترحيب ride the same 30 second terms: a dashboard save arms or
// disarms the greeting within half a minute rather than within a restart.
const welcomeMsgFlags = new ConfigCache(guildId => database.loadWelcomeMessages(guildId));
const textCooldown = new TextCooldownGate();
const voiceSessions = new VoiceSessionTracker();

/** Level-up policy, stated once: a jump from level N to N+M notifies once, for N+M. */
const SYNC_BATCH_SIZE = 100;
const SYNC_MEMBER_PACE_MS = 200;

/**
 * Grants and revokes this system's reward roles on one member, counting what
 * actually happened so the sync pass and the logs can report facts instead of
 * intentions. Every change is guarded like `grantAutoRole`: the role must
 * exist, be unmanaged, and sit below the bot's highest — and a Discord
 * refusal is caught and logged, never allowed to end the pass mid-member.
 * Changes are sequential: member edits are per-member rate limited.
 */
async function applyLevelRoles(
  member: GuildMember,
  toAdd: string[],
  toRemove: string[],
  reason: string
): Promise<{ granted: number; removed: number; failed: number }> {
  const outcome = { granted: 0, removed: 0, failed: 0 };
  const me = member.guild.members.me;
  if (!me) return outcome;
  for (const roleId of toAdd) {
    const role = member.guild.roles.cache.get(roleId);
    if (!role || role.managed || role.position >= me.roles.highest.position) {
      console.warn(`AL AI levels: role ${roleId} is beyond the bot's reach in ${member.guild.id}; skipped`);
      outcome.failed++;
      continue;
    }
    try {
      if (!member.roles.cache.has(roleId)) {
        await member.roles.add(roleId, `AL AI — ${reason}`);
        outcome.granted++;
      }
    } catch (error) {
      outcome.failed++;
      console.warn(`AL AI levels: granting ${roleId} in ${member.guild.id} was refused`, error);
    }
  }
  for (const roleId of toRemove) {
    const role = member.guild.roles.cache.get(roleId);
    if (!role || role.managed || role.position >= me.roles.highest.position) continue;
    try {
      if (member.roles.cache.has(roleId)) {
        await member.roles.remove(roleId, `AL AI — ${reason}`);
        outcome.removed++;
      }
    } catch (error) {
      outcome.failed++;
      console.warn(`AL AI levels: revoking ${roleId} in ${member.guild.id} was refused`, error);
    }
  }
  return outcome;
}

/**
 * Evaluates and applies a member's reward roles for their current levels.
 *
 * The desired set is union semantics: a role stays while ANY rule — text,
 * voice or dual — still earns it, and is only revoked when every source is
 * gone. Revokes are confined to roles a rule names; a moderator's
 * hand-assigned role is never touched.
 */
async function evaluateAndApplyRoles(
  member: GuildMember,
  settings: LevelSettings,
  rewards: LevelRoleReward[],
  textLevel: number,
  voiceLevel: number,
  reason: string
): Promise<{ granted: number; removed: number; failed: number }> {
  if (!rewards.length) return { granted: 0, removed: 0, failed: 0 };
  const desired = desiredLevelRoles(rewards, textLevel, voiceLevel, settings.roleStacking);
  const plan = planLevelRoleChanges([...member.roles.cache.keys()], desired, rewards.map(reward => reward.roleId));
  if (!plan.toAdd.length && !plan.toRemove.length) return { granted: 0, removed: 0, failed: 0 };
  return applyLevelRoles(member, plan.toAdd, plan.toRemove, reason);
}

/* ------------------------------------------------------------------ *
 * Invites module — the Discord side of the scoring contract.
 *
 * The decisions (regular / fake / rejoin / self, the milestone diff, the
 * templates) live in @al-ai/core as pure functions; this section is the
 * plumbing: it reads live state, moves the counters, applies the milestone
 * roles through the same hierarchy-guarded writer the levels engine uses,
 * and posts the operator's rendered templates into the invite-log section.
 * ---------------------------------------------------------------- */

/** Cache-first member fetch — bursts of joins must not become bursts of REST calls. */
async function fetchGuildMember(guildId: string, userId: string): Promise<GuildMember | null> {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return null;
  return guild.members.cache.get(userId) ?? (await guild.members.fetch(userId).catch(() => null));
}

/**
 * Reconciles one inviter's milestone roles against their current net, grants
 * what they newly qualify for (revoking only what the milestones themselves
 * name, and only when the operator did not pick keep-roles), and logs one
 * record per granted role.
 */
async function reconcileMilestoneRoles(
  inviter: GuildMember,
  net: number,
  stats: InviteStats,
  settings: Awaited<ReturnType<typeof database.loadInviteSettings>>,
  reason: string
): Promise<void> {
  if (!settings.milestoneRoles.length) return;
  const plan = planMilestoneRoleChanges([...inviter.roles.cache.keys()], net, settings.milestoneRoles, settings.keepRolesOnLeave);
  if (plan.toAdd.length) {
    const outcome = await applyLevelRoles(inviter, plan.toAdd, plan.toRemove, reason);
    if (settings.logMilestones) {
      const text = renderInviteTemplate(settings.milestoneMessage, {
        userMention: `<@${inviter.id}>`,
        userId: inviter.id,
        userAge: "",
        inviterMention: `<@${inviter.id}>`,
        stats,
        inviteCode: ""
      });
      for (const roleId of plan.toAdd.slice(0, Math.max(outcome.granted, 0))) {
        await logEvent(
          "invites.milestone",
          { guildId: inviter.guild.id, actorId: "system", data: { memberId: inviter.id, roleId, net, threshold: net, text } },
          runtime
        ).catch(() => undefined);
      }
    }
    return;
  }
  if (plan.toRemove.length) await applyLevelRoles(inviter, [], plan.toRemove, reason);
}

/**
 * The join half: classify the attribution the gateway resolved, record it,
 * move the inviter's counters, and log the operator's rendered template.
 *
 * Every read between the classification and the write is ordered so the
 * counters report the values the log shows: the bump returns the row *after*
 * the move, and the log carries exactly that row.
 */
async function handleInviteJoin(info: { guildId: string; memberId: string; inviteCode: string | null; inviterId: string | null; isVanity: boolean }): Promise<void> {
  const settings = await inviteFlags.get(info.guildId).catch(() => null);
  if (!settings?.enabled) return;
  const member = await fetchGuildMember(info.guildId, info.memberId);
  if (!member) return;

  const now = Date.now();
  const createdAt = member.user.createdTimestamp;
  const previous = await database.getInviteMember(info.guildId, info.memberId).catch(() => null);
  const decision = classifyInviteJoin({
    joinerId: info.memberId,
    inviteCode: info.inviteCode,
    inviterId: info.inviterId,
    isVanity: info.isVanity,
    accountAgeMs: Math.max(0, now - createdAt),
    previous: previous ? { counted: previous.counted } : null,
    settings
  });

  await database
    .recordInviteJoin(info.guildId, info.memberId, {
      inviterId: decision.inviterId,
      inviteCode: info.inviteCode,
      kind: decision.kind,
      counted: decision.countsToInviter,
      accountAgeMs: now - createdAt
    })
    .catch(() => undefined);

  // Self-invite attempts are recorded (the row says `self`) but their log line
  // is the operator's opt-in: a server under an alt flood turns it off, the
  // scoring never did.
  if (decision.kind === "self" && !settings.logSelfInvites) return;
  if (!settings.logJoins && !decision.countsToInviter && !decision.countsAsFake) return;

  let stats: InviteStats = { regular: 0, fakes: 0, rejoins: 0, leaves: 0, bonus: 0 };
  if (decision.inviterId) {
    stats = decision.countsToInviter
      ? await database.bumpInviteStats(info.guildId, decision.inviterId, { regular: 1 }).catch(() => stats)
      : decision.countsAsFake
        ? await database.bumpInviteStats(info.guildId, decision.inviterId, { fakes: 1 }).catch(() => stats)
        : decision.countsAsRejoin
          ? await database.bumpInviteStats(info.guildId, decision.inviterId, { rejoins: 1 }).catch(() => stats)
          : await database.getInviteStats(info.guildId, decision.inviterId).catch(() => stats);
  }

  const text = renderInviteTemplate(settings.joinMessage, {
    userMention: `<@${info.memberId}>`,
    userId: info.memberId,
    userAge: formatAccountAge(createdAt, now),
    inviterMention: decision.inviterId ? `<@${decision.inviterId}>` : "",
    stats,
    inviteCode: info.inviteCode ?? ""
  });
  if (settings.logJoins) {
    await logEvent(
      "invites.member-join",
      {
        guildId: info.guildId,
        actorId: "system",
        data: {
          memberId: info.memberId,
          ...(info.inviteCode ? { inviteCode: info.inviteCode } : {}),
          ...(decision.inviterId ? { inviterId: decision.inviterId } : {}),
          kind: decision.kind,
          accountAge: formatAccountAge(createdAt, now),
          inviterNet: inviteNet(stats),
          inviterTotal: inviteTotal(stats),
          inviterLeaves: stats.leaves,
          inviterFakes: stats.fakes,
          text
        }
      },
      runtime
    ).catch(() => undefined);
  }

  // Milestones are checked only where the net could have crossed a threshold:
  // a counted join. Fake, rejoin and unattributed joins never move it.
  if (decision.countsToInviter && decision.inviterId) {
    const inviter = await fetchGuildMember(info.guildId, decision.inviterId);
    if (inviter) await reconcileMilestoneRoles(inviter, inviteNet(stats), stats, settings, "رتبة إحالات عند بلوغ العتبة");
  }
}

/* ------------------------------------------------------------------ *
 * Welcome messages — the send half of رسائل الترحيب.
 *
 * The dashboard composes; this resolves the member's real facts (tokens),
 * renders the configured image through the canvas runtime, and hands the
 * payload to Discord. Attribution for {inviter} is a *race*, not a guess:
 * the invite fetch the join already triggered lands within a couple of
 * seconds, so the handler polls the recorded row briefly and prints
 * "غير معروف" the moment the window closes — never a fabricated name.
 * ------------------------------------------------------------------ */

const INVITER_WAIT_MS = 2_500;
const INVITER_POLL_MS = 250;

async function resolveInviterMention(guildId: string, memberId: string): Promise<string> {
  const deadline = Date.now() + INVITER_WAIT_MS;
  while (Date.now() < deadline) {
    const row = await database.getInviteMember(guildId, memberId).catch(() => null);
    if (row?.inviterId) return `<@${row.inviterId}>`;
    await new Promise(resolve => setTimeout(resolve, INVITER_POLL_MS));
  }
  return "";
}

/** The member's facts, in the shape every welcome template's tokens read. */
async function welcomeValuesFor(member: GuildMember): Promise<import("@al-ai/core").WelcomeTemplateValues> {
  const inviterMention = await resolveInviterMention(member.guild.id, member.id);
  return {
    userMention: `<@${member.id}>`,
    username: member.user.username,
    server: member.guild.name,
    memberCount: member.guild.memberCount,
    inviterMention,
    joinDate: new Date().toLocaleDateString("ar", { year: "numeric", month: "long", day: "numeric" })
  };
}

/** The embed half as a plain APIEmbed — discord.js accepts it verbatim. */
function buildWelcomeEmbed(
  embed: WelcomeEmbed,
  member: GuildMember,
  values: import("@al-ai/core").WelcomeTemplateValues,
  attachedImageName: string | null
): APIEmbed {
  const api: APIEmbed = {
    ...(embed.title.trim()
      ? { title: renderWelcomeMessage(embed.title, values), ...(embed.titleUrl ? { url: embed.titleUrl } : {}) }
      : {}),
    ...(embed.description.trim() ? { description: renderWelcomeMessage(embed.description, values) } : {}),
    ...(embed.color ? { color: Number.parseInt(embed.color.slice(1), 16) } : {}),
    ...(embed.thumbnailMode === "member_avatar"
      ? { thumbnail: { url: member.displayAvatarURL({ extension: "png", size: 128 }) } }
      : embed.thumbnailMode === "custom" && embed.thumbnailUrl
        ? { thumbnail: { url: embed.thumbnailUrl } }
        : {}),
    ...(embed.fields.length
      ? {
          fields: embed.fields.map(field => ({
            name: renderWelcomeMessage(field.name, values),
            value: renderWelcomeMessage(field.value, values),
            inline: field.inline
          }))
        }
      : {}),
    ...(embed.footer.trim()
      ? { footer: { text: renderWelcomeMessage(embed.footer, values), ...(embed.footerIconUrl ? { icon_url: embed.footerIconUrl } : {}) } }
      : {}),
    ...(embed.timestamp ? { timestamp: new Date().toISOString() } : {})
  };
  // The generated card takes the embed's large-image slot via its attachment.
  // The embed's own linked image is the fallback when there is no card — and
  // an uploaded image arrives as the message's file, which Discord renders
  // beneath the embed by itself.
  if (attachedImageName) return { ...api, image: { url: `attachment://${attachedImageName}` } };
  if (embed.imageMode === "url" && embed.imageUrl) return { ...api, image: { url: embed.imageUrl } };
  return api;
}

/**
 * The join-time greeting. Every failure degrades one step — no image, then no
 * embed — and never blocks the join pipeline, because the caller runs it
 * detached like every other join write.
 *
 * The three image modes order the sends:
 *  - with_message: one message; the card rides it as its attachment.
 *  - before_message: the card alone leads, then the message follows.
 *  - separate_channel: the card goes to imageChannelId, the message to channelId.
 */
async function handleWelcomeMessage(member: GuildMember): Promise<void> {
  const settings = await welcomeMsgFlags.get(member.guild.id).catch(() => null);
  if (!settings?.enabled || !settings.channelId) return;

  const values = await welcomeValuesFor(member);

  // The generated card. Built once, reused by whichever mode carries it.
  let image: { buffer: Buffer; contentType: string; extension: string } | null = null;
  if (settings.imageEnabled) {
    try {
      const [avatarBuffer, backgroundBuffer] = await Promise.all([
        fetchImageBytes(member.displayAvatarURL({ extension: "png", size: 256 })),
        settings.image.background.imageDataUrl
          ? Promise.resolve(dataUrlToBuffer(settings.image.background.imageDataUrl))
          : Promise.resolve(null)
      ]);
      image = await renderWelcomeImage(settings.image, { values, avatarBuffer, backgroundBuffer });
    } catch (error) {
      console.warn(`AL AI welcome: image render failed in ${member.guild.id}; sending without it`, error);
    }
  }

  const embedImageName = image ? `welcome.${image.extension}` : null;
  const content = settings.mode === "text" ? renderWelcomeMessage(settings.text, values) : undefined;

  // Embed mode with the embed's OWN uploaded image and no generated card:
  // the data URL is decoded into the attachment here, once.
  let embedFile: { buffer: Buffer; name: string; contentType: string } | null = null;
  if (settings.mode === "embed" && !image && settings.embed.imageMode === "upload" && settings.embed.imageDataUrl) {
    const buffer = dataUrlToBuffer(settings.embed.imageDataUrl);
    if (buffer) embedFile = { buffer, name: "embed-image.png", contentType: "image/png" };
  }

  const embed =
    settings.mode === "embed"
      ? buildWelcomeEmbed(
          settings.embed,
          member,
          values,
          settings.imageEnabled && settings.imageMode === "with_message" ? embedImageName : null
        )
      : undefined;

  const card = image
    ? { buffer: image.buffer, name: embedImageName!, contentType: image.contentType }
    : embedFile;

  const sendMessage = () =>
    sendWelcomePayload(client, settings.channelId!, {
      ...(content ? { content } : {}),
      ...(embed ? { embed } : {}),
      // An uploaded embed image (no generated card) rides the message itself.
      ...(!image && embedFile ? { file: embedFile } : {}),
      // The greeting names its member; that member is the only one it may notify.
      memberId: member.id
    });

  if (settings.imageMode === "with_message") {
    const delivered = await sendWelcomePayload(client, settings.channelId, {
      ...(content ? { content } : {}),
      ...(embed ? { embed } : {}),
      ...(card ? { file: card } : {}),
      memberId: member.id
    });
    if (!delivered) console.warn(`AL AI welcome: channel ${settings.channelId} refused the message in ${member.guild.id}`);
    return;
  }

  if (settings.imageMode === "before_message") {
    if (card) {
      const cardSent = await sendWelcomePayload(client, settings.channelId, { file: card, memberId: member.id });
      if (!cardSent) console.warn(`AL AI welcome: the leading card was refused in ${member.guild.id}`);
    }
    const delivered = await sendMessage();
    if (!delivered) console.warn(`AL AI welcome: channel ${settings.channelId} refused the message in ${member.guild.id}`);
    return;
  }

  // separate_channel: the card goes where the operator picked it; the message
  // does not wait for it, and a refused image channel is logged, not fatal.
  if (card) {
    if (settings.imageChannelId) {
      const imageSent = await sendWelcomePayload(client, settings.imageChannelId, { file: card });
      if (!imageSent) {
        console.warn(`AL AI welcome: image channel ${settings.imageChannelId} refused the card in ${member.guild.id}`);
      }
    } else {
      console.warn(`AL AI welcome: separate-channel image mode has no image channel set in ${member.guild.id}; card skipped`);
    }
  }
  const delivered = await sendMessage();
  if (!delivered) console.warn(`AL AI welcome: channel ${settings.channelId} refused the message in ${member.guild.id}`);
}

/**
 * The leave half: a counted referral that departs costs its inviter one leaf
 * and one net point — exactly once, because the row's `counted` flag is what
 * decides, and it flips off in the same breath the deduction lands.
 */
async function handleInviteLeave(guildId: string, memberId: string): Promise<void> {
  const settings = await inviteFlags.get(guildId).catch(() => null);
  if (!settings?.enabled) return;
  const row = await database.getInviteMember(guildId, memberId).catch(() => null);
  if (!row) return;

  const deducted = row.counted && row.inviterId !== null;
  let stats: InviteStats | null = null;
  if (deducted && row.inviterId) {
    stats = await database.bumpInviteStats(guildId, row.inviterId, { leaves: 1 }).catch(() => null);
  }
  await database.markInviteMemberLeft(guildId, memberId).catch(() => undefined);

  if (settings.logLeaves) {
    const inviterStats = stats ?? (row.inviterId ? await database.getInviteStats(guildId, row.inviterId).catch(() => null) : null);
    const text = renderInviteTemplate(settings.leaveMessage, {
      userMention: `<@${memberId}>`,
      userId: memberId,
      userAge: "",
      inviterMention: row.inviterId ? `<@${row.inviterId}>` : "",
      stats: inviterStats ?? { regular: 0, fakes: 0, rejoins: 0, leaves: 0, bonus: 0 },
      inviteCode: row.inviteCode ?? ""
    });
    await logEvent(
      "invites.member-leave",
      {
        guildId,
        actorId: "system",
        data: {
          memberId,
          ...(row.inviterId ? { inviterId: row.inviterId } : {}),
          deducted,
          ...(inviterStats ? { inviterNet: inviteNet(inviterStats) } : {}),
          text
        }
      },
      runtime
    ).catch(() => undefined);
  }

  // The milestone check runs only for a real deduction: an uncounted member
  // leaving changes nothing about their inviter's standing.
  if (deducted && row.inviterId && stats) {
    const inviter = await fetchGuildMember(guildId, row.inviterId);
    if (inviter) await reconcileMilestoneRoles(inviter, inviteNet(stats), stats, settings, "سحب رتبة إحالات بعد مغادرة مُحال");
  }
}

/**
 * Sends a level-up notification to its configured destination.
 *
 * A voice level-up has no source channel — it was earned in a voice room —
 * so "نفس القناة" falls back to the guild's system channel, and to nowhere
 * when that is unset: inventing a destination the operator never picked is
 * worse than staying silent. A closed DM set is dropped quietly, like every
 * other best-effort notify in this bot.
 */
async function sendLevelUpMessage(
  guildId: string,
  kind: "text" | "voice",
  userId: string,
  sourceChannelId: string | null,
  level: number,
  xp: number
): Promise<void> {
  const settings = await levelFlags.get(guildId).catch(() => null);
  if (!settings?.notifyLevelUp) return;
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return;
  const template = kind === "text" ? settings.textLevelUpMessage : settings.voiceLevelUpMessage;
  const content = renderLevelMessage(template, { user: `<@${userId}>`, level, xp, server: guild.name });

  // The rank card: a rich embed carrying the member's avatar and a real
  // progress bar built from the same core formula the screens use. It is an
  // embed card, not a rendered bitmap — Discord-native, so it needs no image
  // pipeline and shows the member's actual numbers.
  let embed: APIEmbed | undefined;
  if (settings.rankCardEnabled) {
    const cap = settings.maxLevelCap === UNLIMITED_LEVEL_CAP ? MAX_LEVEL_CAP : settings.maxLevelCap;
    const progress = levelProgress(xp, cap);
    const filled = Math.round(progress.percent / 10);
    const bar = "█".repeat(filled) + "░".repeat(10 - filled);
    const member = guild.members.cache.get(userId);
    embed = {
      title: kind === "text" ? "🎖️ ترقية مستوى كتابي" : "🎙️ ترقية مستوى صوتي",
      description: `${bar}\nالتقدم نحو المستوى ${progress.level + 1}: ${progress.percent}%`,
      color: 0xf59e0b,
      ...(member?.user.displayAvatarURL({ size: 128 }) ? { thumbnail: { url: member.user.displayAvatarURL({ size: 128 }) } } : {}),
      fields: [
        { name: "المستوى", value: String(progress.level), inline: true },
        { name: "إجمالي XP", value: xp.toLocaleString("en"), inline: true },
        { name: "للمستوى التالي", value: progress.xpForNextLevel.toLocaleString("en"), inline: true }
      ]
    };
  }

  if (settings.notifyMode === "send_dm") {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (member) {
      await member
        .send({ content, embeds: embed ? [embed] : undefined, allowedMentions: allowedMentionsFor(userId) })
        .catch(() => undefined);
    }
    return;
  }
  const channelId =
    settings.notifyMode === "custom_channel"
      ? settings.notifyChannelId
      : kind === "text"
        ? sourceChannelId
        : (guild.systemChannelId ?? null);
  if (!channelId) return;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (channel?.isTextBased() && "send" in channel) {
    // The level-up names the member it is about; that member is the only one
    // it may notify.
    await channel
      .send({ content, embeds: embed ? [embed] : undefined, allowedMentions: allowedMentionsFor(userId) })
      .catch(() => undefined);
  }
}

/**
 * The text-XP leg: cooldown gate, then one atomic XP write, then level-up
 * handling. The write returns the previous *and* new totals from the same
 * statement, so a level-up is only announced on a previous state that the
 * write itself vouched for — a database hiccup skips the grant entirely
 * rather than minting a level-up from a fake zero.
 */
async function handleLevelTextMessage(message: {
  guildId: string;
  channelId: string;
  parentChannelId: string | null;
  authorId: string;
  isBot: boolean;
  isWebhook: boolean;
  isSystem: boolean;
  memberRoleIds: string[] | null;
  displayName: string | null;
  avatarHash: string | null;
}): Promise<void> {
  const settings = await levelFlags.get(message.guildId).catch(() => null);
  if (
    !settings ||
    !shouldEarnTextXp(settings, {
      isBot: message.isBot,
      isWebhook: message.isWebhook,
      isSystem: message.isSystem,
      channelId: message.channelId,
      parentChannelId: message.parentChannelId,
      memberRoleIds: message.memberRoleIds
    })
  ) {
    return;
  }
  if (!textCooldown.tryConsume(message.guildId, message.authorId, settings.textCooldownSeconds)) return;

  const result = await database
    .recordTextXp(
      message.guildId,
      message.authorId,
      applyXpMultipliers(textXpGain(settings), settings.roleMultipliers, settings.channelMultipliers, {
        roleIds: message.memberRoleIds,
        channelId: message.channelId
      }),
      {
      displayName: message.displayName,
      avatarHash: message.avatarHash
    })
    .catch(() => null);
  if (!result) return;
  const cap = settings.maxLevelCap === UNLIMITED_LEVEL_CAP ? MAX_LEVEL_CAP : settings.maxLevelCap;
  const step = levelStep(result.previous?.textXp ?? 0, result.current.textXp, cap);
  if (!step.leveledUp) return;

  const rewards = await levelRewards.get(message.guildId).catch(() => []);
  const guild = client.guilds.cache.get(message.guildId);
  const member = guild ? await guild.members.fetch(message.authorId).catch(() => null) : null;
  if (guild && member) {
    await evaluateAndApplyRoles(
      member,
      settings,
      rewards,
      step.level,
      levelFromXp(result.current.voiceXp),
      `بلوغ المستوى الكتابي ${step.level}`
    );
  }
  await sendLevelUpMessage(message.guildId, "text", message.authorId, message.channelId, step.level, result.current.textXp);
}

/**
 * Credits whole accrued voice minutes for one member.
 *
 * Called by the minute tick (for every eligible session) and by the leave
 * handler (for the final delta). The XP write is atomic — previous and new
 * totals in one statement — so a jump across several levels notifies once,
 * for the highest level reached, and never from an unreliable previous state.
 */
async function creditVoiceMinutes(
  guildId: string,
  member: GuildMember,
  minutes: number,
  settings: LevelSettings,
  rewards: LevelRoleReward[]
): Promise<void> {
  // One draw per minute: a three-minute credit draws three times, so the
  // range shapes the total the way one-minute credits do.
  let amount = 0;
  for (let i = 0; i < minutes; i++) {
    amount += applyXpMultipliers(voiceXpGain(settings), settings.roleMultipliers, settings.channelMultipliers, {
      roleIds: [...member.roles.cache.keys()],
      channelId: member.voice.channelId
    });
  }
  const result = await database
    .recordVoiceXp(guildId, member.id, amount, {
      displayName: member.displayName,
      avatarHash: member.user.avatar
    })
    .catch(() => null);
  if (!result) return;
  const cap = settings.maxLevelCap === UNLIMITED_LEVEL_CAP ? MAX_LEVEL_CAP : settings.maxLevelCap;
  const step = levelStep(result.previous?.voiceXp ?? 0, result.current.voiceXp, cap);
  if (!step.leveledUp) return;
  await evaluateAndApplyRoles(
    member,
    settings,
    rewards,
    levelFromXp(result.current.textXp),
    step.level,
    `بلوغ المستوى الصوتي ${step.level}`
  );
  await sendLevelUpMessage(guildId, "voice", member.id, null, step.level, result.current.voiceXp);
}

/**
 * The voice-state leg of hybrid timing: sessions open on join, follow channel
 * moves, and close on leave with the remaining whole minutes credited.
 *
 * The leave-time delta is credited only if the member still passes the
 * member-level rules and the room they left still meets the minimum — the
 * engine cannot re-judge the past, and a dropped remainder is at most one
 * minute because the tick credits every minute.
 */
async function handleLevelVoiceStateChange(change: {
  guildId: string;
  memberId: string;
  channelId: string | null;
  selfMute: boolean;
  selfDeaf: boolean;
  serverMute: boolean;
  serverDeaf: boolean;
}): Promise<void> {
  if (change.channelId) {
    if (!voiceSessions.isActive(change.guildId, change.memberId)) {
      voiceSessions.onJoin(change.guildId, change.memberId, change.channelId, Date.now());
    } else {
      voiceSessions.onMove(change.guildId, change.memberId, change.channelId);
    }
    return;
  }
  const minutes = voiceSessions.minutesToCredit(change.guildId, change.memberId, Date.now());
  const leftChannelId = voiceSessions.onLeave(change.guildId, change.memberId);
  if (!leftChannelId || minutes <= 0) return;
  const settings = await levelFlags.get(change.guildId).catch(() => null);
  if (!settings?.enabled || !settings.voiceXpEnabled || settings.voiceXpMax <= 0) return;
  const guild = client.guilds.cache.get(change.guildId);
  if (!guild) return;
  const member = await guild.members.fetch(change.memberId).catch(() => null);
  if (!member) return;
  // The room the member left: remaining eligible members decide whether the
  // final minutes qualify. The leaver is already out of the live cache.
  const channel = guild.channels.cache.get(leftChannelId);
  const remaining = channel?.isVoiceBased() ? [...channel.members.values()].filter(m => !m.user.bot) : [];
  const remainingEligible = countEligibleVoiceMembers(
    settings,
    remaining.map(m => ({
      isBot: m.user.bot,
      channelId: m.voice.channelId,
      memberRoleIds: [...m.roles.cache.keys()],
      selfMute: m.voice.selfMute ?? false,
      selfDeaf: m.voice.selfDeaf ?? false,
      serverMute: m.voice.serverMute ?? false,
      serverDeaf: m.voice.serverDeaf ?? false
    })),
    { afkChannelId: guild.afkChannelId }
  );
  const passesRules = voiceMemberMeetsRules(
    settings,
    {
      isBot: false,
      channelId: leftChannelId,
      memberRoleIds: [...member.roles.cache.keys()],
      selfMute: change.selfMute,
      selfDeaf: change.selfDeaf,
      serverMute: change.serverMute,
      serverDeaf: change.serverDeaf
    },
    { afkChannelId: guild.afkChannelId }
  );
  if (!passesRules || remainingEligible + 1 < settings.voiceMinMembers) return;
  const rewards = await levelRewards.get(change.guildId).catch(() => []);
  await creditVoiceMinutes(change.guildId, member, minutes, settings, rewards);
}

/**
 * The minute clock: sync jobs first, then voice credit.
 *
 * The in-flight guard makes overlapping ticks impossible — a slow pass
 * (a large sync, a DB latency spike) is skipped by the next interval rather
 * than run a second time in parallel, which would double every credit.
 */
async function runLevelsTick(): Promise<void> {
  const startedAt = Date.now();
  textCooldown.sweep();

  // Sync jobs: claimed atomically, worked to completion (or failure with the
  // cursor kept for resume), never dropped.
  const jobs = await database.openSyncJobs().catch(() => []);
  for (const job of jobs) {
    if (!(await database.claimSyncJob(job.id).catch(() => false))) continue;
    await runLevelRoleSyncJob(job.id, job.guildId).catch(async error => {
      console.warn(`AL AI levels: sync job ${job.id} failed`, error);
      await database.failSyncJob(job.id, error instanceof Error ? error.message : String(error)).catch(() => undefined);
    });
  }

  // Voice credit, per guild per channel. The tracker is reconciled against
  // live state first: a member in voice without a session (a missed event, a
  // restart) opens one now so they start accruing; a session whose member has
  // left voice closes without paying.
  for (const guild of client.guilds.cache.values()) {
    const settings = await levelFlags.get(guild.id).catch(() => null);
    if (!settings?.enabled || !settings.voiceXpEnabled || settings.voiceXpMax <= 0) continue;
    const rewards = await levelRewards.get(guild.id).catch(() => []);
    for (const channel of guild.channels.cache.values()) {
      if (!channel.isVoiceBased()) continue;
      const humans = [...channel.members.values()].filter(member => !member.user.bot);
      const facts = humans.map(member => ({
        isBot: member.user.bot,
        channelId: channel.id,
        memberRoleIds: [...member.roles.cache.keys()],
        selfMute: member.voice.selfMute ?? false,
        selfDeaf: member.voice.selfDeaf ?? false,
        serverMute: member.voice.serverMute ?? false,
        serverDeaf: member.voice.serverDeaf ?? false
      }));
      // One eligibility policy for both the count and the grant.
      const eligibleCount = countEligibleVoiceMembers(settings, facts, { afkChannelId: guild.afkChannelId });
      for (let i = 0; i < humans.length; i++) {
        const member = humans[i];
        const now = Date.now();
        if (!voiceSessions.isActive(guild.id, member.id)) {
          voiceSessions.onJoin(guild.id, member.id, channel.id, now);
          continue;
        }
        if (voiceSessions.minutesToCredit(guild.id, member.id, now) <= 0) continue;
        const eligible = isVoiceEligible(settings, facts[i], { afkChannelId: guild.afkChannelId, eligibleCount });
        if (eligible) {
          const minutes = voiceSessions.minutesToCredit(guild.id, member.id, now);
          await creditVoiceMinutes(guild.id, member, minutes, settings, rewards);
        }
        // The clock advances whether or not the minute was eligible — the
        // engine judges the present, never the past.
        voiceSessions.markCredited(guild.id, member.id, now);
      }
    }
  }

  const durationMs = Date.now() - startedAt;
  await database.setSetting("levels.last_voice_tick_at", new Date().toISOString()).catch(() => undefined);
  await database.setSetting("levels.voice_sessions", String(voiceSessions.size())).catch(() => undefined);
  if (durationMs > 5_000) {
    console.warn(`AL AI levels: tick took ${durationMs}ms — consider the sync pace on large guilds`);
  }
}

/**
 * Runs one claimed sync job to completion: keyset-paginated over every ranked
 * member (no silent cap), reconciling reward roles and reporting counters
 * into the persistent job row as it goes, so the dashboard shows live
 * progress and a restart resumes from the cursor rather than starting over.
 */
async function runLevelRoleSyncJob(jobId: string, guildId: string): Promise<void> {
  const settings = await levelFlags.get(guildId).catch(() => null);
  if (!settings?.enabled) {
    await database.failSyncJob(jobId, "نظام المستويات معطل في هذا السيرفر — فعّله ثم أعد المزامنة.");
    return;
  }
  const rewards = await levelRewards.get(guildId).catch(() => []);
  const guild = client.guilds.cache.get(guildId);
  if (!guild) {
    await database.failSyncJob(jobId, "البوت غير موجود في هذا السيرفر حالياً.");
    return;
  }
  const total = await database.countLevelRanks(guildId).catch(() => 0);
  await database.setSyncJobTotal(jobId, total);

  const counters = { processed: 0, granted: 0, removed: 0, skipped: 0, failed: 0 };
  let cursor: string | null = null;
  if (!rewards.length) {
    await database.completeSyncJob(jobId, { granted: 0, removed: 0, skipped: 0, failed: 0 });
    return;
  }
  for (;;) {
    const page = await database.levelRanksPage(guildId, cursor, SYNC_BATCH_SIZE);
    if (!page.length) break;
    for (const rank of page) {
      cursor = rank.userId;
      counters.processed++;
      const member = await guild.members.fetch(rank.userId).catch(() => null);
      if (!member) {
        counters.skipped++;
        continue;
      }
      const syncCap = settings.maxLevelCap === UNLIMITED_LEVEL_CAP ? MAX_LEVEL_CAP : settings.maxLevelCap;
      const outcome = await evaluateAndApplyRoles(
        member,
        settings,
        rewards,
        levelFromXp(rank.textXp, syncCap),
        levelFromXp(rank.voiceXp, syncCap),
        "مزامنة رتب المستويات"
      );
      counters.granted += outcome.granted;
      counters.removed += outcome.removed;
      counters.failed += outcome.failed;
      await new Promise(resolve => setTimeout(resolve, SYNC_MEMBER_PACE_MS));
    }
    await database.updateSyncJobProgress(jobId, {
      cursor,
      processed: counters.processed,
      granted: counters.granted,
      removed: counters.removed,
      skipped: counters.skipped,
      failed: counters.failed
    });
  }
  await database.completeSyncJob(jobId, {
    granted: counters.granted,
    removed: counters.removed,
    skipped: counters.skipped,
    failed: counters.failed
  });
  console.log(
    `AL AI levels: sync ${jobId} of ${guildId} completed — processed ${counters.processed}, granted ${counters.granted}, removed ${counters.removed}, skipped ${counters.skipped}, failed ${counters.failed}`
  );
}

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

/** Operator-facing wording for every way a role action can fail. */
const roleFailureMessages: Record<string, string> = {
  GUILD_UNREACHABLE: "تعذّر الوصول إلى السيرفر.",
  MEMBER_NOT_FOUND: "هذا العضو ليس في السيرفر.",
  // The likely causes are named because the operator cannot tell them apart from
  // the outside: Discord refuses a role that sits above the bot and a role that
  // has been deleted in exactly the same way.
  NO_ROLE_APPLIED: "لم تُطبَّق أي رتبة. تأكّد أن الرتبة ما زالت موجودة وأن رتبة البوت أعلى منها في ترتيب الرتب."
};

/**
 * Resolves a published command name to the command it actually stands for.
 *
 * Discord has no alias mechanism, so an alias is registered as a real command
 * under its own name — `/باند` is a command, not a pointer at `/ban`. Which
 * command it stands for is a per-guild preference, so the answer can only come
 * from that guild's rows and never from the registry alone.
 *
 * Resolving to the canonical name is what keeps an alias from becoming a second
 * command: the definition, the permission tier, the cooldown key and the stored
 * configuration are all read for the command it stands for, so an alias cannot
 * hold a permission of its own.
 */
function resolveCommandAlias(configured: Map<string, Partial<CommandConfig>>, commandName: string): string {
  const { map } = buildAliasMap(
    [...configured].map(([name, config]) => ({ name, aliases: config.aliases }))
  );
  return map.get(commandName) ?? commandName;
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
  inviteTracker,

  /**
   * The welcome feature's half: a human join earns the members' auto-role and a
   * bot's arrival earns the bots' — each only when the switch is armed and the
   * guild picked a role for that kind of arrival.
   */
  onMemberJoin: async member => {
    // رسائل الترحيب: detached beside the join — a slow render or a refused
    // channel never delays the auto-role grant or the join being logged.
    void handleWelcomeMessage(member).catch(error =>
      console.error("AL AI welcome: greeting failed", error)
    );
    const settings = await welcomeFlags.get(member.guild.id).catch(() => null);
    if (!settings?.enabled) return;
    if (settings.delaySeconds > 0) {
      // The delay is a scheduled write, not a blocked one: the join is logged
      // now, and the grant fires later against whatever hierarchy holds then —
      // grantAutoRole re-checks everything, so a stale delay is still safe.
      const timer = setTimeout(() => {
        void grantAutoRole(member, settings.memberRoleId, "رتبة تلقائية لعضو جديد (بعد التأخير)").catch(() => undefined);
      }, settings.delaySeconds * 1000);
      timer.unref?.();
      return;
    }
    await grantAutoRole(member, settings.memberRoleId, "رتبة تلقائية لعضو جديد");
  },
  onBotJoin: async member => {
    const settings = await welcomeFlags.get(member.guild.id).catch(() => null);
    if (!settings?.enabled) return;
    await grantAutoRole(member, settings.botRoleId, "رتبة تلقائية لبوت جديد");
  },


  /**
   * The invites module's join half, fed by the attribution the gateway
   * listener resolved after the join (a diff, not a field). Detached by the
   * same contract as every join write: the join is logged whatever the
   * scoring decides.
   */
  onInviteUse: info => handleInviteJoin(info),

  /**
   * The invites leaderboard's pager. No command pipeline applies to a button,
   * so the guard here is the honest one: the page must parse, and the module
   * must still be armed — a pager left on a message outliving its feature
   * answers with an explanation rather than stale data.
   */
  onComponent: async ({ customId, guildId, update, replyEphemeral }) => {
    if (!customId.startsWith(INVITES_PAGER_PREFIX)) return;
    const page = Number(customId.slice(INVITES_PAGER_PREFIX.length));
    if (!Number.isInteger(page) || page < 0) return;
    const settings = await inviteFlags.get(guildId).catch(() => null);
    if (!settings?.enabled) {
      await replyEphemeral("موديول الإحالات معطّل في هذا السيرفر حالياً.");
      return;
    }
    const total = await database.countInviteStats(guildId).catch(() => 0);
    const totalPages = Math.max(1, Math.ceil(total / INVITES_LEADERBOARD_PER_PAGE));
    const target = Math.min(page, totalPages - 1);
    const rows = await database.inviteLeaderboardPage(guildId, INVITES_LEADERBOARD_PER_PAGE, target * INVITES_LEADERBOARD_PER_PAGE).catch(() => []);
    const card = buildInviteLeaderboardMessage(
      rows.map(row => ({ userId: row.userId, net: inviteNet(row), total: inviteTotal(row), leaves: row.leaves })),
      target,
      totalPages
    );
    await update({ embeds: card.embeds, components: card.components }).catch(() => undefined);
  },

  /**
   * The levels system's text-XP leg. Detached like the join writes: the
   * cooldown gate answers from memory, so a busy channel never slows the
   * message being logged.
   */
  onGuildMessage: message => handleLevelTextMessage(message),

  /**
   * The voice sessions leg of hybrid timing: join/move/leave keep the
   * tracker in sync with reality, and a leave credits its remaining whole
   * minutes immediately instead of waiting for the next tick.
   */
  onVoiceStateChange: change => handleLevelVoiceStateChange(change),

  /**
   * Reset-on-leave: when the operator armed it, a departing member's XP is
   * zeroed and their reward roles are queued for reconciliation — a role the
   * member no longer qualifies for must not outlive the levels that earned it.
   */
  onMemberLeave: async member => {
    const settings = await levelFlags.get(member.guild.id).catch(() => null);
    if (settings?.enabled && settings.resetOnLeave) {
      const removed = await database.resetMemberXp(member.guild.id, member.id).catch(() => false);
      if (removed) {
        await database.createOrResumeSyncJob(member.guild.id).catch(() => undefined);
        console.log(`AL AI levels: reset XP of departing member ${member.id} in ${member.guild.id}`);
      }
    }
    // The invites module's leave half: a counted referral costs its inviter a
    // point, the milestone roles re-check, and the operator's template logs.
    await handleInviteLeave(member.guild.id, member.id).catch(error =>
      console.error(`AL AI invites: leave handling failed for ${member.id} in ${member.guild.id}`, error)
    );
  },

  /**
   * Serves the operator's ready-made reasons to Discord's autocomplete.
   *
   * Read from the cached configuration, never from Discord: an autocomplete
   * interaction has to be answered within three seconds or Discord shows the
   * operator an error, and a round trip to fetch a role list would not fit.
   */
  onAutocomplete: async ({ guildId, commandName, focusedOption, focusedValue }) => {
    if (focusedOption !== "reason") return [];

    // The alias is resolved here for the same reason it is resolved in the
    // command handler: `/باند` carries `/ban`'s options, so its reason field has
    // to offer `/ban`'s preset reasons. Without this an alias would autocomplete
    // nothing and read as a broken copy of the command it stands for.
    const configured = await autocompleteFlags.get(guildId).catch(() => new Map<string, Partial<CommandConfig>>());
    const canonical = resolveCommandAlias(configured, commandName);

    let definition;
    try {
      definition = requireCommand(canonical);
    } catch {
      return [];
    }
    const config = normaliseCommandConfig(definition, configured.get(canonical));
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
    commandName: requestedName,
    targetId,
    numbers,
    strings,
    reason,
    reply,
    retractOnLeave
  }) => {
    // Rebound to the command this one stands for as soon as the guild's rows are
    // read. Everything below compares against a canonical name, so resolving the
    // alias here means the rest of the handler never has to know one was used.
    let commandName = requestedName;

    // The alias is recorded beside the command rather than instead of it: the
    // canonical name is what ran and what the permissions were checked against,
    // while the alias is the string the operator will search the log for.
    const aliasNote = () => (commandName === requestedName ? {} : { alias: requestedName });

    const reject = async (message: string, detail: string) => {
      const signal = detector.authorizationFailure({ guildId, actorId: userId, action: commandName, reason: detail });
      // Past the burst budget the critical audit write stops: the command path
      // does not cross the gateway's rate ceiling, so a member hammering an
      // unauthorized command used to grow the append-only audit trail without
      // bound. The first attempts in the window still land — the budget is
      // checked BEFORE recording this one, so the story is written once and
      // the flood behind it is not.
      if (!detector.isAuthorizationBursting(guildId, userId)) {
        await raiseSecurityEvent(signal.id, signal.data, guildId);
      }
      await logEvent("bot.command-failure", { guildId, actorId: userId, data: { command: commandName, ...aliasNote(), reason: detail } }, runtime).catch(() => undefined);
      await reply(message, { autoDeleteSeconds });
    };

    const succeed = async (message: string) => {
      await logEvent("bot.command-success", { guildId, actorId: userId, data: { command: commandName, ...aliasNote() } }, runtime).catch(() => undefined);
      await reply(message, { autoDeleteSeconds });
    };

    // Raised as soon as the guild's configuration is known, so every reply —
    // including the refusals — honours the operator's tidiness setting.
    let autoDeleteSeconds = 0;

    // 1. This guild's configuration, read before the registry lookup because an
    //    alias only means something inside the guild that configured it: `/باند`
    //    is a real published command, but which command it stands for is a
    //    per-guild preference, and resolving that needs this guild's own rows.
    const configured = await database.loadCommandFlags(guildId);
    commandName = resolveCommandAlias(configured, requestedName);

    // 2. The command must exist in the registry.
    let definition;
    try {
      definition = requireCommand(commandName);
    } catch {
      await reject("هذا الأمر غير مسجل في AL AI.", "UNKNOWN_COMMAND");
      return;
    }

    // 3. The configuration is normalised against the definition so a control the
    //    command does not support can never be honoured — a purge setting on
    //    `/warn` would be a switch that does nothing.
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
      // `configured` was already read at the top of the handler for the alias
      // lookup. This used to read the same flags a second time — two identical
      // round trips on one command, and the second could not even fail: the
      // first read is awaited without a catch, so a rejection would have thrown
      // long before reaching here.
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

    /* ---------------- Server-wide wipes ---------------- */
    // Handled before the channel branch rather than inside it. They are not
    // channel actions — folding them into that ternary would read as though
    // `/clearallwarns` acted on the channel it was typed in, and the success
    // message would be built from `channelSuccessMessages`, which knows nothing
    // about them.
    if (commandName === "clearallwarns" || commandName === "clearallpunishments") {
      const warningsOnly = commandName === "clearallwarns";
      const removed = warningsOnly
        ? { warnings: await database.clearAllWarnings(guildId), states: 0 }
        : await database.clearAllPunishments(guildId);

      const wipeData = {
        guildId,
        actorId: userId,
        data: { actorId: userId, warnings: removed.warnings, states: removed.states, reason: trimmedReason || "—" }
      };

      // Logged by the handler, not by the gateway: nothing in Discord reports a
      // deletion from our own tables, so without this the wipe would leave no
      // trace anywhere — and it is the one action here with no undo at all.
      //
      // Two literal calls rather than one ternary. `routing.test.ts` matches the
      // event ID as a literal first argument so that a declaration nothing
      // produces cannot hide behind a variable; a ternary reads correctly, type
      // checks, and would make both of these invisible to that guard.
      if (warningsOnly) {
        await logEvent("moderation.clearallwarns", wipeData, runtime).catch(() => undefined);
      } else {
        await logEvent("moderation.clearallpunishments", wipeData, runtime).catch(() => undefined);
      }

      // Both numbers when both moved. Reporting only the warnings after a wipe
      // that also released muted and jailed members would understate what
      // happened, and the operator has no undo to go and check.
      const parts = [`${removed.warnings} تحذيراً`];
      if (!warningsOnly) parts.push(`${removed.states} عقوبة سارية`);
      await succeed(`تم مسح ${parts.join(" و")} في هذا السيرفر.`);
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

    if (!actorPositions || botPosition === null) {
      await reject("تعذّر التحقق من الرتب.", "HIERARCHY_UNAVAILABLE");
      return;
    }

    // A banned target is by definition no longer a member — `/unban` could
    // never pass the old "target must be readable" gate — and the record
    // commands may name someone who already left. Discord still refuses the
    // mutations it should refuse, so a missing target reads as position-less
    // instead of failing the whole command. The actor and bot reads stay
    // mandatory: without them there is no hierarchy to reason about.
    const hierarchy = checkHierarchy({
      actorId: userId,
      targetId,
      actorHighestPosition: actorPositions.highestPosition,
      targetHighestPosition: targetPositions?.highestPosition ?? -1,
      botHighestPosition: botPosition,
      actorIsGuildOwner: actorPositions.isGuildOwner,
      targetIsGuildOwner: targetPositions?.isGuildOwner ?? false
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

    /* ---------------- The state-based punishments ----------------
     *
     * Everything below comes down to putting a role on or taking one off, plus a
     * row recording what was done so the inverse can undo it exactly.
     *
     * The role each one uses is a guild setting on the command that applies it,
     * and the inverse reads it from that same row — `/unmute` has no muted-role
     * field of its own and reads `/mute`'s. That is the point of the ownership
     * map: one place to name the role, so the two commands cannot end up
     * disagreeing about which one is the muted role.
     */
    const roleConfigFor = (owner: string) => normaliseCommandConfig(requireCommand(owner), configured.get(owner));

    /**
     * The envelope for one state-based punishment.
     *
     * Only the envelope — the `logEvent` call itself is written out at each site
     * with the event ID as a literal. `routing.test.ts` asserts that every
     * declared event appears as a literal first argument somewhere, precisely so
     * a declaration nothing produces cannot hide behind a variable. Passing the
     * ID in here would satisfy the call and defeat the check.
     */
    const punishmentData = (extra: Record<string, unknown> = {}) => ({
      guildId,
      actorId: userId,
      data: { targetId, actorId: userId, reason: trimmedReason || "—", ...extra }
    });

    /** A role action that failed is refused with the reason, never reported as done. */
    const runRoleAction = async (kind: "grant" | "revoke", roleIds: readonly string[], fallbackReason: string) => {
      const result = await applyRoleChange(client, {
        kind,
        guildId,
        targetId,
        roleIds,
        reason: trimmedReason || fallbackReason
      });
      if (!result.ok) {
        await reject(roleFailureMessages[result.reason] ?? "تعذّر تنفيذ الإجراء.", result.reason);
        return null;
      }
      // Named when partial. A `/down` that stripped three of five roles must not
      // read as though it stripped five — the operator would have no reason to
      // go and look.
      return result;
    };

    /* ---- /mute and /unmute ---- */
    if (commandName === "mute" || commandName === "unmute") {
      const granting = commandName === "mute";
      const mutedRoleId = roleConfigFor("mute").mutedRoleId;
      if (!mutedRoleId) {
        // Refused rather than invented. A role the bot created itself would carry
        // no permission overrides, so the mute would look applied and silence
        // nobody — the exact defect this project treats as its worst kind.
        await reject("لم تُضبط رتبة المكتوم. اضبطها من بطاقة الأمر /mute في اللوحة.", "MUTED_ROLE_UNSET");
        return;
      }

      const applied = await runRoleAction(granting ? "grant" : "revoke", [mutedRoleId], granting ? "كتم" : "فك الكتم");
      if (!applied) return;

      if (granting) {
        await database.setMemberState({
          id: randomUUID(),
          guildId,
          userId: targetId,
          kind: "mute",
          moderatorId: userId,
          reason: trimmedReason
        });
        await logEvent("moderation.mute", punishmentData(), runtime).catch(() => undefined);
      } else {
        // The snapshot is discarded rather than restored: a mute adds a role and
        // takes none away, so there is nothing to give back.
        await database.takeMemberState(guildId, targetId, "mute");
        await logEvent("moderation.unmute", punishmentData(), runtime).catch(() => undefined);
      }

      await maybeNotify(config, guildId, targetId, granting ? `تم كتمك في السيرفر. السبب: ${trimmedReason || "غير محدد"}` : "تم فك الكتم عنك في السيرفر.");
      await succeed(granting ? `تم كتم <@${targetId}>.` : `تم فك الكتم عن <@${targetId}>.`);
      return;
    }

    /* ---- /prison and /unprison ---- */
    if (commandName === "prison" || commandName === "unprison") {
      const granting = commandName === "prison";
      const prison = roleConfigFor("prison");
      if (!prison.prisonRoleId) {
        await reject("لم تُضبط رتبة السجن. اضبطها من بطاقة الأمر /prison في اللوحة.", "PRISON_ROLE_UNSET");
        return;
      }

      if (granting) {
        // Read before the role is applied, and read from Discord rather than from
        // our own record: this is the snapshot `/unprison` gives back, and the
        // only moment it can be taken.
        const before = await readMemberRoleIds(client, guildId, targetId);
        const snapshot = before.filter(roleId => roleId !== prison.prisonRoleId && roleId !== guildId);

        const applied = await runRoleAction("grant", [prison.prisonRoleId], "سجن");
        if (!applied) return;

        await database.setMemberState({
          id: randomUUID(),
          guildId,
          userId: targetId,
          kind: "prison",
          roleIds: snapshot,
          moderatorId: userId,
          reason: trimmedReason
        });

        // Only if a channel is configured, and only if they are in voice. There
        // is no "move" for text: confinement there is the prison role's channel
        // overwrites, which is the role's job and not this call's.
        if (prison.prisonChannelId) {
          await moveMemberToChannel(client, {
            guildId,
            targetId,
            channelId: prison.prisonChannelId,
            reason: trimmedReason || "سجن"
          }).catch(() => false);
        }

        await logEvent("moderation.prison", punishmentData({ restoredRoles: snapshot.length }), runtime).catch(() => undefined);
        await maybeNotify(config, guildId, targetId, `تم سجنك في السيرفر. السبب: ${trimmedReason || "غير محدد"}`);
        await succeed(`تم سجن <@${targetId}>.`);
        return;
      }

      // `take` rather than `get` + delete: it hands the snapshot back exactly
      // once, so two moderators running `/unprison` together cannot both restore
      // it and re-add roles the first had already dealt with.
      const state = await database.takeMemberState(guildId, targetId, "prison");
      const restored = await runRoleAction("grant", state?.roleIds ?? [], "إخراج من السجن");
      if (!restored) return;
      await runRoleAction("revoke", [prison.prisonRoleId], "إخراج من السجن");

      await logEvent("moderation.unprison", punishmentData({ restoredRoles: restored.changed.length }), runtime).catch(() => undefined);
      await maybeNotify(config, guildId, targetId, "تم إخراجك من السجن في السيرفر.");
      await succeed(
        state
          ? `تم إخراج <@${targetId}> من السجن وإعادة ${restored.changed.length} رتبة.`
          : `تم إخراج <@${targetId}> من السجن. لم يكن هناك سجل رتب محفوظ.`
      );
      return;
    }

    /* ---- /blacklist and /unblacklist ---- */
    if (commandName === "blacklist" || commandName === "unblacklist") {
      const granting = commandName === "blacklist";
      const blacklistRoleIds = roleConfigFor("blacklist").blacklistRoleIds;
      if (blacklistRoleIds.length === 0) {
        await reject("لم تُضبط رتب البلاك ليست. اضبطها من بطاقة الأمر /blacklist في اللوحة.", "BLACKLIST_ROLES_UNSET");
        return;
      }

      const applied = await runRoleAction(granting ? "grant" : "revoke", blacklistRoleIds, granting ? "بلاك ليست" : "فك البلاك ليست");
      if (!applied) return;

      if (granting) {
        await database.setMemberState({
          id: randomUUID(),
          guildId,
          userId: targetId,
          kind: "blacklist",
          moderatorId: userId,
          reason: trimmedReason
        });
        await logEvent("moderation.blacklist", punishmentData({ roles: blacklistRoleIds.length }), runtime).catch(() => undefined);
      } else {
        await database.takeMemberState(guildId, targetId, "blacklist");
        await logEvent("moderation.unblacklist", punishmentData({ roles: blacklistRoleIds.length }), runtime).catch(() => undefined);
      }

      await maybeNotify(config, guildId, targetId, granting ? "تم إدراجك في القائمة السوداء في السيرفر." : "تم فك القائمة السوداء عنك.");
      await succeed(granting ? `تم إدراج <@${targetId}> في القائمة السوداء.` : `تم فك القائمة السوداء عن <@${targetId}>.`);
      return;
    }

    /* ---- /block and /unblock ---- */
    if (commandName === "block" || commandName === "unblock") {
      const blockableRoleIds = roleConfigFor("block").blockableRoleIds;
      const requested = strings.role?.trim();

      if (commandName === "block") {
        // Discord's own role picker supplies the value, but a picker is not a
        // permission check: it can offer every role in the guild. The guild's
        // `blockableRoleIds` is what decides, and it is read here rather than
        // baked into the command's choices because a choice list is frozen at
        // registration and this one has to follow a setting.
        if (!requested) {
          await reject("حدّد الرتبة المطلوبة.", "MISSING_ROLE");
          return;
        }
        if (!blockableRoleIds.includes(requested)) {
          await reject(
            blockableRoleIds.length === 0
              ? "لم تُضبط رتب البلوك. اضبطها من بطاقة الأمر /block في اللوحة."
              : "هذه الرتبة ليست ضمن رتب البلوك المسموح بها لهذا الأمر.",
            "ROLE_NOT_BLOCKABLE"
          );
          return;
        }

        const state = await database.getMemberState(guildId, targetId, "block");
        // Added to the existing set rather than replacing it: blocking a second
        // role must not silently lift the block on the first, which is what an
        // upsert that overwrote `blocked_role_ids` would do.
        const blocked = [...new Set([...(state?.blockedRoleIds ?? []), requested])];

        // Taken away as well as blocked. Without this, `/block` on a member who
        // already holds the role would leave them holding it and report that they
        // are blocked from it. Best-effort rather than refusing: unlike a mute,
        // the block is the standing decision this command exists to record, and
        // it still holds the next time the role is handed out even if taking it
        // away right now failed. `runRoleAction` is the wrong tool here — it
        // replies and logs a `bot.command-failure` on a miss, which would put a
        // failure and this command's success in the audit trail for one action.
        const revoked = await applyRoleChange(client, {
          kind: "revoke",
          guildId,
          targetId,
          roleIds: [requested],
          reason: trimmedReason || "منع من رتبة"
        });

        await database.setMemberState({
          id: randomUUID(),
          guildId,
          userId: targetId,
          kind: "block",
          blockedRoleIds: blocked,
          roleIds: state?.roleIds ?? [],
          moderatorId: userId,
          reason: trimmedReason
        });

        await logEvent(
          "moderation.block",
          punishmentData({ roleId: requested, blocked: blocked.length, revoked: revoked.ok ? revoked.changed.length : 0 }),
          runtime
        ).catch(() => undefined);
        await maybeNotify(config, guildId, targetId, "تم منعك من الحصول على رتبة في السيرفر.");
        await succeed(
          revoked.ok && revoked.failed.length > 0
            ? `تم منع <@${targetId}> من الرتبة <@&${requested}>، لكن تعذّر سحبها منه الآن.`
            : `تم منع <@${targetId}> من الرتبة <@&${requested}>.`
        );
        return;
      }

      // No role given means lift every block this member has. That is the only
      // useful reading: `/unblock` with nothing specified should not silently do
      // nothing while reporting success.
      const state = await database.takeMemberState(guildId, targetId, "block");
      const blocked = state?.blockedRoleIds ?? [];
      const lifted = requested ? blocked.filter(roleId => roleId === requested) : blocked;

      if (requested && lifted.length === 0) {
        await succeed(`لا يوجد منع على <@${targetId}> من الرتبة <@&${requested}>.`);
        return;
      }

      // The remaining blocks are written back, so lifting one does not lift all.
      const remaining = blocked.filter(roleId => !lifted.includes(roleId));
      if (remaining.length > 0) {
        await database.setMemberState({
          id: randomUUID(),
          guildId,
          userId: targetId,
          kind: "block",
          blockedRoleIds: remaining,
          roleIds: state?.roleIds ?? [],
          moderatorId: userId,
          reason: trimmedReason
        });
      }

      await logEvent("moderation.unblock", punishmentData({ roleId: requested ?? "all", lifted: lifted.length }), runtime).catch(() => undefined);
      await maybeNotify(config, guildId, targetId, "تم فك المنع عن رتبة في السيرفر.");
      await succeed(
        requested
          ? `تم فك المنع عن <@${targetId}> من الرتبة <@&${requested}>.`
          : `تم فك المنع عن <@${targetId}> من ${lifted.length} رتبة.`
      );
      return;
    }

    /* ---- /down and /undown ---- */
    if (commandName === "down" || commandName === "undown") {
      const down = roleConfigFor("down");

      if (commandName === "down") {
        const strippable = await readStrippableRoleIds(client, {
          guildId,
          targetId,
          configured: down.adminRoleIdsToStrip
        });
        if (strippable.length === 0) {
          await reject("لا توجد رتب إدارية قابلة للسحب من هذا العضو.", "NO_STRIPPABLE_ROLES");
          return;
        }

        // The snapshot is taken before the roles go, and is what `/undown` gives
        // back. Restoring from `adminRoleIdsToStrip` instead would mean editing
        // that setting after a `/down` could strand a member with the roles it no
        // longer lists.
        const before = await readMemberRoleIds(client, guildId, targetId);
        const snapshot = before.filter(roleId => strippable.includes(roleId));

        // `/down` is the one state-based punishment with a length, so it is the
        // only one that resolves a duration. An unresolvable one is not an error
        // here the way it is for `/timeout`: "permanent" is meaningful, because
        // the roles stay off until `/undown` — a state someone can reverse.
        let minutes: number | undefined = numbers.minutes;
        if (minutes === undefined) {
          const seconds = commandDurationSeconds(definition, resolveCommandDuration(config, trimmedReason));
          minutes = seconds === null ? undefined : Math.max(1, Math.round(seconds / 60));
        }
        const expiresAt = minutes === undefined ? null : new Date(Date.now() + minutes * 60_000);

        const applied = await runRoleAction("revoke", strippable, "سحب الرتب الإدارية");
        if (!applied) return;

        await database.setMemberState({
          id: randomUUID(),
          guildId,
          userId: targetId,
          kind: "down",
          // Only the roles actually taken, not every role considered: restoring
          // the difference would re-add roles the member never lost.
          roleIds: applied.changed.filter(roleId => snapshot.includes(roleId)),
          moderatorId: userId,
          reason: trimmedReason,
          expiresAt
        });

        await logEvent(
          "moderation.down",
          punishmentData({ stripped: applied.changed.length, minutes: minutes ?? "permanent" }),
          runtime
        ).catch(() => undefined);
        await maybeNotify(config, guildId, targetId, "تم سحب رتبك الإدارية مؤقتاً في السيرفر.");
        await succeed(
          minutes === undefined
            ? `تم سحب ${applied.changed.length} رتبة إدارية من <@${targetId}> حتى /undown.`
            : `تم سحب ${applied.changed.length} رتبة إدارية من <@${targetId}> لمدة ${minutes} دقيقة.`
        );
        return;
      }

      const state = await database.takeMemberState(guildId, targetId, "down");
      const restored = await runRoleAction("grant", state?.roleIds ?? [], "استعادة الرتب الإدارية");
      if (!restored) return;

      await logEvent("moderation.undown", punishmentData({ restored: restored.changed.length }), runtime).catch(() => undefined);
      await maybeNotify(config, guildId, targetId, "تم إرجاع رتبك الإدارية في السيرفر.");
      await succeed(
        state
          ? `تم إرجاع ${restored.changed.length} رتبة إدارية إلى <@${targetId}>.`
          : `لا توجد رتب إدارية مسحوبة عن <@${targetId}>.`
      );
      return;
    }

    /* ---- /remove ---- */
    // Broader than `/delwarn`, which only sees warnings. This reads the member's
    // whole punishment record — warnings and standing states together — because
    // an operator looking at a member does not think of "a warning" and "a mute"
    // as living in two different places.
    if (commandName === "remove") {
      const index = numbers.index ?? 0;
      const removed = await database.deletePunishmentAt(guildId, targetId, index);
      if (!removed) {
        // A miscount, not an intrusion — the same reasoning as `/delwarn`.
        await succeed(`لا توجد عقوبة بالرقم ${index} على <@${targetId}>.`);
        return;
      }

      // The row is gone, but the Discord side is not touched: `/remove` deletes a
      // record, it does not lift a punishment. Lifting is what the inverse
      // commands are for, and doing it here would make a deletion silently
      // restore roles.
      await logEvent("moderation.remove", punishmentData({ removed: index, kind: removed.kind }), runtime).catch(() => undefined);
      await succeed(`تم حذف العقوبة رقم ${index} عن <@${targetId}> (${removed.kind}: «${removed.reason}»).`);
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

    /* ---------------- Invites ----------------
     * Read-only and bookkeeping commands: no Discord mutation, so the gateway
     * logs nothing and the handler answers directly. */

    if (commandName === "invites") {
      const subject = targetId ?? userId;
      const stats = await database.getInviteStats(guildId, subject).catch(() => null);
      if (!stats) {
        await reply(`لا توجد إحالات مسجلة لـ <@${subject}> بعد.`, { autoDeleteSeconds });
        return;
      }
      const lines = [
        `إحصائيات إحالات <@${subject}>:`,
        `• الصافي: **${inviteNet(stats)}**`,
        `• الإجمالي: ${inviteTotal(stats)}`,
        `• المغادرون: ${stats.leaves}`,
        `• الحسابات الوهمية: ${stats.fakes}`,
        `• إعادة الانضمام: ${stats.rejoins}`
      ];
      if (stats.bonus !== 0) lines.push(`• تعديل يدوي: ${stats.bonus > 0 ? "+" : ""}${stats.bonus}`);
      await reply(lines.join("\n"), { autoDeleteSeconds });
      return;
    }

    if (commandName === "leaderboard") {
      const total = await database.countInviteStats(guildId).catch(() => 0);
      const totalPages = Math.max(1, Math.ceil(total / INVITES_LEADERBOARD_PER_PAGE));
      const rows = await database.inviteLeaderboardPage(guildId, INVITES_LEADERBOARD_PER_PAGE, 0).catch(() => []);
      const card = buildInviteLeaderboardMessage(
        rows.map(row => ({ userId: row.userId, net: inviteNet(row), total: inviteTotal(row), leaves: row.leaves })),
        0,
        totalPages
      );
      await reply("", { autoDeleteSeconds, embeds: card.embeds, components: card.components });
      return;
    }

    if (commandName === "invite-link") {
      const created = await createPersonalInvite(client, guildId, `رابط شخصي طُلب عبر /invite-link بواسطة ${userId}`);
      if (!created) {
        await reject("تعذّر إنشاء رابط الدعوة. تأكّد من أن البوت يملك صلاحية إنشاء الدعوات في قناة النظام أو القنوات النصية.", "INVITE_CREATE_FAILED");
        return;
      }
      await reply(`رابط دعوتك الشخصي — دائم وغير محدود الاستخدام:\n${created.url}`, { autoDeleteSeconds });
      return;
    }

    if (commandName === "admin-invites") {
      if (!targetId) {
        await reject("حدّد العضو المطلوب تعديل إحالاته.", "MISSING_TARGET");
        return;
      }
      const action = strings.action ?? "";
      if (action === "reset") {
        await database.resetInviteStats(guildId, targetId);
        await logEvent("invites.admin-adjust", { guildId, actorId: userId, data: { targetId, actorId: userId, action: "reset" } }, runtime).catch(() => undefined);
        await succeed(`تم تصفير إحالات <@${targetId}>.`);
        return;
      }
      const amount = numbers.amount;
      if (!amount || amount < 1) {
        await reject("حدّد عدد النقاط في خيار amount.", "MISSING_AMOUNT");
        return;
      }
      const bonusDelta = action === "add" ? amount : action === "remove" ? -amount : 0;
      if (!bonusDelta) {
        await reject("إجراء غير معروف. الاستخدام: add / remove / reset.", "UNKNOWN_ACTION");
        return;
      }
      const stats = await database.adjustInviteStats(guildId, targetId, bonusDelta);
      await logEvent(
        "invites.admin-adjust",
        { guildId, actorId: userId, data: { targetId, actorId: userId, action, count: amount, reason: trimmedReason || "بدون سبب", inviterNet: inviteNet(stats) } },
        runtime
      ).catch(() => undefined);
      await succeed(`${action === "add" ? "أُضيفت" : "خُصمت"} ${amount} نقطة ${action === "add" ? "إلى" : "من"} إحالات <@${targetId}>. الصافي الآن: ${inviteNet(stats)}.`);
      return;
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

    // Registered only once the action actually applied. A refused action's reply
    // is the operator's error message, and withdrawing it because the target
    // later left would erase the explanation of why the command did not work.
    if (config.deleteResponseOnLeave && targetId) retractOnLeave(targetId);
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

    // GOVERNANCE rule 14: the privileged-intent budget is seeded from the real
    // member list. A member count would be a cheaper stand-in but a wrong one —
    // it double-counts anybody in two guilds — so the fetch is what feeds the
    // tracker, and a guild it fails for is simply not counted yet.
    await guild.members
      .fetch()
      .then(members => intentUsage.observe(members.keys()))
      .catch(() => undefined);
  }
  console.log(`AL AI intent budget: ${intentUsage.describe()}`);
  await presence.run();

  // Boot recovery for the levels sync state machine: this deployment runs
  // exactly one bot (the instance lock), so any `running` job it finds is a
  // pass its previous life crashed out of — back to `pending`, and the next
  // minute clock resumes it from the stored cursor.
  const resumed = await database.resetStaleSyncJobs().catch(() => 0);
  if (resumed > 0) console.log(`AL AI levels: resumed ${resumed} interrupted sync job(s)`);
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

/* ------------------------------------------------------------------ *
 * Expiring punishments
 * ------------------------------------------------------------------ */
/**
 * `/down` is the one state-based punishment that carries a length, so something
 * has to end it. Without this the duration would save and change nothing — the
 * defect this project treats as its worst kind, and the hardest to notice: the
 * roles stay off, the card reads as configured, and only the member knows.
 *
 * The state is consumed whatever the outcome, matching `/unprison`: the snapshot
 * is handed back exactly once, and a restore that could not happen is reported
 * rather than retried every minute forever. A member who left, or a role that was
 * deleted in the meantime, would otherwise fill the log with the same failure
 * and bury the one entry that matters.
 */
const downSweep = setInterval(() => {
  void sweepExpiredDowns({
    due: () => database.listDueMemberStates(new Date()),
    restore: state =>
      applyRoleChange(client, {
        kind: "grant",
        guildId: state.guildId,
        targetId: state.userId,
        roleIds: state.roleIds,
        reason: "انتهاء مدة سحب الرتب الإدارية"
      }),
    consume: state => database.takeMemberState(state.guildId, state.userId, "down").then(() => undefined),
    // Both numbers, always. Reporting only the restored count after a partial
    // failure would read as a clean expiry, and the member would be left short of
    // roles with nothing in the log to explain it.
    record: (state, counts) =>
      logEvent(
        "moderation.down-expired",
        {
          guildId: state.guildId,
          actorId: "system",
          data: { targetId: state.userId, ...counts, reason: state.reason }
        },
        runtime
      ).catch(() => undefined)
  }).catch(error => console.error("AL AI failed to expire a /down", error));
}, 60_000);
downSweep.unref?.();

/* ------------------------------------------------------------------ *
 * Levels minute clock — sync jobs and voice credit
 *
 * The in-flight guard is the double-XP guard: a tick that outlives its
 * interval (a large sync, a slow database) makes the next interval skip
 * instead of running in parallel and paying every member twice.
 * ------------------------------------------------------------------ */
let levelsTickInFlight = false;
const levelsTick = setInterval(() => {
  if (levelsTickInFlight) return;
  levelsTickInFlight = true;
  void runLevelsTick()
    .catch(error => console.warn("AL AI levels tick failed", error))
    .finally(() => {
      levelsTickInFlight = false;
    });
}, 60_000);
levelsTick.unref?.();

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
  readEnv(process.env, "INTEGRATION_ADAPTER_ENABLED") === "true"
    ? startIntegrationAdapter({
        hmacSecret,
        sourceLayer: controlPlane.instance.sourceLayer,
        consumeNonce: (nonce, expiresAt) => database.consumeNonce(nonce, "integration-adapter", expiresAt),
        onSignatureFailure: reason => {
          const signal = detector.signatureFailure({ layer: "integration-adapter", reason });
          void raiseSecurityEvent(signal.id, signal.data);
        },
        handlers: {
          getStatus: async () => ({ ...pipeline.stats(), intents: intentUsage.stats(), watchdog: watchdog.snapshot() }),
          diagnose: async () => ({
            database: await database.ping().then(() => "reachable").catch(() => "unreachable"),
            watched: watchdog.snapshot(),
            undecidedSettings: undecidedSettings(controlPlane)
          }),
          readLogs: async () => ({ note: "GOVERNANCE rule 6: logs live in Discord and in the audit trail.", stats: pipeline.stats() }),
          suggestConfig: async () => ({ applyableKeys: APPLYABLE_KEYS }),
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
  clearInterval(downSweep);
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
