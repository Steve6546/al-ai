import { useEffect, useState } from "react";
import { Loader2, ShieldAlert, ShieldCheck, ShieldOff } from "lucide-react";
import { api } from "@/api";
import { SaveBar } from "@/components/save-bar";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { formatDateTime } from "@/lib/format";
import type { AntiNukeConfig, AntiNukeSettings, Guild, SecurityEvent } from "@/types";

/**
 * Intrusion detection, and the anti-nuke engine that acts on it.
 *
 * Two halves. The engine is the active one: it watches destructive actions and
 * responds to a burst before a human could. The feed below it is the record —
 * every `security.*` event is critical by contract and is written to bot-log and
 * the append-only trail together, so this screen and the audit screen always
 * agree. An empty feed is the healthy state.
 */
export function SecurityView({ guild }: { guild: Guild }) {
  const [events, setEvents] = useState<SecurityEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setEvents(null);
    setError(null);
    api
      .security(guild.id)
      .then(result => !cancelled && setEvents(result.events))
      .catch(cause => !cancelled && setError(cause instanceof Error ? cause.message : "تعذّر التحميل."));
    return () => {
      cancelled = true;
    };
  }, [guild.id]);

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-4">
      <AntiNukePanel guild={guild} />

      {events && events.length === 0 && (
        <Card>
          <CardContent className="flex items-center gap-3 p-5">
            <div className="grid size-10 place-items-center rounded-lg bg-success/15 text-success">
              <ShieldCheck className="size-5" />
            </div>
            <div>
              <p className="text-sm font-medium">لا توجد محاولات مرصودة</p>
              <p className="text-xs text-muted-foreground">كل أحداث security.* تُكتب هنا وفي سجل التدقيق</p>
            </div>
          </CardContent>
        </Card>
      )}

      {events && events.length > 0 && (
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base">الأحداث المرصودة</CardTitle>
            <Badge variant="destructive" className="tabular">
              {events.length}
            </Badge>
          </CardHeader>
          <CardContent className="space-y-1">
            {events.map((event, index) => (
              <div key={event.id}>
                {index > 0 && <Separator className="my-1" />}
                <div className="flex items-start gap-3 py-2.5">
                  <div className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md bg-destructive/15 text-destructive">
                    <ShieldAlert className="size-3.5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="font-mono text-xs" dir="ltr">
                      {event.eventId}
                    </p>
                    {event.payload && (
                      <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground" dir="ltr">
                        {Object.entries(event.payload)
                          .map(([key, value]) => `${key}=${String(value)}`)
                          .join("  ")}
                      </p>
                    )}
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      {event.sourceLayer} · {formatDateTime(event.createdAt)}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {!events && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          جارٍ التحميل
        </div>
      )}
    </div>
  );
}

/** Sentinel for "no quarantine role". Radix forbids an empty string as a value. */
const NO_ROLE = "__none__";

/**
 * The anti-nuke engine's settings.
 *
 * Every limit is a count of one action inside a minute. The engine ships
 * disarmed and says so plainly: mitigation strips a moderator's roles, and that
 * has to be the owner's decision rather than a default nobody read.
 */
function AntiNukePanel({ guild }: { guild: Guild }) {
  const [loaded, setLoaded] = useState<AntiNukeSettings | null>(null);
  const [saved, setSaved] = useState<AntiNukeConfig | null>(null);
  const [draft, setDraft] = useState<AntiNukeConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoaded(null);
    setSaved(null);
    setDraft(null);
    setError(null);
    api
      .securityConfig(guild.id)
      .then(result => {
        if (cancelled) return;
        setLoaded(result);
        setSaved(result.config);
        setDraft(result.config);
      })
      .catch(cause => !cancelled && setError(cause instanceof Error ? cause.message : "تعذّر التحميل."));
    return () => {
      cancelled = true;
    };
  }, [guild.id]);

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }
  if (!loaded || !saved || !draft) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 p-5 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          جارٍ تحميل إعدادات الأمان
        </CardContent>
      </Card>
    );
  }

  const dirty = JSON.stringify(saved) !== JSON.stringify(draft);
  const canEdit = guild.canManageCommands;
  const setLimit = (action: (typeof loaded.actions)[number]["action"], value: number) =>
    setDraft({
      ...draft,
      limits: { ...draft.limits, [keyFor(action)]: value }
    });

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between space-y-0">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2 text-base">
            {draft.enabled ? <ShieldCheck className="size-4 text-success" /> : <ShieldOff className="size-4" />}
            محرّك مضاد التخريب
          </CardTitle>
          <CardDescription>
            يراقب الإجراءات التدميرية ويحتويها تلقائياً عند تجاوز الحد، قبل أن يتدخّل أحد.
          </CardDescription>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={draft.enabled ? "secondary" : "outline"}>{draft.enabled ? "مفعّل" : "غير مفعّل"}</Badge>
          <Switch
            checked={draft.enabled}
            disabled={!canEdit}
            aria-label="تفعيل محرّك مضاد التخريب"
            onCheckedChange={enabled => setDraft({ ...draft, enabled })}
          />
        </div>
      </CardHeader>

      <CardContent className="space-y-5">
        {!draft.enabled && (
          <Alert>
            <ShieldOff />
            <AlertDescription>
              المحرّك مبني وجاهز لكنه متوقف. لن يُحتوى أي عضو حتى تفعّله — لأن الاحتواء يسحب رتب المشرف، وهذا قرارك أنت.
            </AlertDescription>
          </Alert>
        )}

        <div className="space-y-3">
          <p className="text-sm font-medium">حدود الإجراءات (خلال دقيقة واحدة)</p>
          {loaded.actions.map(({ action, label }) => (
            <div key={action} className="flex items-center justify-between gap-4">
              <Label htmlFor={`limit-${action}`} className="text-sm font-normal text-muted-foreground">
                {label}
              </Label>
              <Input
                id={`limit-${action}`}
                type="number"
                min={1}
                max={100}
                dir="ltr"
                className="w-24 tabular"
                disabled={!canEdit}
                value={draft.limits[keyFor(action)]}
                onChange={event => setLimit(action, Number(event.target.value))}
              />
            </div>
          ))}
          <p className="text-xs text-muted-foreground">
            الحد يشمل القيمة نفسها: حد «3» يسمح بثلاث عمليات ويحتوي الرابعة.
          </p>
        </div>

        <Separator />

        <div className="space-y-2">
          <Label htmlFor="quarantine-role">رتبة الحجر</Label>
          <Select
            value={draft.quarantineRoleId ?? NO_ROLE}
            disabled={!canEdit}
            onValueChange={value => setDraft({ ...draft, quarantineRoleId: value === NO_ROLE ? null : value })}
          >
            <SelectTrigger id="quarantine-role" className="w-full">
              <SelectValue placeholder="بدون رتبة حجر" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_ROLE}>بدون رتبة حجر</SelectItem>
              {loaded.roles.map(role => (
                <SelectItem key={role.id} value={role.id}>
                  {role.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {draft.quarantineRoleId
              ? "عند تجاوز الحد تُسحب كل رتب العضو وتوضع هذه الرتبة بدلاً منها، ويُبلَّغ مالك السيرفر فوراً."
              : "بدون رتبة حجر: سيُبلَّغ المالك ويُسجَّل الحدث، لكن لن تُسحب أي رتبة."}
          </p>
        </div>
      </CardContent>

      {dirty && (
        <SaveBar
          onCancel={() => setDraft(saved)}
          onSave={async () => {
            const result = await api.saveSecurityConfig(guild.id, draft);
            setSaved(result.config);
            setDraft(result.config);
          }}
        />
      )}
    </Card>
  );
}

/** Maps an action onto its limit key, mirroring `ANTI_NUKE_LIMIT_KEYS` in core. */
function keyFor(action: string): keyof AntiNukeConfig["limits"] {
  switch (action) {
    case "channel-delete":
      return "channelDeletesPerMinute";
    case "ban":
      return "bansPerMinute";
    default:
      return "roleChangesPerMinute";
  }
}
