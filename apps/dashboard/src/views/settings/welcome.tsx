import { useEffect, useState } from "react";
import { Shield } from "lucide-react";
import { api } from "@/api";
import { useDraftForm } from "@/lib/use-draft-form";
import { LoadError, LoadingRow } from "@/components/view-states";
import { ModuleStatusCard } from "@/components/module-status-card";
import { RoleSwatch } from "@/components/role-swatch";
import { SaveBar } from "@/components/save-bar";
import { Toaster, useToasts } from "@/components/toaster";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { DiscordRole, Guild, WelcomeSettings } from "@/types";

/** The picker value that means "no role for this kind of arrival". */
const NONE = "__none__";

/**
 * The welcome screen: an auto-role for arriving members and a different one for
 * arriving bots.
 *
 * This screen keeps HeroUI v3 for its surfaces (`data-heroui` scope: the Card
 * and the Switch), but its two pickers are the dashboard's own Radix `Select`.
 * The reason is measurable, not stylistic: HeroUI's trigger ships with no border
 * and a surface one point of lightness away from the card it sits on — 24,24,27
 * on 23,23,26 — so the control vanished into the card and the operator could not
 * see where to press. The app's `SelectTrigger` is the field surface every other
 * picker in the dashboard already uses.
 *
 * The role lists come from the server already filtered to
 * what the bot can actually grant — real, not integration-managed, and below
 * its own highest position, which is Discord's hard ceiling on any role grant.
 * The bot repeats the hierarchy check at assign time because ranks move after a
 * save; what the filter buys is that the operator is never *offered* a setting
 * that cannot work.
 */
export function WelcomeView({ guild }: { guild: Guild }) {
  const [settings, setSettings] = useState<WelcomeSettings | null>(null);
  const [roles, setRoles] = useState<DiscordRole[]>([]);
  const [error, setError] = useState<string | null>(null);
  const { saved, draft, dirty, patch, reset, commit } = useDraftForm(settings);
  const { toasts, dismiss } = useToasts();

  useEffect(() => {
    let cancelled = false;
    setSettings(null);
    setError(null);
    api
      .welcome(guild.id)
      .then(result => {
        if (cancelled) return;
        setSettings(result.settings);
        setRoles(result.roles);
      })
      .catch(cause => !cancelled && setError(cause instanceof Error ? cause.message : "تعذّر التحميل."));
    return () => {
      cancelled = true;
    };
  }, [guild.id]);

  if (error) {
    return <LoadError message={error} />;
  }
  if (!saved || !draft) {
    return <LoadingRow />;
  }

  /**
   * One role row. The colour dot rides *beside* the label rather than inside it:
   * the trigger clones the label as its own text, and a dot in there would be
   * read out as part of the name.
   */
  const roleOption = (role: DiscordRole) => (
    <SelectItem key={role.id} value={role.id} hint={<RoleSwatch color={role.color} />}>
      {role.name}
    </SelectItem>
  );

  return (
    <div data-heroui className="space-y-4">
      <ModuleStatusCard
        icon={Shield}
        title="منح الرتب تلقائياً"
        description="تُمنح عند الانضمام."
        enabled={draft.enabled}
        onToggle={enabled => patch({ enabled })}
        toggleLabel="تفعيل الرتبة التلقائية"
        disabledHint="الوحدة متوقفة. فعّلها لبدء منح الرتب — إعداداتك المحفوظة تبقى كما هي."
        enableLabel="تفعيل الوحدة"
      />

      {draft.enabled ? (
        <>
          {/* Two facing cards: one per kind of arrival. */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="flex flex-col">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">رتبة العضو الجديد</CardTitle>
            <CardDescription>تُمنح عند انضمام عضو.</CardDescription>
          </CardHeader>
          <CardContent className="flex-1 space-y-1.5">
            <Label className="text-xs text-muted-foreground" htmlFor="welcome-member-role">
              الرتبة
            </Label>
            <Select
              value={draft.memberRoleId ?? NONE}
              onValueChange={value => patch({ memberRoleId: value === NONE ? null : value })}
            >
              <SelectTrigger id="welcome-member-role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>بدون رتبة</SelectItem>
                {roles.map(role => roleOption(role))}
              </SelectContent>
            </Select>
          </CardContent>
        </Card>

        <Card className="flex flex-col">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">رتبة البوت الجديد</CardTitle>
            <CardDescription>تُمنح عند إضافة بوت.</CardDescription>
          </CardHeader>
          <CardContent className="flex-1 space-y-1.5">
            <Label className="text-xs text-muted-foreground" htmlFor="welcome-bot-role">
              الرتبة
            </Label>
            <Select
              value={draft.botRoleId ?? NONE}
              onValueChange={value => patch({ botRoleId: value === NONE ? null : value })}
            >
              <SelectTrigger id="welcome-bot-role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>بدون رتبة</SelectItem>
                {roles.map(role => roleOption(role))}
              </SelectContent>
            </Select>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">التوقيت</CardTitle>
          <CardDescription>0 يعني فوراً؛ والتأخير يمنح العضو وقتاً للاستقرار.</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground" htmlFor="welcome-delay">
              التأخير بالثواني
            </Label>
            <div className="flex items-center gap-2" dir="ltr">
              <Input
                id="welcome-delay"
                type="number"
                min={0}
                max={3600}
                value={draft.delaySeconds}
                onChange={event => patch({ delaySeconds: Number(event.target.value) })}
                className="w-28 text-center"
              />
              <Badge variant="secondary">ثانية</Badge>
            </div>
          </div>
        </CardContent>
      </Card>

          <p className="text-xs text-muted-foreground">
            الرتب فوق رتبة البوت لا يمكن منحها — يتحقق البوت عند كل انضمام.
          </p>
        </>
      ) : null}


      <Toaster toasts={toasts} onDismiss={dismiss} />

      {dirty && (
        <SaveBar
          message="تغييرات غير محفوظة"
          saveLabel="حفظ التعديلات"
          cancelLabel="إلغاء"
          onCancel={reset}
          onSave={async () => {
            const result = await api.saveWelcome(guild.id, draft);
            commit(result.settings);
          }}
        />
      )}
    </div>
  );
}
