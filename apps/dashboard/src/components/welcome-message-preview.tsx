import { renderWelcomeMessage, type WelcomeEmbed, type WelcomeImageConfig, type WelcomeMessageSettings, type WelcomeTemplateValues } from "@al-ai/core/browser";
import { cn } from "@/lib/utils";
import { initials } from "@/lib/format";

/**
 * The live preview of a welcome message.
 *
 * It is bound to the *draft*, so it answers the instant something is typed or
 * picked - no save, no request. It draws what the bot will draw: the bot's own
 * picture and name, the message with its variables applied, the embed when the
 * screen is in embed mode, and the generated card when the image is on.
 *
 * Two rules it keeps:
 *
 * - **It never invents data.** The picture and the name come from the server's
 *   own read of the bot in this guild; a missing one is shown as a placeholder
 *   and labelled, not drawn as something else.
 * - **It never shows a Discord trade mark.** The AL AI mark is the platform's
 *   own; the little "Bot" tag says what the message is, the way Discord says
 *   it, without borrowing their logo.
 */
export function WelcomeMessagePreview({
  settings,
  values,
  avatarUrl,
  botName,
  channelName,
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
  className?: string;
}) {
  const text = renderWelcomeMessage(settings.text, values).trim();
  const embed = settings.mode === "embed" ? settings.embed : null;
  const embedTitle = embed ? renderWelcomeMessage(embed.title, values).trim() : "";
  const embedDescription = embed ? renderWelcomeMessage(embed.description, values).trim() : "";
  const embedFields = embed ? embed.fields.filter(field => field.name.trim() || field.value.trim()) : [];

  return (
    <div className={cn("overflow-hidden rounded-xl border border-border bg-card", className)}>
      <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-3 py-2">
        <span className="text-[11px] font-medium text-muted-foreground">معاينة الرسالة</span>
        <span className="truncate text-[11px] text-muted-foreground">
          {channelName ? `إلى #${channelName}` : "لم تُختر القناة بعد"}
        </span>
        {settings.imageEnabled ? (
          <span className="ms-auto shrink-0 rounded-md bg-primary/15 px-1.5 py-0.5 text-[10px] text-primary">صورة الترحيب مفعّلة</span>
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
              <span className="font-semibold">{botName ?? "AL AI"}</span>
              {/* The platform's own word for what this is - not Discord's logo. */}
              <span className="rounded bg-primary/15 px-1 py-0.5 text-[9px] font-semibold text-primary">AL AI</span>
            </p>

            {text ? (
              <p className="mt-1 text-sm leading-relaxed whitespace-pre-wrap text-foreground">{text}</p>
            ) : (
              <p className="mt-1 rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
                لا يوجد نص — سيصل عضو جديد بلا رسالة.
              </p>
            )}

            {embed ? (
              <div
                className="mt-2 overflow-hidden rounded-lg border-s-4 bg-background"
                style={{ borderInlineStartColor: embed.color ?? "#4e5058" }}
              >
                <div className="space-y-2 p-3">
                  {embedTitle ? <p className="text-sm font-semibold">{embedTitle}</p> : null}
                  {embedDescription ? (
                    <p className="text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">{embedDescription}</p>
                  ) : null}
                  {embedFields.length ? (
                    <div className="grid gap-2 sm:grid-cols-2">
                      {embedFields.map(field => (
                        <div key={field.id} className="min-w-0">
                          {field.name.trim() ? <p className="text-[11px] font-semibold">{field.name}</p> : null}
                          {field.value.trim() ? (
                            <p className="text-[11px] text-muted-foreground">{field.value}</p>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {!embedTitle && !embedDescription && !embedFields.length ? (
                    <p className="text-xs text-muted-foreground">الإيمبد فارغ — أضف عنواناً أو وصفاً أو حقلاً.</p>
                  ) : null}
                </div>
                {settings.embed.imageMode === "upload" && settings.embed.imageDataUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={settings.embed.imageDataUrl} alt="" className="max-h-48 w-full object-cover" />
                ) : null}
              </div>
            ) : null}

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
              <p className="mt-2 rounded-lg border border-dashed border-border px-3 py-2 text-[11px] text-muted-foreground">
                تُرسل صورة الترحيب في رسالة منفصلة قبل هذه الرسالة.
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
  return (
    <div
      className="grid place-items-center text-[11px] text-muted-foreground"
      style={{ aspectRatio: `${config.width} / ${config.height}` }}
    >
      صورة الترحيب تُرسم في تبويب «الصورة»
    </div>
  );
}
