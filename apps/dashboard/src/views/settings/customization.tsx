import { useEffect, useState } from "react";
import { Check, CircleHelp, ImageOff, Info, Loader2, Lock, Palette, RotateCcw, ShieldCheck, TriangleAlert, X } from "lucide-react";
import { DEFAULT_CUSTOMIZATION, MAX_NICKNAME_LENGTH } from "@al-ai/core/browser";
import { api } from "@/api";
import { SaveBar } from "@/components/save-bar";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { CustomizationSettings, Guild, PermissionStatus, RoleHierarchyVerdict, RoleIconGate } from "@/types";

/**
 * Per-guild bot identity.
 *
 * This screen only offers what the bot can actually apply in a single guild.
 * Discord gives an application one global avatar and banner, so a "per-server
 * avatar" field would be a control that saves successfully and changes nothing —
 * exactly the kind of fake setting this project treats as a bug. What remains is
 * real: the nickname, and the colour and icon of the AL AI role.
 *
 * The bot picks these up on its sync tick, so a save here is never immediate.
 */
export function CustomizationView({ guild }: { guild: Guild }) {
  const [saved, setSaved] = useState<CustomizationSettings | null>(null);
  const [draft, setDraft] = useState<CustomizationSettings | null>(null);
  const [permissions, setPermissions] = useState<PermissionStatus[]>([]);
  const [hierarchy, setHierarchy] = useState<RoleHierarchyVerdict | null>(null);
  const [roleIcon, setRoleIcon] = useState<RoleIconGate | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSaved(null);
    setDraft(null);
    setHierarchy(null);
    setRoleIcon(null);
    setError(null);
    api
      .customization(guild.id)
      .then(result => {
        if (cancelled) return;
        setSaved(result.settings);
        setDraft(result.settings);
        setPermissions(result.permissions);
        setHierarchy(result.hierarchy);
        setRoleIcon(result.roleIcon);
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
  if (!saved || !draft) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        جارٍ التحميل
      </div>
    );
  }

  const dirty = JSON.stringify(saved) !== JSON.stringify(draft);
  const nicknamePermission = permissions.find(item => item.key === "change_nickname");
  // Only a *known* absence blocks the save. `granted` is null when the permission
  // read failed, and treating that as a refusal would disable Save for every
  // guild whenever Discord had a hiccup.
  const canSave = guild.canManageIdentity && nicknamePermission?.granted !== false && draft.nickname.length <= MAX_NICKNAME_LENGTH;
  // Every permission unknown means the read itself failed, not that the bot is
  // missing everything — say so once, above the list, instead of six times in it.
  const permissionsUnreadable = permissions.length > 0 && permissions.every(permission => permission.granted === null);
  const patch = (next: Partial<CustomizationSettings>) => setDraft({ ...draft, ...next });

  return (
    <div className="space-y-4">
      <BotIdentityPreview guild={guild} settings={draft} />

      <HierarchyWarning verdict={hierarchy} />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="size-4" />
            الصلاحيات المطلوبة
          </CardTitle>
          <CardDescription>هذه الصلاحيات تأتي مع رتبة AL AI التي ينشئها البوت عند دخوله.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {permissions.length === 0 || permissionsUnreadable ? (
            <p className="text-xs text-muted-foreground">
              تعذّر قراءة صلاحيات البوت. أعد إضافة AL AI بصلاحيات Administrator ليتمكن من تعديل هويته.
            </p>
          ) : (
            permissions.map(permission => (
              <div key={permission.key} className="flex items-center justify-between gap-3 text-sm">
                <span className="text-muted-foreground">{permission.label}</span>
                {permission.granted === true ? (
                  <Badge variant="secondary" className="gap-1">
                    <Check className="size-3" />
                    متاحة
                  </Badge>
                ) : permission.granted === false ? (
                  <Badge variant="destructive" className="gap-1">
                    <X className="size-3" />
                    مفقودة
                  </Badge>
                ) : (
                  <Badge variant="outline" className="gap-1">
                    <CircleHelp className="size-3" />
                    غير معروفة
                  </Badge>
                )}
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div className="space-y-1">
            <CardTitle className="text-base">هوية البوت في هذا السيرفر</CardTitle>
            <CardDescription>تنطبق على هذا السيرفر وحده، ولا تؤثر على باقي السيرفرات.</CardDescription>
          </div>
          <Badge variant={canSave ? "secondary" : "destructive"}>{canSave ? "جاهز" : "الحفظ معطّل"}</Badge>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="nickname">الاسم المستعار</Label>
            <Input
              id="nickname"
              value={draft.nickname}
              maxLength={MAX_NICKNAME_LENGTH}
              placeholder={DEFAULT_CUSTOMIZATION.nickname}
              onChange={event => patch({ nickname: event.target.value })}
            />
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">
                اتركه فارغاً ليظهر البوت باسمه الأصلي <span dir="ltr">{DEFAULT_CUSTOMIZATION.nickname}</span>.
              </p>
              <p className="tabular text-xs text-muted-foreground">
                {draft.nickname.length} / {MAX_NICKNAME_LENGTH}
              </p>
            </div>
          </div>

          <Separator />

          <div className="space-y-2">
            <Label htmlFor="role-color">لون رتبة AL AI</Label>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                id="role-color"
                type="color"
                className="h-9 w-14 shrink-0 p-1"
                aria-label="اختيار لون الرتبة"
                value={draft.roleColor ?? "#3b82f6"}
                onChange={event => patch({ roleColor: event.target.value })}
              />
              <Input
                dir="ltr"
                className="w-32"
                placeholder="#3b82f6"
                aria-label="قيمة لون الرتبة"
                value={draft.roleColor ?? ""}
                onChange={event => patch({ roleColor: event.target.value.trim() || null })}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={draft.roleColor === null}
                onClick={() => patch({ roleColor: null })}
              >
                <RotateCcw />
                اللون الافتراضي
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              يظهر اللون على رتبة البوت في قائمة الأعضاء. القيمة الفارغة تعيد لون Discord الافتراضي.
            </p>
          </div>

          <Separator />

          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Label htmlFor="role-icon">أيقونة الرتبة</Label>
              {roleIcon?.locked && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex cursor-help items-center gap-1 rounded-md bg-warning/15 px-2 py-0.5 text-xs text-warning">
                      <Lock className="size-3" />
                      مقفلة
                    </span>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs text-right leading-relaxed">{roleIcon.reason}</TooltipContent>
                </Tooltip>
              )}
            </div>
            <Input
              id="role-icon"
              dir="ltr"
              placeholder="https://…/icon.png"
              value={draft.roleIconUrl ?? ""}
              disabled={roleIcon?.locked}
              onChange={event => patch({ roleIconUrl: event.target.value.trim() || null })}
            />
            {roleIcon?.locked ? (
              <p className="flex items-start gap-1.5 text-xs leading-relaxed text-warning">
                <Lock className="mt-0.5 size-3.5 shrink-0" />
                {roleIcon.reason}
              </p>
            ) : (
              <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                <Info className="mt-0.5 size-3.5 shrink-0" />
                رابط HTTPS لصورة مربعة. لأن صورة حساب البوت عامة لكل السيرفرات، فإن الصورة الخاصة بكل سيرفر تظهر على
                رتبة AL AI بدلاً من الحساب.
                {roleIcon?.unknown && " تعذّر قراءة مستوى تعزيز السيرفر الآن، وسيتحقق البوت عند التطبيق."}
              </p>
            )}
          </div>

          <Alert>
            <Info />
            <AlertDescription>
              يُطبّق البوت هذه التغييرات خلال دقيقة من الحفظ. إن لم تظهر، تأكّد من أن رتبة AL AI أعلى من الرتب التي
              يحاول تعديلها.
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>

      {dirty && (
        <SaveBar
          onCancel={() => setDraft(saved)}
          onSave={async () => {
            const result = await api.saveCustomization(guild.id, draft);
            setSaved(result.settings);
            setDraft(result.settings);
          }}
        />
      )}
    </div>
  );
}

/**
 * The advisory shown when the bot's own role sits at or below a role it is
 * expected to manage.
 *
 * This is the single most common reason a correctly configured bot silently
 * does nothing, and Discord reports it only as a failed API call. Saying it on
 * the screen turns an unexplained no-op into a fixable problem.
 *
 * Exported for its render test: a null verdict (roles unreadable) and a passing
 * verdict both render nothing, so the test can prove the warning is not shown
 * speculatively.
 */
export function HierarchyWarning({ verdict }: { verdict: RoleHierarchyVerdict | null }) {
  if (!verdict?.blocked) return null;
  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-warning/40 bg-warning/10 p-3">
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
      <div className="space-y-1">
        <p className="text-sm font-medium">ترتيب الرتب يمنع البوت من العمل</p>
        <p className="text-xs leading-relaxed text-muted-foreground">{verdict.message}</p>
        <p className="text-xs leading-relaxed text-muted-foreground">
          افتح إعدادات السيرفر ← الرتب، واسحب رتبة AL AI إلى ما فوق أعلى رتبة إدارية.
        </p>
      </div>
    </div>
  );
}

/**
 * A live mock of the guild member list row, so the operator sees the nickname and
 * role colour together instead of having to imagine them.
 */
function BotIdentityPreview({ guild, settings }: { guild: Guild; settings: CustomizationSettings }) {
  const nickname = settings.nickname || DEFAULT_CUSTOMIZATION.nickname;
  const color = settings.roleColor ?? "#6b7280";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Palette className="size-4" />
          معاينة
        </CardTitle>
        <CardDescription>هكذا سيظهر AL AI في قائمة أعضاء {guild.name}.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/40 p-3">
          <span
            className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-full text-xs font-semibold text-white"
            style={{ backgroundColor: color }}
          >
            {settings.roleIconUrl ? (
              // A broken URL is common while typing, so a plain img with a fallback
              // beats a component that would render an empty box.
              <img src={settings.roleIconUrl} alt="" className="size-full object-cover" />
            ) : (
              "AI"
            )}
          </span>
          <div className="min-w-0">
            <p className="flex items-center gap-2 truncate text-sm font-medium">
              {nickname}
              <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {settings.roleIconUrl ? "أيقونة الرتبة مفعّلة" : "بدون أيقونة رتبة"}
              {settings.roleColor ? ` · ${settings.roleColor}` : " · لون Discord الافتراضي"}
            </p>
          </div>
          {!settings.roleIconUrl && <ImageOff className="ms-auto size-4 shrink-0 text-muted-foreground" />}
        </div>
      </CardContent>
    </Card>
  );
}
