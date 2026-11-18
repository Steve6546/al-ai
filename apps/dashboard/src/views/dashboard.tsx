import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  Ban,
  ChevronLeft,
  Clock,
  Link2,
  MessageSquareHeart,
  Minus,
  Palette,
  ScrollText,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  SquareTerminal,
  Trophy,
  UserCog,
  UserMinus,
  UserPlus,
  Users,
  Wifi,
  WifiOff,
  Zap,
  type LucideIcon
} from "lucide-react";
import { BOT_HEARTBEAT_STALE_MS, PING_WARN_MS, changeSince, type WindowChange } from "@al-ai/core/browser";
import { api } from "@/api";
import { Sparkline } from "@/components/sparkline";
import { LoadError, LoadingRow } from "@/components/view-states";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { useI18n, type Translate } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { Guild, GuildMetrics, GuildModuleKey, GuildModuleState } from "@/types";

/**
 * The overview screen.
 *
 * Two halves, both of them claims the project can back:
 *
 * 1. **Live numbers.** Discord's own gateway heartbeat (reported by the bot),
 *    Discord's aggregate widget presence, and counts read out of the append-only
 *    audit trail — including a 24-hour histogram of it, which is what the
 *    sparklines draw. Nothing is estimated, and a change from an empty window is
 *    named rather than printed as `Infinity%` (see `changeSince`).
 *
 * 2. **The modules this project actually has.** One card per screen the sidebar
 *    offers, each carrying the state its own settings row holds — never "the
 *    screen exists, so it must be running". The list is the closed set in
 *    `GUILD_MODULE_KEYS`; a system that is not in the code cannot appear here,
 *    which is the rule that keeps a reference design from smuggling in tickets,
 *    backups or badge tiers this bot does not implement.
 */

/** Where each module lives, and whether its action reads as "manage" or "open settings". */
type ModuleMeta = {
  icon: LucideIcon;
  /** The sidebar key this card opens. */
  view: "security" | "logs" | "audit" | "commands" | "roles" | "welcome" | "welcome-messages" | "levels" | "invites" | "customization" | "presence";
  /** A control surface ("open settings") rather than a management screen. */
  settings?: boolean;
};

const MODULES: Record<GuildModuleKey, ModuleMeta> = {
  security: { icon: ShieldCheck, view: "security" },
  logging: { icon: ScrollText, view: "logs" },
  audit: { icon: Clock, view: "audit" },
  commands: { icon: SquareTerminal, view: "commands" },
  roles: { icon: UserCog, view: "roles" },
  welcome: { icon: UserPlus, view: "welcome" },
  welcomeMessages: { icon: MessageSquareHeart, view: "welcome-messages" },
  customization: { icon: Palette, view: "customization", settings: true },
  levels: { icon: Trophy, view: "levels" },
  invites: { icon: Link2, view: "invites" },
  presence: { icon: Sparkles, view: "presence", settings: true }
};

const GROUPS: { id: string; titleKey: "overview.group.moderation" | "overview.group.management" | "overview.group.bot"; keys: GuildModuleKey[] }[] = [
  { id: "moderation", titleKey: "overview.group.moderation", keys: ["security", "logging", "audit"] },
  {
    id: "management",
    titleKey: "overview.group.management",
    keys: ["commands", "roles", "welcome", "welcomeMessages", "levels", "invites"]
  },
  // «حالة البوت» is instance-wide, so the server omits it for anybody who is not
  // the deployment's owner; the group disappears with its last card.
  { id: "bot", titleKey: "overview.group.bot", keys: ["customization", "presence"] }
];

export function DashboardView({ guild, onOpen }: { guild: Guild; onOpen: (view: ModuleMeta["view"]) => void }) {
  const { t, language } = useI18n();
  const [metrics, setMetrics] = useState<GuildMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modules, setModules] = useState<GuildModuleState[] | null>(null);
  const [modulesFailed, setModulesFailed] = useState(false);
  const locale = language === "en" ? "en" : "ar";

  useEffect(() => {
    let cancelled = false;
    setMetrics(null);
    setError(null);
    setModules(null);
    setModulesFailed(false);

    // The numbers go stale within seconds; the switches do not. They are fetched
    // together on load and on the same timer, but a failing module read must not
    // take the numbers down with it (and the reverse).
    const load = () => {
      api
        .metrics(guild.id)
        .then(result => !cancelled && setMetrics(result))
        .catch(cause => !cancelled && setError(cause instanceof Error ? cause.message : t("dashboard.loadFailed")));
      api
        .modules(guild.id)
        .then(result => !cancelled && setModules(result.modules))
        .catch(() => !cancelled && setModulesFailed(true));
    };

    void load();
    const timer = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [guild.id, t]);

  if (error) {
    return <LoadError message={error} />;
  }
  if (!metrics) {
    return <LoadingRow label={t("dashboard.loading")} />;
  }

  return (
    <OverviewContent
      guild={guild}
      metrics={metrics}
      modules={modules}
      modulesFailed={modulesFailed}
      onOpen={onOpen}
    />
  );
}

/**
 * The rendered overview, given what the two requests returned.
 *
 * Split from the fetching half so it can be mounted with a known payload: under
 * `renderToString` effects never run, so a smoke test only ever saw the loading
 * row, and the module grid — nine cards, three groups, a badge and a button each
 * — was never rendered by any test. It is also what the layout harness loads to
 * check RTL, phone widths and the appearance tokens against the real component
 * rather than a mock-up of it.
 */
export function OverviewContent({
  guild,
  metrics,
  modules,
  modulesFailed,
  onOpen
}: {
  guild: Guild;
  metrics: GuildMetrics;
  modules: GuildModuleState[] | null;
  modulesFailed: boolean;
  onOpen: (view: ModuleMeta["view"]) => void;
}) {
  const { t, language } = useI18n();
  const locale = language === "en" ? "en" : "ar";
  const { bot, members, punishments24h, recentActivity, series } = metrics;
  // A payload without these fields is not a metrics screen with zero values -
  // it is a response this screen cannot read. Reporting zeros would be a number
  // we made up (the same rule the guild list follows: "unknown" is not "none").
  //
  // The check has to happen *before* `buildStats` reads the payload, and the
  // memo has to stay unconditional (the hook count cannot depend on the data),
  // so the memo is given `null` instead of a payload it would throw on. That is
  // the difference between an error card and a screen that cannot render at
  // all: a malformed response must never reach the arithmetic.
  const readable = Boolean(bot && members && punishments24h && Array.isArray(recentActivity));
  const stats = useMemo(
    () => (readable ? buildStats(metrics, locale, t) : null),
    [readable, metrics, locale, t]
  );

  if (!readable || !stats) {
    return <LoadError message={t("dashboard.incomplete")} />;
  }

  return (
    <div className="space-y-6">
      {/* ---------------------------------------------------------------- *
       * Live numbers
       * ---------------------------------------------------------------- */}
      <section aria-labelledby="overview-stats" className="space-y-3">
        <SectionHeading id="overview-stats" icon={Activity} title={t("overview.stats.title")} hint={t("overview.stats.hint")} />

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {/* Bot: no chart. The gateway heartbeat is a single current value, and
              a line drawn through one number would be an invention. */}
          <Card className={cn("overflow-hidden", !bot.online && "border-destructive/40")}>
            <CardContent className="space-y-3 p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    className={cn(
                      "grid size-8 shrink-0 place-items-center rounded-lg",
                      bot.online ? "bg-success/15 text-success" : "bg-destructive/15 text-destructive"
                    )}
                  >
                    {bot.online ? <Wifi className="size-4" /> : <WifiOff className="size-4" />}
                  </span>
                  <p className="truncate text-xs font-medium text-muted-foreground">{t("dashboard.bot")}</p>
                </div>
                <span
                  className={cn(
                    "mt-1 size-2 shrink-0 rounded-full",
                    bot.online ? "animate-pulse bg-success" : "bg-destructive"
                  )}
                  aria-hidden
                />
              </div>
              <p className="text-2xl font-semibold leading-none">{stats.botValue}</p>
              <p className="text-mini leading-relaxed text-muted-foreground">{stats.botHint}</p>
            </CardContent>
          </Card>

          {/* Members: a real ratio, not a chart. Presence comes from Discord's
              widget as one aggregate number, so there is no series to plot. */}
          <Card className="overflow-hidden">
            <CardContent className="space-y-3 p-4">
              <div className="flex items-center gap-2">
                <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/12 text-primary">
                  <Users className="size-4" />
                </span>
                <p className="truncate text-xs font-medium text-muted-foreground">{t("dashboard.members")}</p>
              </div>
              <p className="text-2xl font-semibold leading-none tabular">{stats.members}</p>
              {members.online !== null ? (
                <>
                  <div
                    className="h-1.5 overflow-hidden rounded-full bg-muted"
                    role="img"
                    aria-label={t("overview.membersRatio", {
                      online: members.online.toLocaleString(locale),
                      total: members.total.toLocaleString(locale)
                    })}
                  >
                    <div
                      className="h-full rounded-full bg-primary transition-[width] duration-500"
                      style={{ width: `${stats.onlineShare}%` }}
                    />
                  </div>
                  <p className="text-mini leading-relaxed text-muted-foreground">
                    {t("overview.membersRatio", {
                      online: members.online.toLocaleString(locale),
                      total: members.total.toLocaleString(locale)
                    })}
                  </p>
                </>
              ) : (
                <p className="text-mini leading-relaxed text-muted-foreground">
                  {members.onlineNote ?? t("overview.membersUnknown")}
                </p>
              )}
            </CardContent>
          </Card>

          {/* Punishments: a real histogram of moderation events per hour. */}
          <StatChart
            icon={ShieldAlert}
            label={t("overview.stat.punishments")}
            // The chart's own total, so the number above it can never contradict
            // the line beneath it. `punishments24h` is the fallback for a failed
            // histogram read, and it covers the same window.
            value={stats.penalties.toLocaleString(locale)}
            hint={stats.penaltyHint}
            series={series?.penalties ?? null}
            change={stats.penaltyChange}
            tone={stats.penalties > 0 ? "warn" : "ok"}
            t={t}
          />

          {/* Logged events: everything the audit trail holds this day, charted. */}
          <StatChart
            icon={Activity}
            label={t("overview.events24h")}
            value={stats.events.toLocaleString(locale)}
            hint={stats.eventsHint}
            series={series?.events ?? null}
            change={stats.eventChange}
            tone="neutral"
            t={t}
          />
        </div>

        {!bot.online && (
          <Alert>
            <TriangleAlertIcon />
            <AlertDescription>
              {bot.lastSeenAt
                ? t("dashboard.offlineAgo", { time: formatRelative(bot.lastSeenAt, t) })
                : t("dashboard.offlineNever")}
            </AlertDescription>
          </Alert>
        )}
      </section>

      {/* ---------------------------------------------------------------- *
       * The modules this project actually has
       * ---------------------------------------------------------------- */}
      <section aria-labelledby="overview-modules" className="space-y-4">
        <SectionHeading
          id="overview-modules"
          icon={Sparkles}
          title={t("overview.modules.title")}
          hint={t("overview.modules.hint")}
        />

        {modulesFailed && modules === null ? (
          <Card>
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              {t("overview.modules.loadFailed")}
            </CardContent>
          </Card>
        ) : null}

        {modules === null && !modulesFailed ? (
          <LoadingRow label={t("overview.modules.loading")} />
        ) : null}

        {modules
          ? GROUPS.map(group => {
              // A card the server withheld (owner-only) takes its group with it.
              const cards = group.keys
                .map(key => modules.find(entry => entry.key === key))
                .filter((entry): entry is GuildModuleState => Boolean(entry));
              if (cards.length === 0) return null;
              return (
                <div key={group.id} className="space-y-2">
                  <h3 className="px-1 text-xs font-semibold tracking-wide text-muted-foreground">
                    {t(group.titleKey)}
                  </h3>
                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                    {cards.map(entry => (
                      <ModuleCard key={entry.key} state={entry} onOpen={onOpen} />
                    ))}
                  </div>
                </div>
              );
            })
          : null}
      </section>

      {/* ---------------------------------------------------------------- *
       * What actually happened, and what this server is
       * ---------------------------------------------------------------- */}
      <div className="grid gap-3 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Clock className="size-4" />
              {t("dashboard.activity")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {recentActivity.length === 0 ? (
              <p className="py-6 text-center text-xs text-muted-foreground">{t("dashboard.activityEmpty")}</p>
            ) : (
              recentActivity.map((entry, index) => (
                <div key={entry.id}>
                  {index > 0 && <Separator className="mb-3" />}
                  <div className="flex items-start gap-3">
                    <div className={`mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg ${severityClass(entry.severity)}`}>
                      <ActionIcon eventId={entry.eventId} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{actionLabel(entry.eventId, t)}</span>
                        {entry.targetId && (
                          <span className="text-muted-foreground" dir="ltr">
                            {entry.targetId}
                          </span>
                        )}
                        <Badge variant="secondary" className="text-micro">
                          {formatRelative(entry.createdAt, t)}
                        </Badge>
                      </div>
                      <p className="truncate text-xs text-muted-foreground">
                        {entry.reason ?? t("dashboard.noReason")}
                        {entry.actorId ? t("dashboard.by", { id: entry.actorId }) : ""}
                      </p>
                    </div>
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">{t("overview.detail.title")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <Row label={t("dashboard.name")} value={guild.name} />
            <Separator />
            {/* `guild.tier` is the operator's own tier, resolved server-side from
                the role mapping — the row says so. Its fallback named AL AI,
                which is a different subject: a null tier means nobody mapped a
                role for the person reading it, not that the bot lost a rank. */}
            <Row label={t("dashboard.yourTier")} value={guild.tier ? t(`tier.${guild.tier}`) : t("dashboard.noTier")} />
            <Separator />
            <Row
              label={t("dashboard.bot")}
              value={guild.botPresent ? t("dashboard.added") : t("dashboard.notAdded")}
              badge={guild.botPresent ? "default" : "destructive"}
            />
            <Separator />
            <Row label={t("dashboard.ban")} value={countOf(punishments24h.ban, locale)} />
            <Separator />
            <Row label={t("dashboard.kick")} value={countOf(punishments24h.kick, locale)} />
            <Separator />
            <Row label={t("dashboard.timeout")} value={countOf(punishments24h.timeout, locale)} />
            <Separator />
            <Row label={t("dashboard.warn")} value={countOf(punishments24h.warn, locale)} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * The numbers, derived once
 * ------------------------------------------------------------------ */

type OverviewStats = {
  botValue: string;
  botHint: string;
  members: string;
  onlineShare: number;
  events: number;
  penalties: number;
  eventsHint: string;
  penaltyHint: string;
  eventChange: WindowChange | null;
  /** Same window as the chart beside it, so the two cannot disagree. */
  penaltyChange: WindowChange | null;
};

/**
 * Every figure on the four cards, computed in one place.
 *
 * Two rules live here rather than in the JSX:
 *
 * - A percentage only exists when the previous window had something in it.
 *   `changeSince` returns a named case for an empty baseline, so `0 → 4` reads
 *   «جديد» and never `Infinity%`.
 * - The online share is clamped to 0…100 and is `0` when the total is zero.
 *   Discord's widget can report more online members than the count we stored
 *   (the count is refreshed by the bot's heartbeat, the widget is live), and a
 *   bar wider than its track is the arithmetic equivalent of a lie.
 *
 * Exported so these rules can be asserted without a browser (see
 * `overview.test.tsx`): under `renderToString` the screen renders its loading
 * state, so the arithmetic has to be reachable on its own.
 */
export function buildStats(metrics: GuildMetrics, locale: string, t: Translate): OverviewStats {
  const { bot, members, punishments24h, series, previous, recentActivity } = metrics;

  const events = Array.isArray(series?.events) ? series.events.reduce((sum, value) => sum + value, 0) : recentActivity.length;
  const penalties = Array.isArray(series?.penalties) ? series.penalties.reduce((sum, value) => sum + value, 0) : punishments24h.total;
  // An empty array is not a chart: the server sends one when the histogram read
  // failed, and drawing a comparison from it would claim yesterday was silent.
  const hasSeries = Array.isArray(series?.events) && series.events.length > 0;
  const hasPrevious = typeof previous?.events === "number";

  const share = members.online !== null && members.total > 0 ? Math.min(100, Math.max(0, Math.round((members.online / members.total) * 100))) : 0;
  const lastEvent = recentActivity[0]?.createdAt;

  return {
    botValue: bot.online
      ? bot.pingMs === null
        ? t("dashboard.online")
        : t("dashboard.onlinePing", { ping: bot.pingMs })
      : t("dashboard.offline"),
    botHint: bot.online ? t("dashboard.pingHint") : stalenessHint(bot.lastSeenAt, t),
    members: members.total.toLocaleString(locale),
    onlineShare: share,
    events: hasSeries ? events : recentActivity.length,
    penalties,
    eventsHint: lastEvent ? t("overview.eventsHint", { time: formatRelative(lastEvent, t) }) : t("overview.eventsHintEmpty"),
    // The card prints the chart's total, so its hint has to be able to describe
    // that same number: the per-kind breakdown comes from the exact 24-hour
    // counter, which can be an hour's worth of events behind the histogram.
    // When the two disagree the hint states the window instead of contradicting
    // the number above it.
    penaltyHint:
      penalties === 0
        ? t("dashboard.noPunishments")
        : punishmentBreakdown(punishments24h, t) || t("overview.punishmentsHint"),
    // Both comparisons need a chart (the window's own total) *and* a previous
    // window. Without either, the card says nothing rather than guessing.
    eventChange: hasPrevious && hasSeries ? changeSince(events, previous.events) : null,
    penaltyChange: hasPrevious && hasSeries ? changeSince(penalties, previous.penalties) : null
  };
}

/**
 * A card with a chart.
 *
 * `series` is null when the histogram read failed, and the card says so
 * underneath instead of drawing an empty line — an empty chart would claim that
 * nothing happened today, which is the opposite of "we could not look".
 */
function StatChart({
  icon: Icon,
  label,
  value,
  hint,
  series,
  change,
  tone,
  t
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  hint: string;
  series: number[] | null;
  change: WindowChange | null;
  tone: "ok" | "warn" | "neutral";
  t: Translate;
}) {
  const toneClass =
    tone === "ok" ? "bg-success/15 text-success" : tone === "warn" ? "bg-warning/15 text-warning" : "bg-primary/12 text-primary";
  return (
    <Card className="overflow-hidden">
      <CardContent className="space-y-3 p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span className={cn("grid size-8 shrink-0 place-items-center rounded-lg", toneClass)}>
              <Icon className="size-4" />
            </span>
            <p className="truncate text-xs font-medium text-muted-foreground">{label}</p>
          </div>
          {change ? <ChangeChip change={change} t={t} /> : null}
        </div>
        <p className="text-2xl font-semibold leading-none tabular">{value}</p>
        <p className="line-clamp-1 text-mini leading-relaxed text-muted-foreground">{hint}</p>
        {series && series.length > 0 ? (
          <Sparkline values={series} label={t("overview.sparkline")} height={38} className="text-primary/70" />
        ) : series === null ? (
          <p className="text-micro leading-relaxed text-muted-foreground">{t("overview.seriesUnavailable")}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** The comparison with the previous day, or the honest absence of one. */
function ChangeChip({ change, t }: { change: WindowChange; t: Translate }) {
  // The chip states the comparison in two or three characters' worth of text;
  // the full sentence («…compared with the previous day») is the tooltip, so a
  // narrow card keeps its layout and a reader still gets the meaning.
  if (change.kind === "unknown") {
    return (
      <span className="shrink-0 text-micro text-muted-foreground" title={t("overview.change.unknown")}>
        —
      </span>
    );
  }
  if (change.kind === "new") {
    return (
      <Badge variant="secondary" className="shrink-0 gap-1 text-micro" title={t("overview.change.new")}>
        <ArrowUpRight className="size-3" />
        {t("overview.change.newShort")}
      </Badge>
    );
  }
  if (change.kind === "flat") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 text-micro text-muted-foreground" title={t("overview.change.flat")}>
        <Minus className="size-3" />
        {t("overview.change.flatShort")}
      </span>
    );
  }
  const Icon = change.kind === "up" ? ArrowUpRight : ArrowDownRight;
  const percent = Math.abs(change.percent ?? 0);
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 text-micro font-medium",
        change.kind === "up" ? "text-warning" : "text-muted-foreground"
      )}
      title={t(change.kind === "up" ? "overview.change.up" : "overview.change.down", { percent })}
    >
      <Icon className="size-3" />
      {t(change.kind === "up" ? "overview.change.upShort" : "overview.change.downShort", { percent })}
    </span>
  );
}

/** One card in the module grid: what it is, whether it is on, and where it lives. */
function ModuleCard({ state, onOpen }: { state: GuildModuleState; onOpen: (view: ModuleMeta["view"]) => void }) {
  const { t, language } = useI18n();
  const meta = MODULES[state.key];
  const Icon = meta.icon;
  const locale = language === "en" ? "en" : "ar";

  // The module's own tally, when it has one worth printing beside the badge.
  const count =
    state.count === null
      ? null
      : state.key === "roles"
        ? t("overview.moduleCount.tiers", { count: state.count.toLocaleString(locale) })
        : state.key === "audit"
          ? t("overview.moduleCount.audit", { count: state.count.toLocaleString(locale) })
          : state.key === "commands" && state.count > 0
            ? t("overview.moduleCount.disabledCommands", { count: state.count.toLocaleString(locale) })
            : null;

  return (
    <Card
      className={cn(
        "group flex flex-col overflow-hidden transition-colors",
        state.enabled ? "border-border" : "border-dashed"
      )}
    >
      <CardContent className="flex flex-1 flex-col gap-3 p-4">
        <div className="flex items-start justify-between gap-2">
          <span
            className={cn(
              "grid size-10 shrink-0 place-items-center rounded-xl",
              state.enabled ? "bg-primary/12 text-primary" : "bg-muted text-muted-foreground"
            )}
          >
            <Icon className="size-5" aria-hidden />
          </span>
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-micro font-medium",
              state.enabled ? "bg-success/15 text-success" : "bg-muted text-muted-foreground"
            )}
          >
            <span className={cn("size-1.5 rounded-full", state.enabled ? "bg-success" : "bg-muted-foreground/60")} aria-hidden />
            {state.enabled ? t("overview.enabled") : t("overview.disabled")}
          </span>
        </div>

        <div className="space-y-1">
          <p className="text-base font-semibold leading-tight">{t(`overview.module.${state.key}.title`)}</p>
          <p className="text-sm leading-relaxed text-muted-foreground">{t(`overview.module.${state.key}.body`)}</p>
        </div>

        {count ? <p className="text-micro text-muted-foreground">{count}</p> : null}

        <div className="mt-auto pt-1">
          <Button
            size="sm"
            variant={state.enabled ? "secondary" : "default"}
            className="w-full justify-between sm:w-auto"
            onClick={() => onOpen(meta.view)}
          >
            {meta.settings ? t("overview.openSettings") : t("overview.manage")}
            {/* The chevron points along the reading direction, so an RTL layout
                does not send the eye backwards. */}
            <ChevronLeft className={cn("size-4", language === "ar" ? "" : "rotate-180")} />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function SectionHeading({
  id,
  icon: Icon,
  title,
  hint
}: {
  id: string;
  icon: LucideIcon;
  title: string;
  hint: string;
}) {
  return (
    <div className="flex items-start gap-2 px-1">
      <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg bg-primary/12 text-primary">
        <Icon className="size-4" aria-hidden />
      </span>
      <div className="min-w-0">
        <h2 id={id} className="text-sm font-semibold leading-tight">
          {title}
        </h2>
        <p className="text-mini leading-relaxed text-muted-foreground">{hint}</p>
      </div>
    </div>
  );
}

/**
 * The four counters, in the operator's language, skipping the empty ones.
 *
 * `null` rather than «no punishments» when all four are zero: the caller knows
 * whether the total it printed was zero, and an empty breakdown under a non-zero
 * total would be the card arguing with itself.
 */
function punishmentBreakdown(counts: GuildMetrics["punishments24h"], t: Translate) {
  const parts = [
    counts.ban > 0 ? t("dashboard.punishment.ban", { count: counts.ban }) : null,
    counts.kick > 0 ? t("dashboard.punishment.kick", { count: counts.kick }) : null,
    counts.timeout > 0 ? t("dashboard.punishment.timeout", { count: counts.timeout }) : null,
    counts.warn > 0 ? t("dashboard.punishment.warn", { count: counts.warn }) : null
  ].filter((part): part is string => part !== null);
  return parts.length ? parts.join(" · ") : null;
}

const actionLabels = {
  "moderation.ban": "dashboard.event.ban",
  "moderation.unban": "dashboard.event.unban",
  "moderation.kick": "dashboard.event.kick",
  "moderation.timeout": "dashboard.event.timeout",
  "moderation.warn": "dashboard.event.warn",
  "moderation.clearwarns": "dashboard.event.clearwarns"
} as const;

const actionLabel = (eventId: string, t: Translate) => {
  if (typeof eventId !== "string" || eventId.length === 0) return t("dashboard.event");
  const key = actionLabels[eventId as keyof typeof actionLabels];
  return key ? t(key) : eventId.replace("moderation.", "");
};

function ActionIcon({ eventId }: { eventId: string }) {
  const Icon = eventId === "moderation.ban" ? Ban : eventId === "moderation.kick" ? UserMinus : eventId === "moderation.timeout" ? Zap : ShieldAlert;
  return <Icon className="size-3.5" />;
}

function TriangleAlertIcon() {
  // Kept local so the alert that says "the bot is not running" does not pull the
  // whole icon set through this module's imports twice.
  return <ShieldAlert className="size-4" />;
}

function severityClass(severity: "info" | "warning" | "critical") {
  if (severity === "critical") return "bg-destructive/15 text-destructive";
  if (severity === "warning") return "bg-warning/15 text-warning";
  return "bg-muted text-muted-foreground";
}

/**
 * Why the bot is not shown as live, phrased for an operator.
 *
 * The final branch is not "online": the heartbeat is fresh but the row says the
 * bot is not present, so the card already reads «غير متصل». Calling that
 * «متصل» underneath would contradict the value above it. It reports the fact
 * instead — the socket is quiet, not that the bot is healthy.
 */
function stalenessHint(lastSeenAt: string | null, t: Translate) {
  if (!lastSeenAt) return t("dashboard.neverRun");
  const age = Date.now() - Date.parse(lastSeenAt);
  if (age >= BOT_HEARTBEAT_STALE_MS) return t("dashboard.stale", { time: formatRelative(lastSeenAt, t) });
  return t("dashboard.silent");
}

/** Short relative time in the active language, no external library. */
function formatRelative(iso: string, t: Translate) {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 60) return t("dashboard.relative.now");
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t("dashboard.relative.minutes", { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t("dashboard.relative.hours", { count: hours });
  const days = Math.round(hours / 24);
  return t("dashboard.relative.days", { count: days });
}

/**
 * A counter the server did not send.
 *
 * `String(undefined)` is the word "undefined" on the screen, which reads like
 * a value rather than like an absence. A count that is not there is shown as a
 * dash - the same rule the guild list follows: "unknown" is not "none".
 */
function countOf(value: unknown, locale: string): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString(locale) : "—";
}

function Row({ label, value, badge }: { label: string; value: string; badge?: "default" | "destructive" }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      {badge ? (
        <Badge variant={badge === "default" ? "secondary" : "destructive"} className="shrink-0">
          {value}
        </Badge>
      ) : (
        <span className="min-w-0 break-words text-end tabular">{value}</span>
      )}
    </div>
  );
}
