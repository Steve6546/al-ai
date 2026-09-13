import { useEffect, useState } from "react";
import { Activity, Ban, Clock, Loader2, ShieldAlert, TriangleAlert, UserMinus, Users, Wifi, WifiOff, Zap } from "lucide-react";
import { BOT_HEARTBEAT_STALE_MS, PING_WARN_MS } from "@al-ai/core/browser";
import { api } from "@/api";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { tierLabels, type Guild, type GuildMetrics } from "@/types";

/**
 * The overview screen.
 *
 * Every number here comes from a real source: Discord's own gateway heartbeat
 * (reported by the bot), Discord's aggregate widget presence, and counts read
 * from the append-only audit trail. The previous version showed the dashboard's
 * internal gateway counters, which told an operator nothing about their server.
 */
export function DashboardView({ guild }: { guild: Guild }) {
  const [metrics, setMetrics] = useState<GuildMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setMetrics(null);
    setError(null);

    const load = () =>
      api
        .metrics(guild.id)
        .then(result => !cancelled && setMetrics(result))
        .catch(cause => !cancelled && setError(cause instanceof Error ? cause.message : "تعذّر تحميل المقاييس."));

    void load();
    // The ping and the activity feed go stale within seconds, so the screen
    // refreshes itself rather than showing a snapshot from page load.
    const timer = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [guild.id]);

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }
  if (!metrics) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        جارٍ تحميل مقاييس السيرفر
      </div>
    );
  }

  const { bot, members, punishments24h, recentActivity } = metrics;
  const ping = bot.pingMs;
  const pingTone: "ok" | "warn" | "bad" = !bot.online ? "bad" : ping === null ? "warn" : ping > PING_WARN_MS ? "warn" : "ok";

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          icon={bot.online ? Wifi : WifiOff}
          label="حالة البوت"
          value={bot.online ? (ping === null ? "متصل" : `متصل · ${ping} ms`) : "غير متصل"}
          hint={bot.online ? "زمن استجابة البوابة الفعلي" : stalenessHint(bot.lastSeenAt)}
          tone={pingTone}
        />
        <Stat
          icon={Users}
          label="الأعضاء"
          value={members.total.toLocaleString("ar")}
          hint={members.online === null ? members.onlineNote ?? undefined : `${members.online.toLocaleString("ar")} متصل الآن`}
          tone="neutral"
        />
        <Stat
          icon={ShieldAlert}
          label="عقوبات آخر 24 ساعة"
          value={punishments24h.total.toLocaleString("ar")}
          hint={punishmentBreakdown(punishments24h)}
          tone={punishments24h.total > 0 ? "warn" : "ok"}
        />
        <Stat
          icon={Activity}
          label="أحداث إشراف حديثة"
          value={recentActivity.length.toLocaleString("ar")}
          hint="آخر العمليات المسجّلة"
          tone="neutral"
        />
      </div>

      {!bot.online && (
        <Alert>
          <TriangleAlert />
          <AlertDescription>
            {bot.lastSeenAt
              ? `آخر نبضة من البوت كانت ${formatRelative(bot.lastSeenAt)}. شغّل البوت ليستأنف التسجيل وتنفيذ الأوامر.`
              : "لم يتصل البوت بهذا السيرفر بعد. شغّل البوت ثم أعد تحميل الصفحة."}
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-3 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Clock className="size-4" />
              شريط النشاط الأخير
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {recentActivity.length === 0 ? (
              <p className="py-6 text-center text-xs text-muted-foreground">
                لا توجد عمليات إشراف مسجّلة بعد. ستظهر هنا فور تنفيذ أول عقوبة.
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
                        <span className="font-medium">{actionLabel(entry.eventId)}</span>
                        {entry.targetId && (
                          <span className="text-muted-foreground" dir="ltr">
                            {entry.targetId}
                          </span>
                        )}
                        <Badge variant="secondary" className="text-[10px]">
                          {formatRelative(entry.createdAt)}
                        </Badge>
                      </div>
                      <p className="truncate text-xs text-muted-foreground">
                        {entry.reason ?? "بلا سبب مسجّل"}
                        {entry.actorId ? ` — بواسطة ${entry.actorId}` : ""}
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
            <CardTitle className="text-base">السيرفر</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <Row label="الاسم" value={guild.name} />
            <Separator />
            <Row label="رتبتك" value={guild.tier ? tierLabels[guild.tier] : "لا توجد رتبة AL AI"} />
            <Separator />
            <Row
              label="البوت"
              value={guild.botPresent ? "مضاف" : "غير مضاف"}
              badge={guild.botPresent ? "default" : "destructive"}
            />
            <Separator />
            <Row label="عقوبات: حظر" value={String(punishments24h.ban)} />
            <Separator />
            <Row label="عقوبات: طرد" value={String(punishments24h.kick)} />
            <Separator />
            <Row label="عقوبات: إسكات" value={String(punishments24h.timeout)} />
            <Separator />
            <Row label="عقوبات: تحذير" value={String(punishments24h.warn)} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

/** The four counters, in the operator's language, skipping the empty ones. */
function punishmentBreakdown(counts: GuildMetrics["punishments24h"]) {
  const parts = [
    counts.ban > 0 ? `${counts.ban} حظر` : null,
    counts.kick > 0 ? `${counts.kick} طرد` : null,
    counts.timeout > 0 ? `${counts.timeout} إسكات` : null,
    counts.warn > 0 ? `${counts.warn} تحذير` : null
  ].filter((part): part is string => part !== null);
  return parts.length ? parts.join(" · ") : "لا عقوبات خلال آخر 24 ساعة";
}

const actionLabels: Record<string, string> = {
  "moderation.ban": "حظر",
  "moderation.unban": "رفع حظر",
  "moderation.kick": "طرد",
  "moderation.timeout": "إسكات مؤقت",
  "moderation.warn": "تحذير",
  "moderation.clearwarns": "مسح تحذيرات"
};

const actionLabel = (eventId: string) => actionLabels[eventId] ?? eventId.replace("moderation.", "");

function ActionIcon({ eventId }: { eventId: string }) {
  const Icon = eventId === "moderation.ban" ? Ban : eventId === "moderation.kick" ? UserMinus : eventId === "moderation.timeout" ? Zap : ShieldAlert;
  return <Icon className="size-3.5" />;
}

function severityClass(severity: "info" | "warning" | "critical") {
  if (severity === "critical") return "bg-destructive/15 text-destructive";
  if (severity === "warning") return "bg-warning/15 text-warning";
  return "bg-muted text-muted-foreground";
}

/** Why the bot is not shown as live, phrased for an operator. */
function stalenessHint(lastSeenAt: string | null) {
  if (!lastSeenAt) return "لم يُشغَّل بعد";
  const age = Date.now() - Date.parse(lastSeenAt);
  if (age >= BOT_HEARTBEAT_STALE_MS) return `آخر نبضة ${formatRelative(lastSeenAt)}`;
  return "متصل";
}

/** Short, locale-neutral relative time. Arabic wording, no external library. */
function formatRelative(iso: string) {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 60) return "الآن";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `قبل ${minutes} د`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `قبل ${hours} س`;
  const days = Math.round(hours / 24);
  return `قبل ${days} ي`;
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

function Row({ label, value, badge }: { label: string; value: string; badge?: "default" | "destructive" }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      {badge ? <Badge variant={badge === "default" ? "secondary" : "destructive"}>{value}</Badge> : <span className="tabular">{value}</span>}
    </div>
  );
}
