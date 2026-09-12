import { useEffect, useState } from "react";
import { isCategoryEnabled } from "@al-ai/core/browser";
import { Loader2 } from "lucide-react";
import { api } from "@/api";
import { SaveBar } from "@/components/save-bar";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { logCategories, type ChannelOption, type Guild, type LoggingSettings } from "@/types";

const NONE = "__none__";

export function LogsView({ guild }: { guild: Guild }) {
  const [saved, setSaved] = useState<LoggingSettings | null>(null);
  const [draft, setDraft] = useState<LoggingSettings | null>(null);
  const [channels, setChannels] = useState<ChannelOption[]>([]);
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

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">التسجيل المركزي</CardTitle>
          <Switch checked={draft.enabled} aria-label="تفعيل السجلات" onCheckedChange={enabled => patch({ enabled })} />
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>قناة السجل العامة</Label>
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

          <div className="space-y-2">
            <Label>القنوات المستثناة</Label>
            <ScrollArea className="h-32 rounded-md border border-border p-2">
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
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">الوجهات السبع</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1">
          {logCategories.map((category, index) => {
            // Same rule the router applies, so the switch can never disagree with reality.
            const enabled = isCategoryEnabled(draft.eventFlags, category.id);
            return (
              <div key={category.id}>
                {index > 0 && <Separator className="my-1" />}
                <div className="flex flex-wrap items-center gap-3 py-2">
                  <Switch
                    checked={enabled}
                    aria-label={category.label}
                    onCheckedChange={value => patch({ eventFlags: { ...draft.eventFlags, [category.id]: value } })}
                  />
                  <div className="min-w-40 flex-1">
                    <p className="text-sm font-medium">{category.label}</p>
                    <p className="text-xs text-muted-foreground">{category.description}</p>
                  </div>
                  <Select
                    value={draft.categoryChannels[category.id] ?? NONE}
                    onValueChange={value =>
                      patch({
                        categoryChannels: withoutKey(draft.categoryChannels, category.id, value === NONE ? null : value)
                      })
                    }
                  >
                    <SelectTrigger className="w-44">
                      <SelectValue placeholder="بدون وجهة" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>بدون وجهة</SelectItem>
                      {textChannels.map(channel => (
                        <SelectItem key={channel.id} value={channel.id}>
                          #{channel.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

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
