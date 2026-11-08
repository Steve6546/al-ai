import { renderWelcomeMessage, type WelcomeImageConfig, type WelcomeMessageSettings, type WelcomeTemplateValues } from "@al-ai/core/browser";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { initials } from "@/lib/format";

/**
 * The live preview of a **text** welcome message.
 *
 * It is bound to the *draft*, so it answers the instant something is typed or
 * picked - no save, no request. It draws the bot's own picture and name, the
 * message with its variables applied, and the generated card when the image is
 * on.
 *
 * It has no embed section, on purpose. The bot builds an embed only when
 * `mode === "embed"` (`apps/bot/src/index.ts:736`), and this component is
 * mounted only in text mode — the embed half of it was therefore unreachable
 * code that had grown a title, a description, fields, an image, a thumbnail and
 * a footer none of them could ever appear. The embed is edited and previewed in
 * one place instead: `welcome-embed-editor.tsx`, where the card *is* the form.
 *
 * Two rules it keeps:
 *
 * - **It never invents data.** The picture and the name come from the server's
 *   own read of the bot in this guild; a missing one is shown as a placeholder
 *   and labelled, not drawn as something else.
 * - **It borrows Discord's wording, not its artwork.** The "Bot" tag is the word
 *   the client prints beside a bot's name — the same one the embed editor uses —
 *   drawn with this platform's own tokens rather than their logo or palette.
 */
export function WelcomeMessagePreview({
  settings,
  values,
  avatarUrl,
  botName,
  channelName,
  nameColor,
  className
}: {
  settings: WelcomeMessageSettings;
  values: WelcomeTemplateValues;
  /** The bot's picture in this guild, or null. */
  avatarUrl: string | null;
  /** The bot's display name in this guild, or null. */
  botName: string | null;
  /** Where the message goes, by name, or null when it is not chosen yet. */
  channelName: string | null;
  /** The bot's role colour in this guild, which Discord paints the name with. */
  nameColor?: string | null;
  className?: string;
}) {
  const { t } = useI18n();
  const text = renderWelcomeMessage(settings.text, values).trim();

  return (
    <div className={cn("overflow-hidden rounded-xl border border-border bg-card", className)}>
      <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-3 py-2">
        <span className="shrink-0 text-mini font-medium text-muted-foreground">{t("welcome.previewTitle")}</span>
        <span className="min-w-0 flex-1 truncate text-mini text-muted-foreground">
          {channelName ? t("welcome.toChannel", { channel: channelName }) : t("welcome.noChannelYet")}
        </span>
        {settings.imageEnabled ? (
          <span className="shrink-0 rounded-md bg-primary/15 px-1.5 py-0.5 text-micro text-primary">{t("welcome.imageEnabledBadge")}</span>
        ) : null}
      </div>

      <div className="space-y-3 p-3">
        <div className="flex items-start gap-2.5">
          <span className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-full bg-muted text-xs font-semibold text-muted-foreground">
            {avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={avatarUrl} alt="" className="size-full object-cover" />
            ) : (
              initials(botName ?? "AL AI")
            )}
          </span>
          <div className="min-w-0 flex-1">
            <p className="flex flex-wrap items-center gap-1.5 text-sm">
              <span className="font-semibold" style={nameColor ? { color: nameColor } : undefined} dir="ltr">
                {botName ?? "AL AI"}
              </span>
              {/* Discord's own word for the sender kind, in the same shape its
                  client draws — and the same one the embed editor uses, so the
                  two previews on this screen cannot disagree about what the
                  message is. */}
              <span className="rounded bg-primary/15 px-1 py-0.5 text-[9px] font-bold uppercase text-primary">Bot</span>
            </p>

            {text ? (
              <p className="mt-1 break-words text-sm leading-relaxed whitespace-pre-wrap text-foreground">{text}</p>
            ) : (
              <p className="mt-1 rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
                {t("welcome.noText")}
              </p>
            )}


            {/*
              The card rides with the message only in the «with_message»
              mode; in «before_message» it is a separate message, and in
              «separate_channel» it goes to another channel entirely. The
              preview says which, rather than drawing a card that will not
              be sent here.
            */}
            {settings.imageEnabled && settings.imageMode === "with_message" ? (
              <div className="mt-2 overflow-hidden rounded-lg border border-border bg-muted/30">
                <WelcomeImageStub config={settings.image} />
              </div>
            ) : null}
            {settings.imageEnabled && settings.imageMode === "before_message" ? (
              <p className="mt-2 rounded-lg border border-dashed border-border px-3 py-2 text-mini text-muted-foreground">
                {t("welcome.imageSeparate")}
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * A placeholder for the generated card.
 *
 * The card itself is drawn on the canvas tab, where it can be edited; here it
 * only has to say that a card is coming, at the card's own proportions.
 */
function WelcomeImageStub({ config }: { config: WelcomeImageConfig }) {
  const { t } = useI18n();
  return (
    <div
      className="grid place-items-center text-mini text-muted-foreground"
      style={{ aspectRatio: `${config.width} / ${config.height}` }}
    >
      {t("welcome.imageStub")}
    </div>
  );
}
