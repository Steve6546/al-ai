import { useEffect, useMemo, useState } from "react";
import { Loader2, SquareTerminal } from "lucide-react";
import { api, type CommandChange } from "@/api";
import { EmptyState } from "@/components/empty-state";
import { SaveBar } from "@/components/save-bar";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { tierLabels, tierOrder, type CommandFlag, type Guild, type Tier } from "@/types";

/**
 * Settings: slash-command availability.
 *
 * Edits are held in a draft and only written by the save bar, so toggling a
 * command never fires a request on its own and cancelling restores the previous
 * state instantly. Only commands that actually changed are sent.
 */
export function CommandsView({ guild }: { guild: Guild }) {
  const [saved, setSaved] = useState<CommandFlag[] | null>(null);
  const [draft, setDraft] = useState<CommandFlag[] | null>(null);
  const [modules, setModules] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSaved(null);
    setDraft(null);
    setError(null);
    api
      .commands(guild.id)
      .then(result => {
        if (cancelled) return;
        setSaved(result.commands);
        setDraft(result.commands);
        setModules(result.modules);
      })
      .catch(cause => !cancelled && setError(cause instanceof Error ? cause.message : "تعذّر التحميل."));
    return () => {
      cancelled = true;
    };
  }, [guild.id]);

  /** Only the commands that differ from what is stored. */
  const changes = useMemo<CommandChange[]>(() => {
    if (!saved || !draft) return [];
    const before = new Map(saved.map(command => [command.name, command]));
    return draft
      .filter(command => {
        const original = before.get(command.name);
        return !original || original.enabled !== command.enabled || original.minimumTier !== command.minimumTier;
      })
      .map(command => ({ command: command.name, enabled: command.enabled, minimumTier: command.minimumTier }));
  }, [saved, draft]);

  const grouped = useMemo(() => {
    const map = new Map<string, CommandFlag[]>();
    for (const command of draft ?? []) map.set(command.module, [...(map.get(command.module) ?? []), command]);
    return map;
  }, [draft]);

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

  const patch = (name: string, next: Partial<CommandFlag>) =>
    setDraft(current => (current ?? []).map(command => (command.name === name ? { ...command, ...next } : command)));

  if (draft.length === 0) {
    return (
      <EmptyState
        icon={SquareTerminal}
        title="لا توجد أوامر مسجّلة"
        description="تُبنى هذه القائمة من سجل الأوامر المشترك. أضف الأمر إلى السجل ثم أعد تشغيل البوت ليظهر هنا."
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 lg:grid-cols-2">
        {modules.map(module => {
          const items = grouped.get(module) ?? [];
          if (items.length === 0) return null;
          return (
            <Card key={module}>
              <CardHeader className="flex-row items-center justify-between space-y-0">
                <CardTitle className="text-base">{module}</CardTitle>
                <Badge variant="secondary" className="tabular">
                  {items.length}
                </Badge>
              </CardHeader>
              <CardContent className="space-y-1">
                {items.map((command, index) => (
                  <div key={command.name}>
                    {index > 0 && <Separator className="my-1" />}
                    <div className="flex flex-wrap items-center gap-3 py-2">
                      <Switch
                        checked={command.enabled}
                        aria-label={command.name}
                        onCheckedChange={enabled => patch(command.name, { enabled })}
                      />
                      <div className="min-w-40 flex-1">
                        <p className="truncate font-mono text-sm" dir="ltr">
                          /{command.name}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">{command.description}</p>
                      </div>
                      <Select
                        value={command.minimumTier}
                        onValueChange={value => patch(command.name, { minimumTier: value as Tier })}
                      >
                        <SelectTrigger className="w-40" aria-label={`أدنى رتبة لأمر ${command.name}`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {tierOrder.map(tier => (
                            <SelectItem key={tier} value={tier}>
                              {tierLabels[tier]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          );
        })}
      </div>

      <p className="text-xs text-muted-foreground">
        إيقاف أمر يمنع تنفيذه فوراً، وأدنى رتبة تُفحص على الخادم عند كل تنفيذ لا في الواجهة فقط.
      </p>

      {changes.length > 0 && (
        <SaveBar
          message={`${changes.length} تغيير غير محفوظ`}
          onCancel={() => setDraft(saved)}
          onSave={async () => {
            await api.saveCommands(guild.id, changes);
            const result = await api.commands(guild.id);
            setSaved(result.commands);
            setDraft(result.commands);
          }}
        />
      )}
    </div>
  );
}
