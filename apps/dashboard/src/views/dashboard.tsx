import { Activity, Database, Gauge, Server, ShieldCheck, TriangleAlert, UserCog } from "lucide-react";
import { VERIFICATION_REMIND_USER_THRESHOLD } from "@al-ai/core/browser";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { tierLabels, type Guild, type HealthSnapshot } from "@/types";

export function DashboardView({ guild, health }: { guild: Guild; health: HealthSnapshot | null }) {
  const botOnline = health?.bot === "connected";
  const dbOnline = health?.database === "reachable";

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat icon={Activity} label="البوت" value={botOnline ? "متصل" : "غير متصل"} tone={botOnline ? "ok" : "bad"} />
        <Stat icon={Database} label="قاعدة البيانات" value={dbOnline ? "متصلة" : "غير متاحة"} tone={dbOnline ? "ok" : "bad"} />
        <Stat icon={Gauge} label="أحداث Gateway" value={health ? `${health.gateway.eventsLastMinute} / ${health.gateway.ceiling}` : "—"} tone="neutral" />
        <Stat icon={Server} label="سيرفرات مسجلة" value={health ? String(health.verification.guildCount) : "—"} tone="neutral" />
      </div>

      {health?.verification.warning && (
        <Alert>
          <TriangleAlert />
          <AlertDescription>{health.verification.warning}</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-3 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">السيرفر</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <Row label="الاسم" value={guild.name} />
            <Separator />
            <Row label="الأعضاء" value={guild.memberCount.toLocaleString("ar")} />
            <Separator />
            <Row label="رتبتك" value={guild.tier ? tierLabels[guild.tier] : "لا توجد رتبة AL AI"} />
            <Separator />
            <Row
              label="البوت"
              value={guild.botPresent ? "مضاف" : "غير مضاف"}
              badge={guild.botPresent ? "default" : "destructive"}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">سلامة التكامل</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <Row label="اللوحة" value={health?.dashboard === "online" ? "تعمل" : "—"} />
            <Separator />
            <Row
              label="مستخدمون فريدون"
              value={health ? `${health.verification.uniqueUsers.toLocaleString("ar")} / ${VERIFICATION_REMIND_USER_THRESHOLD.toLocaleString("ar")}` : "—"}
            />
            <Separator />
            <Row label="طلب التوثيق" value={health?.verification.reviewRequired ? "مطلوب" : "غير مطلوب"} />
            <Separator />
            <Row label="المصادقة" value="إعادة فحص على الخادم" />
            <Separator />
            <p className="flex items-center gap-2 pt-1 text-xs text-muted-foreground">
              <ShieldCheck className="size-3.5" />
              لا تُعرض أي أسرار في المتصفح
            </p>
          </CardContent>
        </Card>
      </div>

      {!guild.botPresent && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <UserCog className="size-4" />
              إضافة البوت
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="mb-3 text-sm text-muted-foreground">أضف AL AI بتصاريح bot و applications.commands.</p>
            <a
              href={`/api/guilds/${guild.id}/invite`}
              className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground"
            >
              إضافة عبر Discord
            </a>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
  tone
}: {
  icon: typeof Activity;
  label: string;
  value: string;
  tone: "ok" | "bad" | "neutral";
}) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-4">
        <div
          className={
            tone === "ok"
              ? "grid size-9 place-items-center rounded-lg bg-success/15 text-success"
              : tone === "bad"
                ? "grid size-9 place-items-center rounded-lg bg-destructive/15 text-destructive"
                : "grid size-9 place-items-center rounded-lg bg-muted text-muted-foreground"
          }
        >
          <Icon className="size-4" />
        </div>
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className="truncate text-sm font-semibold tabular">{value}</p>
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
