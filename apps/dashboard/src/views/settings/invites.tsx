import { useEffect, useState } from "react";
import { Info, Link2, Plus, Trash2, Users } from "lucide-react";
import { api } from "@/api";
import { useDraftForm } from "@/lib/use-draft-form";
import { LoadError, LoadingRow } from "@/components/view-states";
import { SaveBar } from "@/components/save-bar";
import { Toaster, useToasts } from "@/components/toaster";
import { StateBadge } from "@/components/state-badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { INVITE_MESSAGE_TOKENS, MAX_FAKE_ACCOUNT_DAYS, normaliseInviteMilestones } from "@al-ai/core/browser";
import type { DiscordRole, Guild, InviteMilestone, InviteSettings } from "@/types";

const NONE_ROLE = "__none__";

/**
 * The invites module's settings screen.
 *
 * One screen, three cards: the scoring policy (what counts and what logs), the
 * milestone ladder, and the log templates. The draft/save machinery is the
 * shared `useDraftForm` hook — the same unsaved-changes bar every other
 * settings screen carries, never a second copy of it.
 */
export function InvitesView({ guild }: { guild: Guild }) {
  const [settings, setSettings] = useState<InviteSettings | null>(null);
  const [problems, setProblems] = useState<{ code: string; message: string }[]>([]);
  const [roles, setRoles] = useState<DiscordRole[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [newMilestone, setNewMilestone] = useState<{ net: string; roleId: string }>({ net: "", roleId: NONE_ROLE });
  const { draft, dirty, patch, reset, commit } = useDraftForm(settings);
  const { toasts, push, dismiss } = useToasts();

  useEffect(() => {
    let cancelled = false;
    setSettings(null);
    setError(null);
    api
      .invitesSettings(guild.id)
      .then(result => {
        if (cancelled) return;
        setSettings(result.settings);
        setProblems(result.problems ?? []);
        setRoles(result.roles);
      })
      .catch(cause => !cancelled && setError(cause instanceof Error ? cause.message : "تعذّر التحميل."));
    return () => {
      cancelled = true;
    };
  }, [guild.id]);

  if (error) return <LoadError message={error} />;
  if (!settings || !draft) return <LoadingRow />;

  const addMilestone = () => {
    const net = Number(newMilestone.net);
    if (!Number.isInteger(net) || net < 1) {
      push({ title: "حدّد عتبة صحيحة (رقم موجب).", tone: "error" });
      return;
    }
    if (newMilestone.roleId === NONE_ROLE) {
      push({ title: "اختر رتبة القاعدة قبل الإضافة.", tone: "error" });
      return;
    }
    const next = normaliseInviteMilestones([...draft.milestoneRoles, { id: `ms-${Date.now()}`, net, roleId: newMilestone.roleId }]);
    if (next.length === draft.milestoneRoles.length) {
      push({ title: "هذه القاعدة مكررة — رتبة واحدة وعتبة واحدة لا تُضاف مرتين.", tone: "error" });
      return;
    }
    patch({ milestoneRoles: next });
    setNewMilestone({ net: "", roleId: NONE_ROLE });
  };

  const removeMilestone = (milestone: InviteMilestone) => {
    patch({ milestoneRoles: draft.milestoneRoles.filter(rule => rule.id !== milestone.id || rule.roleId !== milestone.roleId) });
  };

  const roleName = (roleId: string) => roles.find(role => role.id === roleId)?.name ?? "رتبة غير معروفة";

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-semibold">
            <Link2 className="size-5" /> الإحالات والدعوات
          </h1>
          <p className="text-xs text-muted-foreground">
            تتبّع من دعا من عند دخول الأعضاء وخروجهم، عدّاد لكل داعٍ، ورتب إنجاز تلقائية — بجانب نظام السجلات.
          </p>
        </div>
        <StateBadge enabled={draft.enabled} enabledLabel="مفعّل" disabledLabel="معطّل" />
      </div>

      {problems.length > 0 && (
        <Alert>
          <Info className="size-4" />
          <AlertDescription>
            <ul className="list-inside list-disc space-y-1">
              {problems.map(problem => (
                <li key={problem.code + problem.message}>{problem.message}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      {/* The hero row carries the one switch that decides whether the rest of
          the screen exists. Off, the policy/milestones/templates cards are
          hidden — not dimmed — the same contract the welcome screen keeps: a
          disabled-looking form implies its saves mean something, and they
          would not. The values stay stored; nothing is wiped by hiding. */}
      <Card>
        <div className="flex flex-row items-center justify-between gap-3 p-6">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-primary/15 text-primary">
              <Link2 className="size-5" aria-hidden />
            </span>
            <div className="min-w-0">
              <CardTitle className="truncate text-base">موديول الإحالات</CardTitle>
              <p className="text-xs text-muted-foreground">
                عند دخول عضو يقارن البوت قائمة الدعوات باللقطة السابقة ليعرف الرابط المستخدم وصاحبه.
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <StateBadge enabled={draft.enabled} enabledLabel="مفعّل" disabledLabel="معطّل" />
            <Switch checked={draft.enabled} onCheckedChange={enabled => patch({ enabled })} aria-label="تفعيل موديول الإحالات" />
          </div>
        </div>
      </Card>

      {draft.enabled ? (
        <>
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">آلية التتبع</CardTitle>
          <CardDescription>
            الرابط المخصص (Vanity) يُرصد لكنه لا يمنح نقطة لأحد، والدعوة الذاتية لا تحسب مهما كانت إعدادات السجل.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-xs">عتبة الحساب الوهمي (أيام)</Label>
              <Input
                type="number"
                min={0}
                max={MAX_FAKE_ACCOUNT_DAYS}
                value={draft.fakeAccountDays}
                onChange={event => patch({ fakeAccountDays: Number(event.target.value) })}
              />
              <p className="text-[10px] text-muted-foreground">
                حساب أصغر من هذا العمر يُسجَّل «وهمياً» ولا يُحسب في الصافي. 0 = لا يُعد أي حساب وهمياً.
              </p>
            </div>
            <div className="grid grid-cols-1 gap-2 self-end">
              <label className="flex items-center justify-between gap-2 rounded-lg border border-border/80 px-3 py-1.5">
                <span className="text-xs">إبقاء رتب الإنجاز عند انخفاض الصافي</span>
                <Switch checked={draft.keepRolesOnLeave} onCheckedChange={keepRolesOnLeave => patch({ keepRolesOnLeave })} />
              </label>
              <label className="flex items-center justify-between gap-2 rounded-lg border border-border/80 px-3 py-1.5">
                <span className="text-xs">تسجيل محاولات الدعوة الذاتية</span>
                <Switch checked={draft.logSelfInvites} onCheckedChange={logSelfInvites => patch({ logSelfInvites })} />
              </label>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <label className="flex items-center justify-between gap-2 rounded-lg border border-border/80 px-3 py-1.5">
              <span className="text-xs">سجل الدخول</span>
              <Switch checked={draft.logJoins} onCheckedChange={logJoins => patch({ logJoins })} />
            </label>
            <label className="flex items-center justify-between gap-2 rounded-lg border border-border/80 px-3 py-1.5">
              <span className="text-xs">سجل الخروج والخصم</span>
              <Switch checked={draft.logLeaves} onCheckedChange={logLeaves => patch({ logLeaves })} />
            </label>
            <label className="flex items-center justify-between gap-2 rounded-lg border border-border/80 px-3 py-1.5">
              <span className="text-xs">سجل رتب الإنجاز</span>
              <Switch checked={draft.logMilestones} onCheckedChange={logMilestones => patch({ logMilestones })} />
            </label>
          </div>
          <p className="text-[10px] text-muted-foreground">
            تُرسل السجلات إلى قناة «الدعوات» المضبوطة في شاشة السجلات، مع ربط لكل سجل على حدة كما في باقي الأقسام.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Users className="size-4" /> رتب الإنجاز (Milestones)
          </CardTitle>
          <CardDescription>
            رتب تُمنح تلقائياً عندما يبلغ صافي إحالات الداعي العتبة، وتُسحب إن نزل عنها — إلا إذا اخترت إبقاءها أعلاه.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {draft.milestoneRoles.length === 0 && (
            <p className="rounded-lg border border-dashed border-border/80 px-3 py-4 text-center text-xs text-muted-foreground">
              لا توجد قواعد بعد. أضف أول عتبة — مثلاً 5 إحالات لرتبة «داعي نشط».
            </p>
          )}
          {draft.milestoneRoles.length > 0 && (
            <ul className="space-y-1.5">
              {draft.milestoneRoles.map(milestone => (
                <li
                  key={`${milestone.id}:${milestone.roleId}`}
                  className="flex items-center justify-between gap-2 rounded-lg border border-border/80 px-3 py-1.5"
                >
                  <span className="text-xs">
                    <span className="font-semibold">{milestone.net}</span> إحالة صافية ← رتبة{" "}
                    <span className="font-semibold">{roleName(milestone.roleId)}</span>
                  </span>
                  <Button variant="ghost" size="icon" className="size-7" onClick={() => removeMilestone(milestone)} aria-label="حذف القاعدة">
                    <Trash2 className="size-3.5" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap items-end gap-2">
            <div className="w-28 space-y-1">
              <Label className="text-xs">العتبة</Label>
              <Input
                type="number"
                min={1}
                placeholder="مثال: 5"
                value={newMilestone.net}
                onChange={event => setNewMilestone(current => ({ ...current, net: event.target.value }))}
              />
            </div>
            <div className="min-w-52 flex-1 space-y-1">
              <Label className="text-xs">الرتبة</Label>
              <Select
                value={newMilestone.roleId}
                onValueChange={roleId => setNewMilestone(current => ({ ...current, roleId }))}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="اختر رتبة" />
                </SelectTrigger>
                <SelectContent>
                  {roles.map(role => (
                    <SelectItem key={role.id} value={role.id}>
                      {role.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button type="button" size="sm" onClick={addMilestone}>
              <Plus className="size-3.5" /> إضافة
            </Button>
          </div>
          {roles.length === 0 && (
            <p className="text-[10px] text-muted-foreground">
              لا تظهر أي رتب هنا — تأكد أن البوت يعمل وأن رتباً قابلة للمنح موجودة أسفل رتبة البوت.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">قوالب السجلات</CardTitle>
          <CardDescription>
            نصوص سجلات الدخول والخروج ورتب الإنجاز. اضغط متغيراً لإدراجه، أو اكتبه يدوياً — المتغيرات غير المعروفة تبقى
            كما كتبتها.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-1.5">
            {INVITE_MESSAGE_TOKENS.map(token => (
              <span key={token} className="rounded-md border border-border/80 bg-muted/40 px-2 py-0.5 font-mono text-[10px]">
                {token}
              </span>
            ))}
          </div>
          {(
            [
              { key: "joinMessage", label: "قالب سجل الدخول", rows: 4 },
              { key: "leaveMessage", label: "قالب سجل الخروج والخصم", rows: 3 },
              { key: "milestoneMessage", label: "قالب سجل رتبة الإنجاز", rows: 2 }
            ] as const
          ).map(field => (
            <div key={field.key} className="space-y-1.5">
              <Label className="text-xs">{field.label}</Label>
              <Textarea
                rows={field.rows}
                value={draft[field.key]}
                onChange={event => patch({ [field.key]: event.target.value })}
                className="text-xs"
              />
            </div>
          ))}
        </CardContent>
      </Card>
        </>
      ) : (
        <Alert>
          <Info aria-hidden />
          <AlertDescription>
            موديول الإحالات <strong>معطّل</strong> — فعّله من المفتاح أعلى الصفحة لتظهر سياسة التتبع ورتب الإنجاز
            والقوالب. القيم المحفوظة لا تُمسّ بالإخفاء.
          </AlertDescription>
        </Alert>
      )}

      {dirty && (
        <SaveBar
          message="لديك تعديلات غير محفوظة على موديول الإحالات"
          saveLabel="حفظ التعديلات"
          cancelLabel="إلغاء"
          onCancel={reset}
          onSave={async () => {
            const result = await api.saveInvitesSettings(guild.id, draft);
            commit(result.settings);
            push({ title: "حُفظت إعدادات الإحالات — تُطبَّق على البوت خلال نصف دقيقة.", tone: "success" });
          }}
        />
      )}

      <Toaster toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
