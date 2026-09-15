import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  BarChart3,
  Bot,
  ChevronDown,
  Gavel,
  Hash,
  Loader2,
  MessageSquare,
  Palette,
  Plus,
  ScrollText,
  Search,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  SquareTerminal,
  Trash2,
  TrendingUp,
  UserCircle,
  Users,
  Volume2,
  X,
  type LucideIcon
} from "lucide-react";
import {
  clampInteger,
  commandDurations,
  MAX_AUTO_DELETE_SECONDS,
  MAX_COOLDOWN_SECONDS,
  MAX_PRESET_REASONS,
  MAX_PURGE_DAYS
} from "@al-ai/core/browser";
import { api, type CommandChange, type ScopedMember } from "@/api";
import { EmptyState } from "@/components/empty-state";
import { SaveBar } from "@/components/save-bar";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { type ChannelOption, type CommandCategory, type CommandDuration, type CommandFlag, type DiscordRole, type Guild, type PresetReason } from "@/types";

/**
 * Settings: slash-command availability, scopes and per-command behaviour.
 *
 * Five rules shape this screen:
 *
 * 1. Edits live in a draft and are written only by the save bar, so toggling a
 *    command never fires a request on its own and cancelling restores the
 *    previous state instantly. "Enable all" is the same kind of edit as one
 *    switch, which is why it needs no endpoint of its own.
 * 2. Only the commands that actually changed are sent, compared field by field
 *    rather than by stringifying — the two objects come from different places,
 *    and `JSON.stringify` would call a re-ordered key a change.
 * 3. A control is only rendered when the command supports it. A "delete
 *    messages" field on `/warn` would be a switch that does nothing, which is
 *    worse than no switch at all.
 * 4. There is no tier selector. It asked the operator to translate "moderator"
 *    into a set of people; the badge names the Discord permission the command
 *    actually asks for, and the scopes below it are what make the answer precise.
 * 5. Every one of the fourteen sections is offered, including the ones with no
 *    commands yet. An empty section says so plainly rather than being hidden:
 *    a section nobody can see looks like a feature that was never planned, and
 *    padding it with placeholder commands would put switches in the database
 *    that nothing reads.
 */
export function CommandsView({ guild }: { guild: Guild }) {
  const [data, setData] = useState<{
    commands: CommandFlag[];
    categories: { id: CommandCategory; label: string; description: string }[];
    roles: DiscordRole[];
    channels: ChannelOption[];
    permissionLabels: Record<string, string>;
  } | null>(null);
  const [members, setMembers] = useState<ScopedMember[]>([]);
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
        // Names for the members the stored scopes already name. Fetched after the
        // commands and never awaited by them: the scopes live in our own
        // database, so the screen must render even when Discord does not answer.
        const ids = [
          ...new Set(result.commands.flatMap(command => [...command.allowedUserIds, ...command.deniedUserIds]))
        ];
        return api
          .resolveMembers(guild.id, ids)
          .then(resolved => !cancelled && setMembers(resolved.members))
          .catch(() => undefined);
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
      // Remounting on a guild change resets the draft, the search box and the
      // active section, so a switch can never leave one guild's pending edits
      // against another's rows.
      key={guild.id}
      commands={data.commands}
      categories={data.categories}
      roles={data.roles}
      channels={data.channels}
      permissionLabels={data.permissionLabels}
      members={members}
      onSave={changes => api.saveCommands(guild.id, changes)}
      onSaved={async () => (await api.commands(guild.id)).commands}
    />
  );
}

/** The filter over the command list. Composes with the section and the search. */
type StatusFilter = "all" | "enabled" | "disabled";

const statusFilters: { id: StatusFilter; label: string }[] = [
  { id: "all", label: "الكل" },
  { id: "enabled", label: "مفعّل" },
  { id: "disabled", label: "معطّل" }
];

/**
 * The icon each section wears in the sidebar.
 *
 * Keyed by the shared `CommandCategory` union, so adding a section to core
 * without giving it an icon here is a type error rather than a blank row.
 */
const categoryIcons: Record<CommandCategory, LucideIcon> = {
  core: Sparkles,
  penalties: Gavel,
  "punishment-logs": ScrollText,
  "channel-management": Hash,
  "chat-tools": MessageSquare,
  voice: Volume2,
  "role-management": ShieldCheck,
  "special-roles": Palette,
  "member-info": Users,
  "bot-tools": Bot,
  protection: ShieldAlert,
  levels: TrendingUp,
  "server-stats": BarChart3,
  profile: UserCircle
};

/**
 * The screen itself, with the loading already done.
 *
 * Kept separate from the container so it can be rendered — and asserted on —
 * with a fixed set of commands, without a network round trip. Effects never run
 * under `renderToString`, so anything reachable only through the fetch would
 * otherwise have no coverage at all.
 */
export function CommandsBoard({
  commands,
  categories,
  roles,
  channels,
  permissionLabels,
  members = [],
  onSave,
  onSaved
}: {
  commands: CommandFlag[];
  categories: { id: CommandCategory; label: string; description: string }[];
  roles: DiscordRole[];
  channels: ChannelOption[];
  permissionLabels: Record<string, string>;
  /** Resolved names for the members the scopes name. Absent renders the raw id. */
  members?: ScopedMember[];
  onSave: (changes: CommandChange[]) => Promise<unknown>;
  /** Re-reads the stored configuration after a save, so the draft is rebased. */
  onSaved: () => Promise<CommandFlag[]>;
}) {
  const [saved, setSaved] = useState<CommandFlag[]>(commands);
  const [draft, setDraft] = useState<CommandFlag[]>(commands);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [section, setSection] = useState<CommandCategory | "all">("all");

  const memberById = useMemo(() => new Map(members.map(member => [member.id, member])), [members]);

  /** Only the commands that differ from what is stored, compared field by field. */
  const changes = useMemo<CommandChange[]>(() => {
    const before = new Map(saved.map(command => [command.name, command]));
    return draft.filter(command => commandDiffers(command, before.get(command.name))).map(command => ({
      name: command.name,
      enabled: command.enabled,
      allowedLevel: command.allowedLevel,
      dmOnAction: command.dmOnAction,
      deleteMessageDays: command.deleteMessageDays,
      allowedRoleIds: command.allowedRoleIds,
      deniedRoleIds: command.deniedRoleIds,
      allowedChannelIds: command.allowedChannelIds,
      deniedChannelIds: command.deniedChannelIds,
      allowedUserIds: command.allowedUserIds,
      deniedUserIds: command.deniedUserIds,
      cooldownSeconds: command.cooldownSeconds,
      autoDeleteResponseSeconds: command.autoDeleteResponseSeconds,
      requireReason: command.requireReason,
      allowCustomReason: command.allowCustomReason,
      defaultDuration: command.defaultDuration,
      presetReasons: command.presetReasons
    }));
  }, [saved, draft]);

  /** The three filters, composed. A search narrows what the section shows. */
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return draft.filter(command => {
      if (section !== "all" && command.category !== section) return false;
      if (status === "enabled" && !command.enabled) return false;
      if (status === "disabled" && command.enabled) return false;
      if (!needle) return true;
      return (
        command.name.toLowerCase().includes(needle) ||
        command.description.toLowerCase().includes(needle) ||
        `/${command.name}`.includes(needle)
      );
    });
  }, [draft, query, section, status]);

  const grouped = useMemo(() => {
    const map = new Map<CommandCategory, CommandFlag[]>();
    for (const command of visible) map.set(command.category, [...(map.get(command.category) ?? []), command]);
    return map;
  }, [visible]);

  /** Per section, over the whole draft so the sidebar does not move while typing. */
  const counts = useMemo(() => {
    const map = new Map<CommandCategory, { total: number; enabled: number }>();
    for (const category of categories) map.set(category.id, { total: 0, enabled: 0 });
    for (const command of draft) {
      const entry = map.get(command.category) ?? { total: 0, enabled: 0 };
      entry.total += 1;
      if (command.enabled) entry.enabled += 1;
      map.set(command.category, entry);
    }
    return map;
  }, [draft, categories]);

  const stats = useMemo(
    () => ({
      total: draft.length,
      enabled: draft.filter(command => command.enabled).length,
      sections: categories.filter(category => (counts.get(category.id)?.total ?? 0) > 0).length
    }),
    [draft, categories, counts]
  );

  const patch = (name: string, next: Partial<CommandFlag>) =>
    setDraft(current => current.map(command => (command.name === name ? { ...command, ...next } : command)));

  /**
   * Applies one field to every command at once. Still a draft edit.
   *
   * Scoped to what the current filters show rather than to the whole registry:
   * the operator has narrowed the list to the commands they mean, and reaching
   * past that to touch commands they cannot see would be the surprising choice.
   */
  const patchVisible = (next: Partial<CommandFlag>) => {
    const names = new Set(visible.map(command => command.name));
    setDraft(current => current.map(command => (names.has(command.name) ? { ...command, ...next } : command)));
  };

  const activeSection = section === "all" ? null : categories.find(category => category.id === section) ?? null;

  return (
    <div className="grid min-h-0 gap-4 lg:grid-cols-[15rem_minmax(0,1fr)]">
      {/* ---------------------------------------------------------------- *
       * Sections
       *
       * Sticky, and `self-start` because a grid item stretches to the row
       * height by default — without it there is nothing for `sticky` to
       * travel inside and the nav would scroll away with the cards.
       * ---------------------------------------------------------------- */}
      <nav aria-label="أقسام الأوامر" className="lg:sticky lg:top-6 lg:self-start">
        <div className="flex gap-1 overflow-x-auto pb-2 lg:flex-col lg:overflow-visible lg:pb-0">
          <SectionButton
            label="كل الأوامر"
            icon={SquareTerminal}
            total={stats.total}
            enabled={stats.enabled}
            active={section === "all"}
            onClick={() => setSection("all")}
          />
          {categories.map(category => {
            const count = counts.get(category.id) ?? { total: 0, enabled: 0 };
            return (
              <SectionButton
                key={category.id}
                label={category.label}
                icon={categoryIcons[category.id]}
                total={count.total}
                enabled={count.enabled}
                active={section === category.id}
                onClick={() => setSection(category.id)}
              />
            );
          })}
        </div>
      </nav>

      {/* ---------------------------------------------------------------- *
       * Totals, filters and the list
       * ---------------------------------------------------------------- */}
      <div className="min-w-0 space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <StatCard label="إجمالي الأوامر" value={stats.total} />
          <StatCard label="الأوامر المفعلة" value={stats.enabled} tone="positive" />
          <StatCard label="أقسام فيها أوامر" value={stats.sections} />
        </div>

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

          <div role="group" aria-label="تصفية حسب الحالة" className="flex items-center gap-1 rounded-md border border-border p-0.5">
            {statusFilters.map(filter => (
              <Button
                key={filter.id}
                variant={status === filter.id ? "secondary" : "ghost"}
                size="sm"
                aria-pressed={status === filter.id}
                onClick={() => setStatus(filter.id)}
              >
                {filter.label}
              </Button>
            ))}
          </div>

          <Button variant="outline" size="sm" onClick={() => patchVisible({ enabled: true })}>
            تفعيل الكل
          </Button>
          <Button variant="outline" size="sm" onClick={() => patchVisible({ enabled: false })}>
            تعطيل الكل
          </Button>
        </div>

        {activeSection && (
          <div className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{activeSection.label}</p>
              <p className="truncate text-xs text-muted-foreground">{activeSection.description}</p>
            </div>
            <Button variant="ghost" size="sm" className="gap-1" onClick={() => setSection("all")}>
              <X className="size-3.5" />
              كل الأوامر
            </Button>
          </div>
        )}

        {visible.length === 0 && (
          <p className="rounded-md border border-border px-3 py-6 text-center text-sm text-muted-foreground">
            {activeSection && !query.trim() && status === "all"
              ? "لا توجد أوامر مضافة في هذا القسم حالياً، سيتم توفيرها في التحديثات القادمة."
              : `لا يوجد أمر يطابق عوامل التصفية الحالية${query.trim() ? ` «${query.trim()}»` : ""}.`}
          </p>
        )}

        {categories.map(category => {
          const items = grouped.get(category.id) ?? [];
          if (items.length === 0) return null;
          return (
            <section key={category.id} className="space-y-2">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold">{category.label}</h3>
                <Badge variant="secondary" className="tabular">
                  {items.length}
                </Badge>
              </div>
              <div className="space-y-2">
                {items.map(command => (
                  <CommandCard
                    key={command.name}
                    command={command}
                    roles={roles}
                    channels={channels}
                    memberById={memberById}
                    permissionLabels={permissionLabels}
                    onPatch={next => patch(command.name, next)}
                  />
                ))}
              </div>
            </section>
          );
        })}

        <p className="text-xs text-muted-foreground">
          إيقاف أمر يمنع تنفيذه فوراً، وكل القيود هنا تُفحص على الخادم عند كل تنفيذ لا في الواجهة فقط.
        </p>
      </div>

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

/**
 * One row of the section nav.
 *
 * The badge shows how many of the section's commands are enabled, which is the
 * number an operator is looking for — a section with four commands and none
 * enabled reads as `0` and is worth investigating, while `4/4` is not.
 */
function SectionButton({
  label,
  icon: Icon,
  total,
  enabled,
  active,
  onClick
}: {
  label: string;
  icon: LucideIcon;
  total: number;
  enabled: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "true" : undefined}
      className={`flex shrink-0 items-center gap-2 rounded-md px-2.5 py-2 text-start text-sm transition-colors lg:w-full ${
        active ? "bg-primary/15 font-medium text-primary" : "text-muted-foreground hover:bg-accent hover:text-foreground"
      }`}
    >
      <Icon className="size-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className={`tabular text-xs ${total === 0 ? "text-muted-foreground/60" : ""}`}>{enabled}</span>
    </button>
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

/** The fields a save compares. Anything outside this list is not sent either. */
const COMPARED_KEYS = [
  "enabled",
  "allowedLevel",
  "dmOnAction",
  "deleteMessageDays",
  "cooldownSeconds",
  "autoDeleteResponseSeconds",
  "requireReason",
  "allowCustomReason",
  "defaultDuration"
] as const;

/**
 * Whether the draft differs from what is stored, field by field.
 *
 * Not `JSON.stringify`. The two objects are built by different code — one by the
 * server's `commandFlagsFor`, one by spreading and patching that — so a key that
 * arrives in a different position would stringify differently and be reported as
 * a change the operator never made. Comparing the fields that are actually sent,
 * plus the four lists and the presets in order, is what makes "unchanged" mean
 * unchanged.
 */
function commandDiffers(a: CommandFlag, b: CommandFlag | undefined): boolean {
  if (!b) return true;
  for (const key of COMPARED_KEYS) {
    if (a[key] !== b[key]) return true;
  }
  return (
    !sameList(a.allowedRoleIds, b.allowedRoleIds) ||
    !sameList(a.deniedRoleIds, b.deniedRoleIds) ||
    !sameList(a.allowedChannelIds, b.allowedChannelIds) ||
    !sameList(a.deniedChannelIds, b.deniedChannelIds) ||
    !sameList(a.allowedUserIds, b.allowedUserIds) ||
    !sameList(a.deniedUserIds, b.deniedUserIds) ||
    !samePresets(a.presetReasons, b.presetReasons)
  );
}

/** Order-insensitive: a scope is a set, and the picker may reorder it. */
function sameList(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sorted = [...b].sort();
  return [...a].sort().every((value, index) => value === sorted[index]);
}

/** Order-sensitive: the preset list is rendered in order, so a move is a change. */
function samePresets(a: PresetReason[], b: PresetReason[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((preset, index) => preset.id === b[index]!.id && preset.label === b[index]!.label && preset.duration === b[index]!.duration);
}

/**
 * One command, collapsed to a switch and a badge, expanded to everything else.
 *
 * The permission badge replaces the tier dropdown this card used to carry. The
 * dropdown asked the operator to decide which of three words a command was, and
 * then to remember which roles those words mapped to on the tier screen. The
 * badge names the Discord permission instead — the one thing the operator
 * already grants, in Discord's own role editor, and the one that cannot drift
 * from what Discord enforces.
 */
function CommandCard({
  command,
  roles,
  channels,
  memberById,
  permissionLabels,
  onPatch
}: {
  command: CommandFlag;
  roles: DiscordRole[];
  channels: ChannelOption[];
  memberById: Map<string, ScopedMember>;
  permissionLabels: Record<string, string>;
  onPatch: (next: Partial<CommandFlag>) => void;
}) {
  const [open, setOpen] = useState(false);
  const customised =
    command.allowedRoleIds.length > 0 ||
    command.deniedRoleIds.length > 0 ||
    command.allowedChannelIds.length > 0 ||
    command.deniedChannelIds.length > 0 ||
    command.allowedUserIds.length > 0 ||
    command.deniedUserIds.length > 0 ||
    command.cooldownSeconds > 0 ||
    command.autoDeleteResponseSeconds > 0 ||
    command.requireReason ||
    !command.allowCustomReason;

  const permission = command.requiredPermission ? permissionLabels[command.requiredPermission] : null;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <Card>
        <div className="flex flex-wrap items-center gap-3 p-3">
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
          <Badge variant={permission ? "secondary" : "outline"} className="shrink-0 text-[10px]">
            {permission ? `يتطلب: ${permission}` : "متاح للجميع"}
          </Badge>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="gap-1" aria-label={`إعدادات ${command.name}`}>
              <span className="text-xs">إعدادات</span>
              <ChevronDown className={`size-4 transition-transform ${open ? "rotate-180" : ""}`} />
            </Button>
          </CollapsibleTrigger>
        </div>

        <CollapsibleContent>
          <div className="space-y-4 border-t border-border p-3">
            {/* -------------------------------------------------------- *
             * (أ) الصلاحيات
             * -------------------------------------------------------- */}
            <SectionTitle>الصلاحيات</SectionTitle>

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

            <div className="grid gap-3 lg:grid-cols-2">
              <UserScopeList
                label="الأعضاء المسموح لهم"
                hint="استثناء ضيّق لشخص بعينه حين لا تكفي رتبة: مساعد واحد، أو حساب ثانٍ للمالك."
                selected={command.allowedUserIds}
                memberById={memberById}
                onChange={ids => onPatch({ allowedUserIds: ids })}
              />
              <UserScopeList
                label="الأعضاء الممنوعون"
                hint="الحظر يتقدّم على كل سماح: من أُدرج هنا لا ينفّذ الأمر حتى لو منحته رتبة أو رتبة أساسية."
                selected={command.deniedUserIds}
                memberById={memberById}
                onChange={ids => onPatch({ deniedUserIds: ids })}
              />
            </div>

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

            {/* -------------------------------------------------------- *
             * (ب) السلوك والمؤقتات
             * -------------------------------------------------------- */}
            <SectionTitle>السلوك والمؤقتات</SectionTitle>

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

            {/* -------------------------------------------------------- *
             * (ج) إعدادات العقوبات — only where they mean something
             * -------------------------------------------------------- */}
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

                  {/* Only meaningful once there is a list to restrict to, so it
                      is hidden rather than shown as a switch that does nothing. */}
                  {command.presetReasons.length > 0 && (
                    <>
                      <label className="flex items-center gap-2 text-sm">
                        <Switch
                          checked={command.allowCustomReason}
                          onCheckedChange={checked => onPatch({ allowCustomReason: checked })}
                        />
                        السماح بكتابة سبب غير الأسباب الجاهزة
                      </label>
                      <p className="text-xs text-muted-foreground">
                        عند إيقافه تُقبل الأسباب الجاهزة وحدها، وهو ما يعطي مجموعة أسباب نظيفة قابلة للعدّ.
                      </p>
                    </>
                  )}

                  {command.supportsDuration && (
                    <div className="space-y-1.5">
                      <Label htmlFor={`duration-${command.name}`}>المدة الافتراضية</Label>
                      <Select
                        value={command.defaultDuration}
                        onValueChange={value => onPatch({ defaultDuration: value as CommandDuration })}
                      >
                        <SelectTrigger id={`duration-${command.name}`} className="w-full max-w-sm">
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
                        تُطبَّق عندما لا يحدّد المشرف مدة. «دائم» يطلب كتابة المدة صراحةً، و«مخصص» يطلبها دائماً حتى لو حمل
                        السبب الجاهز مدة مقترنة.
                      </p>
                    </div>
                  )}

                  <PresetReasons command={command} onChange={presets => onPatch({ presetReasons: presets })} />
                </div>
              </>
            )}
          </div>
        </CollapsibleContent>
      </Card>
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
 * A scope list for members, addressed by id rather than picked from a list.
 *
 * There is no member dropdown because there is no member list: fetching one
 * needs the privileged `GUILD_MEMBERS` intent and would return thousands of rows
 * to render at most twenty-five. The operator pastes an id or a mention, and the
 * name shown beside it comes from a separate, cached lookup — so a member who
 * has left degrades to their raw id rather than breaking the row.
 */
export function UserScopeList({
  label,
  hint,
  selected,
  memberById,
  onChange
}: {
  label: string;
  hint: string;
  selected: string[];
  memberById: Map<string, ScopedMember>;
  onChange: (ids: string[]) => void;
}) {
  const [entry, setEntry] = useState("");
  const trimmed = entry.trim();
  // A mention is what the operator has to hand — they copy it from Discord —
  // so both forms are accepted and reduced to the snowflake inside.
  const candidate = trimmed.replace(/[<@!>]/g, "");
  const valid = /^\d{17,20}$/.test(candidate);
  const duplicate = valid && selected.includes(candidate);

  const add = () => {
    if (!valid || duplicate) return;
    onChange([...selected, candidate]);
    setEntry("");
  };

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

      <div className="flex items-center gap-2">
        <Input
          value={entry}
          onChange={event => setEntry(event.target.value)}
          onKeyDown={event => {
            if (event.key === "Enter") {
              event.preventDefault();
              add();
            }
          }}
          placeholder="معرّف العضو أو الإشارة، مثل 123456789012345678"
          aria-label={label}
          dir="ltr"
          className="h-8"
        />
        <Button variant="outline" size="sm" className="gap-1" disabled={!valid || duplicate} onClick={add}>
          <Plus className="size-3.5" />
          إضافة
        </Button>
      </div>

      {trimmed && !valid && <p className="text-xs text-destructive">المعرّف يجب أن يكون من 17 إلى 20 رقماً.</p>}
      {duplicate && <p className="text-xs text-muted-foreground">هذا العضو مضاف بالفعل.</p>}

      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selected.map(id => {
            const member = memberById.get(id);
            return (
              <span key={id} className="flex items-center gap-1.5 rounded-full border border-border py-1 pe-1 ps-2 text-xs">
                {member?.avatarUrl && <img src={member.avatarUrl} alt="" className="size-4 rounded-full" />}
                <span className="max-w-40 truncate" title={id}>
                  {member?.name ?? id}
                </span>
                <button
                  type="button"
                  aria-label={`إزالة ${member?.name ?? id}`}
                  className="rounded-full p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                  onClick={() => onChange(selected.filter(value => value !== id))}
                >
                  <X className="size-3" />
                </button>
              </span>
            );
          })}
        </div>
      )}

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

// `clampInteger` used to be a second copy here. It lives in core now, next to
// the limits it applies, so the editor cannot clamp differently from the
// validator that stores the same fields.
