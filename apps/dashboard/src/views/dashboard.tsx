import { useEffect, useState } from "react";
import { Activity, Ban, Clock, ShieldAlert, TriangleAlert, UserMinus, Users, Wifi, WifiOff, Zap } from "lucide-react";
import { BOT_HEARTBEAT_STALE_MS, PING_WARN_MS } from "@al-ai/core/browser";
import { api } from "@/api";
import { LoadError, LoadingRow } from "@/components/view-states";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { useI18n, type Translate } from "@/lib/i18n";
import { type Guild, type GuildMetrics } from "@/types";

/**
 * The overview screen.
 *
 * Every number here comes from a real source: Discord's own gateway heartbeat
 * (reported by the bot), Discord's aggregate widget presence, and counts read
 * from the append-only audit trail. The previous version showed the dashboard's
 * internal gateway counters, which told an operator nothing about their server.
 */
export function DashboardView({ guild }: { guild: Guild }) {
  const { t, language } = useI18n();
  const [metrics, setMetrics] = useState<GuildMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const locale = language === "en" ? "en" : "ar";

  useEffect(() => {
    let cancelled = false;
    setMetrics(null);
    setError(null);

    const load = () =>
      api
        .metrics(guild.id)
        .then(result => !cancelled && setMetrics(result))
        .catch(cause => !cancelled && setError(cause instanceof Error ? cause.message : t("dashboard.loadFailed")));

    void load();
    // The ping and the activity feed go stale within seconds, so the screen
    // refreshes itself rather than showing a snapshot from page load.
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

  const { bot, members, punishments24h, recentActivity } = metrics;

  // A payload without these fields is not a metrics screen with zero values -
  // it is a response this screen cannot read. Reporting zeros would be a
  // number we made up (the same rule the guild list follows: "unknown" is not
  // "none"), and reading `bot.pingMs` on a missing `bot` threw inside the
  // render, which dropped the whole screen into the error boundary instead of
  // saying what was wrong with the answer.
  if (!bot || !members || !punishments24h || !Array.isArray(recentActivity)) {
    return <LoadError message={t("dashboard.incomplete")} />;
  }

  const ping = bot.pingMs;
  const pingTone: "ok" | "warn" | "bad" = !bot.online ? "bad" : ping === null ? "warn" : ping > PING_WARN_MS ? "warn" : "ok";

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          icon={bot.online ? Wifi : WifiOff}
          label={t("dashboard.bot")}
          value={
            bot.online
              ? ping === null
                ? t("dashboard.online")
                : t("dashboard.onlinePing", { ping })
              : t("dashboard.offline")
          }
          hint={bot.online ? t("dashboard.pingHint") : stalenessHint(bot.lastSeenAt, t)}
          tone={pingTone}
        />
        <Stat
          icon={Users}
          label={t("dashboard.members")}
          value={members.total.toLocaleString(locale)}
          hint={
            members.online === null
              ? members.onlineNote ?? undefined
              : t("dashboard.onlineNow", { count: members.online.toLocaleString(locale) })
          }
          tone="neutral"
        />
        <Stat
          icon={ShieldAlert}
          label={t("dashboard.punishments")}
          value={punishments24h.total.toLocaleString(locale)}
          hint={punishmentBreakdown(punishments24h, t)}
          tone={punishments24h.total > 0 ? "warn" : "ok"}
        />
        <Stat
          icon={Activity}
          label={t("dashboard.recentEvents")}
          value={recentActivity.length.toLocaleString(locale)}
          hint={t("dashboard.recentEventsHint")}
          tone="neutral"
        />
      </div>

      {!bot.online && (
        <Alert>
          <TriangleAlert />
          <AlertDescription>
            {bot.lastSeenAt
              ? t("dashboard.offlineAgo", { time: formatRelative(bot.lastSeenAt, t) })
              : t("dashboard.offlineNever")}
          </AlertDescription>
        </Alert>
      )}

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
              <p className="py-6 text-center text-xs text-muted-foreground">
                {t("dashboard.activityEmpty")}
              </p>
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
                        <Badge variant="secondary" className="text-[10px]">
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
            <CardTitle className="text-base">{t("dashboard.server")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <Row label={t("dashboard.name")} value={guild.name} />
            <Separator />
            {/* `guild.tier` is the operator's own tier, resolved server-side from
                the role mapping — the row says so. Its fallback named AL AI,
                which is a different subject: a null tier means nobody mapped a
                role for the person reading it, not that the bot lost a rank. */}
            <Row
              label={t("dashboard.yourTier")}
              value={guild.tier ? t(`tier.${guild.tier}`) : t("dashboard.noTier")}
            />
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

/** The four counters, in the operator's language, skipping the empty ones. */
function punishmentBreakdown(counts: GuildMetrics["punishments24h"], t: Translate) {
  const parts = [
    counts.ban > 0 ? t("dashboard.punishment.ban", { count: counts.ban }) : null,
    counts.kick > 0 ? t("dashboard.punishment.kick", { count: counts.kick }) : null,
    counts.timeout > 0 ? t("dashboard.punishment.timeout", { count: counts.timeout }) : null,
    counts.warn > 0 ? t("dashboard.punishment.warn", { count: counts.warn }) : null
  ].filter((part): part is string => part !== null);
  return parts.length ? parts.join(" · ") : t("dashboard.noPunishments");
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

function Stat({
  icon: Icon,
  label,
  value,
  hint,
  tone
}: {
  icon: typeof Activity;
  label: string;
  value: string;
  hint?: string;
  tone: "ok" | "warn" | "bad" | "neutral";
}) {
  const toneClass =
    tone === "ok"
      ? "bg-success/15 text-success"
      : tone === "bad"
        ? "bg-destructive/15 text-destructive"
        : tone === "warn"
          ? "bg-warning/15 text-warning"
          : "bg-muted text-muted-foreground";
  return (
    <Card>
      <CardContent className="flex items-start gap-3 p-4">
        <div className={`grid size-9 shrink-0 place-items-center rounded-lg ${toneClass}`}>
          <Icon className="size-4" />
        </div>
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className="truncate text-sm font-semibold tabular">{value}</p>
          {hint && <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">{hint}</p>}
        </div>
      </CardContent>
    </Card>
  );
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
        <Badge variant={badge === "default" ? "secondary" : "destructive"} className="shrink-0">{value}</Badge>
      ) : (
        <span className="min-w-0 break-words text-end tabular">{value}</span>
      )}
    </div>
  );
}
