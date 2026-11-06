import { useEffect, useState } from "react";
import { Activity, Loader2 } from "lucide-react";
import { MAX_ACTIVITY_TEXT_LENGTH, activityTypes } from "@al-ai/core/browser";
import { api } from "@/api";
import { useI18n, type TranslationKey } from "@/lib/i18n";
import { useDraftForm } from "@/lib/use-draft-form";
import { SaveBar } from "@/components/save-bar";
import { StatusDot, StatusPicker } from "@/components/status-picker";
import { Toaster, useToasts } from "@/components/toaster";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { activitySummaryLabel, durationLabel, statusLabel } from "@/views/settings/bot-preview";
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
 * So the screen says it once, in a plain line above the controls. The feature is
 * unchanged — the same two fields, the same status picker with its timed windows
 * — and the operator is no longer invited to believe it is scoped to the server
 * they happen to be looking at.
 *
 * The write is stored here and applied by the bot: it re-reads the row every
 * fifteen seconds and pushes the value onto the gateway. The dashboard has no
 * way to do it itself, and the save message says so instead of implying a
 * Discord call that never happened.
 */
export function BotPresenceView({ guild }: { guild: Guild }) {
  const { t, language } = useI18n();
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
      .catch(cause => !cancelled && setError(cause instanceof Error ? cause.message : t("presence.loadFailed")));

    return () => {
      cancelled = true;
    };
  }, [guild.id, t]);

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
        {t("presence.loading")}
      </div>
    );
  }

  const { draft, patch, reset, dirty } = form;
  const duration = durationLabel(draft.statusDuration, t);
  const activityText = (draft.activityText ?? "").trim();

  const onSave = async () => {
    try {
      const result = await api.saveBotPresence(guild.id, draft);
      form.commit(result.settings);
      // Not "applied": the dashboard cannot apply this. The bot picks the row up
      // on its next tick, which is why the sentence names the delay instead of
      // claiming a write that never happened.
      push({ tone: "success", title: t("presence.saved") });
    } catch (cause) {
      const refused = cause instanceof Error ? cause : new Error(t("presence.saveFailedFallback"));
      push({ tone: "error", title: t("presence.saveFailed"), description: refused.message });
      throw refused;
    }
  };

  return (
    <div className="space-y-4">
      <Toaster toasts={toasts} onDismiss={dismiss} />

      {/* One line, not a bar. The paragraph and the bordered Alert used to say
          the same thing twice, and the Alert carried `role="alert"` — so a
          static note interrupted a screen reader on every load. */}
      <p className="text-xs text-muted-foreground">
        {t("presence.scope", { guild: guild.name })}
      </p>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Activity className="size-4" />
            {t("presence.title")}
          </CardTitle>
          <CardDescription>{t("presence.subtitle")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-xs">{t("presence.status")}</Label>
              <StatusPicker
                className="w-full"
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
              <Label className="text-xs">{t("presence.activity")}</Label>
              <div className="flex gap-2">
                <Select
                  value={draft.activityType}
                  onValueChange={value => patch({ activityType: value as BotPresenceSettings["activityType"] })}
                >
                  <SelectTrigger className="w-40 shrink-0 rounded-xl" aria-label={t("presence.activityKind")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {activityTypes.map(type => (
                      <SelectItem
                        key={type}
                        value={type}
                        textValue={t(`presence.kind.${type}` as TranslationKey)}
                        hint={language === "ar" ? t(`presence.term.${type}` as TranslationKey) : undefined}
                      >
                        {t(`presence.kind.${type}` as TranslationKey)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  value={draft.activityText}
                  maxLength={MAX_ACTIVITY_TEXT_LENGTH}
                  onChange={event => patch({ activityText: event.target.value })}
                  placeholder={t("presence.activityPlaceholder")}
                  className="min-w-0 flex-1 rounded-xl"
                />
              </div>
              {/*
                There is no default activity to fall back to. An empty text makes
                the bot send `activities: []` — "no activity", not an activity
                with a blank name — so the sentence used to promise a default that
                nothing ever applies, and the placeholder spelled an example out
                as though it were the value the bot would choose.
              */}
              <p className="text-xs text-muted-foreground">
                {t("presence.activityHint")}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* What the stored row actually says, in one line. The controls above are
          drafts; this is what the bot will push, and it is deliberately plain
          text so a value that did not survive normalisation is visible. */}
      <div className="rounded-xl border border-border bg-card px-3 py-2.5 text-xs">
        <p className="mb-1 font-medium text-muted-foreground">{t("presence.applied")}</p>
        <p className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5">
            <StatusDot status={draft.status} size={9} />
            <span className="font-medium">{statusLabel(draft.status, t)}</span>
            {duration ? <span className="text-muted-foreground">· {duration}</span> : null}
          </span>
          <span className="text-muted-foreground">
            {activityText ? `${activitySummaryLabel(draft.activityType, t, language)} ${activityText}` : t("presence.noActivity")}
          </span>
        </p>
      </div>


      {dirty ? (
        <SaveBar
          message={t("presence.unsaved")}
          saveLabel={t("presence.save")}
          cancelLabel={t("presence.discard")}
          onCancel={reset}
          onSave={onSave}
        />
      ) : null}
    </div>
  );
}
