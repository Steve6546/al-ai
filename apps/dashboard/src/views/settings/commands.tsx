import { useEffect, useMemo, useState } from "react";
import { ChevronDown, Loader2, SquareTerminal } from "lucide-react";
import { MAX_PURGE_DAYS } from "@al-ai/core/browser";
import { api, type CommandChange } from "@/api";
import { EmptyState } from "@/components/empty-state";
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
import { tierLabels, tierOrder, type CommandFlag, type DiscordRole, type Guild, type Tier } from "@/types";

/**
 * Settings: slash-command availability and per-command behaviour.
 *
 * Three rules shape this screen:
 *
 * 1. Edits live in a draft and are written only by the save bar, so toggling a
 *    command never fires a request on its own and cancelling restores the
 *    previous state instantly.
 * 2. Only the commands that actually changed are sent. The server normalises
 *    each one against its registry definition, so a control the command does
 *    not support cannot be smuggled in.
 * 3. A control is only rendered when the command supports it. A "delete
 *    messages" field on `/warn` would be a switch that does nothing, which is
 *    worse than no switch at all.
 */
export function CommandsView({ guild }: { guild: Guild }) {
  const [saved, setSaved] = useState<CommandFlag[] | null>(null);
  const [draft, setDraft] = useState<CommandFlag[] | null>(null);
  const [modules, setModules] = useState<string[]>([]);
  const [roles, setRoles] = useState<DiscordRole[]>([]);
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
    // Only needed for the extra-roles picker, so a failure here must not take
    // the whole screen down — the command switches still work.
    api
      .tiers(guild.id)
      .then(result => !cancelled && setRoles(result.roles))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [guild.id]);

  /** Only the commands that differ from what is stored, compared in full. */
  const changes = useMemo<CommandChange[]>(() => {
    if (!saved || !draft) return [];
    const before = new Map(saved.map(command => [command.name, command]));
    return draft
      .filter(command => {
        const original = before.get(command.name);
        return !original || JSON.stringify(original) !== JSON.stringify(command);
      })
      .map(command => ({
        name: command.name,
        enabled: command.enabled,
        allowedLevel: command.allowedLevel,
        dmOnAction: command.dmOnAction,
        deleteMessageDays: command.deleteMessageDays,
        customRoleIds: command.customRoleIds
      }));
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
                    <CommandRow
                      command={command}
                      roles={roles}
                      onPatch={next => patch(command.name, next)}
                    />
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

function CommandRow({
  command,
  roles,
  onPatch
}: {
  command: CommandFlag;
  roles: DiscordRole[];
  onPatch: (next: Partial<CommandFlag>) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="flex flex-wrap items-center gap-3 py-2">
        <Switch
          checked={command.enabled}
          aria-label={command.name}
          onCheckedChange={enabled => onPatch({ enabled })}
        />
        <div className="min-w-40 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate font-mono text-sm" dir="ltr">
              /{command.name}
            </p>
            {command.allowedLevel !== command.minimumTier && (
              <Badge variant="outline" className="text-[10px]">
                مخصّص
              </Badge>
            )}
          </div>
          <p className="truncate text-xs text-muted-foreground">{command.description}</p>
        </div>
        <Select value={command.allowedLevel} onValueChange={value => onPatch({ allowedLevel: value as Tier })}>
          <SelectTrigger className="w-36" aria-label={`أدنى رتبة لأمر ${command.name}`}>
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
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm" className="gap-1" aria-label={`إعدادات ${command.name}`}>
            <span className="text-xs">إعدادات</span>
            <ChevronDown className={`size-4 transition-transform ${open ? "rotate-180" : ""}`} />
          </Button>
        </CollapsibleTrigger>
      </div>

      <CollapsibleContent>
        <div className="ms-4 mb-3 space-y-3 rounded-md border border-border p-3">
          {command.supportsPurge && (
            <div className="space-y-1.5">
              <Label htmlFor={`purge-${command.name}`}>حذف رسائل العضو عند التنفيذ</Label>
              <div className="flex items-center gap-2">
                <Input
                  id={`purge-${command.name}`}
                  type="number"
                  min={0}
                  max={MAX_PURGE_DAYS}
                  className="w-24"
                  value={command.deleteMessageDays}
                  onChange={event => onPatch({ deleteMessageDays: clampDays(Number(event.target.value)) })}
                />
                <span className="text-xs text-muted-foreground">{`أيام (0 = بلا حذف، والحد ${MAX_PURGE_DAYS})`}</span>
              </div>
            </div>
          )}

          {command.supportsNotify && (
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={command.dmOnAction}
                onCheckedChange={checked => onPatch({ dmOnAction: checked === true })}
              />
              إرسال رسالة خاصة للعضو عند تنفيذ الإجراء
            </label>
          )}

          <div className="space-y-1.5">
            <Label>رتب إضافية مسموح لها بهذا الأمر</Label>
            <ScrollArea className="h-28 rounded-md border border-border p-2">
              <div className="space-y-1.5">
                {roles.length === 0 && <p className="text-xs text-muted-foreground">لا توجد رتب</p>}
                {roles.map(role => (
                  <label key={role.id} className="flex items-center gap-2 rounded px-1 py-1 text-sm hover:bg-accent">
                    <Checkbox
                      checked={command.customRoleIds.includes(role.id)}
                      onCheckedChange={checked =>
                        onPatch({
                          customRoleIds: checked
                            ? [...command.customRoleIds, role.id]
                            : command.customRoleIds.filter(id => id !== role.id)
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
              من يحمل إحدى هذه الرتب يستطيع تنفيذ هذا الأمر تحديداً، دون ترقيته إلى رتبة أعلى في كل الأوامر.
            </p>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Keeps the purge value inside the range Discord accepts. */
function clampDays(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(Math.trunc(value), 0), MAX_PURGE_DAYS);
}
