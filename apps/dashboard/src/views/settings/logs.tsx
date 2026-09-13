import { useEffect, useState } from "react";
import { isCategoryEnabled, isEventEnabled, type LoggingMode } from "@al-ai/core/browser";
import { ChevronDown, Loader2 } from "lucide-react";
import { api } from "@/api";
import { SaveBar } from "@/components/save-bar";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import {
  logCategories,
  type ChannelOption,
  type DiscordRole,
  type Guild,
  type LogDestination,
  type LoggingSettings
} from "@/types";

const NONE = "__none__";

/**
 * The logging screen.
 *
 * Two ideas drive the layout:
 *
 * 1. `mode` decides the shape of the form. `single` sends everything to one
 *    channel, so the per-destination channel pickers are hidden rather than
 *    disabled — an operator in single mode has no use for them. `granular` shows
 *    them again. The values are never discarded, so switching back and forth
 *    loses nothing.
 * 2. A destination is a switch *and* a list of sub-switches. Turning the
 *    destination off is the coarse move; the sub-switches are for "log members,
 *    but not nickname churn". Both write into the same `eventFlags` map, which
 *    is exactly what the bot's router reads.
 */
export function LogsView({ guild }: { guild: Guild }) {
  const [saved, setSaved] = useState<LoggingSettings | null>(null);
  const [draft, setDraft] = useState<LoggingSettings | null>(null);
  const [channels, setChannels] = useState<ChannelOption[]>([]);
  const [roles, setRoles] = useState<DiscordRole[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSaved(null);
    setDraft(null);
    setError(null);
    api
      .logging(guild.id)
      .then(result => {
        if (cancelled) return;
        setSaved(result.settings);
        setDraft(result.settings);
      })
      .catch(cause => !cancelled && setError(cause instanceof Error ? cause.message : "تعذّر التحميل."));
    api
      .channels(guild.id)
      .then(result => !cancelled && setChannels(result.channels))
      .catch(cause => !cancelled && setError(cause instanceof Error ? cause.message : "تعذّر قراءة القنوات."));
    // The role list is only needed for the ignore picker, so a failure here must
    // not take the whole screen down — the log settings are still usable.
    api
      .tiers(guild.id)
      .then(result => !cancelled && setRoles(result.roles))
      .catch(() => undefined);
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
  if (!saved || !draft) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        جارٍ التحميل
      </div>
    );
  }

  const dirty = JSON.stringify(saved) !== JSON.stringify(draft);
  const textChannels = channels.filter(channel => channel.type === "text");
  const patch = (next: Partial<LoggingSettings>) => setDraft({ ...draft, ...next });

  /** Writes a single event flag, or removes it to fall back to the destination default. */
  const setEventFlag = (eventId: string, value: boolean | null) =>
    patch({ eventFlags: withFlag(draft.eventFlags, eventId, value) });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">التسجيل المركزي</CardTitle>
          <Switch checked={draft.enabled} aria-label="تفعيل السجلات" onCheckedChange={enabled => patch({ enabled })} />
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>وضع التوزيع</Label>
            <div className="flex gap-2">
              <ModeButton
                active={draft.mode === "single"}
                title="مفرد"
                hint="كل الأحداث إلى قناة واحدة"
                onClick={() => patch({ mode: "single" })}
              />
              <ModeButton
                active={draft.mode === "granular"}
                title="تفصيلي"
                hint="لكل قسم قناته الخاصة"
                onClick={() => patch({ mode: "granular" })}
              />
            </div>
            {draft.mode === "granular" && !draft.globalChannelId && (
              <p className="text-xs text-muted-foreground">
                في الوضع التفصيلي، القسم الذي بلا قناة خاصة لا يُرسَل إلى أي مكان.
              </p>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>القناة العامة</Label>
              <Select
                value={draft.globalChannelId ?? NONE}
                onValueChange={value => patch({ globalChannelId: value === NONE ? null : value })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="بدون قناة عامة" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>بدون قناة عامة</SelectItem>
                  {textChannels.map(channel => (
                    <SelectItem key={channel.id} value={channel.id}>
                      #{channel.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">تُستخدم في الوضع المفرد، وهي الوجهة الاحتياطية للوضع التفصيلي.</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="color">لون الـ Embed</Label>
              <div className="flex items-center gap-2">
                <Input
                  id="color"
                  type="color"
                  className="h-9 w-14 shrink-0 p-1"
                  value={draft.embedColor}
                  onChange={event => patch({ embedColor: event.target.value })}
                />
                <code className="text-sm text-muted-foreground" dir="ltr">
                  {draft.embedColor}
                </code>
              </div>
            </div>
          </div>

          <Separator />

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>القنوات المستثناة</Label>
              <ScrollArea className="h-36 rounded-md border border-border p-2">
                <div className="space-y-1.5">
                  {textChannels.length === 0 && <p className="text-xs text-muted-foreground">لا توجد قنوات نصية</p>}
                  {textChannels.map(channel => (
                    <label key={channel.id} className="flex items-center gap-2 rounded px-1 py-1 text-sm hover:bg-accent">
                      <Checkbox
                        checked={draft.ignoredChannelIds.includes(channel.id)}
                        onCheckedChange={checked =>
                          patch({
                            ignoredChannelIds: checked
                              ? [...draft.ignoredChannelIds, channel.id]
                              : draft.ignoredChannelIds.filter(id => id !== channel.id)
                          })
                        }
                      />
                      #{channel.name}
                    </label>
                  ))}
                </div>
              </ScrollArea>
              <p className="text-xs text-muted-foreground">لا يُسجَّل أي حدث يقع داخل هذه القنوات.</p>
            </div>

            <div className="space-y-2">
              <Label>الرتب المستثناة</Label>
              <ScrollArea className="h-36 rounded-md border border-border p-2">
                <div className="space-y-1.5">
                  {roles.length === 0 && <p className="text-xs text-muted-foreground">لا توجد رتب</p>}
                  {roles.map(role => (
                    <label key={role.id} className="flex items-center gap-2 rounded px-1 py-1 text-sm hover:bg-accent">
                      <Checkbox
                        checked={draft.ignoredRoleIds.includes(role.id)}
                        onCheckedChange={checked =>
                          patch({
                            ignoredRoleIds: checked
                              ? [...draft.ignoredRoleIds, role.id]
                              : draft.ignoredRoleIds.filter(id => id !== role.id)
                          })
                        }
                      />
                      <span
                        aria-hidden
                        className="size-2.5 shrink-0 rounded-full border border-border"
                        style={{ background: role.color ? `#${role.color.toString(16).padStart(6, "0")}` : undefined }}
                      />
                      <span className="truncate">{role.name}</span>
                    </label>
                  ))}
                </div>
              </ScrollArea>
              <p className="text-xs text-muted-foreground">
                من يحمل إحدى هذه الرتب لا يظهر في السجلات — سواء كان الفاعل أو الطرف المتأثر. مفيد لاستثناء البوتات.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">الأقسام</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1">
          {logCategories.map((category, index) => {
            // The same rule the router applies, so a switch can never disagree with reality.
            const enabled = isCategoryEnabled(draft.eventFlags, category.id);
            return (
              <div key={category.id}>
                {index > 0 && <Separator className="my-1" />}
                <DestinationRow
                  categoryId={category.id}
                  label={category.label}
                  description={category.description}
                  enabled={enabled}
                  events={category.events}
                  eventFlags={draft.eventFlags}
                  channelId={draft.categoryChannels[category.id] ?? null}
                  channels={textChannels}
                  showChannel={draft.mode === "granular"}
                  onToggleCategory={value => patch({ eventFlags: { ...draft.eventFlags, [category.id]: value } })}
                  onToggleEvent={setEventFlag}
                  onChannelChange={value =>
                    patch({ categoryChannels: withoutKey(draft.categoryChannels, category.id, value) })
                  }
                />
              </div>
            );
          })}
        </CardContent>
      </Card>

      <Alert>
        <AlertDescription className="text-xs">
          سجلات البوت الداخلية وأحداث الأمان لا تظهر هنا: تُرسَل مباشرة إلى Webhook المطوّر ولا يمكن إسكاتها من اللوحة.
        </AlertDescription>
      </Alert>

      {dirty && (
        <SaveBar
          onCancel={() => setDraft(saved)}
          onSave={async () => {
            const result = await api.saveLogging(guild.id, draft);
            setSaved(result.settings);
            setDraft(result.settings);
          }}
        />
      )}
    </div>
  );
}

function ModeButton({
  active,
  title,
  hint,
  onClick
}: {
  active: boolean;
  title: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex-1 rounded-md border px-3 py-2 text-start transition-colors ${
        active ? "border-primary bg-accent" : "border-border hover:bg-accent/50"
      }`}
    >
      <span className="block text-sm font-medium">{title}</span>
      <span className="block text-xs text-muted-foreground">{hint}</span>
    </button>
  );
}

function DestinationRow({
  categoryId,
  label,
  description,
  enabled,
  events,
  eventFlags,
  channelId,
  channels,
  showChannel,
  onToggleCategory,
  onToggleEvent,
  onChannelChange
}: {
  categoryId: LogDestination;
  label: string;
  description: string;
  enabled: boolean;
  events: { id: string; label: string }[];
  eventFlags: Record<string, boolean>;
  channelId: string | null;
  channels: ChannelOption[];
  showChannel: boolean;
  onToggleCategory: (value: boolean) => void;
  onToggleEvent: (eventId: string, value: boolean | null) => void;
  onChannelChange: (value: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const muted = events.filter(event => !isEventEnabled(eventFlags, categoryId, event.id)).length;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="flex flex-wrap items-center gap-3 py-2">
        <Switch checked={enabled} aria-label={label} onCheckedChange={onToggleCategory} />
        <div className="min-w-40 flex-1">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium">{label}</p>
            {muted > 0 && <Badge variant="secondary">{`${muted} مكتوم`}</Badge>}
          </div>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>

        {showChannel && (
          <Select value={channelId ?? NONE} onValueChange={value => onChannelChange(value === NONE ? null : value)}>
            <SelectTrigger className="w-44">
              <SelectValue placeholder="بدون وجهة" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>بدون وجهة</SelectItem>
              {channels.map(channel => (
                <SelectItem key={channel.id} value={channel.id}>
                  #{channel.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm" className="gap-1" aria-label={`أحداث ${label}`}>
            <span className="text-xs">الأحداث</span>
            <ChevronDown className={`size-4 transition-transform ${open ? "rotate-180" : ""}`} />
          </Button>
        </CollapsibleTrigger>
      </div>

      <CollapsibleContent>
        <div className="ms-4 mb-2 grid gap-1.5 rounded-md border border-border p-2 sm:grid-cols-2">
          {events.map(event => (
            <label key={event.id} className="flex items-center gap-2 rounded px-1 py-1 text-sm hover:bg-accent">
              <Checkbox
                checked={isEventEnabled(eventFlags, categoryId, event.id)}
                onCheckedChange={checked => onToggleEvent(event.id, checked === "indeterminate" ? null : checked)}
              />
              {event.label}
            </label>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Sets or removes a single event flag without leaving `undefined` behind. */
function withFlag(source: Record<string, boolean>, key: string, value: boolean | null): Record<string, boolean> {
  const next = { ...source };
  if (value === null) {
    delete next[key];
  } else {
    next[key] = value;
  }
  return next;
}

/** Sets or removes a single channel destination without leaving `undefined` behind. */
function withoutKey(source: Record<string, string>, key: string, value: string | null): Record<string, string> {
  const next = { ...source };
  if (value === null) {
    delete next[key];
  } else {
    next[key] = value;
  }
  return next;
}
