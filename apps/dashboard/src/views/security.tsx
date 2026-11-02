import { useEffect, useState } from "react";
import { Bot, ChevronDown, Eye, Gavel, Hash, Loader2, MessageSquare, Minus, Plus, ShieldAlert, ShieldCheck, ShieldOff, Users, Webhook, Zap } from "lucide-react";
import { api } from "@/api";
import { useDraftForm } from "@/lib/use-draft-form";
import { SaveBar } from "@/components/save-bar";
import { LoadError, LoadingRow } from "@/components/view-states";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import {
  ANTI_NUKE_LIMIT_KEYS,
  ANTI_NUKE_WINDOW_MS,
  NUKE_FAMILIES,
  NUKE_FAMILY_LABELS,
  NUKE_PROTECTIONS,
  activeProtectionCount,
  discordPermissionLabels,
  protectionEnabled,
  protectionsInFamily,
  type NukeFamily,
  type NukeProtection
} from "@al-ai/core/browser";
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
    return <LoadError message={error} />;
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
              <p className="text-xs text-muted-foreground">تُكتب هنا وفي سجل التدقيق.</p>
            </div>
          </CardContent>
        </Card>
      )}

      {events && events.length > 0 && (
        <Card>
          <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
            <CardTitle className="min-w-0 text-base">الأحداث المرصودة</CardTitle>
            <Badge variant="destructive" className="tabular shrink-0">
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
 * The four sections of the protection screen.
 *
 * Only `punish` has controls today. The other three are declared here because the
 * navigation is what the operator needs to see the shape of the feature — and
 * each one renders a plain sentence about what is missing rather than a disabled
 * control that would look configurable and do nothing.
 */
const securityTabs = [
  { key: "punish", label: "تحديد العقوبة", icon: Gavel },
  { key: "instant", label: "عقوبة فورية", icon: Zap },
  { key: "detect", label: "كشف فقط", icon: Eye },
  { key: "selfdef", label: "الدفاع الذاتي للبوت", icon: Bot }
] as const;

type SecurityTab = (typeof securityTabs)[number]["key"];

const familyIcons: Record<NukeFamily, typeof Hash> = {
  channels: Hash,
  roles: ShieldCheck,
  members: Users,
  webhooks: Webhook,
  content: MessageSquare
};

/** The honest sentence for a section whose controls are not built yet. */
const pendingSections: Record<Exclude<SecurityTab, "punish">, string> = {
  instant: "لم تُضبط هذه الإعدادات بعد. المحرّك يعمل الآن بإعدادات قسم «تحديد العقوبة».",
  detect: "لم تُضبط هذه الإعدادات بعد. كل إجراء مرصود يُسجَّل حاليًا في سجل التدقيق وفي قائمة الأحداث.",
  selfdef: "لم تُضبط هذه الإعدادات بعد. المحرّك يستثني رتبته هو ولا يعاقب نفسه."
};

/**
 * The anti-nuke engine's settings.
 *
 * Every limit is a count of one action inside a minute. The engine now ships
 * armed, so a guild is protected from the moment AL AI joins it and this screen
 * exists to tune the thresholds or to switch protection off deliberately. The
 * banner below therefore only appears in the one case worth warning about: an
 * operator has turned it off.
 */
function AntiNukePanel({ guild }: { guild: Guild }) {
  const [loaded, setLoaded] = useState<AntiNukeSettings | null>(null);
  const [config, setConfig] = useState<AntiNukeConfig | null>(null);
  const { saved, draft, dirty, setDraft, reset, commit } = useDraftForm(config);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<SecurityTab>("punish");
  const [family, setFamily] = useState<NukeFamily>("channels");

  useEffect(() => {
    let cancelled = false;
    setLoaded(null);
    setConfig(null);
    setError(null);
    api
      .securityConfig(guild.id)
      .then(result => {
        if (cancelled) return;
        setLoaded(result);
        setConfig(result.config);
      })
      .catch(cause => !cancelled && setError(cause instanceof Error ? cause.message : "تعذّر التحميل."));
    return () => {
      cancelled = true;
    };
  }, [guild.id]);

  if (error) {
    return <LoadError message={error} />;
  }
  if (!loaded || !saved || !draft) {
    return (
      <Card>
        <CardContent className="p-5">
          <LoadingRow label="جارٍ تحميل إعدادات الأمان" />
        </CardContent>
      </Card>
    );
  }

  const canEdit = guild.canManageCommands;
  /**
   * Which limits the server says the engine actually reads.
   *
   * Taken from the response, not from the registry: the old flat grid got this
   * guarantee for free because the server built the rows, and a screen that
   * renders an editable number for an action nothing counts is the same bug in a
   * nicer layout.
   */
  const watchedLimits = new Set(loaded.actions.map(entry => ANTI_NUKE_LIMIT_KEYS[entry.action]));
  /**
   * The punishment the engine actually applies, named from the roles Discord
   * returned rather than from the stored ID.
   *
   * A row that said «رتبة الحجر» without naming which one would be describing a
   * setting the operator cannot verify, and a stored ID matching no role renders
   * as the no-role case — which is what mitigation does in that situation.
   */
  const quarantineRole = draft.quarantineRoleId ? loaded.roles.find(role => role.id === draft.quarantineRoleId) : undefined;
  const punishmentLabel = quarantineRole ? `سحب الرتب ← ${quarantineRole.name}` : "بدون رتبة حجر";
  /**
   * Live for this guild right now: armed, switched on, and counted by the engine.
   *
   * One definition used by the section badge and every family pill, because two
   * counters that disagree about what «مفعّل» means is how a screen ends up
   * showing 4/12 beside a family that says 2/2.
   */
  const isActive = (protection: NukeProtection) =>
    draft.enabled &&
    protection.limitKey !== undefined &&
    watchedLimits.has(protection.limitKey) &&
    protectionEnabled(draft.protections, protection.key);
  const setLimit = (limitKey: keyof AntiNukeConfig["limits"], value: number) =>
    setDraft({
      ...draft,
      limits: { ...draft.limits, [limitKey]: value }
    });

  return (
    <Card>
      {/*
        The unsaved-changes bar lives at the **end** of the screen, floating
        above the content while the screen scrolls. It is *below* an open
        dropdown menu (the menus are portalled at z-50, the bar is at z-40), so
        it never swallows the click that should have chosen an option.
      */}
      <CardHeader className="flex-col gap-3 space-y-0 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <CardTitle className="flex items-center gap-2 text-base">
            {draft.enabled ? <ShieldCheck className="size-4 text-success" /> : <ShieldOff className="size-4" />}
            محرّك مضاد التخريب
          </CardTitle>
          <CardDescription>
            يراقب الإجراءات التدميرية ويحتويها عند تجاوز الحد.
          </CardDescription>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Switch
            checked={draft.enabled}
            disabled={!canEdit}
            aria-label="تفعيل نظام حماية الإشراف التلقائي"
            onCheckedChange={enabled => setDraft({ ...draft, enabled })}
          />
        </div>
      </CardHeader>

      <CardContent className="space-y-5">
        {!draft.enabled && (
          <Alert>
            <ShieldOff />
            <AlertDescription>
              الحماية متوقفة. لن يُرصد تخريب حتى تعيد التفعيل.
            </AlertDescription>
          </Alert>
        )}

        {/* Segmented navigation: one pill strip, active tab in primary. */}
        <nav
          role="tablist"
          aria-label="أقسام الحماية"
          className="scrollbar-none inline-flex max-w-full flex-wrap items-center gap-1 rounded-2xl border border-border/80 bg-card/70 p-1.5 backdrop-blur-md"
        >
          {securityTabs.map(entry => {
            const Icon = entry.icon;
            const active = tab === entry.key;
            return (
              <button
                key={entry.key}
                role="tab"
                aria-selected={active}
                onClick={() => setTab(entry.key)}
                className={
                  active
                    ? "flex items-center gap-1.5 whitespace-nowrap rounded-xl bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground shadow-sm shadow-primary/30 transition-colors"
                    : "flex items-center gap-1.5 whitespace-nowrap rounded-xl px-3.5 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                }
              >
                <Icon className="size-4" aria-hidden />
                {entry.label}
              </button>
            );
          })}
        </nav>

        {tab !== "punish" && (
          <Alert>
            <ShieldAlert />
            <AlertDescription>{pendingSections[tab]}</AlertDescription>
          </Alert>
        )}

        {tab === "punish" && (
          <>
            <nav
              role="tablist"
              aria-label="عائلات الحماية"
              className="scrollbar-none inline-flex max-w-full flex-wrap items-center gap-1 rounded-2xl border border-border/80 bg-background/60 p-1.5"
            >
              {NUKE_FAMILIES.map(entry => {
                const Icon = familyIcons[entry];
                const active = family === entry;
                const rows = protectionsInFamily(entry);
                const live = rows.filter(isActive).length;
                return (
                  <button
                    key={entry}
                    role="tab"
                    aria-selected={active}
                    onClick={() => setFamily(entry)}
                    className={
                      active
                        ? "flex items-center gap-1.5 whitespace-nowrap rounded-xl bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground shadow-sm shadow-primary/30 transition-colors"
                        : "flex items-center gap-1.5 whitespace-nowrap rounded-xl px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    }
                  >
                    <Icon className="size-3.5" aria-hidden />
                    {NUKE_FAMILY_LABELS[entry]}
                    <span className="tabular text-[11px] opacity-80">
                      {live}/{rows.length}
                    </span>
                  </button>
                );
              })}
            </nav>

            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 space-y-1">
                <p className="text-sm font-medium">تعيين حد وعقوبة لكل إجراء</p>
                <p className="text-xs text-muted-foreground">
                  الحد يشمل القيمة نفسها: حد «3» يسمح بثلاث عمليات ويحتوي الرابعة.
                </p>
              </div>
              <Badge variant={draft.enabled ? "secondary" : "destructive"} className="tabular shrink-0">
                {activeProtectionCount(draft.enabled, draft.protections)}/{NUKE_PROTECTIONS.length} مفعّل
              </Badge>
            </div>

            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-medium">{NUKE_FAMILY_LABELS[family]}</p>
              <span className="tabular text-xs text-muted-foreground">
                {protectionsInFamily(family).filter(isActive).length}/{protectionsInFamily(family).length} مفعّل
              </span>
            </div>

            <div className="grid gap-3 lg:grid-cols-2">
              {protectionsInFamily(family).map(protection => {
                const limitKey = protection.limitKey;
                const enforced = limitKey !== undefined && watchedLimits.has(limitKey);
                return (
                  <ProtectionCard
                    key={protection.key}
                    protection={protection}
                    enforced={enforced}
                    canEdit={canEdit && enforced}
                    enabled={protectionEnabled(draft.protections, protection.key)}
                    limitValue={limitKey ? draft.limits[limitKey] : protection.limit.default}
                    punishmentLabel={punishmentLabel}
                    windowSeconds={ANTI_NUKE_WINDOW_MS / 1000}
                    onToggle={enabled =>
                      setDraft({
                        ...draft,
                        protections: { ...draft.protections, [protection.key]: { enabled } }
                      })
                    }
                    onLimitChange={value => {
                      if (limitKey) setLimit(limitKey, value);
                    }}
                  />
                );
              })}
            </div>

            {family === "roles" && (
              <p className="text-xs text-muted-foreground">
                إنشاء الرتب وحذفها يُحتسبان في ميزانية واحدة: الحد يظهر في السطرين لأنهما يقرآن رقمًا واحدًا.
              </p>
            )}

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
                  ? "عند تجاوز الحد تُسحب رتب العضو وتُمنح رتبة الحجر."
                  : "بدون رتبة حجر: يُبلَّغ المالك ويُسجَّل الحدث، دون سحب رتب."}
              </p>
            </div>
          </>
        )}
      </CardContent>

      {dirty && (
        <SaveBar
          onCancel={reset}
          onSave={async () => {
            const result = await api.saveSecurityConfig(guild.id, draft);
            commit(result.config);
          }}
        />
      )}
    </Card>
  );
}

/**
 * One protection, as the operator meets it: a switch, and the settings that only
 * matter once the switch is on.
 *
 * The fields appear under the toggle rather than beside it because three of the
 * four are not per-protection yet. Showing them always would put a disabled
 * dropdown in front of someone who has not enabled the protection; showing them
 * only when it is on matches what the engine will do with them, and the hint at
 * the bottom says exactly which of them the engine reads today.
 */
function ProtectionCard({
  protection,
  enforced,
  canEdit,
  enabled,
  limitValue,
  punishmentLabel,
  windowSeconds,
  onToggle,
  onLimitChange
}: {
  protection: NukeProtection;
  /** Whether the engine counts this action at all. */
  enforced: boolean;
  canEdit: boolean;
  enabled: boolean;
  limitValue: number;
  punishmentLabel: string;
  windowSeconds: number;
  onToggle: (enabled: boolean) => void;
  onLimitChange: (value: number) => void;
}) {
  const [showExceptions, setShowExceptions] = useState(false);

  return (
    <div className="rounded-2xl border border-border/80 bg-background/40 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-medium">{protection.label}</p>
          <p className="text-xs text-muted-foreground">{protection.description}</p>
          <p className="font-mono text-[11px] text-muted-foreground/80" dir="ltr">
            {protection.auditEvents.join(" · ")}
          </p>
          <p className="text-[11px] text-muted-foreground">
            يتطلب صلاحية: {discordPermissionLabels[protection.permission] ?? protection.permission}
          </p>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <Switch
            checked={enabled && enforced}
            disabled={!canEdit}
            aria-label={`تفعيل ${protection.label}`}
            onCheckedChange={onToggle}
          />
          {!enforced && (
            <Badge variant="outline" className="text-[10px]">
              غير موصولة بالمحرّك بعد
            </Badge>
          )}
        </div>
      </div>

      {enabled && enforced && (
        <>
          <Separator className="my-3" />

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={`limit-${protection.key}`} className="text-xs font-normal text-muted-foreground">
                الحد المسموح
              </Label>
              <LimitStepper
                id={`limit-${protection.key}`}
                value={limitValue}
                min={protection.limit.min}
                max={protection.limit.max}
                disabled={!canEdit}
                onChange={onLimitChange}
              />
            </div>

            <div className="space-y-1.5">
              <span className="text-xs font-normal text-muted-foreground">العقوبة</span>
              {/* Disabled on purpose: mitigation is one sequence for the whole
                  engine (strip roles → quarantine → notify owner), not a choice
                  per action yet. The value shown is the real one. */}
              <Select value="quarantine" disabled>
                <SelectTrigger aria-label={`عقوبة ${protection.label}`} className="w-full">
                  <SelectValue>{punishmentLabel}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="quarantine">{punishmentLabel}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor={`window-${protection.key}`} className="text-xs font-normal text-muted-foreground">
                نفاذة الوقت (ثانية)
              </Label>
              <LimitStepper
                id={`window-${protection.key}`}
                value={windowSeconds}
                min={windowSeconds}
                max={windowSeconds}
                disabled
                onChange={() => {}}
              />
            </div>

            <div className="space-y-1.5">
              <button
                type="button"
                onClick={() => setShowExceptions(open => !open)}
                aria-expanded={showExceptions}
                className="flex w-full items-center justify-between gap-2 rounded-lg px-1 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                استثناءات خاصة بهذه الحماية
                <ChevronDown className={`size-3.5 transition-transform ${showExceptions ? "rotate-180" : ""}`} aria-hidden />
              </button>
              {showExceptions && (
                <p className="rounded-lg border border-dashed border-border/70 px-3 py-2 text-[11px] text-muted-foreground">
                  قائمة مستثنيين لكل حماية لم تُوصَل بالمحرّك بعد؛ المحرّك الآن يستثني نفسه فقط.
                </p>
              )}
            </div>
          </div>

          <p className="mt-3 text-[11px] text-muted-foreground">
            الحد يقرؤه المحرّك الآن. العقوبة والنافذة والاستثناءات تُطبَّق على كل المحرّك: العقوبة هي رتبة الحجر،
            والنافذة {windowSeconds} ثانية ثابتة.
          </p>
        </>
      )}
    </div>
  );
}

/**
 * A bounded number with − and + beside it.
 *
 * The buttons clamp rather than pass a raw value on, so the field can never hold
 * a number the engine would refuse — and the lower button disappears at the
 * floor instead of sitting there disabled, which is how a limit of 1 tells you it
 * is already at its minimum.
 */
function LimitStepper({
  id,
  value,
  min,
  max,
  disabled,
  onChange
}: {
  id: string;
  value: number;
  min: number;
  max: number;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  const step = (delta: number) => onChange(Math.min(max, Math.max(min, Math.trunc(value + delta))));

  return (
    <div className="flex items-center gap-1.5">
      {value > min && (
        <Button type="button" size="icon" variant="outline" className="size-8 shrink-0 rounded-lg" disabled={disabled} onClick={() => step(-1)} aria-label="إنقاص الحد">
          <Minus className="size-3.5" />
        </Button>
      )}
      <Input
        id={id}
        type="number"
        min={min}
        max={max}
        dir="ltr"
        className="h-8 w-full tabular text-center"
        disabled={disabled}
        value={value}
        onChange={event => onChange(Number(event.target.value))}
      />
      {value < max && (
        <Button type="button" size="icon" variant="outline" className="size-8 shrink-0 rounded-lg" disabled={disabled} onClick={() => step(1)} aria-label="زيادة الحد">
          <Plus className="size-3.5" />
        </Button>
      )}
    </div>
  );
}
