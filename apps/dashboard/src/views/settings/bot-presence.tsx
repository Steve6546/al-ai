import { useEffect, useState } from "react";
import { Activity, Globe2, Loader2 } from "lucide-react";
import { DEFAULT_BOT_PRESENCE, MAX_ACTIVITY_TEXT_LENGTH, activityTypeLabels, activityTypes } from "@al-ai/core/browser";
import { api } from "@/api";
import { useDraftForm } from "@/lib/use-draft-form";
import { SaveBar } from "@/components/save-bar";
import { StatusDot, StatusPicker } from "@/components/status-picker";
import { Toaster, useToasts } from "@/components/toaster";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { activityLabel, durationLabel, statusLabel } from "@/views/settings/bot-preview";
import type { BotPresenceSettings, Guild } from "@/types";

/**
 * The bot's status and activity — the account-wide half, on its own screen.
 *
 * It lives here rather than on «هوية البوت» because of a fact about Discord, not
 * a preference: a status is set on the bot's *gateway connection*, there is no
 * REST route for it, and the connection is one for every server the bot is in.
 * A control that changes all of them cannot sit on a form whose whole promise is
 * «هذا ما يظهر به البوت هنا» — that was the contradiction this screen resolves.
 *
 * So the screen says what it is, out loud, twice: once in the header and once
 * under the controls. The feature is unchanged — the same two fields, the same
 * status picker with its timed windows — and the operator is no longer invited
 * to believe it is scoped to the server they happen to be looking at.
 *
 * The write is stored here and applied by the bot: it re-reads the row every
 * fifteen seconds and pushes the value onto the gateway. The dashboard has no
 * way to do it itself, and the save message says so instead of implying a
 * Discord call that never happened.
 */
export function BotPresenceView({ guild }: { guild: Guild }) {
  const [settings, setSettings] = useState<BotPresenceSettings | null>(null);
  const form = useDraftForm(settings);
  const [error, setError] = useState<string | null>(null);
  const { toasts, push, dismiss } = useToasts();

  useEffect(() => {
    let cancelled = false;
    setSettings(null);
    setError(null);

    api
      .botPresence(guild.id)
      .then(result => !cancelled && setSettings(result.settings))
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
  if (!form.saved || !form.draft) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        جارٍ التحميل
      </div>
    );
  }

  const { draft, patch, reset, dirty } = form;
  const duration = durationLabel(draft.statusDuration);
  const activityText = (draft.activityText ?? "").trim();

  const onSave = async () => {
    try {
      const result = await api.saveBotPresence(guild.id, draft);
      form.commit(result.settings);
      // Not "applied": the dashboard cannot apply this. The bot picks the row up
      // on its next tick, which is why the sentence names the delay instead of
      // claiming a write that never happened.
      push({ tone: "success", title: "تم حفظ الحالة — يطبّقها البوت خلال ثوانٍ في كل السيرفرات" });
    } catch (cause) {
      const refused = cause instanceof Error ? cause : new Error("تعذّر حفظ الحالة.");
      push({ tone: "error", title: "تعذّر حفظ الحالة", description: refused.message });
      throw refused;
    }
  };

  return (
    <div className="space-y-4">
      {dirty ? (
        <SaveBar
          message="لديك تغييرات غير محفوظة"
          saveLabel="حفظ الحالة"
          cancelLabel="تجاهل"
          onCancel={reset}
          onSave={onSave}
        />
      ) : null}
      <Toaster toasts={toasts} onDismiss={dismiss} />

      <div className="space-y-1 pt-1">
        <h1 className="text-lg font-semibold">حالة البوت والنشاط</h1>
        <p className="text-xs text-muted-foreground">
          كيف يظهر AL AI في قائمة الأعضاء: حالته، والنشاط المكتوب تحتها. هذه القيم تخصّ البوت كله — تظهر في كل سيرفر، بما فيه{" "}
          <span className="font-medium text-foreground">{guild.name}</span>.
        </p>
      </div>

      <Alert>
        <Globe2 className="size-4" />
        <AlertDescription>
          الحالة تُكتب على اتصال البوت الحي (gateway)، وليس لكل سيرفر حالة خاصة. ما تُغيِّره هنا يظهر في كل السيرفرات التي يعمل فيها AL
          AI، ولا يمكن قصره على سيرفر واحد — لأن Discord لا يوفّر ذلك أصلاً.
        </AlertDescription>
      </Alert>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Activity className="size-4" />
            الحالة والنشاط
          </CardTitle>
          <CardDescription>اختر الحالة ومدة انتهائها إن أردت، واكتب النشاط الذي يظهر تحتها.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-xs">حالة البوت</Label>
              <StatusPicker
                status={draft.status}
                duration={draft.statusDuration}
                onChange={({ status, duration: chosen }) =>
                  // The expiry is the server's to compute: a client clock can be
                  // hours out, and letting it set the instant would mean a window
                  // decided by whichever machine pressed save.
                  patch({ status, statusDuration: chosen, statusExpiresAt: null })
                }
              />
            </div>

            <div className="space-y-1.5">
              {/* One label for both controls: the kind and its text are two
                  halves of one activity, and naming them separately is what made
                  the old card read as two fields. */}
              <Label className="text-xs">نشاط البوت</Label>
              <div className="flex gap-2">
                <Select
                  value={draft.activityType}
                  onValueChange={value => patch({ activityType: value as BotPresenceSettings["activityType"] })}
                >
                  <SelectTrigger className="w-40 shrink-0 rounded-xl" aria-label="نوع النشاط">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {activityTypes.map(type => (
                      <SelectItem key={type} value={type}>
                        {activityTypeLabels[type]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  value={draft.activityText}
                  maxLength={MAX_ACTIVITY_TEXT_LENGTH}
                  onChange={event => patch({ activityText: event.target.value })}
                  placeholder={DEFAULT_BOT_PRESENCE.activityText || "سيرفرات ديسكورد"}
                  className="min-w-0 flex-1 rounded-xl"
                />
              </div>
              <p className="text-[11px] text-muted-foreground">
                اترك النص فارغاً ليظهر النشاط الافتراضي بدل نوع بلا نص — النوع وحده لا يعرض شيئاً في Discord.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* What the stored row actually says, in one line. The controls above are
          drafts; this is what the bot will push, and it is deliberately plain
          text so a value that did not survive normalisation is visible. */}
      <div className="rounded-xl border border-border bg-card px-3 py-2.5 text-xs">
        <p className="mb-1 font-medium text-muted-foreground">ما سيطبّقه البوت</p>
        <p className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5">
            <StatusDot status={draft.status} size={9} />
            <span className="font-medium">{statusLabel(draft.status)}</span>
            {duration ? <span className="text-muted-foreground">· {duration}</span> : null}
          </span>
          <span className="text-muted-foreground">
            {activityText ? `${activityLabel(draft.activityType)} ${activityText}` : "لا يوجد نشاط ظاهر"}
          </span>
        </p>
      </div>

    </div>
  );
}
