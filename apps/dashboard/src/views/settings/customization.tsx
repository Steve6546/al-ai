import { useEffect, useState } from "react";
import { Check, ImageOff, Info, Loader2, Palette, RotateCcw, ShieldCheck, X } from "lucide-react";
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
import type { CustomizationSettings, Guild, PermissionStatus } from "@/types";

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
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSaved(null);
    setDraft(null);
    setError(null);
    api
      .customization(guild.id)
      .then(result => {
        if (cancelled) return;
        setSaved(result.settings);
        setDraft(result.settings);
        setPermissions(result.permissions);
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
  const canSave = guild.canManageIdentity && (nicknamePermission?.granted ?? true) && draft.nickname.length <= MAX_NICKNAME_LENGTH;
  const patch = (next: Partial<CustomizationSettings>) => setDraft({ ...draft, ...next });

  return (
    <div className="space-y-4">
      <BotIdentityPreview guild={guild} settings={draft} />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="size-4" />
            الصلاحيات المطلوبة
          </CardTitle>
          <CardDescription>هذه الصلاحيات تأتي مع رتبة AL AI التي ينشئها البوت عند دخوله.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {permissions.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              تعذّر قراءة صلاحيات البوت. أعد إضافة AL AI بصلاحيات Administrator ليتمكن من تعديل هويته.
            </p>
          ) : (
            permissions.map(permission => (
              <div key={permission.key} className="flex items-center justify-between gap-3 text-sm">
                <span className="text-muted-foreground">{permission.label}</span>
                {permission.granted ? (
                  <Badge variant="secondary" className="gap-1">
                    <Check className="size-3" />
                    متاحة
                  </Badge>
                ) : (
                  <Badge variant="destructive" className="gap-1">
                    <X className="size-3" />
                    مفقودة
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
            <Label htmlFor="role-icon">أيقونة الرتبة</Label>
            <Input
              id="role-icon"
              dir="ltr"
              placeholder="https://…/icon.png"
              value={draft.roleIconUrl ?? ""}
              onChange={event => patch({ roleIconUrl: event.target.value.trim() || null })}
            />
            <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
              <Info className="mt-0.5 size-3.5 shrink-0" />
              رابط HTTPS لصورة مربعة. لأن صورة حساب البوت عامة لكل السيرفرات، فإن الصورة الخاصة بكل سيرفر تظهر على
              رتبة AL AI بدلاً من الحساب.
            </p>
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
