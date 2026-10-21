import { useEffect, useState } from "react";
import { Shield } from "lucide-react";
import { Card as HeroCard, ListBox, Select, Switch } from "@heroui/react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { api } from "@/api";
import { useDraftForm } from "@/lib/use-draft-form";
import { LoadError, LoadingRow } from "@/components/view-states";
import { SaveBar } from "@/components/save-bar";
import { Toaster, useToasts } from "@/components/toaster";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StateBadge } from "@/components/state-badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { DiscordRole, Guild, WelcomeSettings } from "@/types";

/** The picker value that means "no role for this kind of arrival". */
const NONE = "__none__";

/**
 * The welcome screen: an auto-role for arriving members and a different one for
 * arriving bots.
 *
 * This is the first screen migrated to HeroUI v3 (`data-heroui` scope). The
 * HeroUI pieces (Card, Switch, Select) live beside the dashboard's own SaveBar
 * and role list, and the role lists come from the server already filtered to
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

  const roleItem = (role: DiscordRole) => (
    <ListBox.Item key={role.id} id={role.id} textValue={role.name}>
      <span className="flex w-full items-center gap-2">
        <span
          aria-hidden
          className="size-2.5 shrink-0 rounded-full border border-border"
          style={{ background: role.color ? `#${role.color.toString(16).padStart(6, "0")}` : undefined }}
        />
        {role.name}
      </span>
      <ListBox.ItemIndicator />
    </ListBox.Item>
  );

  return (
    <div data-heroui className="space-y-4">
      {dirty && (
        <SaveBar
          message="لديك تعديلات غير محفوظة"
          saveLabel="حفظ التعديلات"
          cancelLabel="إلغاء"
          onCancel={reset}
          onSave={async () => {
            const result = await api.saveWelcome(guild.id, draft);
            commit(result.settings);
          }}
        />
      )}
      <HeroCard>
        <div className="flex flex-row items-center justify-between gap-3 p-6">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-warning/15 text-warning">
              <Shield className="size-5" aria-hidden />
            </span>
            <div className="min-w-0">
              <HeroCard.Title className="truncate">رتبة تلقائية</HeroCard.Title>
              <HeroCard.Description>{draft.enabled ? "مفعّل" : "معطّل"}</HeroCard.Description>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <StateBadge enabled={draft.enabled} />
            {/* HeroUI v3's Switch is a React-Aria SwitchField: the hidden
                checkbox that makes it clickable lives inside Switch.Content
                (SwitchButton). A bare Switch.Control under the root renders a
                span with nothing to press — which is exactly why this toggle
                read as dead. The Content wrapper restores the input, and with
                it the click, the keyboard and the screen-reader announcement. */}
            <Switch isSelected={draft.enabled} onChange={enabled => patch({ enabled })} aria-label="تفعيل الرتبة التلقائية">
              <Switch.Content>
                <Switch.Control
                  style={
                    draft.enabled
                      ? { backgroundColor: "#10b981", borderColor: "#34d399" }
                      : undefined
                  }
                >
                  <Switch.Thumb />
                </Switch.Control>
              </Switch.Content>
            </Switch>
          </div>
        </div>
      </HeroCard>

      {draft.enabled ? (
        <>
          {/* Two facing cards: one per kind of arrival. */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="flex flex-col">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">رتب الأعضاء الجدد</CardTitle>
            <CardDescription>تُمنح لكل عضو بشري ينضم للسيرفر.</CardDescription>
          </CardHeader>
          <CardContent className="flex-1 space-y-1.5">
            <Label className="text-xs text-muted-foreground" htmlFor="welcome-member-role">
              رتبة الأعضاء الجدد
            </Label>
            <Select
              className="w-full"
              placeholder="بدون رتبة"
              value={draft.memberRoleId ?? NONE}
              onChange={value => patch({ memberRoleId: value === NONE || value === null ? null : String(value) })}
            >
              <Select.Trigger id="welcome-member-role">
                <Select.Value />
                <Select.Indicator />
              </Select.Trigger>
              <Select.Popover>
                <ListBox>
                  <ListBox.Item id={NONE} textValue="بدون رتبة">
                    بدون رتبة
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                  {roles.map(role => roleItem(role))}
                </ListBox>
              </Select.Popover>
            </Select>
            <p className="text-xs text-muted-foreground">الرتبة التي تُعطى للأعضاء الجدد عند الانضمام.</p>
          </CardContent>
        </Card>

        <Card className="flex flex-col">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">رتب البوتات الجديدة</CardTitle>
            <CardDescription>تُمنح لكل بوت يُضاف للسيرفر.</CardDescription>
          </CardHeader>
          <CardContent className="flex-1 space-y-1.5">
            <Label className="text-xs text-muted-foreground" htmlFor="welcome-bot-role">
              رتبة البوتات الجديدة
            </Label>
            <Select
              className="w-full"
              placeholder="بدون رتبة"
              value={draft.botRoleId ?? NONE}
              onChange={value => patch({ botRoleId: value === NONE || value === null ? null : String(value) })}
            >
              <Select.Trigger id="welcome-bot-role">
                <Select.Value />
                <Select.Indicator />
              </Select.Trigger>
              <Select.Popover>
                <ListBox>
                  <ListBox.Item id={NONE} textValue="بدون رتبة">
                    بدون رتبة
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                  {roles.map(role => roleItem(role))}
                </ListBox>
              </Select.Popover>
            </Select>
            <p className="text-xs text-muted-foreground">الرتبة التي تُعطى للبوتات عند إضافتها للسيرفر.</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">التوقيت</CardTitle>
          <CardDescription>متى تُمنح الرتبة بعد الانضمام.</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground" htmlFor="welcome-delay">
              تأخير منح الرتبة (0 = فوري)
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
          <p className="self-center text-xs text-muted-foreground">
            التأخير مفيد لترك العضو يستقر — أو لتفادي الموجة الأولى من أي محاولة — قبل أن تحصل على الرتبة.
          </p>
        </CardContent>
      </Card>

          <p className="text-xs text-muted-foreground">
            تُمنح الرتبة فقط إذا كانت تحت أعلى رتبة للبوت — ديسكورد يرفض ما فوقها، والبوت يعيد الفحص عند الانضمام.
          </p>
        </>
      ) : (
        <Alert>
          <Shield aria-hidden />
          <AlertDescription>
            رتبة التلقائية <strong>مُعطّلة</strong> — فعّلها من المفتاح أعلى الصفحة لتظهر بطاقتا الأعضاء والبوتات
            والتوقيت.
          </AlertDescription>
        </Alert>
      )}


      <Toaster toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
