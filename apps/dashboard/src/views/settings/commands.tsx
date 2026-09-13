import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronDown, Loader2, Plus, Search, SquareTerminal, Trash2 } from "lucide-react";
import { commandDurations, MAX_AUTO_DELETE_SECONDS, MAX_COOLDOWN_SECONDS, MAX_PRESET_REASONS, MAX_PURGE_DAYS } from "@al-ai/core/browser";
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
import {
  tierLabels,
  tierOrder,
  type ChannelOption,
  type CommandCategory,
  type CommandDuration,
  type CommandFlag,
  type DiscordRole,
  type Guild,
  type PresetReason,
  type Tier
} from "@/types";

/**
 * Settings: slash-command availability and per-command behaviour.
 *
 * Four rules shape this screen:
 *
 * 1. Edits live in a draft and are written only by the save bar, so toggling a
 *    command never fires a request on its own and cancelling restores the
 *    previous state instantly. "Enable all" is the same kind of edit as one
 *    switch, which is why it needs no endpoint of its own.
 * 2. Only the commands that actually changed are sent. The server normalises
 *    each one against its registry definition, so a control the command does
 *    not support cannot be smuggled in.
 * 3. A control is only rendered when the command supports it. A "delete
 *    messages" field on `/warn` would be a switch that does nothing, which is
 *    worse than no switch at all — and the same rule decides whether the
 *    duration dropdown, the reason requirement and the purge field appear.
 * 4. The role and channel lists arrive with the commands, from the same
 *    memoised read the other screens use. Opening this screen used to cost two
 *    extra Discord calls for a list that had just been fetched elsewhere.
 */
export function CommandsView({ guild }: { guild: Guild }) {
  const [data, setData] = useState<{
    commands: CommandFlag[];
    categories: { id: CommandCategory; label: string; description: string }[];
    roles: DiscordRole[];
    channels: ChannelOption[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    api
      .commands(guild.id)
      .then(result => {
        if (cancelled) return;
        setData(result);
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
  if (!data) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        جارٍ التحميل
      </div>
    );
  }

  if (data.commands.length === 0) {
    return (
      <EmptyState
        icon={SquareTerminal}
        title="لا توجد أوامر مسجّلة"
        description="تُبنى هذه القائمة من سجل الأوامر المشترك. أضف الأمر إلى السجل ثم أعد تشغيل البوت ليظهر هنا."
      />
    );
  }

  return (
    <CommandsBoard
      // Remounting on a guild change resets the draft and the search box, so a
      // switch can never leave one guild's pending edits against another's rows.
      key={guild.id}
      commands={data.commands}
      categories={data.categories}
      roles={data.roles}
      channels={data.channels}
      onSave={changes => api.saveCommands(guild.id, changes)}
      onSaved={async () => (await api.commands(guild.id)).commands}
    />
  );
}

/**
 * The screen itself, with the loading already done.
 *
 * Kept separate from the container so it can be rendered — and asserted on — with
 * a fixed set of commands, without a network round trip. Effects never run under
 * `renderToString`, so anything reachable only through the fetch would otherwise
 * have no coverage at all.
 */
export function CommandsBoard({
  commands,
  categories,
  roles,
  channels,
  onSave,
  onSaved
}: {
  commands: CommandFlag[];
  categories: { id: CommandCategory; label: string; description: string }[];
  roles: DiscordRole[];
  channels: ChannelOption[];
  onSave: (changes: CommandChange[]) => Promise<unknown>;
  /** Re-reads the stored configuration after a save, so the draft is rebased. */
  onSaved: () => Promise<CommandFlag[]>;
}) {
  const [saved, setSaved] = useState<CommandFlag[]>(commands);
  const [draft, setDraft] = useState<CommandFlag[]>(commands);
  const [query, setQuery] = useState("");

  /** Only the commands that differ from what is stored, compared in full. */
  const changes = useMemo<CommandChange[]>(() => {
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
        allowedRoleIds: command.allowedRoleIds,
        deniedRoleIds: command.deniedRoleIds,
        allowedChannelIds: command.allowedChannelIds,
        deniedChannelIds: command.deniedChannelIds,
        cooldownSeconds: command.cooldownSeconds,
        autoDeleteResponseSeconds: command.autoDeleteResponseSeconds,
        requireReason: command.requireReason,
        defaultDuration: command.defaultDuration,
        presetReasons: command.presetReasons
      }));
  }, [saved, draft]);

  /** The search filter, applied to the name and the Arabic description alike. */
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return draft;
    return draft.filter(
      command =>
        command.name.toLowerCase().includes(needle) ||
        command.description.toLowerCase().includes(needle) ||
        `/${command.name}`.includes(needle)
    );
  }, [draft, query]);

  const grouped = useMemo(() => {
    const map = new Map<CommandCategory, CommandFlag[]>();
    for (const command of visible) map.set(command.category, [...(map.get(command.category) ?? []), command]);
    return map;
  }, [visible]);

  const stats = useMemo(
    () => ({
      total: draft.length,
      enabled: draft.filter(command => command.enabled).length,
      categories: new Set(draft.map(command => command.category)).size
    }),
    [draft]
  );

  const patch = (name: string, next: Partial<CommandFlag>) =>
    setDraft(current => current.map(command => (command.name === name ? { ...command, ...next } : command)));

  /** Applies one field to every command at once. Still a draft edit. */
  const patchAll = (next: Partial<CommandFlag>) => setDraft(current => current.map(command => ({ ...command, ...next })));

  return (
    <div className="space-y-4">
      {/* ---------------------------------------------------------------- *
       * Totals
       * ---------------------------------------------------------------- */}
      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard label="إجمالي الأوامر" value={stats.total} />
        <StatCard label="الأوامر المفعلة" value={stats.enabled} tone="positive" />
        <StatCard label="الأقسام" value={stats.categories} />
      </div>

      {/* ---------------------------------------------------------------- *
       * Search and bulk actions
       * ---------------------------------------------------------------- */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute inset-y-0 start-2.5 my-auto size-4 text-muted-foreground" />
          <Input
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder="ابحث عن أمر... 🔍"
            aria-label="ابحث عن أمر"
            className="ps-8"
          />
        </div>
        <Button variant="outline" size="sm" onClick={() => patchAll({ enabled: true })}>
          تفعيل الكل
        </Button>
        <Button variant="outline" size="sm" onClick={() => patchAll({ enabled: false })}>
          تعطيل الكل
        </Button>
      </div>

      {/* ---------------------------------------------------------------- *
       * Commands, by section
       * ---------------------------------------------------------------- */}
      {visible.length === 0 && (
        <p className="rounded-md border border-border px-3 py-6 text-center text-sm text-muted-foreground">
          لا يوجد أمر يطابق «{query}».
        </p>
      )}

      {categories.map(category => {
        const items = grouped.get(category.id) ?? [];
        if (items.length === 0) return null;
        return (
          <Card key={category.id}>
            <CardHeader className="flex-row items-start justify-between space-y-0">
              <div className="space-y-0.5">
                <CardTitle className="text-base">{category.label}</CardTitle>
                <p className="text-xs text-muted-foreground">{category.description}</p>
              </div>
              <Badge variant="secondary" className="tabular">
                {items.length}
              </Badge>
            </CardHeader>
            <CardContent className="space-y-1">
              {items.map((command, index) => (
                <div key={command.name}>
                  {index > 0 && <Separator className="my-1" />}
                  <CommandRow command={command} roles={roles} channels={channels} onPatch={next => patch(command.name, next)} />
                </div>
              ))}
            </CardContent>
          </Card>
        );
      })}

      <p className="text-xs text-muted-foreground">
        إيقاف أمر يمنع تنفيذه فوراً، وكل القيود هنا تُفحص على الخادم عند كل تنفيذ لا في الواجهة فقط.
      </p>

      {changes.length > 0 && (
        <SaveBar
          message={`${changes.length} تغيير غير محفوظ`}
          onCancel={() => setDraft(saved)}
          onSave={async () => {
            await onSave(changes);
            // Rebased on what the server stored, not on the local draft: the
            // server normalises every change, so the two can legitimately differ.
            const fresh = await onSaved();
            setSaved(fresh);
            setDraft(fresh);
          }}
        />
      )}
    </div>
  );
}

function StatCard({ label, value, tone }: { label: string; value: number; tone?: "positive" }) {
  return (
    <Card>
      <CardContent className="py-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className={`text-2xl font-semibold tabular ${tone === "positive" ? "text-primary" : ""}`}>{value}</p>
      </CardContent>
    </Card>
  );
}

function CommandRow({
  command,
  roles,
  channels,
  onPatch
}: {
  command: CommandFlag;
  roles: DiscordRole[];
  channels: ChannelOption[];
  onPatch: (next: Partial<CommandFlag>) => void;
}) {
  const [open, setOpen] = useState(false);
  const customised =
    command.allowedLevel !== command.minimumTier ||
    command.allowedRoleIds.length > 0 ||
    command.deniedRoleIds.length > 0 ||
    command.allowedChannelIds.length > 0 ||
    command.deniedChannelIds.length > 0 ||
    command.cooldownSeconds > 0;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="flex flex-wrap items-center gap-3 py-2">
        <Switch checked={command.enabled} aria-label={command.name} onCheckedChange={enabled => onPatch({ enabled })} />
        <div className="min-w-40 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate font-mono text-sm" dir="ltr">
              /{command.name}
            </p>
            {customised && (
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
        <div className="ms-4 mb-3 space-y-4 rounded-md border border-border p-3">
          {/* ------------------------------------------------------------ *
           * Purge and DM — the two controls that predate the scopes
           * ------------------------------------------------------------ */}
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
              <Checkbox checked={command.dmOnAction} onCheckedChange={checked => onPatch({ dmOnAction: checked === true })} />
              إرسال رسالة خاصة للعضو عند تنفيذ الإجراء
            </label>
          )}

          <Separator />

          {/* ------------------------------------------------------------ *
           * Role scopes
           * ------------------------------------------------------------ */}
          <SectionTitle>الرتب</SectionTitle>
          <div className="grid gap-3 lg:grid-cols-2">
            <ScopeList
              label="الرتب المسموحة"
              hint="من يحمل إحدى هذه الرتب يستطيع تنفيذ الأمر دون ترقيته في كل الأوامر."
              items={roles.map(role => ({ id: role.id, name: role.name, color: role.color }))}
              selected={command.allowedRoleIds}
              emptyLabel="لا توجد رتب"
              onChange={ids => onPatch({ allowedRoleIds: ids })}
            />
            <ScopeList
              label="الرتب الممنوعة"
              hint="الحظر يتقدّم على السماح: من يحمل رتبة ممنوعة لا يستطيع التنفيذ مهما كانت رتبته."
              items={roles.map(role => ({ id: role.id, name: role.name, color: role.color }))}
              selected={command.deniedRoleIds}
              emptyLabel="لا توجد رتب"
              onChange={ids => onPatch({ deniedRoleIds: ids })}
            />
          </div>

          {/* ------------------------------------------------------------ *
           * Channel scopes
           * ------------------------------------------------------------ */}
          <SectionTitle>القنوات</SectionTitle>
          <div className="grid gap-3 lg:grid-cols-2">
            <ScopeList
              label="القنوات المسموحة"
              hint="اتركها فارغة للسماح في كل القنوات. عند تحديد أي قناة يعمل الأمر فيها فقط."
              items={channels.map(channel => ({ id: channel.id, name: channel.name, type: channel.type }))}
              selected={command.allowedChannelIds}
              emptyLabel="لا توجد قنوات"
              onChange={ids => onPatch({ allowedChannelIds: ids })}
            />
            <ScopeList
              label="القنوات الممنوعة"
              hint="تُستثنى دائماً، حتى لو كانت ضمن القنوات المسموحة."
              items={channels.map(channel => ({ id: channel.id, name: channel.name, type: channel.type }))}
              selected={command.deniedChannelIds}
              emptyLabel="لا توجد قنوات"
              onChange={ids => onPatch({ deniedChannelIds: ids })}
            />
          </div>

          <Separator />

          {/* ------------------------------------------------------------ *
           * Execution behaviour
           * ------------------------------------------------------------ */}
          <SectionTitle>سلوك التنفيذ</SectionTitle>
          <div className="grid gap-3 lg:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={`cooldown-${command.name}`}>فترة الانتظار (ثوانٍ)</Label>
              <div className="flex items-center gap-2">
                <Input
                  id={`cooldown-${command.name}`}
                  type="number"
                  min={0}
                  max={MAX_COOLDOWN_SECONDS}
                  className="w-24"
                  value={command.cooldownSeconds}
                  onChange={event => onPatch({ cooldownSeconds: clampInteger(Number(event.target.value), 0, MAX_COOLDOWN_SECONDS) })}
                />
                <span className="text-xs text-muted-foreground">بين كل استخدامين لنفس العضو (0 = بلا انتظار)</span>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor={`autodelete-${command.name}`}>حذف رد البوت تلقائياً (ثوانٍ)</Label>
              <div className="flex items-center gap-2">
                <Input
                  id={`autodelete-${command.name}`}
                  type="number"
                  min={0}
                  max={MAX_AUTO_DELETE_SECONDS}
                  className="w-24"
                  value={command.autoDeleteResponseSeconds}
                  onChange={event =>
                    onPatch({ autoDeleteResponseSeconds: clampInteger(Number(event.target.value), 0, MAX_AUTO_DELETE_SECONDS) })
                  }
                />
                <span className="text-xs text-muted-foreground">0 = إبقاء الرد</span>
              </div>
            </div>
          </div>

          {/* ------------------------------------------------------------ *
           * Penalty settings — only where they mean something
           * ------------------------------------------------------------ */}
          {command.supportsReason && (
            <>
              <Separator />
              <SectionTitle>إعدادات العقوبات</SectionTitle>
              <div className="space-y-3">
                <label className="flex items-center gap-2 text-sm">
                  <Switch checked={command.requireReason} onCheckedChange={checked => onPatch({ requireReason: checked })} />
                  السبب مطلوب
                </label>
                <p className="text-xs text-muted-foreground">
                  يُرفض تنفيذ الأمر بدون سبب مسجّل. الفحص يتم على الخادم، فلا يمكن تجاوزه من الواجهة.
                </p>

                {command.supportsDuration && (
                  <div className="space-y-1.5">
                    <Label htmlFor={`duration-${command.name}`}>المدة الافتراضية</Label>
                    <Select
                      value={command.defaultDuration}
                      onValueChange={value => onPatch({ defaultDuration: value as CommandDuration })}
                    >
                      <SelectTrigger id={`duration-${command.name}`} className="w-48">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {commandDurations.map(option => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      تُطبَّق عندما لا يحدّد المشرف مدة. «دائم» ليس مدة صالحة للإسكات، وسيُطلب تحديد المدة صراحةً.
                    </p>
                  </div>
                )}

                <PresetReasons
                  command={command}
                  onChange={presets => onPatch({ presetReasons: presets })}
                />
              </div>
            </>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{children}</p>;
}

/**
 * A multi-select list of roles or channels.
 *
 * A checkbox list rather than a dropdown: the operator is usually picking
 * several entries, and a dropdown that closes after every choice turns that into
 * a chore. A filter appears once the list is long enough to need one, which is
 * every real server's channel list.
 */
export function ScopeList({
  label,
  hint,
  items,
  selected,
  emptyLabel,
  onChange
}: {
  label: string;
  hint: string;
  items: { id: string; name: string; color?: number; type?: string }[];
  selected: string[];
  emptyLabel: string;
  onChange: (ids: string[]) => void;
}) {
  const [filter, setFilter] = useState("");
  const needle = filter.trim().toLowerCase();
  const visible = needle ? items.filter(item => item.name.toLowerCase().includes(needle)) : items;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label>{label}</Label>
        {selected.length > 0 && (
          <Badge variant="secondary" className="tabular text-[10px]">
            {selected.length}
          </Badge>
        )}
      </div>

      {items.length > 8 && (
        <Input
          value={filter}
          onChange={event => setFilter(event.target.value)}
          placeholder="تصفية..."
          aria-label={`تصفية ${label}`}
          className="h-8"
        />
      )}

      <ScrollArea className="h-32 rounded-md border border-border p-2">
        <div className="space-y-1.5">
          {visible.length === 0 && <p className="text-xs text-muted-foreground">{items.length === 0 ? emptyLabel : "لا نتائج"}</p>}
          {visible.map(item => (
            <label key={item.id} className="flex items-center gap-2 rounded px-1 py-1 text-sm hover:bg-accent">
              <Checkbox
                checked={selected.includes(item.id)}
                onCheckedChange={checked => onChange(checked ? [...selected, item.id] : selected.filter(id => id !== item.id))}
              />
              {item.color !== undefined && (
                <span
                  aria-hidden
                  className="size-2.5 shrink-0 rounded-full border border-border"
                  style={{ background: item.color ? `#${item.color.toString(16).padStart(6, "0")}` : undefined }}
                />
              )}
              {item.type && <span className="text-[10px] text-muted-foreground">#{item.type}</span>}
              <span className="truncate">{item.name}</span>
            </label>
          ))}
        </div>
      </ScrollArea>
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

/**
 * The ready-made reasons, as they will appear in Discord.
 *
 * Each one carries its own duration, which is why the duration field only shows
 * for a command that can apply one — on `/ban` a paired length would be stored
 * and then ignored, and the bot would have to pretend otherwise.
 */
export function PresetReasons({ command, onChange }: { command: CommandFlag; onChange: (presets: PresetReason[]) => void }) {
  const update = (id: string, next: Partial<PresetReason>) =>
    onChange(command.presetReasons.map(preset => (preset.id === id ? { ...preset, ...next } : preset)));

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label>أسباب جاهزة تظهر في ديسكورد</Label>
        <Button
          variant="outline"
          size="sm"
          className="gap-1"
          disabled={command.presetReasons.length >= MAX_PRESET_REASONS}
          onClick={() => onChange([...command.presetReasons, { id: newPresetId(), label: "", duration: command.supportsDuration ? "permanent" : null }])}
        >
          <Plus className="size-3.5" />
          إضافة سبب
        </Button>
      </div>

      {command.presetReasons.length === 0 && (
        <p className="text-xs text-muted-foreground">لا توجد أسباب جاهزة. يكتب المشرف السبب يدوياً.</p>
      )}

      <div className="space-y-2">
        {command.presetReasons.map(preset => (
          <div key={preset.id} className="flex items-center gap-2">
            <Input
              value={preset.label}
              onChange={event => update(preset.id, { label: event.target.value })}
              placeholder="نص السبب، مثل: سبام"
              aria-label="نص السبب"
            />
            {command.supportsDuration && (
              <Select
                value={preset.duration ?? "permanent"}
                onValueChange={value => update(preset.id, { duration: value as CommandDuration })}
              >
                <SelectTrigger className="w-36" aria-label="المدة المقترنة بالسبب">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {commandDurations.map(option => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Button
              variant="ghost"
              size="icon"
              aria-label="حذف السبب"
              onClick={() => onChange(command.presetReasons.filter(entry => entry.id !== preset.id))}
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        ))}
      </div>

      {command.presetReasons.length > 0 && (
        <p className="text-xs text-muted-foreground">
          تظهر هذه الأسباب كاقتراحات في حقل السبب داخل ديسكورد
          {command.supportsDuration ? "، وعند اختيار سبب بمدة مقترنة تُطبَّق ما لم يحدّد المشرف مدة." : "."}
        </p>
      )}
    </div>
  );
}

/** A stable key for a preset the operator has not saved yet. */
function newPresetId() {
  return `preset-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Keeps the purge value inside the range Discord accepts. */
function clampDays(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(Math.trunc(value), 0), MAX_PURGE_DAYS);
}

function clampInteger(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.trunc(value), min), max);
}
