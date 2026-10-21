import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Award,
  Eye,
  EyeOff,
  Info,
  Link2,
  ListOrdered,
  Mic,
  MoreHorizontal,
  PenLine,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Settings2,
  Trash2,
  Trophy,
  Zap
} from "lucide-react";
import { api } from "@/api";
import { useDraftForm } from "@/lib/use-draft-form";
import { DualRangeSlider } from "@/components/dual-range-slider";
import { LoadError, LoadingRow } from "@/components/view-states";
import { SaveBar } from "@/components/save-bar";
import { Toaster, useToasts } from "@/components/toaster";
import { RoleSwatch } from "@/components/role-swatch";
import { SearchableMultiSelect } from "@/components/searchable-multi-select";
import { StateBadge } from "@/components/state-badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { levelFromXp, LEVEL_MESSAGE_TOKENS, levelProgress, type LevelMultiplier, xpForLevel } from "@al-ai/core/browser";
import type {
  ChannelOption,
  DiscordRole,
  Guild,
  LeaderboardPage,
  LevelConfigProblem,
  LevelNotifyMode,
  LevelRewardInput,
  LevelRewardKind,
  LevelRoleReward,
  LevelSettings,
  LevelSyncJob,
  LevelsStatus
} from "@/types";

type RewardTab = "text" | "voice" | "dual";
type LevelsTab = "settings" | "multipliers" | RewardTab | "leaderboard";

const NONE = "__none__";
const SYNC_POLL_MS = 4_000;
const LEADERBOARD_PAGE_SIZE = 25;

const levelTabs: { key: LevelsTab; label: string; icon: typeof Settings2 }[] = [
  { key: "settings", label: "الإعدادات العامة", icon: Settings2 },
  { key: "multipliers", label: "مضاعفات XP", icon: Zap },
  { key: "text", label: "رتب كتابية", icon: PenLine },
  { key: "voice", label: "رتب صوتية", icon: Mic },
  { key: "dual", label: "رتب مشتركة", icon: Link2 },
  { key: "leaderboard", label: "المتصدرين", icon: Trophy }
];

/** The tab a kind maps to, so the reward editor can jump between lists. */
function tabKey(kind: LevelRewardInput["kind"]): RewardTab {
  return kind;
}

function kindLabel(kind: LevelRewardInput["kind"]): string {
  if (kind === "voice") return "رتبة صوتية";
  if (kind === "dual") return "رتبة مشتركة";
  return "رتبة كتابية";
}

function kindChip(kind: LevelRewardKind): string {
  if (kind === "voice") return "صوتية";
  if (kind === "dual") return "مشتركة";
  return "كتابية";
}

function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "—";
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? "—" : at.toLocaleString("ar", { dateStyle: "short", timeStyle: "short" });
}

/** The guild's effective level ceiling, resolving 0 to the hard maximum. */
function effectiveCap(maxLevelCap: number): number {
  return maxLevelCap === 0 ? 1000 : maxLevelCap;
}

/* ------------------------------------------------------------------ *
 * Shared bits
 * ------------------------------------------------------------------ */

/** The XP formula card every rewards tab shows, with the shipped examples. */
function FormulaCard() {
  return (
    <Alert>
      <Award aria-hidden />
      <AlertDescription>
        <p className="font-bold">معادلة احتساب المستوى: XP = (المستوى × 25)²</p>
        <p className="mt-1 text-muted-foreground">
          مستوى 5 = {xpForLevel(5).toLocaleString("en")} XP · مستوى 10 = {xpForLevel(10).toLocaleString("en")} XP ·
          مستوى 20 = {xpForLevel(20).toLocaleString("en")} XP
        </p>
      </AlertDescription>
    </Alert>
  );
}

/**
 * Inserts a token into a message template at the caret. Controlled inputs move
 * the caret to the end on every keystroke, so the position is read from the
 * event target before React re-renders and restored afterwards.
 */
function insertToken(textarea: HTMLTextAreaElement | null, token: string, set: (value: string) => void) {
  if (!textarea) {
    set(token);
    return;
  }
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? start;
  const next = `${textarea.value.slice(0, start)}${token}${textarea.value.slice(end)}`;
  set(next);
  requestAnimationFrame(() => {
    textarea.focus();
    const caret = start + token.length;
    textarea.setSelectionRange(caret, caret);
  });
}

/** One merged range row: [ min ] إلى [ max ] XP — the shipped draw shape. */
function RangeField({
  label,
  floor,
  ceiling,
  minValue,
  maxValue,
  onMinChange,
  onMaxChange,
  suffix = "XP"
}: {
  label: string;
  floor: number;
  ceiling: number;
  minValue: number;
  maxValue: number;
  onMinChange: (value: number) => void;
  onMaxChange: (value: number) => void;
  suffix?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <DualRangeSlider
        label={label}
        valueMin={minValue}
        valueMax={maxValue}
        floor={floor}
        ceiling={ceiling}
        onMinChange={onMinChange}
        onMaxChange={onMaxChange}
        formatValue={value => `${value} ${suffix}`}
      />
      <div className="flex items-center gap-2" dir="ltr">
        <Input
          aria-label={`${label} — الأدنى (رقمي)`}
          type="number"
          min={floor}
          max={ceiling}
          value={minValue}
          onChange={event => onMinChange(Number(event.target.value))}
          className="w-16 text-center"
        />
        <span className="shrink-0 text-xs text-muted-foreground">إلى</span>
        <Input
          aria-label={`${label} — الأقصى (رقمي)`}
          type="number"
          min={floor}
          max={ceiling}
          value={maxValue}
          onChange={event => onMaxChange(Number(event.target.value))}
          className="w-16 text-center"
        />
        <Badge variant="secondary" className="shrink-0 font-mono">
          {suffix}
        </Badge>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Settings tab — text | voice columns, then system limits
 * ------------------------------------------------------------------ */

function SettingsTab({
  draft,
  patch,
  roles,
  channels
}: {
  draft: LevelSettings;
  patch: (value: Partial<LevelSettings>) => void;
  roles: DiscordRole[];
  channels: ChannelOption[];
}) {
  const textRef = useRef<HTMLTextAreaElement>(null);
  const voiceRef = useRef<HTMLTextAreaElement>(null);

  const messageCard = (
    title: string,
    ref: React.RefObject<HTMLTextAreaElement | null>,
    value: string,
    onChange: (value: string) => void,
    hint: string
  ) => (
    <div className="space-y-2">
      <Label>{title}</Label>
      <Textarea ref={ref} value={value} onChange={event => onChange(event.target.value)} rows={2} />
      <div className="flex flex-wrap gap-1.5">
        {LEVEL_MESSAGE_TOKENS.map(token => (
          <Button
            key={token}
            type="button"
            variant="outline"
            size="sm"
            className="h-7 font-mono text-xs"
            onClick={() => insertToken(ref.current, token, onChange)}
          >
            {token}
          </Button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );

  return (
    <div className="space-y-4">
      {/* Two columns: the text track on one side, the voice track opposite. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="flex flex-col">
          <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <PenLine className="size-4 text-primary" aria-hidden />
              الخبرة الكتابية
            </CardTitle>
            <Switch
              id="levels-text-xp"
              checked={draft.textXpEnabled}
              onCheckedChange={textXpEnabled => patch({ textXpEnabled })}
              aria-label="تفعيل الخبرة الكتابية"
            />
          </CardHeader>
          <CardContent className="flex flex-1 flex-col justify-between gap-4">
            <RangeField
              label="XP لكل رسالة مؤهلة"
              floor={1}
              ceiling={100}
              minValue={draft.textXpMin}
              maxValue={draft.textXpMax}
              onMinChange={textXpMin => patch({ textXpMin })}
              onMaxChange={textXpMax => patch({ textXpMax })}
            />
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground" htmlFor="levels-cooldown">
                فترة الانتظار بين رسالتين
              </Label>
              <div className="flex items-center gap-2" dir="ltr">
                <Input
                  id="levels-cooldown"
                  type="number"
                  min={10}
                  max={3600}
                  value={draft.textCooldownSeconds}
                  onChange={event => patch({ textCooldownSeconds: Number(event.target.value) })}
                  className="w-24 text-center"
                />
                <Badge variant="secondary">ثانية</Badge>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              كل رسالة مؤهلة تمنح العضو نقاطاً عشوائية بين الحدين — والقنوات والرتب المستثناة تُضبط في بطاقة
              الاستثناءات.
            </p>
          </CardContent>
        </Card>

        <Card className="flex flex-col">
          <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Mic className="size-4 text-primary" aria-hidden />
              الخبرة الصوتية
            </CardTitle>
            <Switch
              id="levels-voice-xp"
              checked={draft.voiceXpEnabled}
              onCheckedChange={voiceXpEnabled => patch({ voiceXpEnabled })}
              aria-label="تفعيل الخبرة الصوتية"
            />
          </CardHeader>
          <CardContent className="flex flex-1 flex-col gap-4">
            <RangeField
              label="XP لكل دقيقة مؤهلة"
              floor={0}
              ceiling={100}
              minValue={draft.voiceXpMin}
              maxValue={draft.voiceXpMax}
              onMinChange={voiceXpMin => patch({ voiceXpMin })}
              onMaxChange={voiceXpMax => patch({ voiceXpMax })}
            />
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label className="text-xs text-muted-foreground" htmlFor="levels-min-members">
                  الحد الأدنى للأعضاء المؤهلين
                </Label>
                <Badge variant="secondary" dir="ltr">
                  {draft.voiceMinMembers} / 10
                </Badge>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-10 shrink-0 text-[10px] text-muted-foreground">1</span>
                <input
                  id="levels-min-members"
                  type="range"
                  min={1}
                  max={10}
                  step={1}
                  value={draft.voiceMinMembers}
                  onChange={event => patch({ voiceMinMembers: Number(event.target.value) })}
                  className="w-full accent-primary"
                  aria-label="الحد الأدنى للأعضاء المؤهلين في القناة، من 1 إلى 10"
                  aria-valuetext={`${draft.voiceMinMembers} من 10`}
                />
                <span className="w-10 shrink-0 text-end text-[10px] text-muted-foreground">10</span>
              </div>
            </div>
            <div className="grid grid-cols-1 gap-2">
              <label className="flex items-center justify-between gap-2 rounded-lg border border-border/80 px-3 py-1.5">
                <span className="text-xs">تجاهل المكتومين</span>
                <Switch checked={draft.ignoreMuted} onCheckedChange={ignoreMuted => patch({ ignoreMuted })} />
              </label>
              <label className="flex items-center justify-between gap-2 rounded-lg border border-border/80 px-3 py-1.5">
                <span className="text-xs">تجاهل الصامتين</span>
                <Switch checked={draft.ignoreDeafened} onCheckedChange={ignoreDeafened => patch({ ignoreDeafened })} />
              </label>
              <label className="flex items-center justify-between gap-2 rounded-lg border border-border/80 px-3 py-1.5">
                <span className="text-xs">تجاهل قناة AFK</span>
                <Switch checked={draft.ignoreAfk} onCheckedChange={ignoreAfk => patch({ ignoreAfk })} />
              </label>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">حدود النظام</CardTitle>
          <CardDescription>سقف الترقية وما يحدث عند مغادرة الأعضاء.</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground" htmlFor="levels-cap">
              الحد الأقصى للمستوى (0 = غير محدود)
            </Label>
            <div className="flex items-center gap-2" dir="ltr">
              <Input
                id="levels-cap"
                type="number"
                min={0}
                max={1000}
                value={draft.maxLevelCap}
                onChange={event => patch({ maxLevelCap: Number(event.target.value) })}
                className="w-28 text-center"
              />
              <Badge variant="secondary">مستوى</Badge>
            </div>
          </div>
          <label className="flex items-center justify-between gap-3 rounded-lg border border-border/80 px-3 py-2">
            <span>
              <span className="block text-sm font-medium">تصفير نقاط العضو عند مغادرة السيرفر</span>
              <span className="block text-xs text-muted-foreground">
                تُصفّر نقاط المغادر وتُسحب رتبه غير المستحقة في أول مزامنة.
              </span>
            </span>
            <Switch checked={draft.resetOnLeave} onCheckedChange={resetOnLeave => patch({ resetOnLeave })} />
          </label>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">إشعارات الترقية والرسائل</CardTitle>
          <CardDescription>إشعار العضو عند ترقيته، وجهته وصيغته وبطاقة الترقية.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex items-center justify-between gap-2 rounded-lg border border-border/80 px-3 py-2">
              <span className="text-sm">رسائل رفع المستوى</span>
              <Switch checked={draft.notifyLevelUp} onCheckedChange={notifyLevelUp => patch({ notifyLevelUp })} />
            </label>
            <label className="flex items-center justify-between gap-2 rounded-lg border border-border/80 px-3 py-2">
              <span>
                <span className="block text-sm">بطاقة صورة الترقية</span>
                <span className="block text-[10px] text-muted-foreground">بطاقة غنية مع الإشعار</span>
              </span>
              <Switch checked={draft.rankCardEnabled} onCheckedChange={rankCardEnabled => patch({ rankCardEnabled })} />
            </label>
          </div>
          {draft.notifyLevelUp && (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">وجهة الإشعار</Label>
                  <Select value={draft.notifyMode} onValueChange={mode => patch({ notifyMode: mode as LevelNotifyMode })}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="same_channel">نفس القناة (الافتراضي)</SelectItem>
                      <SelectItem value="custom_channel">قناة مخصصة</SelectItem>
                      <SelectItem value="send_dm">رسالة خاصة (خاص DM)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {draft.notifyMode === "custom_channel" && (
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">قناة الإشعارات</Label>
                    <Select
                      value={draft.notifyChannelId ?? NONE}
                      onValueChange={value => patch({ notifyChannelId: value === NONE ? null : value })}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="اختر قناة..." />
                      </SelectTrigger>
                      <SelectContent>
                        {channels.map(channel => (
                          <SelectItem key={channel.id} value={channel.id}>
                            {channel.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </div>
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                {messageCard(
                  "رسالة الترقية الكتابية",
                  textRef,
                  draft.textLevelUpMessage,
                  textLevelUpMessage => patch({ textLevelUpMessage }),
                  "{user} منشن · {level} المستوى · {xp} النقاط · {server} السيرفر"
                )}
                {messageCard(
                  "رسالة الترقية الصوتية",
                  voiceRef,
                  draft.voiceLevelUpMessage,
                  voiceLevelUpMessage => patch({ voiceLevelUpMessage }),
                  "ترقية الصوت تُرسل للقناة المخصصة أو قناة النظام أو الخاص."
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">الاستثناءات</CardTitle>
          <CardDescription>من وأين لا تُحتسب النقاط إطلاقاً.</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <SearchableMultiSelect
            id="levels-ignored-text"
            kind="text"
            label="قنوات كتابية"
            hint="رسائل هذه القنوات وثريداتها لا تُحتسب."
            options={channels.filter(channel => channel.type === "text")}
            selected={draft.ignoredTextChannelIds}
            onChange={ignoredTextChannelIds => patch({ ignoredTextChannelIds })}
          />
          <SearchableMultiSelect
            id="levels-ignored-voice"
            kind="voice"
            label="قنوات صوتية"
            hint="الوقت في هذه الرومات لا يُحتسب."
            options={channels.filter(channel => channel.type === "voice")}
            selected={draft.ignoredVoiceChannelIds}
            onChange={ignoredVoiceChannelIds => patch({ ignoredVoiceChannelIds })}
          />
          <SearchableMultiSelect
            id="levels-ignored-roles"
            kind="role"
            label="رتب مستثناة"
            hint="حاملو أي من هذه الرتب لا يكسبون XP."
            options={roles}
            selected={draft.ignoredRoleIds}
            onChange={ignoredRoleIds => patch({ ignoredRoleIds })}
          />
        </CardContent>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Multipliers tab
 * ------------------------------------------------------------------ */

function MultiplierTable({
  title,
  hint,
  options,
  rules,
  onChange
}: {
  title: string;
  hint: string;
  options: { id: string; name: string }[];
  rules: LevelMultiplier[];
  onChange: (next: LevelMultiplier[]) => void;
}) {
  const [pendingId, setPendingId] = useState("");
  const [pendingFactor, setPendingFactor] = useState("2");
  const taken = new Set(rules.map(rule => rule.id));
  const available = options.filter(option => !taken.has(option.id));

  const addRule = () => {
    const multiplier = Number(pendingFactor);
    if (!pendingId || !Number.isFinite(multiplier) || multiplier < 0.1 || multiplier > 10) return;
    onChange([...rules, { id: pendingId, multiplier: Math.round(multiplier * 100) / 100 }]);
    setPendingId("");
  };

  return (
    <div className="space-y-2">
      <Label>{title}</Label>
      {rules.length > 0 && (
        <ul className="divide-y divide-border/80 rounded-xl border border-border/80">
          {rules.map(rule => {
            const name = options.find(option => option.id === rule.id)?.name ?? rule.id;
            return (
              <li key={rule.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                <span className="flex min-w-0 items-center gap-1.5">
                  <RoleSwatch color={(options.find(option => option.id === rule.id) as DiscordRole | undefined)?.color} />
                  <span className="truncate">{name}</span>
                </span>
                <span className="flex shrink-0 items-center gap-2" dir="ltr">
                  <Badge variant="secondary">×{rule.multiplier}</Badge>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="hover:text-destructive"
                    aria-label={`حذف ${name}`}
                    onClick={() => onChange(rules.filter(entry => entry.id !== rule.id))}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {available.length > 0 && rules.length < 50 && (
        <div className="flex items-center gap-2">
          <Select value={pendingId} onValueChange={setPendingId}>
            <SelectTrigger className="flex-1">
              <SelectValue placeholder="اختر..." />
            </SelectTrigger>
            <SelectContent>
              {available.map(option => (
                <SelectItem key={option.id} value={option.id}>
                  {option.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            aria-label="قيمة المضاعف"
            type="number"
            min={0.1}
            max={10}
            step={0.1}
            className="w-20 text-center"
            dir="ltr"
            value={pendingFactor}
            onChange={event => setPendingFactor(event.target.value)}
          />
          <Button size="sm" variant="outline" onClick={addRule} disabled={!pendingId}>
            <Plus />
            إضافة
          </Button>
        </div>
      )}
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

function MultipliersTab({
  draft,
  patch,
  roles,
  channels
}: {
  draft: LevelSettings;
  patch: (value: Partial<LevelSettings>) => void;
  roles: DiscordRole[];
  channels: ChannelOption[];
}) {
  return (
    <div className="space-y-4">
      <Alert>
        <Zap aria-hidden />
        <AlertDescription>
          قواعد تضاعف نقاط من يحقق شرطها — وتتركّب عند تطابق أكثر من قاعدة (×2 مع ×1.5 = ×3).
        </AlertDescription>
      </Alert>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">مضاعفات حسب الرتبة</CardTitle>
            <CardDescription>مثال: رتبة Server Booster بمضاعف ×2.0 — من يحملها يكسب ضعف النقاط.</CardDescription>
          </CardHeader>
          <CardContent>
            <MultiplierTable
              title="قواعد الرتب"
              hint="تُطبَّق على النقاط الكتابية والصوتية معاً."
              options={roles}
              rules={draft.roleMultipliers}
              onChange={roleMultipliers => patch({ roleMultipliers })}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">مضاعفات حسب القناة</CardTitle>
            <CardDescription>مثال: روم الفعاليات بمضاعف ×1.5 — النقاط المكتوبة فيه تتضاعف.</CardDescription>
          </CardHeader>
          <CardContent>
            <MultiplierTable
              title="قواعد القنوات"
              hint="القناة الكتابية تضاعف رسائلها، والصوتية تضاعف وقتها."
              options={channels}
              rules={draft.channelMultipliers}
              onChange={channelMultipliers => patch({ channelMultipliers })}
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Rewards tabs (text / voice / dual) — card-based lists
 * ------------------------------------------------------------------ */

type RewardDraft = {
  id: string | null;
  level: string;
  voiceLevel: string;
  roleId: string;
  alwaysKeep: boolean;
};

function RewardRulesTab({
  guild,
  kind,
  rewards,
  roles,
  problems,
  stacking,
  onStackingChange,
  cap,
  sync,
  onSync,
  syncing,
  onChanged
}: {
  guild: Guild;
  kind: RewardTab;
  rewards: LevelRoleReward[];
  roles: DiscordRole[];
  problems: LevelConfigProblem[];
  stacking: boolean;
  onStackingChange: (value: boolean) => void;
  cap: number;
  sync: LevelSyncJob | null;
  onSync: () => void;
  syncing: boolean;
  onChanged: () => void;
}) {
  const { toasts, push, dismiss } = useToasts();
  const [editorOpen, setEditorOpen] = useState(false);
  const [editor, setEditor] = useState<RewardDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const kindRewards = useMemo(() => rewards.filter(reward => reward.kind === kind), [rewards, kind]);
  const personal = usePersonalLevels(kind === "dual" ? guild.id : null);

  const openCreate = () =>
    setEditor({ id: null, level: "1", voiceLevel: kind === "dual" ? "1" : "", roleId: "", alwaysKeep: false });
  const openEdit = (reward: LevelRoleReward) =>
    setEditor({
      id: reward.id,
      level: String(reward.level),
      voiceLevel: String(reward.voiceLevel ?? 1),
      roleId: reward.roleId,
      alwaysKeep: reward.alwaysKeep
    });

  const submit = async () => {
    if (!editor) return;
    const level = Number(editor.level);
    if (!Number.isFinite(level) || level < 1) {
      setError("أدخل مستوى صحيحاً (1 أو أعلى).");
      return;
    }
    if (kind === "dual" && (!Number.isFinite(Number(editor.voiceLevel)) || Number(editor.voiceLevel) < 1)) {
      setError("أدخل المستوى الصوتي المطلوب.");
      return;
    }
    if (!editor.roleId) {
      setError("اختر رتبة ديسكورد.");
      return;
    }
    setBusy(true);
    setError(null);
    const payload: LevelRewardInput = {
      kind,
      level: Math.round(level),
      voiceLevel: kind === "dual" ? Math.round(Number(editor.voiceLevel)) : null,
      roleId: editor.roleId,
      alwaysKeep: editor.alwaysKeep
    };
    try {
      if (editor.id) {
        await api.updateLevelReward(guild.id, editor.id, payload);
      } else {
        await api.createLevelReward(guild.id, payload);
      }
      setEditorOpen(false);
      setEditor(null);
      push({ title: "تم حفظ القاعدة، وستُزامن الرتب تلقائياً.", tone: "success" });
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "تعذّر الحفظ.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (reward: LevelRoleReward) => {
    try {
      await api.deleteLevelReward(guild.id, reward.id);
      push({ title: "حُذفت القاعدة، وستُزامن الرتب تلقائياً.", tone: "success" });
      onChanged();
    } catch (cause) {
      push({ title: cause instanceof Error ? cause.message : "تعذّر الحذف.", tone: "error" });
    }
  };

  const roleName = (roleId: string) => roles.find(role => role.id === roleId);
  // One role may be earned through several rules across the three tracks —
  // the chips say so, so losing one source never reads as losing the role.
  const otherKindsFor = (roleId: string) =>
    [...new Set(rewards.filter(reward => reward.roleId === roleId && reward.kind !== kind).map(reward => reward.kind))];

  return (
    <div className="space-y-4">
      {kind === "dual" && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Link2 className="size-4 text-primary" aria-hidden />
              كيف تعمل الرتب المشتركة؟
            </CardTitle>
            <CardDescription>
              تُمنح الرتبة فقط عند استيفاء الشرطين معاً — كتابي ≥ X و صوتي ≥ Y — وتُسحب تلقائياً عند فقد أي شرط، وتبقى
              طالما بقي أي مصدر استحقاق آخر.
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      <FormulaCard />

      {problems.length > 0 && (
        <Alert>
          <Award aria-hidden />
          <AlertDescription>
            <p className="font-bold text-destructive">مشاكل في الإعداد الحالي</p>
            <ul className="mt-1 list-disc space-y-0.5 pe-5 text-xs text-muted-foreground">
              {problems.map((problem, index) => (
                <li key={index}>{problem.message}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader className="flex-row items-start justify-between space-y-0 pb-3">
          <div className="min-w-0 space-y-1">
            <CardTitle className="text-base">
              {kind === "dual" ? "قواعد الشرط المزدوج" : "رتب المستويات"}
            </CardTitle>
            <CardDescription>
              {kind === "dual"
                ? "رتب تُمنح بتحقق شرطين معاً."
                : "أضف رتبة لكل مستوى تستهدفه، وقرر لكل قاعدة سلوكها."}
            </CardDescription>
          </div>
          <div className="flex flex-col items-end gap-2">
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                onClick={() => {
                  openCreate();
                  setEditorOpen(true);
                }}
              >
                <Plus />
                {kind === "dual" ? "إنشاء قاعدة مشتركة" : "إضافة رتبة مكافأة"}
              </Button>
              <SyncButton sync={sync} syncing={syncing} onSync={onSync} />
            </div>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Switch checked={stacking} onCheckedChange={onStackingChange} aria-label="أدوار تراكمية" />
              أدوار تراكمية (الاحتفاظ بجميع الرتب السابقة)
            </label>
          </div>
        </CardHeader>
        <CardContent>
          {kindRewards.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">لا توجد قواعد بعد — أضف أول رتبة.</p>
          ) : (
            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {kindRewards.map(reward => {
                const role = roleName(reward.roleId);
                const others = otherKindsFor(reward.roleId);
                return (
                  <li
                    key={reward.id}
                    className="flex items-center justify-between gap-3 rounded-xl border border-border/80 bg-background/40 px-3 py-2.5"
                  >
                    <div className="min-w-0 space-y-1.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="secondary" className="font-mono">
                          {reward.kind === "dual"
                            ? `كتابي ≥ ${reward.level} · صوتي ≥ ${reward.voiceLevel}`
                            : `Lv. ${reward.level}`}
                        </Badge>
                        <span className="flex min-w-0 items-center gap-1.5 text-sm">
                          <RoleSwatch color={role?.color} />
                          <span className="truncate">{role?.name ?? reward.roleId}</span>
                        </span>
                        <Badge
                          variant="outline"
                          className={
                            reward.alwaysKeep
                              ? "border-primary/40 text-[10px] text-primary"
                              : "text-[10px] text-muted-foreground"
                          }
                        >
                          {reward.alwaysKeep ? "تراكمي" : "تطوري"}
                        </Badge>
                        {others.map(other => (
                          <Badge key={other} variant="outline" className="text-[10px] text-muted-foreground">
                            تُكتسب أيضاً كـ{kindChip(other)}
                          </Badge>
                        ))}
                      </div>
                      {kind === "dual" && personal && (
                        <DualRuleState
                          personal={personal}
                          cap={cap}
                          requiredTextLevel={reward.level}
                          requiredVoiceLevel={reward.voiceLevel ?? 0}
                        />
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        size="icon"
                        variant="ghost"
                        className="hover:text-destructive"
                        aria-label="حذف"
                        onClick={() => void remove(reward)}
                      >
                        <Trash2 />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label="تعديل"
                        onClick={() => {
                          openEdit(reward);
                          setEditorOpen(true);
                        }}
                      >
                        <Pencil />
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={editorOpen}
        onOpenChange={open => {
          setEditorOpen(open);
          if (!open) setError(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editor?.id ? "تعديل القاعدة" : `إضافة ${kindLabel(kind)}`}</DialogTitle>
            <DialogDescription>
              {kind === "dual"
                ? "حدّد الشرطين معاً، ثم اختر رتبة السيرفر التي تُمنح عندهما."
                : "حدّد المستوى المستهدف، ثم اختر رتبة ديسكورد التي تُمنح عنده."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {kind === "dual" ? (
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground" htmlFor="reward-text-level">
                    المستوى الكتابي ≥
                  </Label>
                  <Input
                    id="reward-text-level"
                    type="number"
                    min={1}
                    value={editor?.level ?? ""}
                    onChange={event => setEditor(state => state && { ...state, level: event.target.value })}
                    className="text-center"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground" htmlFor="reward-voice-level">
                    المستوى الصوتي ≥
                  </Label>
                  <Input
                    id="reward-voice-level"
                    type="number"
                    min={1}
                    value={editor?.voiceLevel ?? ""}
                    onChange={event => setEditor(state => state && { ...state, voiceLevel: event.target.value })}
                    className="text-center"
                  />
                </div>
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground" htmlFor="reward-level">
                  المستوى المستهدف
                </Label>
                <Input
                  id="reward-level"
                  type="number"
                  min={1}
                  value={editor?.level ?? ""}
                  onChange={event => setEditor(state => state && { ...state, level: event.target.value })}
                  className="w-28 text-center"
                />
              </div>
            )}
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">رتبة السيرفر</Label>
              <Select
                value={editor?.roleId || ""}
                onValueChange={roleId => setEditor(state => state && { ...state, roleId })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="اختر رتبة..." />
                </SelectTrigger>
                <SelectContent>
                  {roles.map(role => (
                    <SelectItem key={role.id} value={role.id}>
                      <span className="flex items-center gap-2">
                        <RoleSwatch color={role.color} />
                        <span>{role.name}</span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                تظهر فقط الرتب تحت أعلى رتبة البوت — ما فوقها يرفضه ديسكورد.
              </p>
            </div>
            <label className="flex items-center justify-between gap-3 rounded-lg border border-border/80 px-3 py-2">
              <span>
                <span className="block text-sm font-medium">الاحتفاظ بهذه الرتبة (تراكمية)</span>
                <span className="block text-xs text-muted-foreground">
                  تبقى مع العضو ما دامت القاعدة مستوفاة، حتى لو كان التكديس معطلاً.
                </span>
              </span>
              <Switch
                checked={editor?.alwaysKeep ?? false}
                onCheckedChange={alwaysKeep => setEditor(state => state && { ...state, alwaysKeep })}
              />
            </label>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setEditorOpen(false)} disabled={busy}>
              إلغاء
            </Button>
            <Button onClick={() => void submit()} loading={busy}>
              {/* The label stays put: the button's own `loading` state puts a
                  spinner in front of it, and swapping the text as well would
                  move the button's contents twice for one event. */}
              حفظ
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Toaster toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}

/**
 * The signed-in operator's own levels, fetched only for the dual tab — the
 * personal eligibility chips come from real data or show "غير متاح", never a
 * guess against an imaginary member.
 */
function usePersonalLevels(guildId: string | null) {
  const [personal, setPersonal] = useState<{ levels: { textXp: number; voiceXp: number } | null; available: boolean } | null>(
    null
  );
  useEffect(() => {
    if (!guildId) return;
    let cancelled = false;
    api
      .levelsMe(guildId)
      .then(result => {
        if (cancelled) return;
        setPersonal({ levels: result.levels, available: true });
      })
      .catch(() => !cancelled && setPersonal({ levels: null, available: false }));
    return () => {
      cancelled = true;
    };
  }, [guildId]);
  return personal;
}

/** One dual rule judged against the signed-in operator's real levels. */
function DualRuleState({
  personal,
  cap,
  requiredTextLevel,
  requiredVoiceLevel
}: {
  personal: { levels: { textXp: number; voiceXp: number } | null; available: boolean };
  cap: number;
  requiredTextLevel: number;
  requiredVoiceLevel: number;
}) {
  const chip = (met: boolean | null, label: string) => (
    <Badge
      variant={met === true ? "default" : met === false ? "secondary" : "outline"}
      className={met === false ? "text-muted-foreground" : undefined}
    >
      {label} {met === true ? "✓" : met === false ? "✗" : "—"}
    </Badge>
  );
  if (!personal.available) {
    return <div className="mt-1 flex flex-wrap gap-1"><Badge variant="outline">حالة التحقق: غير متاح</Badge></div>;
  }
  if (!personal.levels) {
    return <div className="mt-1 flex flex-wrap gap-1"><Badge variant="outline">لا توجد بيانات مستويات لك بعد</Badge></div>;
  }
  const textLevel = levelFromXp(personal.levels.textXp, cap);
  const voiceLevel = levelFromXp(personal.levels.voiceXp, cap);
  const textMet = textLevel >= requiredTextLevel;
  const voiceMet = voiceLevel >= requiredVoiceLevel;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1">
      {chip(textMet, "كتابي")}
      {chip(voiceMet, "صوتي")}
      <Badge variant={textMet && voiceMet ? "default" : "outline"}>
        {textMet && voiceMet ? "مستحق لك ✓" : "غير مستحق لك بعد"}
      </Badge>
    </div>
  );
}

/** The sync button: real job state, real progress, real failure — one sync surface per tab. */
function SyncButton({
  sync,
  syncing,
  onSync
}: {
  sync: LevelSyncJob | null;
  syncing: boolean;
  onSync: () => void;
}) {
  const active = sync?.status === "pending" || sync?.status === "running";
  return (
    <div className="flex flex-col items-end gap-1">
      {/* Syncing from a live job is a *job* state (the RotateCw keeps its own
          spin while the job runs); `syncing` is the request in flight and uses
          the shared loading. */}
      <Button
        size="sm"
        variant="outline"
        onClick={onSync}
        disabled={active}
        loading={syncing}
      >
        <RotateCw className={active ? "animate-spin" : undefined} />
        {active ? "جارٍ المزامنة" : sync?.status === "failed" ? "إعادة المحاولة" : "مزامنة"}
      </Button>
      {active && sync?.total !== null && sync?.total !== undefined && (
        <span className="text-xs text-muted-foreground" dir="ltr">
          {sync.processed} / {sync.total} · ✓{sync.granted} ✗{sync.removed}
          {sync.failed > 0 ? ` ⚠${sync.failed}` : ""}
        </span>
      )}
      {sync?.status === "failed" && (
        <span className="max-w-56 truncate text-xs text-destructive" title={sync.error ?? undefined}>
          {sync.error ?? "فشلت المزامنة"}
        </span>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Leaderboard tab
 * ------------------------------------------------------------------ */

type XpEditorState = {
  userId: string;
  displayName: string;
  /** The value for the currently displayed track; the other track stays untouched. */
  value: string;
};

function LeaderboardTab({ guild, cap }: { guild: Guild; cap: number }) {
  const [track, setTrack] = useState<"text" | "voice">("text");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<LeaderboardPage | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const inFlight = useRef(false);
  const { toasts, push, dismiss } = useToasts();
  const [xpEditor, setXpEditor] = useState<XpEditorState | null>(null);
  const [xpSaving, setXpSaving] = useState(false);
  const [resetTarget, setResetTarget] = useState<{ userId: string; displayName: string } | null>(null);
  const [resetting, setResetting] = useState(false);

  const load = useCallback(
    (forTrack: "text" | "voice", forPage: number) => {
      // One request at a time: a slow response must not race a newer one.
      if (inFlight.current) return;
      inFlight.current = true;
      setLoading(true);
      api
        .levelsLeaderboard(guild.id, forTrack, forPage, LEADERBOARD_PAGE_SIZE)
        .then(result => {
          setData(result);
          setUpdatedAt(new Date().toISOString());
          setError(null);
        })
        .catch(cause => setError(cause instanceof Error ? cause.message : "تعذّر التحميل."))
        .finally(() => {
          inFlight.current = false;
          setLoading(false);
        });
    },
    [guild.id]
  );

  useEffect(() => {
    load(track, page);
  }, [load, track, page]);

  const saveXp = async () => {
    if (!xpEditor) return;
    setXpSaving(true);
    try {
      // Only the displayed track is written; the other track passes null and
      // the server leaves it exactly as it was.
      await api.setMemberXp(
        guild.id,
        xpEditor.userId,
        track === "text" ? { textXp: Number(xpEditor.value), voiceXp: null } : { textXp: null, voiceXp: Number(xpEditor.value) }
      );
      push({ title: "حُدّثت نقاط العضو، وستُزامن رتبه تلقائياً.", tone: "success" });
      setXpEditor(null);
      load(track, page);
    } catch (cause) {
      push({ title: cause instanceof Error ? cause.message : "تعذّر تحديث النقاط.", tone: "error" });
    } finally {
      setXpSaving(false);
    }
  };

  const resetMember = async () => {
    if (!resetTarget) return;
    setResetting(true);
    try {
      await api.resetMemberXp(guild.id, resetTarget.userId);
      push({ title: `صُفّرت نقاط ${resetTarget.displayName}، وستُزامن رتبه تلقائياً.`, tone: "success" });
      setResetTarget(null);
      load(track, page);
    } catch (cause) {
      push({ title: cause instanceof Error ? cause.message : "تعذّر التصفير.", tone: "error" });
    } finally {
      setResetting(false);
    }
  };

  const toggleHidden = async (entry: LeaderboardPage["entries"][number]) => {
    try {
      await api.setMemberLeaderboardHidden(guild.id, entry.userId, !entry.hidden);
      load(track, page);
    } catch (cause) {
      push({ title: cause instanceof Error ? cause.message : "تعذّر التغيير.", tone: "error" });
    }
  };

  const stats = data?.stats;
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / LEADERBOARD_PAGE_SIZE));

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Card>
          <CardContent className="pt-6 text-center">
            <p className="text-2xl font-black">{stats?.highestLevel ?? "—"}</p>
            <p className="text-xs text-muted-foreground">أعلى مستوى</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6 text-center">
            <p className="text-2xl font-black">{stats ? stats.totalXp.toLocaleString("en") : "—"}</p>
            <p className="text-xs text-muted-foreground">إجمالي XP</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6 text-center">
            <p className="text-2xl font-black">{stats?.rankedMembers ?? "—"}</p>
            <p className="text-xs text-muted-foreground">عضو نشط</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <ListOrdered aria-hidden />
            المتصدرين
          </CardTitle>
          <div className="flex items-center gap-2">
            <Select value={track} onValueChange={value => setTrack(value as "text" | "voice")}>
              <SelectTrigger className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="text">المستوى الكتابي</SelectItem>
                <SelectItem value="voice">المستوى الصوتي</SelectItem>
              </SelectContent>
            </Select>
            <Button size="icon" variant="outline" aria-label="تحديث" onClick={() => load(track, page)} disabled={loading}>
              <RefreshCw className={loading ? "animate-spin" : undefined} />
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {error ? (
            <div className="space-y-2">
              <LoadError message={error} />
              <Button size="sm" variant="outline" onClick={() => load(track, page)}>
                إعادة المحاولة
              </Button>
            </div>
          ) : loading && !data ? (
            <LoadingRow />
          ) : (data?.entries.length ?? 0) === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">لا توجد بيانات بعد — النقاط تُجمع تلقائياً مع التفاعل.</p>
          ) : (
            <ol className="divide-y divide-border/80">
              {data?.entries.map((entry, index) => {
                const progress = levelProgress(entry.xp, cap);
                const rank = (page - 1) * LEADERBOARD_PAGE_SIZE + index + 1;
                return (
                  <li
                    key={entry.userId}
                    className={`flex items-center gap-3 py-3 transition-opacity ${entry.hidden ? "opacity-50" : undefined}`}
                  >
                    <span className="w-7 shrink-0 text-center text-sm font-bold text-muted-foreground" dir="ltr">
                      {rank}
                    </span>
                    <Avatar className="size-9">
                      {entry.avatarUrl && <AvatarImage src={entry.avatarUrl} alt="" />}
                      <AvatarFallback>{(entry.displayName ?? "?").slice(0, 1)}</AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5">
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span className="truncate text-sm font-medium">{entry.displayName ?? entry.userId}</span>
                          {entry.hidden && (
                            <Badge variant="outline" className="text-[10px] text-muted-foreground">
                              مخفي من اللوحة
                            </Badge>
                          )}
                        </span>
                        <Badge variant="secondary" dir="ltr">
                          Lv. {progress.level}
                        </Badge>
                      </div>
                      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-primary"
                          style={{ width: `${Math.min(100, progress.percent)}%` }}
                        />
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground" dir="ltr">
                        {entry.xp.toLocaleString("en")} XP · {progress.xpInLevel.toLocaleString("en")} /{" "}
                        {progress.xpForNextLevel.toLocaleString("en")}
                      </p>
                    </div>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button size="icon" variant="ghost" aria-label={`إدارة ${entry.displayName ?? entry.userId}`}>
                          <MoreHorizontal />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          onClick={() =>
                            setXpEditor({
                              userId: entry.userId,
                              displayName: entry.displayName ?? entry.userId,
                              value: String(entry.xp)
                            })
                          }
                        >
                          <Pencil aria-hidden />
                          تعديل الـ XP
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => setResetTarget({ userId: entry.userId, displayName: entry.displayName ?? entry.userId })}>
                          <RotateCcw aria-hidden />
                          إعادة تعيين النقاط
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => void toggleHidden(entry)}>
                          {entry.hidden ? <Eye aria-hidden /> : <EyeOff aria-hidden />}
                          {entry.hidden ? "إظهار في اللوحة" : "حظر من اللوحة"}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </li>
                );
              })}
            </ol>
          )}
          {(data?.total ?? 0) > LEADERBOARD_PAGE_SIZE && (
            <div className="flex items-center justify-between gap-2 pt-3">
              <Button size="sm" variant="outline" disabled={page <= 1 || loading} onClick={() => setPage(p => p - 1)}>
                السابق
              </Button>
              <span className="text-xs text-muted-foreground">
                صفحة {page} من {totalPages} · آخر تحديث {formatWhen(updatedAt)}
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={page >= totalPages || loading}
                onClick={() => setPage(p => p + 1)}
              >
                التالي
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={xpEditor !== null} onOpenChange={open => !open && setXpEditor(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>تعديل نقاط {xpEditor?.displayName}</DialogTitle>
            <DialogDescription>
              يُعدَّل المسار المعروض فقط — المستوى يُشتق من المعادلة نفسها، والمسار الآخر يبقى كما هو.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground" htmlFor="member-xp-value">
              الـ {track === "text" ? "الكتابي" : "الصوتي"} ({xpEditor?.displayName})
            </Label>
            <Input
              id="member-xp-value"
              type="number"
              min={0}
              value={xpEditor?.value ?? ""}
              onChange={event => setXpEditor(state => state && { ...state, value: event.target.value })}
              className="w-32 text-center"
              dir="ltr"
            />
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setXpEditor(null)} disabled={xpSaving}>
              إلغاء
            </Button>
            <Button onClick={() => void saveXp()} loading={xpSaving}>
              حفظ
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={resetTarget !== null} onOpenChange={open => !open && setResetTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>إعادة تعيين نقاط {resetTarget?.displayName}؟</DialogTitle>
            <DialogDescription>
              سيُصفّر الـ XP الكتابي والصوتي معاً، وتُسحب رتب المكافآت التي لم تعد مستحقة في أول مزامنة تلقائية.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setResetTarget(null)} disabled={resetting}>
              إلغاء
            </Button>
            {/* A destructive action that IS the dialog's intent takes the
                destructive variant — the inline-ghost rule is for rows, and
                `loading` keeps the double-click from firing it twice. */}
            <Button variant="destructive" onClick={() => void resetMember()} loading={resetting}>
              إعادة تعيين
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Toaster toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * The screen
 * ------------------------------------------------------------------ */

export function LevelsView({ guild }: { guild: Guild }) {
  const [tab, setTab] = useState<LevelsTab>("settings");
  const [settings, setSettings] = useState<LevelSettings | null>(null);
  const [problems, setProblems] = useState<LevelConfigProblem[]>([]);
  const [roles, setRoles] = useState<DiscordRole[]>([]);
  const [channels, setChannels] = useState<ChannelOption[]>([]);
  const [rewards, setRewards] = useState<LevelRoleReward[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sync, setSync] = useState<LevelSyncJob | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [status, setStatus] = useState<LevelsStatus | null>(null);
  const { saved, draft, dirty, patch, reset, commit } = useDraftForm(settings);
  const { toasts, push, dismiss } = useToasts();

  const loadRewards = useCallback(() => {
    api
      .levelsRewards(guild.id)
      .then(result => setRewards(result.rewards))
      .catch(() => undefined);
  }, [guild.id]);

  const loadStatus = useCallback(() => {
    api
      .levelsStatus(guild.id)
      .then(result => {
        setStatus(result);
        setSync(result.sync);
      })
      .catch(() => undefined);
  }, [guild.id]);

  useEffect(() => {
    let cancelled = false;
    setSettings(null);
    setRewards(null);
    setError(null);
    api
      .levelsSettings(guild.id)
      .then(result => {
        if (cancelled) return;
        setSettings(result.settings);
        setProblems(result.problems ?? []);
        setRoles(result.roles);
        setChannels(result.channels);
      })
      .catch(cause => !cancelled && setError(cause instanceof Error ? cause.message : "تعذّر التحميل."));
    loadRewards();
    loadStatus();
    return () => {
      cancelled = true;
    };
  }, [guild.id, loadRewards, loadStatus]);

  // A running sync is polled at a slow fixed pace and only while it is open —
  // no idle polling, no websocket machinery.
  const syncOpen = sync?.status === "pending" || sync?.status === "running";
  useEffect(() => {
    if (!syncOpen) return;
    const timer = setInterval(loadStatus, SYNC_POLL_MS);
    return () => clearInterval(timer);
  }, [syncOpen, loadStatus]);

  // Unsaved-state hardening: a real dirty draft warns before the tab closes.
  useEffect(() => {
    if (!dirty) return;
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty]);

  const startSync = useCallback(async () => {
    setSyncing(true);
    try {
      const result = await api.startLevelsSync(guild.id);
      setSync(result.job);
      setStatus(current => (current ? { ...current, sync: result.job } : current));
      if (result.job.status === "pending" || result.job.status === "running") {
        push({ title: "المزامنة قيد التنفيذ — يعرض الزر التقدم الحي.", tone: "success" });
      } else {
        push({
          title: `اكتملت المزامنة: منحت ${result.job.granted} وسحبت ${result.job.removed}.`,
          tone: "success"
        });
      }
    } catch (cause) {
      push({ title: cause instanceof Error ? cause.message : "تعذّر إرسال طلب المزامنة.", tone: "error" });
    } finally {
      setSyncing(false);
    }
  }, [guild.id, push]);

  if (error) {
    return <LoadError message={error} />;
  }
  if (!saved || !draft || !rewards) {
    return <LoadingRow />;
  }

  const armed = draft.enabled;
  const cap = effectiveCap(draft.maxLevelCap);

  return (
    <div className="space-y-5">
      {/*
        The unsaved-changes bar lives at the **end** of the screen, floating
        above the content while the screen scrolls. It is *below* an open
        dropdown menu (the menus are portalled at z-50, the bar is at z-40), so
        it never swallows the click that should have chosen an option.
      */}
      {/* The engine's own state and the master switch. The page's title and
          one line of context come from the frame, so this row carries only
          what is *not* already said elsewhere: whether the engine is armed,
          and the technical heartbeat behind the info button. */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
            <Trophy className="size-4" aria-hidden />
          </span>
          <StateBadge enabled={armed} />
          <span className="truncate text-sm text-muted-foreground">
            {armed ? "المحرّك يعمل" : "المحرّك متوقف"}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="icon" variant="ghost" aria-label="حالة المحرّك التقنية">
                <Info className="size-4 text-muted-foreground" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="space-y-1 text-xs">
              <p>آخر نبضة صوتية: {formatWhen(status?.lastVoiceTickAt ?? null)}</p>
              <p>آخر حركة XP: {formatWhen(status?.lastXpWriteAt ?? null)}</p>
              <p>جلسات صوتية نشطة: {status?.voiceSessions ?? "—"}</p>
              {status?.sync?.status === "completed" && (
                <p>
                  آخر مزامنة: {formatWhen(status.sync.completedAt)} (منحت {status.sync.granted}، سحبت{" "}
                  {status.sync.removed})
                </p>
              )}
            </TooltipContent>
          </Tooltip>
          <Switch
            checked={draft.enabled}
            aria-label="تفعيل نظام المستويات"
            onCheckedChange={enabled => patch({ enabled })}
          />
        </div>
      </div>

      {armed && (
      <>
      {/* Segmented navigation: one pill strip, active tab in primary. */}
      <nav
        role="tablist"
        aria-label="أقسام نظام المستويات"
        className="scrollbar-none inline-flex max-w-full flex-wrap items-center gap-1 rounded-2xl border border-border/80 bg-card/70 p-1.5 backdrop-blur-md"
      >
        {levelTabs.map(entry => {
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

      {tab === "settings" && <SettingsTab draft={draft} patch={patch} roles={roles} channels={channels} />}
      {tab === "multipliers" && <MultipliersTab draft={draft} patch={patch} roles={roles} channels={channels} />}
      {(tab === "text" || tab === "voice" || tab === "dual") && (
        <RewardRulesTab
          key={tab}
          guild={guild}
          kind={tabKey(tab)}
          rewards={rewards}
          roles={roles}
          problems={problems}
          stacking={draft.roleStacking}
          onStackingChange={roleStacking => patch({ roleStacking })}
          cap={cap}
          sync={sync}
          syncing={syncing}
          onSync={() => void startSync()}
          onChanged={loadRewards}
        />
      )}
      {tab === "leaderboard" && <LeaderboardTab guild={guild} cap={cap} />}
      </>)}

      <Toaster toasts={toasts} onDismiss={dismiss} />

      {dirty && (
        <SaveBar
          message="لديك تعديلات غير محفوظة على النظام"
          saveLabel="حفظ التعديلات"
          cancelLabel="إلغاء"
          onCancel={reset}
          onSave={async () => {
            const result = await api.saveLevelsSettings(guild.id, draft);
            commit(result.settings);
            push({ title: "حُفظت إعدادات المستويات.", tone: "success" });
          }}
        />
      )}
    </div>
  );
}
