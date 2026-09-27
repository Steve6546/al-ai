import { useEffect, useState } from "react";
import { Shield } from "lucide-react";
import { api } from "@/api";
import { useDraftForm } from "@/lib/use-draft-form";
import { LoadError, LoadingRow } from "@/components/view-states";
import { SaveBar } from "@/components/save-bar";
import { Toaster, useToasts } from "@/components/toaster";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { DiscordRole, Guild, WelcomeSettings } from "@/types";

/** The picker value that means "no role for this kind of arrival". */
const NONE = "__none__";

/**
 * The welcome screen: an auto-role for arriving members and a different one for
 * arriving bots.
 *
 * The role lists come from the server already filtered to what the bot can
 * actually grant — real, not integration-managed, and below its own highest
 * position, which is Discord's hard ceiling on any role grant. The bot repeats
 * the hierarchy check at assign time because ranks move after a save; what the
 * filter buys is that the operator is never *offered* a setting that cannot
 * work.
 */
export function WelcomeView({ guild }: { guild: Guild }) {
  const [settings, setSettings] = useState<WelcomeSettings | null>(null);
  const [roles, setRoles] = useState<DiscordRole[]>([]);
  const [error, setError] = useState<string | null>(null);
  const { saved, draft, dirty, patch, reset, commit } = useDraftForm(settings);
  const { toasts, push, dismiss } = useToasts();

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

  const rolePicker = (label: string, value: string | null, hint: string, onChange: (roleId: string | null) => void) => (
    <div className="space-y-2">
      <Label>{label}</Label>
      <Select value={value ?? NONE} onValueChange={selected => onChange(selected === NONE ? null : selected)}>
        <SelectTrigger>
          <SelectValue placeholder={label.includes("البوتات") ? "بدون رتبة" : "اختر رتب..."} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>{label.includes("البوتات") ? "بدون رتبة" : "بدون رتبة"}</SelectItem>
          {roles.map(role => (
            <SelectItem key={role.id} value={role.id}>
              {role.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div className="flex items-center gap-3">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-amber-500/15 text-amber-400">
              <Shield className="size-5" aria-hidden />
            </span>
            <div>
              <p className="text-base font-bold">رتبة تلقائية</p>
              <p className="text-xs text-muted-foreground">{draft.enabled ? "مفعل" : "معطل"}</p>
            </div>
          </div>
          <Switch checked={draft.enabled} aria-label="تفعيل الرتبة التلقائية" onCheckedChange={enabled => patch({ enabled })} />
        </CardHeader>

        <CardContent className="space-y-5">
          {rolePicker(
            "رتبة الأعضاء الجدد",
            draft.memberRoleId,
            "الرتبة التي تُعطى للأعضاء الجدد عند الانضمام.",
            memberRoleId => patch({ memberRoleId })
          )}
          {rolePicker(
            "رتبة البوتات الجديدة",
            draft.botRoleId,
            "الرتبة التي تُعطى للبوتات عند إضافتها للسيرفر.",
            botRoleId => patch({ botRoleId })
          )}
          <p className="text-xs text-muted-foreground">
            تُمنح الرتبة فقط إذا كانت تحت أعلى رتبة للبوت — ديسكورد يرفض ما فوقها، والبوت يعيد الفحص عند الانضمام.
          </p>
        </CardContent>
      </Card>

      {dirty && (
        <SaveBar
          onCancel={reset}
          onSave={async () => {
            const result = await api.saveWelcome(guild.id, draft);
            commit(result.settings);
          }}
        />
      )}

      <Toaster toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
