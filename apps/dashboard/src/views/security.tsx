import { useEffect, useId, useRef, useState } from "react";
import { AlertTriangle, Ban, Bot, Check, ChevronDown, Clock, DoorOpen, Eye, FolderPlus, Gavel, Hash, KeyRound, Loader2, MessageSquare, MessageSquareX, Minus, MinusCircle, Pencil, Plus, Search, ShieldAlert, ShieldCheck, ShieldMinus, ShieldOff, ShieldPlus, Timer, Trash2, Users, Webhook, WebhookOff, X, Zap } from "lucide-react";
import { api, type ScopedMember } from "@/api";
import { useDraftForm } from "@/lib/use-draft-form";
import { SaveBar } from "@/components/save-bar";
import { LoadError, LoadingRow } from "@/components/view-states";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import {
  ANTI_NUKE_LIMIT_KEYS,
  MAX_PROTECTION_EXCEPTIONS,
  MAX_WINDOW_SECONDS,
  MIN_WINDOW_SECONDS,
  NUKE_PROTECTIONS,
  PROTECTION_PUNISHMENTS,
  activeProtectionCount,
  protectionEnabled,
  protectionsInFamily,
  type NukeFamily,
  type NukeProtection,
  type NukeProtectionKey,
  type ProtectionPunishment
} from "@al-ai/core/browser";
import { formatDateTime, initials } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useI18n, type Translate, type TranslationKey } from "@/lib/i18n";
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
  const { t, language } = useI18n();
  const [events, setEvents] = useState<SecurityEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setEvents(null);
    setError(null);
    api
      .security(guild.id)
      .then(result => !cancelled && setEvents(result.events))
      .catch(cause => !cancelled && setError(cause instanceof Error ? cause.message : t("security.loadFailed")));
    return () => {
      cancelled = true;
    };
  }, [guild.id, t]);

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
              <p className="text-sm font-medium">{t("security.noneTitle")}</p>
              <p className="text-xs text-muted-foreground">{t("security.noneBody")}</p>
            </div>
          </CardContent>
        </Card>
      )}

      {events && events.length > 0 && (
        <Card>
          <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
            <CardTitle className="min-w-0 text-base">{t("security.events")}</CardTitle>
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
                      <p className="mt-1 break-all font-mono text-mini text-muted-foreground" dir="ltr">
                        {Object.entries(event.payload)
                          .map(([key, value]) => `${key}=${String(value)}`)
                          .join("  ")}
                      </p>
                    )}
                    <p className="mt-1 text-mini text-muted-foreground">
                      {event.sourceLayer} · {formatDateTime(event.createdAt, language)}
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
          {t("common.loading")}
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
  { key: "punish", labelKey: "security.tab.punish", icon: Gavel },
  { key: "instant", labelKey: "security.tab.instant", icon: Zap },
  { key: "detect", labelKey: "security.tab.detect", icon: Eye },
  { key: "selfdef", labelKey: "security.tab.selfdef", icon: Bot }
] as const;

type SecurityTab = (typeof securityTabs)[number]["key"];

const familyIcons: Record<NukeFamily, typeof Hash> = {
  channels: Hash,
  roles: ShieldCheck,
  members: Users,
  webhooks: Webhook,
  content: MessageSquare
};

/**
 * One lucide glyph per protection, so a card is recognisable before it is read.
 * Lucide is ISC-licensed; the names are the library's own, checked against the
 * installed package rather than guessed.
 */
const PROTECTION_ICONS: Record<NukeProtectionKey, typeof Hash> = {
  "channel-delete": Trash2,
  "channel-create": FolderPlus,
  "channel-update": Pencil,
  "channel-permissions": KeyRound,
  "role-create": ShieldPlus,
  "role-delete": ShieldMinus,
  "role-update": ShieldAlert,
  "member-ban": Ban,
  "member-kick": DoorOpen,
  "member-timeout": Timer,
  "webhook-create": Webhook,
  "webhook-update": WebhookOff,
  "message-purge": MessageSquareX
};

/**
 * The order the category strip is read in.
 *
 * Deliberately not `NUKE_FAMILIES`: that array is the registry's order, which
 * the engine does not care about, and it puts members before webhooks. The
 * strip is read top to bottom as a scale — what the server is made of
 * (channels, roles), then what connects into it (webhooks), then the people in
 * it, then what they write. Reordering the registry to match would have moved
 * a data structure for a presentation reason.
 */
const FAMILY_ORDER: readonly NukeFamily[] = ["channels", "roles", "webhooks", "members", "content"];

/**
 * The window in words: minutes once it is a minute or more, seconds below that.
 *
 * `Math.round(seconds / 60)` alone printed «0 دقيقة» for a five-second window —
 * a true number that reads as a broken field, so the operator would nudge the
 * stepper again to make the text say something.
 */
function windowHint(seconds: number, t: Translate): string {
  if (seconds < 60) return t("security.windowHintSeconds", { seconds });
  const minutes = Math.round((seconds / 60) * 10) / 10;
  return t("security.windowHint", { minutes });
}

/**
 * Each punishment's icon and tone, so the dropdown reads at a glance.
 *
 * Every class name here is written out in full rather than assembled from a
 * base (`text-${tone}`, `border-${tone}`). Tailwind emits a rule only for class
 * names it can find as literal text in the source, so a name built at runtime
 * produces **no CSS at all** — the border the design asks for would simply not
 * paint, while the markup looked correct. The previous version derived its
 * border from the text tone with a `.replace()`, which is exactly that bug.
 */
const PUNISHMENT_STYLES: Record<
  ProtectionPunishment,
  { icon: typeof Minus; text: string; border: string; surface: string }
> = {
  ban: {
    icon: Ban,
    text: "text-red-700 dark:text-red-400",
    border: "border-red-500/70",
    surface: "bg-red-500/10"
  },
  kick: {
    icon: DoorOpen,
    text: "text-orange-700 dark:text-orange-400",
    border: "border-orange-500/70",
    surface: "bg-orange-500/10"
  },
  timeout: {
    icon: Clock,
    text: "text-amber-700 dark:text-amber-400",
    border: "border-amber-500/70",
    surface: "bg-amber-500/10"
  },
  "remove-roles": {
    icon: MinusCircle,
    text: "text-sky-700 dark:text-sky-400",
    border: "border-sky-500/70",
    surface: "bg-sky-500/10"
  },
  warn: {
    icon: AlertTriangle,
    // The neutral punishment stays neutral in both palettes: it is the one
    // choice that reads as "just tell me", and a colour would make it look like
    // a punishment of its own.
    text: "text-slate-700 dark:text-slate-300",
    border: "border-slate-500/60",
    surface: "bg-slate-500/10"
  }
};

/** The honest sentence for a section whose controls are not built yet. */
const pendingSections: Record<Exclude<SecurityTab, "punish">, TranslationKey> = {
  instant: "security.pending.instant",
  detect: "security.pending.detect",
  selfdef: "security.pending.selfdef"
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
  const { t } = useI18n();
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
      .catch(cause => !cancelled && setError(cause instanceof Error ? cause.message : t("security.loadFailed")));
    return () => {
      cancelled = true;
    };
  }, [guild.id, t]);

  if (error) {
    return <LoadError message={error} />;
  }
  if (!loaded || !saved || !draft) {
    return (
      <Card>
        <CardContent className="p-5">
          <LoadingRow label={t("security.loading")} />
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
  const punishmentLabel = quarantineRole
    ? t("security.strippedRoles", { role: quarantineRole.name })
    : t("security.quarantineNone");
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
    /*
     * A stack of cards, one job each.
     *
     * The screen used to be a single card holding the switch, both tab strips,
     * the settings and the quarantine picker — one border around five unrelated
     * jobs, which read as a long form rather than as a console. It is now cut
     * into surfaces in the order the operator thinks: is it on (1), where am I
     * and which section am I tuning (2), what do I set here (3 — one card per
     * protection, so a tool can be read and switched without reading its
     * neighbours), and what mitigation leaves behind (4).
     *
     * The save bar is last and outside every card: it floats over the page, so
     * belonging to one of them would be a lie.
     */
    <div className="space-y-3">
      {/* 1 — the switch, on its own. */}
      <Card>
        <CardContent className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <div
              className={cn(
                "grid size-10 shrink-0 place-items-center rounded-xl",
                draft.enabled ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"
              )}
            >
              {draft.enabled ? <ShieldCheck className="size-5" aria-hidden /> : <ShieldOff className="size-5" aria-hidden />}
            </div>
            <div className="min-w-0 space-y-1">
              <p className="text-base font-semibold">{t("security.engineTitle")}</p>
              <p className="text-sm text-muted-foreground">{t("security.engineBody")}</p>
            </div>
          </div>
          <Switch
            checked={draft.enabled}
            disabled={!canEdit}
            aria-label={t("security.enableAria")}
            onCheckedChange={enabled => setDraft({ ...draft, enabled })}
          />
        </CardContent>
        {!draft.enabled && (
          <CardContent className="pt-0">
            <Alert>
              <ShieldOff />
              <AlertDescription>{t("security.off")}</AlertDescription>
            </Alert>
          </CardContent>
        )}
      </Card>

      {/*
        2 — the mode strip, alone on its surface and filling the width.

        The four modes are a grid, not a right-aligned row of pills: the old row
        left half the card empty on an RTL screen, which read as a broken layout
        rather than as navigation.
      */}
      <Card>
        <CardContent className="space-y-2 p-4 sm:p-5">
          <p className="text-mini font-medium text-muted-foreground">{t("security.navMode")}</p>
          <nav role="tablist" aria-label={t("security.tabsAria")} className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
            {securityTabs.map(entry => {
              const Icon = entry.icon;
              const active = tab === entry.key;
              return (
                <button
                  key={entry.key}
                  role="tab"
                  aria-selected={active}
                  onClick={() => setTab(entry.key)}
                  className={cn(
                    "flex items-center justify-center gap-1.5 whitespace-nowrap rounded-xl border px-2 py-2.5 text-sm transition-colors sm:gap-2",
                    active
                      ? "border-primary bg-primary font-medium text-primary-foreground shadow-sm shadow-primary/25"
                      : "border-border bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground"
                  )}
                >
                  <Icon className="size-4 shrink-0" aria-hidden />
                  {t(entry.labelKey)}
                </button>
              );
            })}
          </nav>
        </CardContent>
      </Card>

      {tab !== "punish" && (
        <Alert>
          <ShieldAlert />
          <AlertDescription>{t(pendingSections[tab])}</AlertDescription>
        </Alert>
      )}

      {tab === "punish" && (
        <>
          {/*
            The section header carries the WHOLE engine's counter — every
            protection in all five families — because «am I protected?» is one
            question, not five. The per-family figures live on the strip below
            and beside the family heading, so the two scales never disagree.
          */}
          <div className="space-y-1 px-1 pt-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-bold">{t("security.tab.punish")}</h2>
              <Badge variant={draft.enabled ? "secondary" : "destructive"} className="tabular shrink-0">
                {t("security.activeCount", {
                  active: activeProtectionCount(draft.enabled, draft.protections),
                  total: NUKE_PROTECTIONS.length
                })}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground">{t("security.punish.title")}</p>
          </div>

          <div className="space-y-2">
            <p className="px-1 text-mini font-medium text-muted-foreground">{t("security.navFamilies")}</p>
            <nav
              role="tablist"
              aria-label={t("security.familiesAria")}
              className="grid grid-cols-2 gap-1 rounded-2xl border border-border bg-card p-1 sm:grid-cols-3 lg:grid-cols-5"
            >
              {FAMILY_ORDER.map(entry => {
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
                    className={cn(
                      "flex items-center justify-center gap-1.5 rounded-xl px-2 py-2.5 text-sm transition-colors",
                      active
                        ? "bg-primary font-medium text-primary-foreground shadow-sm shadow-primary/25"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground"
                    )}
                  >
                    <Icon className="size-3.5 shrink-0" aria-hidden />
                    <span className="truncate">{t(`security.family.${entry}` as TranslationKey)}</span>
                    <span className="tabular text-mini opacity-80">
                      {live}/{rows.length}
                    </span>
                  </button>
                );
              })}
            </nav>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 px-1">
            <p className="min-w-0 truncate text-base font-semibold">
              {t(`security.family.${family}` as TranslationKey)}
            </p>
            <p className="tabular shrink-0 text-xs text-muted-foreground">
              {t("security.activeCount", {
                active: protectionsInFamily(family).filter(isActive).length,
                total: protectionsInFamily(family).length
              })}
            </p>
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            {protectionsInFamily(family).map(protection => {
              const limitKey = protection.limitKey;
              const enforced = limitKey !== undefined && watchedLimits.has(limitKey);
              const current = draft.protections[protection.key];
              const patchProtection = (next: Partial<typeof current>) =>
                setDraft({
                  ...draft,
                  protections: { ...draft.protections, [protection.key]: { ...current, ...next } }
                });
              return (
                <ProtectionCard
                  key={protection.key}
                  guildId={guild.id}
                  protection={protection}
                  enforced={enforced}
                  canEdit={canEdit && enforced}
                  enabled={protectionEnabled(draft.protections, protection.key)}
                  limitValue={limitKey ? draft.limits[limitKey] : protection.limit.default}
                  punishment={current.punishment}
                  timeoutSeconds={current.timeoutSeconds}
                  windowSeconds={current.windowSeconds}
                  exceptions={current.exceptions}
                  onToggle={enabled => patchProtection({ enabled })}
                  onLimitChange={value => {
                    if (limitKey) setLimit(limitKey, value);
                  }}
                  onPunishmentChange={punishment => patchProtection({ punishment })}
                  onTimeoutChange={timeoutSeconds => patchProtection({ timeoutSeconds })}
                  onWindowChange={windowSeconds => patchProtection({ windowSeconds })}
                  onExceptionsChange={exceptions => patchProtection({ exceptions })}
                />
              );
            })}
          </div>

          {family === "roles" && (
            <p className="px-1 text-xs text-muted-foreground">{t("security.rolesShared")}</p>
          )}
        </>
      )}

      {/* 4 — what mitigation leaves behind. */}
      <Card>
        <CardContent className="space-y-2 p-5">
          <Label htmlFor="quarantine-role">{t("security.quarantine")}</Label>
          <Select
            value={draft.quarantineRoleId ?? NO_ROLE}
            disabled={!canEdit}
            onValueChange={value => setDraft({ ...draft, quarantineRoleId: value === NO_ROLE ? null : value })}
          >
            <SelectTrigger id="quarantine-role" className="w-full">
              <SelectValue placeholder={t("security.quarantineNone")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_ROLE}>{t("security.quarantineNone")}</SelectItem>
              {loaded.roles.map(role => (
                <SelectItem key={role.id} value={role.id}>
                  {role.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {draft.quarantineRoleId
              ? t("security.quarantineOn")
              : t("security.quarantineOff")}
          </p>
        </CardContent>
      </Card>

      {dirty && (
        <SaveBar
          onCancel={reset}
          onSave={async () => {
            const result = await api.saveSecurityConfig(guild.id, draft);
            commit(result.config);
          }}
        />
      )}
    </div>
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
  guildId,
  protection,
  enforced,
  canEdit,
  enabled,
  limitValue,
  punishment,
  timeoutSeconds,
  windowSeconds,
  exceptions,
  onToggle,
  onLimitChange,
  onPunishmentChange,
  onTimeoutChange,
  onWindowChange,
  onExceptionsChange
}: {
  /** The guild whose members the exception picker searches. */
  guildId: string;
  protection: NukeProtection;
  /** Whether the engine counts this action at all. */
  enforced: boolean;
  canEdit: boolean;
  enabled: boolean;
  limitValue: number;
  punishment: ProtectionPunishment;
  timeoutSeconds: number;
  windowSeconds: number;
  /** Members this protection never counts, as Discord user IDs. */
  exceptions: string[];
  onToggle: (enabled: boolean) => void;
  onLimitChange: (value: number) => void;
  onPunishmentChange: (value: ProtectionPunishment) => void;
  onTimeoutChange: (value: number) => void;
  onWindowChange: (value: number) => void;
  onExceptionsChange: (value: string[]) => void;
}) {
  const { t } = useI18n();
  const [showExceptions, setShowExceptions] = useState(false);
  const style = PUNISHMENT_STYLES[punishment];
  const PunishIcon = style.icon;
  const ProtectionIcon = PROTECTION_ICONS[protection.key];
  const label = t(`security.protection.${protection.key}.label` as TranslationKey);

  return (
    /*
     * A `Card`, not a bordered div: these are now peers of the cards above, not
     * rows inside a section container, so they must share the same surface and
     * border instead of the recessed tint they had while nested.
     *
     * `@container`: the settings inside are laid out by the width of *this*
     * card, not of the window. The card is half the column on a wide screen and
     * full width below `lg`, so a viewport breakpoint put two columns in a 330px
     * card and the punishment field truncated its own label to «سحب».
     */
    <Card className="@container flex flex-col p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
            <ProtectionIcon className="size-5" aria-hidden />
          </div>
          <div className="min-w-0 space-y-1">
            <p className="text-base font-semibold">{label}</p>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {t(`security.protection.${protection.key}.description` as TranslationKey)}
            </p>
          </div>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <Switch
            checked={enabled && enforced}
            disabled={!canEdit}
            aria-label={label}
            onCheckedChange={onToggle}
          />
          {!enforced && (
            <Badge variant="outline" className="text-micro">
              {t("security.notWired")}
            </Badge>
          )}
        </div>
      </div>

      {enabled && enforced && (
        <>
          <Separator className="my-3" />

          <div className="grid gap-3 @md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={`limit-${protection.key}`} className="text-xs font-normal text-muted-foreground">
                {t("security.limit")}
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
              <span className="text-xs font-normal text-muted-foreground">{t("security.punishment")}</span>
              <Select
                value={punishment}
                disabled={!canEdit}
                onValueChange={value => onPunishmentChange(value as ProtectionPunishment)}
              >
                {/*
                  The closed field states the current choice three ways — the
                  punishment's own icon, its name in its own colour, and a check
                  — inside a border that carries the same colour. That is the
                  whole point of the control: the operator reads what this
                  protection will do without opening the menu, and a red border
                  beside an amber one two cards over is legible from across the
                  screen.

                  The contents are a `div`, not a `span`: `SelectTrigger` applies
                  `line-clamp-1` to every direct `span` child, which sets
                  `display: -webkit-box` and silently flattens a flex row — the
                  check would fall under the label and the row would stop being
                  one line.
                */}
                <SelectTrigger
                  aria-label={t("security.punishmentAria", { protection: label })}
                  className={cn(
                    "h-11 w-full rounded-xl border-2 text-sm font-medium transition-colors",
                    style.border,
                    style.surface
                  )}
                >
                  <div className="flex w-full min-w-0 items-center gap-2">
                    <PunishIcon className={cn("size-4 shrink-0", style.text)} aria-hidden />
                    <span className={cn("truncate", style.text)}>
                      {t(`security.punishmentKind.${punishment}` as TranslationKey)}
                    </span>
                    <Check className={cn("ms-auto size-4 shrink-0", style.text)} aria-hidden />
                  </div>
                </SelectTrigger>
                <SelectContent>
                  {PROTECTION_PUNISHMENTS.map(kind => {
                    const meta = PUNISHMENT_STYLES[kind];
                    const Icon = meta.icon;
                    return (
                      <SelectItem key={kind} value={kind} className="cursor-pointer py-2">
                        <span className="flex items-center gap-2">
                          <Icon className={cn("size-4 shrink-0", meta.text)} aria-hidden />
                          <span className={meta.text}>{t(`security.punishmentKind.${kind}` as TranslationKey)}</span>
                        </span>
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor={`window-${protection.key}`} className="text-xs font-normal text-muted-foreground">
                {t("security.window")}
              </Label>
              <LimitStepper
                id={`window-${protection.key}`}
                value={windowSeconds}
                // The same range the engine clamps to, so the field cannot offer
                // a number the save would quietly change.
                min={MIN_WINDOW_SECONDS}
                max={MAX_WINDOW_SECONDS}
                disabled={!canEdit}
                onChange={onWindowChange}
              />
              <p className="text-mini text-muted-foreground">{windowHint(windowSeconds, t)}</p>
            </div>

            {punishment === "timeout" && (
              <div className="space-y-1.5">
                <Label htmlFor={`timeout-${protection.key}`} className="text-xs font-normal text-muted-foreground">
                  {t("security.timeoutSeconds")}
                </Label>
                <LimitStepper
                  id={`timeout-${protection.key}`}
                  value={timeoutSeconds}
                  min={60}
                  max={2419200}
                  disabled={!canEdit}
                  onChange={onTimeoutChange}
                />
              </div>
            )}
          </div>

          {/*
            The exception list spans the card rather than sharing the two-column
            grid with the numbers. A search field is the one control here that
            gets wider as it gets more useful — a name, an avatar and a handle
            need room — and a half-width column inside a half-width card left it
            a few characters wide.
          */}
          <div className="mt-3">
            <button
              type="button"
              onClick={() => setShowExceptions(open => !open)}
              aria-expanded={showExceptions}
              className="flex w-full items-center justify-between gap-2 rounded-xl border border-border/70 bg-muted/30 px-3 py-2 text-xs font-medium transition-colors hover:bg-muted/60"
            >
              <span className="flex items-center gap-1.5">
                <Users className="size-3.5" aria-hidden />
                {t("security.exceptions")}
                {exceptions.length > 0 && (
                  <Badge variant="secondary" className="tabular h-5 px-1.5 text-micro">
                    {exceptions.length}
                  </Badge>
                )}
              </span>
              <ChevronDown className={cn("size-3.5 shrink-0 transition-transform", showExceptions && "rotate-180")} aria-hidden />
            </button>
            {showExceptions && (
              <div className="mt-2">
                <ExceptionPicker
                  guildId={guildId}
                  value={exceptions}
                  disabled={!canEdit}
                  onChange={onExceptionsChange}
                />
              </div>
            )}
          </div>
        </>
      )}
    </Card>
  );
}

/* -------------------------------------------------------------------- *
 * Exceptions
 * -------------------------------------------------------------------- */

/**
 * How long the picker waits after a keystroke before asking the server.
 *
 * Long enough that typing a name is one request rather than one per letter,
 * short enough that the list appears while the operator is still looking at the
 * field. The server debounces nothing on its side, so this is the only thing
 * standing between a fast typist and a burst of Discord calls.
 */
const SEARCH_DEBOUNCE_MS = 250;

/**
 * The members one protection exempts.
 *
 * A search field, not a member list: the list is the guild, and the guild has
 * thousands of members. Typing asks the server — which asks Discord — for the
 * handful that match, and each result carries the three things that make a
 * person recognisable: their picture, their display name, and the @handle that
 * is unique to them. Two members can share a display name; only the handle
 * distinguishes them, which is why it is always drawn.
 *
 * Chosen members are shown above the field as chips, resolved by ID so a stored
 * exemption still renders after the member leaves the guild (falling back to
 * the raw ID, which is what the engine matches on anyway).
 */
function ExceptionPicker({
  guildId,
  value,
  disabled,
  onChange
}: {
  guildId: string;
  value: string[];
  disabled: boolean;
  onChange: (next: string[]) => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ScopedMember[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [open, setOpen] = useState(false);
  const [known, setKnown] = useState<Record<string, ScopedMember>>({});
  const listId = useId();
  /** IDs already asked for, so a failed resolve is not re-requested every render. */
  const requested = useRef<Set<string>>(new Set());

  const full = value.length >= MAX_PROTECTION_EXCEPTIONS;

  // Names for the members already stored. The config holds IDs only — a name is
  // a display detail that changes, and a stored one would go stale.
  useEffect(() => {
    const missing = value.filter(id => !requested.current.has(id));
    if (missing.length === 0) return;
    for (const id of missing) requested.current.add(id);

    let cancelled = false;
    api
      .resolveMembers(guildId, missing)
      .then(result => {
        if (cancelled) return;
        setKnown(current => {
          const next = { ...current };
          for (const member of result.members) next[member.id] = member;
          return next;
        });
      })
      .catch(() => {
        // A name is a courtesy, not the data: the chip falls back to the ID and
        // the list is allowed to ask again on the next change.
        for (const id of missing) requested.current.delete(id);
      });
    return () => {
      cancelled = true;
    };
  }, [guildId, value]);

  // The search itself, debounced. `cancelled` is what stops a slow answer for
  // "ab" from landing on top of a fast one for "abc".
  useEffect(() => {
    const needle = query.trim();
    if (needle.length === 0) {
      setResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    let cancelled = false;
    const timer = setTimeout(() => {
      api
        .searchMembers(guildId, needle)
        .then(result => {
          if (cancelled) return;
          setResults(result.members);
          setKnown(current => {
            const next = { ...current };
            for (const member of result.members) next[member.id] = member;
            return next;
          });
        })
        .catch(() => {
          if (!cancelled) setResults([]);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [guildId, query]);

  const add = (member: ScopedMember) => {
    if (value.includes(member.id) || value.length >= MAX_PROTECTION_EXCEPTIONS) return;
    setKnown(current => ({ ...current, [member.id]: member }));
    onChange([...value, member.id]);
    setQuery("");
    setResults(null);
  };

  const remove = (id: string) => onChange(value.filter(entry => entry !== id));

  const dropdownOpen = open && query.trim().length > 0;

  return (
    <div
      className="space-y-2"
      // Focus containment rather than a document listener: the popup closes when
      // focus genuinely leaves the picker, and stays open while it moves between
      // the field and an option.
      onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <p className="text-mini leading-relaxed text-muted-foreground">{t("security.exceptionsBody")}</p>

      {value.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {value.map(id => {
            const member = known[id];
            const name = member?.name ?? id;
            return (
              <li key={id}>
                <span className="flex items-center gap-1.5 rounded-full border border-border/80 bg-muted/50 py-1 pe-1 ps-1.5 text-xs">
                  <Avatar className="size-5">
                    {member?.avatarUrl && <AvatarImage src={member.avatarUrl} alt="" />}
                    <AvatarFallback className="text-[9px]">{initials(name)}</AvatarFallback>
                  </Avatar>
                  <span className="max-w-40 truncate font-medium">{name}</span>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => remove(id)}
                    aria-label={t("common.removeItem", { name })}
                    className="rounded-full p-0.5 text-muted-foreground transition-colors hover:bg-background hover:text-foreground disabled:opacity-50"
                  >
                    <X className="size-3" aria-hidden />
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}

      <div className="relative">
        <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input
          type="search"
          role="combobox"
          aria-expanded={dropdownOpen}
          aria-controls={listId}
          aria-autocomplete="list"
          placeholder={full ? t("security.exceptionsFull") : t("security.exceptionsSearch")}
          aria-label={t("security.exceptionsSearch")}
          value={query}
          disabled={disabled || full}
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          onChange={event => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          className="h-11 w-full rounded-xl border-2 pe-10 ps-9 text-sm"
        />
        {searching && (
          <Loader2 className="pointer-events-none absolute end-3 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground" aria-hidden />
        )}

        {dropdownOpen && (
          <div
            id={listId}
            role="listbox"
            aria-label={t("security.exceptionsSearch")}
            className="absolute z-50 mt-1 w-full overflow-hidden rounded-xl border border-border/80 bg-popover shadow-xl"
          >
            <div className="max-h-64 overflow-y-auto p-1.5">
              {results === null ? (
                <p className="flex items-center gap-2 p-2 text-xs text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" aria-hidden />
                  {t("security.exceptionsSearching")}
                </p>
              ) : results.length === 0 ? (
                <p className="p-2 text-xs text-muted-foreground">{t("security.exceptionsEmpty")}</p>
              ) : (
                <div className="space-y-0.5">
                  {results.map(member => {
                    const chosen = value.includes(member.id);
                    return (
                      <button
                        key={member.id}
                        type="button"
                        role="option"
                        aria-selected={chosen}
                        // Keeps focus in the field while picking, so the popup
                        // does not close before the click lands.
                        onMouseDown={event => event.preventDefault()}
                        onClick={() => add(member)}
                        disabled={chosen}
                        className={cn(
                          "flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-start transition-colors",
                          chosen ? "bg-primary/10" : "hover:bg-muted"
                        )}
                      >
                        <Avatar className="size-8 shrink-0">
                          {member.avatarUrl && <AvatarImage src={member.avatarUrl} alt="" />}
                          <AvatarFallback className="text-micro">{initials(member.name)}</AvatarFallback>
                        </Avatar>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-semibold">{member.name}</span>
                          <span className="block truncate text-xs text-muted-foreground">
                            @{member.username ?? member.id}
                          </span>
                        </span>
                        {chosen ? (
                          <Check className="size-4 shrink-0 text-primary" aria-hidden />
                        ) : (
                          <Plus className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
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
  const { t } = useI18n();
  const clamp = (next: number) =>
    Math.min(max, Math.max(min, Math.trunc(Number.isFinite(next) ? next : min)));
  const step = (delta: number) => onChange(clamp(value + delta));

  return (
    <div className="flex items-center gap-2">
      {value > min && (
        <Button type="button" size="icon" variant="outline" className="size-10 shrink-0 rounded-xl border-2" disabled={disabled} onClick={() => step(-1)} aria-label={t("security.decrease")}>
          <Minus className="size-4" />
        </Button>
      )}
      <Input
        id={id}
        type="number"
        min={min}
        max={max}
        dir="ltr"
        className="h-10 w-full rounded-xl border-2 text-base font-bold tabular text-center"
        disabled={disabled}
        value={value}
        // Typed digits are taken as they come — clamping on every keystroke
        // turns "10" into 5 then 50 — but the field refuses to *keep* a number
        // outside the range: leaving it snaps back to the nearest allowed value,
        // and the same happens on Enter. The min/max attributes stop the spinner
        // from ever offering one.
        onChange={event => onChange(event.target.value === "" ? min : Number(event.target.value))}
        onBlur={() => onChange(clamp(value))}
        onKeyDown={event => {
          if (event.key === "Enter") onChange(clamp(value));
        }}
      />
      {value < max && (
        <Button type="button" size="icon" variant="outline" className="size-10 shrink-0 rounded-xl border-2" disabled={disabled} onClick={() => step(1)} aria-label={t("security.increase")}>
          <Plus className="size-4" />
        </Button>
      )}
    </div>
  );
}
