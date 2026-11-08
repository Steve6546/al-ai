import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, Image as ImageIcon, Info, Plus, Trash2, X } from "lucide-react";
import { api } from "@/api";
import { useI18n, type Translate, type TranslationKey } from "@/lib/i18n";
import { useDraftForm } from "@/lib/use-draft-form";
import { fitImageUnder } from "@/lib/image-fit";
import { LoadError, LoadingRow } from "@/components/view-states";
import { SaveBar } from "@/components/save-bar";
import { Toaster, useToasts } from "@/components/toaster";
import { WelcomeMessagePreview } from "@/components/welcome-message-preview";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  clampWelcomeImageConfig,
  MAX_IMAGE_BYTES,
  MAX_WELCOME_CUSTOM_TEXTS,
  WELCOME_FONT_FAMILIES,
  welcomeEmbedReady,
} from "@al-ai/core/browser";
import { EmbedEditor } from "./welcome-embed-editor";
import { EmojiPicker, FieldRow, TokenStrip, insertAtCursor } from "./welcome-messages-parts";
import { WelcomeImageCanvas } from "./welcome-image-canvas";
import type { ChannelOption, Guild, GuildProfileSnapshot, WelcomeEmbedField, WelcomeMessageSettings, WelcomeTextLayer } from "@/types";

type Tab = "settings" | "message" | "image";
type CanvasPanel = "background" | "avatar" | "username" | "custom" | "canvas-settings";
type Selection =
  | { kind: "avatar" }
  | { kind: "username" }
  | { kind: "custom"; id: string }
  | null;

const NONE = "__none__";

const IMAGE_SEND_MODES: WelcomeMessageSettings["imageMode"][] = ["with_message", "before_message", "separate_channel"];

/**
 * The picked file as a data URL inside the image budget — shrunk if needed.
 *
 * The old version compared the *encoded string* against a byte budget, so the
 * effective limit was three quarters of what the hint promised, and any photo
 * from a phone was refused outright. Both are the same bug seen twice; the
 * fitter below is the one place that decides.
 */
async function readImageAsDataUrl(file: File, t: Translate): Promise<string> {
  if (!/^image\/(png|jpeg|jpg|webp|gif)$/.test(file.type)) {
    throw new Error(t("welcome.imageBadType"));
  }
  try {
    return (await fitImageUnder(file, MAX_IMAGE_BYTES)).dataUrl;
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : "";
    if (reason === "animated-gif-too-large") throw new Error(t("welcome.gifTooLarge"));
    if (reason === "cannot-fit") throw new Error(t("welcome.imageTooLarge"));
    throw new Error(t("customization.imageReadFailed"));
  }
}

/**
 * A real person to stand in for the joiner.
 *
 * The previews used to print «اسم_المستخدِم» and a silhouette: invented words in
 * a card whose entire job is to say what a member will see. The operator is the
 * one real account this screen already holds — name and picture both resolved
 * server-side, animated avatars included — so the sample is a person, and it is
 * labelled as one.
 */
export type WelcomeSample = { name: string; avatarUrl: string | null };

/**
 * رسائل الترحيب — three tabs over one draft: what is sent and where
 * (الإعدادات), the message and its embed (الرسالة), and the generated card
 * (الصورة). One `useDraftForm`, one save bar, exactly the contract every
 * other settings screen keeps.
 */
export function WelcomeMessagesView({ guild, sample }: { guild: Guild; sample: WelcomeSample | null }) {
  const { t, language } = useI18n();
  const [tab, setTab] = useState<Tab>("settings");
  const [settings, setSettings] = useState<WelcomeMessageSettings | null>(null);
  const [channels, setChannels] = useState<ChannelOption[]>([]);
  /* The channel list could not be read from Discord. The screen must say that
     rather than draw an empty picker: "there are no channels" and "we could not
     ask" are different answers, and only one of them is the operator's to fix. */
  const [channelsError, setChannelsError] = useState(false);
  /* The bot's picture and name in THIS guild, for the preview. The same read the
     identity screen uses, so the preview shows the bot the members see. */
  const [profile, setProfile] = useState<GuildProfileSnapshot | null>(null);
  /* The bot's role colour in this guild. Discord paints a member's name in it,
     so the preview needs it to look like the message rather than like a form. */
  const [roleColor, setRoleColor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [canvasPanel, setCanvasPanel] = useState<CanvasPanel>("background");
  const [selection, setSelection] = useState<Selection>(null);
  const { draft, dirty, patch, reset, commit } = useDraftForm(settings);
  const { toasts, push, dismiss } = useToasts();

  // Caret targets: every text field that accepts tokens keeps a ref so the
  // strip inserts where the operator's cursor is, not at the end.
  const textRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageInputTarget = useRef<"background" | "embed-image">("background");
  // Display-only: the real file name of the last upload, so the attachment bar
  // names what the operator actually picked instead of a generic label. Never
  // persisted — the stored value is the image itself.
  const [fileNames, setFileNames] = useState<{ background?: string; embed?: string }>({});

  useEffect(() => {
    let cancelled = false;
    setSettings(null);
    setError(null);
    api
      .welcomeMessages(guild.id)
      .then(result => {
        if (cancelled) return;
        setSettings(result.settings);
        setChannels(result.channels);
        setChannelsError(result.channelsError === true);
      })
      .catch(cause => !cancelled && setError(cause instanceof Error ? cause.message : t("welcome.messagesLoadFailed")));
    // The bot's own picture and name in this guild, for the preview. The same
    // read the identity screen uses, so the preview shows the bot the members
    // of *this* server see - and a read that fails leaves the preview with a
    // placeholder instead of failing the screen.
    void api
      .customization(guild.id)
      .then(result => {
        if (cancelled) return;
        setProfile(result.profile ?? null);
        setRoleColor(result.settings?.roleColor ?? null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [guild.id, t]);

  const sampleValues = useMemo(
    () => ({
      /* With no real person to borrow, the token is shown exactly as typed: an
         unresolved `{user}` reads as "a variable goes here", while «@العضو»
         reads as a name the bot would actually print — and it never does. */
      userMention: sample ? `@${sample.name}` : "{user}",
      username: sample?.name ?? "{username}",
      server: guild.name,
      memberCount: guild.memberCount ?? null,
      inviterMention: sample ? `@${sample.name}` : "{inviter}",
      joinDate: new Date().toLocaleDateString(language === "ar" ? "ar" : "en-GB", { year: "numeric", month: "long", day: "numeric" })
    }),
    [guild.name, guild.memberCount, sample, language]
  );

  /** The chosen channel's name, for the preview's header. */
  const channelName = useMemo(() => {
    const id = draft?.channelId ?? null;
    if (!id) return null;
    return channels.find(channel => channel.id === id)?.name ?? null;
  }, [channels, draft?.channelId]);

  /**
   * The bot's own picture, the one the members of this server see.
   *
   * Discord's own rule: a server that sets no picture of its own shows the
   * account's. So the guild picture comes first and the account's is the
   * fallback - a bot with a perfectly good face must not render as a blank
   * circle in the preview.
   */
  const botAvatarUrl = profile?.avatarUrl ?? profile?.accountAvatarUrl ?? null;

  if (error) return <LoadError message={error} />;
  if (!settings || !draft) return <LoadingRow />;

  const channelSelect = (value: string) => (value === NONE ? null : value);

  /*
   * **The channel a greeting is sent to is the one thing the bot cannot
   * guess.** The server refuses to arm the module without one - a welcome
   * pointing nowhere is a silent module, not a working one - and it answers
   * that refusal with 409. Until now the screen learned about it only *after*
   * the round trip: the picker looked empty, the operator pressed save, and
   * the bar answered with a rejection for a field that had not said it was
   * required.
   *
   * The empty picker had its own cause. The "no channel" choice was the
   * sentinel `__none__`, but no option carried that value, so Radix had no
   * label to render and drew a blank box - which reads as a broken control,
   * not as "nothing selected yet". The sentinel now has an option, a saved
   * channel that Discord no longer has is named instead of hidden, and the
   * requirement is stated at the field and in the save bar before the click.
   */
  const knows = (id: string | null) => id === null || channels.some(channel => channel.id === id);
  const welcomeChannelMissing = !knows(draft.channelId);
  const imageChannelMissing = !knows(draft.imageChannelId);
  const channelRequired = draft.enabled && !draft.channelId;
  const imageChannelRequired =
    draft.enabled && draft.imageEnabled && draft.imageMode === "separate_channel" && !draft.imageChannelId;
  const blockedReason = channelRequired
    ? t("welcome.blockedChannel")
    : imageChannelRequired
      ? t("welcome.blockedImageChannel")
      : channelsError
        ? t("welcome.blockedChannelsError")
        : null;

  const tabs: { key: Tab; label: string }[] = [
    { key: "settings", label: t("welcome.tab.settings") },
    { key: "message", label: t("welcome.tab.message") },
    { key: "image", label: t("welcome.tab.image") }
  ];

  /* ---------------- embed helpers ---------------- */
  const patchEmbed = (partial: Partial<WelcomeMessageSettings["embed"]>) => patch({ embed: { ...draft.embed, ...partial } });

  const addField = () => {
    if (draft.embed.fields.length >= 10) {
      push({ title: t("welcome.maxFields"), tone: "error" });
      return;
    }
    patchEmbed({
      fields: [...draft.embed.fields, { id: `field-${Date.now()}`, name: "", value: "", inline: false }]
    });
  };

  const patchField = (id: string, partial: Partial<WelcomeEmbedField>) =>
    patchEmbed({ fields: draft.embed.fields.map(field => (field.id === id ? { ...field, ...partial } : field)) });

  const removeField = (id: string) => patchEmbed({ fields: draft.embed.fields.filter(field => field.id !== id) });

  const pickImage = (target: "background" | "embed-image") => {
    imageInputTarget.current = target;
    fileInputRef.current?.click();
  };

  const onFileChosen = async (file: File | undefined) => {
    if (!file) return;
    try {
      const dataUrl = await readImageAsDataUrl(file, t);
      if (imageInputTarget.current === "background") {
        patchImage({ ...draft.image, background: { ...draft.image.background, type: "image", imageDataUrl: dataUrl } });
        setFileNames(current => ({ ...current, background: file.name }));
      } else {
        patchEmbed({ imageMode: "upload", imageDataUrl: dataUrl });
        setFileNames(current => ({ ...current, embed: file.name }));
      }
    } catch (cause) {
      push({ title: cause instanceof Error ? cause.message : t("customization.imageReadFailed"), tone: "error" });
    }
  };

  /* ---------------- canvas helpers ---------------- */
  // The live editor applies the same bounds the normaliser enforces at save:
  // sliders and drags cannot park a layer outside the canvas, and the avatar
  // cannot outgrow the card it sits on.
  const patchImage = (image: WelcomeMessageSettings["image"]) => patch({ image: clampWelcomeImageConfig(image) });
  const patchTextLayer = (id: string, partial: Partial<WelcomeTextLayer>) => {
    if (id === draft.image.username.id) {
      patchImage({ ...draft.image, username: { ...draft.image.username, ...partial } });
      return;
    }
    patchImage({
      ...draft.image,
      customTexts: draft.image.customTexts.map(layer => (layer.id === id ? { ...layer, ...partial } : layer))
    });
  };

  const addCustomText = () => {
    if (draft.image.customTexts.length >= MAX_WELCOME_CUSTOM_TEXTS) {
      push({ title: t("welcome.maxCustomTexts", { max: MAX_WELCOME_CUSTOM_TEXTS }), tone: "error" });
      return;
    }
    const id = `text-${Date.now()}`;
    const layer: WelcomeTextLayer = {
      id,
      text: t("welcome.newText"),
      x: Math.round(draft.image.width / 2),
      y: Math.round(draft.image.height / 2),
      fontFamily: "IBM Plex Sans Arabic",
      fontSize: 24,
      color: "#ffffff",
      weight: "normal",
      align: "center"
    };
    patchImage({ ...draft.image, customTexts: [...draft.image.customTexts, layer] });
    setSelection({ kind: "custom", id });
    setCanvasPanel("custom");
  };

  const selectedCustom = selection?.kind === "custom" ? draft.image.customTexts.find(layer => layer.id === selection.id) ?? null : null;

  const canvasPanels: { key: CanvasPanel; label: string }[] = [
    { key: "background", label: t("welcome.canvas.background") },
    { key: "avatar", label: t("welcome.canvas.avatar") },
    { key: "username", label: t("welcome.canvas.username") },
    { key: "custom", label: t("welcome.canvas.custom") },
    { key: "canvas-settings", label: t("welcome.canvas.settings") }
  ];

  return (
    <div className="space-y-4">
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        aria-hidden
        tabIndex={-1}
        onChange={event => {
          void onFileChosen(event.target.files?.[0]);
          event.target.value = "";
        }}
      />

      {/* The page's own title and one line of context are rendered by the
          shell (the frame's page header), so this screen starts with the
          content itself - a second title here would say the same thing twice
          and push the tabs below the fold on a phone. */}

      {/* Tab strip. Five tabs wrap instead of scrolling: a hidden-scrollbar
          scroller gave no affordance and read as cut-off on a phone, and two
          wrapped rows cost less than a swipe the operator cannot see. */}
      <div role="tablist" aria-label={t("welcome.tabsLabel")} className="flex flex-wrap gap-1 rounded-xl border border-border/80 bg-card/70 p-1.5">
        {tabs.map(entry => (
          <button
            key={entry.key}
            role="tab"
            aria-selected={tab === entry.key}
            onClick={() => setTab(entry.key)}
            className={cn(
              "whitespace-nowrap rounded-lg px-4 py-2 text-sm transition-colors",
              tab === entry.key
                ? "bg-primary font-medium text-primary-foreground shadow-sm shadow-primary/30"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            )}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {/* ============================= Tab 1: الإعدادات ============================= */}
      {tab === "settings" && (
        <Card>
          <CardContent className="space-y-3 pt-6">
            <label className="flex items-center justify-between gap-2 rounded-lg border border-border/80 px-3 py-2">
              <span className="flex items-center gap-2 text-sm">
                <Info className="size-3.5 text-muted-foreground" aria-hidden />
                {t("welcome.enable")}
              </span>
              <Switch checked={draft.enabled} onCheckedChange={enabled => patch({ enabled })} aria-label={t("welcome.enable")} />
            </label>

            <label className="flex items-center justify-between gap-2 rounded-lg border border-border/80 px-3 py-2">
              <span className="flex items-center gap-2 text-sm">
                <Info className="size-3.5 text-muted-foreground" aria-hidden />
                {t("welcome.enableImage")}
              </span>
              <Switch checked={draft.imageEnabled} onCheckedChange={imageEnabled => patch({ imageEnabled })} aria-label={t("welcome.enableImage")} />
            </label>

            {draft.imageEnabled && (
              <Alert>
                <Info className="size-4" />
                <AlertDescription>
                  {t("welcome.imageWithEmbed")}
                </AlertDescription>
              </Alert>
            )}

            {draft.imageEnabled && (
              <>
                {/* `FieldRow` prints its label as a plain span, so nothing
                    associates it with the control beneath it — and a Radix
                    trigger is a `<button role="combobox">`, which axe then
                    reads as a nameless button. Each picker on this tab carries
                    its own `aria-label`, worded as its visible label. */}
                <FieldRow label={t("welcome.imageSend")}>
                  <Select
                    value={draft.imageMode}
                    onValueChange={value => patch({ imageMode: value as WelcomeMessageSettings["imageMode"], imageChannelId: value === "separate_channel" ? draft.imageChannelId : null })}
                  >
                    <SelectTrigger className="w-full" aria-label={t("welcome.imageSendAria")}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(Object.keys(IMAGE_SEND_MODES) as WelcomeMessageSettings["imageMode"][]).map(mode => (
                        <SelectItem key={mode} value={mode}>
                          {t(`welcome.imageMode.${mode}` as TranslationKey)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FieldRow>

                {draft.imageMode === "separate_channel" && (
                  <FieldRow label={t("welcome.chooseImageChannel")}>
                    <Select
                      value={draft.imageChannelId ?? NONE}
                      onValueChange={value => patch({ imageChannelId: channelSelect(value) })}
                    >
                      <SelectTrigger
                        className="w-full"
                        aria-label={t("welcome.chooseImageChannelAria")}
                        aria-invalid={imageChannelRequired || imageChannelMissing}
                      >
                        <SelectValue placeholder={t("welcome.chooseChannelPlaceholder")} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NONE}>{t("welcome.noChannel")}</SelectItem>
                        {channels.map(channel => (
                          <SelectItem key={channel.id} value={channel.id}>
                            #{channel.name}
                          </SelectItem>
                        ))}
                        {imageChannelMissing && draft.imageChannelId && (
                          <SelectItem value={draft.imageChannelId}>
                            {t("welcome.channelGone", { id: draft.imageChannelId })}
                          </SelectItem>
                        )}
                      </SelectContent>
                    </Select>
                    {imageChannelRequired && (
                      <p className="text-mini text-destructive">{t("welcome.imageChannelRequired")}</p>
                    )}
                    {imageChannelMissing && !imageChannelRequired && (
                      <p className="text-mini text-destructive">
                        {t("welcome.savedChannelGone")}
                      </p>
                    )}
                  </FieldRow>
                )}
              </>
            )}

            <FieldRow label={draft.enabled ? t("welcome.channelLabelRequired") : t("welcome.channelLabel")}>
              <Select value={draft.channelId ?? NONE} onValueChange={value => patch({ channelId: channelSelect(value) })}>
                <SelectTrigger
                  className="w-full"
                  aria-label={t("welcome.channelAria")}
                  aria-invalid={channelRequired || welcomeChannelMissing}
                  aria-describedby="welcome-channel-hint"
                >
                  <SelectValue placeholder={t("welcome.chooseChannelPlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  {/* The sentinel needs an option of its own: a value with no
                      item has no label, and Radix then draws an empty box. */}
                  <SelectItem value={NONE}>{t("welcome.noChannel")}</SelectItem>
                  {channels.map(channel => (
                    <SelectItem key={channel.id} value={channel.id}>
                      #{channel.name}
                    </SelectItem>
                  ))}
                  {welcomeChannelMissing && draft.channelId && (
                    <SelectItem value={draft.channelId}>{t("welcome.channelGone", { id: draft.channelId })}</SelectItem>
                  )}
                </SelectContent>
              </Select>
              {/* One hint line, announced with the field: whichever sentence is
                  true wins - the missing channel is the thing to fix first. */}
              {(channelRequired || welcomeChannelMissing || channelsError) && (
                <p id="welcome-channel-hint" className="text-mini text-destructive">
                  {channelRequired
                    ? t("welcome.channelRequiredHint")
                    : welcomeChannelMissing
                      ? t("welcome.savedChannelGone")
                      : t("welcome.channelsErrorHint")}
                </p>
              )}
            </FieldRow>
          </CardContent>
        </Card>
      )}

      {/* ============================= Tab 2: الرسالة ============================= */}
      {tab === "message" && (
        <div className="space-y-4">
          <div className="flex justify-end gap-1 rounded-xl border border-border/80 bg-card/70 p-1.5">
            <button
              type="button"
              aria-pressed={draft.mode === "text"}
              onClick={() => patch({ mode: "text" })}
              className={cn(
                "whitespace-nowrap rounded-lg px-4 py-2 text-sm transition-colors",
                draft.mode === "text" ? "bg-primary font-medium text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
            >
              {t("welcome.textOnly")}
            </button>
            <button
              type="button"
              aria-pressed={draft.mode === "embed"}
              onClick={() => patch({ mode: "embed" })}
              className={cn(
                "whitespace-nowrap rounded-lg px-4 py-2 text-sm transition-colors",
                draft.mode === "embed" ? "bg-primary font-medium text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
            >
              {t("welcome.embedMode")}
            </button>
          </div>

          {draft.mode === "text" ? (
            <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">{t("welcome.messageText")}</CardTitle>
                  <CardDescription>{t("welcome.messageTextBody")}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  {/* The emoji trigger sits in its own row above the field.
                      Overlaying it on the textarea made the first line run
                      underneath it on a phone, which read as clipped text. */}
                  <div className="flex items-center justify-between gap-2">
                    <span className="min-w-0 text-mini text-muted-foreground">
                      {t("welcome.insertHint")}
                    </span>
                    <EmojiPicker label={t("welcome.insertEmoji")} onPick={emoji => patch({ text: insertAtCursor(textRef.current, draft.text, emoji) })} />
                  </div>
                  <Textarea
                    ref={textRef}
                    rows={4}
                    dir="auto"
                    value={draft.text}
                    onChange={event => patch({ text: event.target.value })}
                    className="min-h-24 rounded-xl text-sm [overflow-wrap:anywhere]"
                  />
                  <div className="space-y-1">
                    <span className="text-mini text-muted-foreground">{t("welcome.availableVariables")}</span>
                    <TokenStrip onInsert={token => patch({ text: insertAtCursor(textRef.current, draft.text, token) })} />
                  </div>
                </CardContent>
              </Card>
              {/* The preview, bound to the draft: it answers the instant a letter
                  is typed, and it never claims Discord has received anything. */}
              <WelcomeMessagePreview
                settings={draft}
                values={sampleValues}
                avatarUrl={botAvatarUrl}
                botName={profile?.nickname || profile?.username || null}
                channelName={channelName}
                nameColor={roleColor}
                className="lg:sticky lg:top-6 lg:self-start"
              />
            </div>
          ) : (
            <Card className="border-primary/20 bg-card/70 shadow-lg shadow-primary/5 backdrop-blur-sm">
              <CardHeader className="pb-3">
                <CardTitle className="text-base">{t("welcome.previewEditorTitle")}</CardTitle>
                <CardDescription>
                  {t("welcome.previewEditorBody")}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="rounded-lg bg-[#2b2d31] p-2 sm:p-4">
                <EmbedEditor
                  botName={profile?.nickname || profile?.username || "AL AI"}
                  botAvatarUrl={botAvatarUrl}
                  roleColor={roleColor}
                  memberAvatarUrl={sample?.avatarUrl ?? null}
                    embed={draft.embed}
                    onEmbedChange={patchEmbed}
                    imageUpload={{
                      imageDataUrl: draft.embed.imageDataUrl,
                      // The name of the file the operator actually picked, or
                      // nothing: a stored image reloaded from the database has
                      // no file behind it any more, and inventing a name for it
                      // would describe an upload that happened in a previous session.
                      fileName: fileNames.embed ?? null,
                      onPickFile: () => pickImage("embed-image"),
                      onFileDrop: (file: File | undefined) => {
                        imageInputTarget.current = "embed-image";
                        void onFileChosen(file);
                      },
                      onRemove: () => patchEmbed({ imageMode: "none", imageDataUrl: null })
                    }}
                    onAddField={addField}
                    onPatchField={patchField}
                    onRemoveField={removeField}
                  />
                </div>
                <div
                  className={cn(
                    "flex items-center gap-2 rounded-lg border px-3 py-2 text-sm",
                    welcomeEmbedReady(draft.embed)
                      ? "border-success/40 bg-success/10 text-success"
                      : "border-border bg-muted/30 text-muted-foreground"
                  )}
                >
                  {welcomeEmbedReady(draft.embed) ? <CheckCircle2 className="size-4" /> : <AlertCircle className="size-4" />}
                  {welcomeEmbedReady(draft.embed)
                    ? t("welcome.embedReady")
                    : t("welcome.embedNotReady")}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* ============================= Tab 3: الصورة ============================= */}
      {tab === "image" && (
        <div className="space-y-4">
          {!draft.imageEnabled && (
            <Alert>
              <Info className="size-4" />
              <AlertDescription>
                {t("welcome.imageDisabled")}
              </AlertDescription>
            </Alert>
          )}

          <Card className="border-primary/20 bg-card/70 shadow-lg shadow-primary/5 backdrop-blur-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">{t("welcome.designerTitle")}</CardTitle>
              <CardDescription>
                {t("welcome.designerBody")}
              </CardDescription>
            </CardHeader>
            <CardContent className="px-2 pb-4 pt-0 sm:px-5 sm:pb-5">
              <WelcomeImageCanvas
                config={draft.image}
                values={sampleValues}
                sampleAvatarUrl={sample?.avatarUrl ?? null}
                selected={selection}
                onSelect={setSelection}
                onConfigChange={patchImage}
              />
            </CardContent>
          </Card>

          {/* Element control sub-tabs. Wrapped rather than scrolled: a
              hidden-scrollbar strip read as cut off on a phone, and the five
              short labels fit on two rows. */}
          <div className="flex flex-wrap gap-1 rounded-xl border border-border/80 bg-card/70 p-1.5">
            {canvasPanels.map(entry => (
              <button
                key={entry.key}
                type="button"
                aria-pressed={canvasPanel === entry.key}
                onClick={() => setCanvasPanel(entry.key)}
                className={cn(
                  "whitespace-nowrap rounded-lg px-4 py-2 text-sm transition-colors",
                  canvasPanel === entry.key
                    ? "bg-primary font-medium text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
              >
                {entry.label}
              </button>
            ))}
          </div>

          <Card>
            <CardContent className="space-y-3 pt-6">
              {canvasPanel === "background" && (
                <>
                  <FieldRow label={t("welcome.backgroundType")}>
                    <Select
                      value={draft.image.background.type}
                      onValueChange={value =>
                        patch({
                          image: {
                            ...draft.image,
                            background: {
                              ...draft.image.background,
                              type: value as WelcomeMessageSettings["image"]["background"]["type"],
                              ...(value === "color" ? { color: draft.image.background.color ?? "#0b1020" } : {})
                            }
                          }
                        })
                      }
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="transparent">{t("welcome.bg.transparent")}</SelectItem>
                        <SelectItem value="color">{t("welcome.bg.color")}</SelectItem>
                        <SelectItem value="gradient">{t("welcome.bg.gradient")}</SelectItem>
                        <SelectItem value="image">{t("welcome.bg.image")}</SelectItem>
                      </SelectContent>
                    </Select>
                  </FieldRow>
                  {draft.image.background.type === "color" && (
                    <input
                      type="color"
                      value={draft.image.background.color ?? "#0b1020"}
                      onChange={event => patchImage({ ...draft.image, background: { ...draft.image.background, color: event.target.value } })}
                      className="h-9 w-full cursor-pointer rounded-md border border-input bg-background"
                      aria-label={t("welcome.bgColor")}
                    />
                  )}
                  {draft.image.background.type === "gradient" && (
                    <div className="grid gap-3 sm:grid-cols-2">
                      <FieldRow label={t("welcome.gradientFrom")}>
                        <input
                          type="color"
                          value={draft.image.background.gradientFrom ?? "#1d4ed8"}
                          onChange={event =>
                            patchImage({
                              ...draft.image,
                              background: { ...draft.image.background, gradientFrom: event.target.value }
                            })
                          }
                          className="h-9 w-full cursor-pointer rounded-md border border-input bg-background"
                          aria-label={t("welcome.gradientFromAria")}
                        />
                      </FieldRow>
                      <FieldRow label={t("welcome.gradientTo")}>
                        <input
                          type="color"
                          value={draft.image.background.gradientTo ?? "#7c3aed"}
                          onChange={event =>
                            patchImage({
                              ...draft.image,
                              background: { ...draft.image.background, gradientTo: event.target.value }
                            })
                          }
                          className="h-9 w-full cursor-pointer rounded-md border border-input bg-background"
                          aria-label={t("welcome.gradientToAria")}
                        />
                      </FieldRow>
                    </div>
                  )}
                  {draft.image.background.type !== "transparent" && (
                    <FieldRow label={t("welcome.opacity", { percent: Math.round((draft.image.background.opacity ?? 1) * 100) })}>
                      <input
                        type="range"
                        min={0}
                        max={100}
                        value={Math.round((draft.image.background.opacity ?? 1) * 100)}
                        onChange={event =>
                          patchImage({
                            ...draft.image,
                            background: { ...draft.image.background, opacity: Number(event.target.value) / 100 }
                          })
                        }
                        className="w-full accent-primary"
                        aria-label={t("welcome.opacityAria")}
                      />
                    </FieldRow>
                  )}
                  {draft.image.background.type === "image" && (
                    draft.image.background.imageDataUrl ? (
                      <div className="flex items-center gap-2 rounded-lg border border-border/80 bg-muted/30 p-2">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={draft.image.background.imageDataUrl} alt="" className="size-10 rounded object-cover" />
                        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" dir="ltr">
                          {fileNames.background ?? "background.png"}
                        </span>
                        <Button variant="outline" size="sm" onClick={() => pickImage("background")}>{t("welcome.replace")}</Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-8 hover:text-destructive"
                          aria-label={t("welcome.removeBgImage")}
                          onClick={() => patchImage({ ...draft.image, background: { ...draft.image.background, type: "transparent", imageDataUrl: null } })}
                        >
                          <X />
                        </Button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="grid w-full place-items-center gap-1 rounded-xl border border-dashed border-border py-6 transition-colors hover:border-primary/50"
                        onClick={() => pickImage("background")}
                        onDragOver={event => event.preventDefault()}
                        onDrop={event => {
                          event.preventDefault();
                          imageInputTarget.current = "background";
                          void onFileChosen(event.dataTransfer.files?.[0]);
                        }}
                      >
                        <ImageIcon className="size-5 text-muted-foreground" aria-hidden />
                        <span className="text-sm font-medium">{t("welcome.uploadBg")}</span>
                      </button>
                    )
                  )}
                </>
              )}

              {canvasPanel === "avatar" && (
                <>
                  <label className="flex items-center justify-between gap-2 rounded-lg border border-border/80 px-3 py-2">
                    <span className="text-xs">{t("welcome.showAvatar")}</span>
                    <Switch
                      checked={draft.image.avatar.enabled}
                      onCheckedChange={enabled => patchImage({ ...draft.image, avatar: { ...draft.image.avatar, enabled } })}
                      aria-label={t("welcome.showAvatar")}
                    />
                  </label>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <FieldRow label={t("welcome.avatarSize", { px: draft.image.avatar.size })}>
                      <input
                        type="range"
                        min={16}
                        max={512}
                        value={draft.image.avatar.size}
                        onChange={event => patchImage({ ...draft.image, avatar: { ...draft.image.avatar, size: Number(event.target.value) } })}
                        className="w-full accent-primary"
                      />
                    </FieldRow>
                    <FieldRow label={t("welcome.avatarPosition", { x: draft.image.avatar.x, y: draft.image.avatar.y })}>
                      <div className="flex gap-2">
                        <Input type="number" min={0} max={draft.image.width} value={draft.image.avatar.x} onChange={event => patchImage({ ...draft.image, avatar: { ...draft.image.avatar, x: Number(event.target.value) } })} aria-label={t("welcome.horizontal")} />
                        <Input type="number" min={0} max={draft.image.height} value={draft.image.avatar.y} onChange={event => patchImage({ ...draft.image, avatar: { ...draft.image.avatar, y: Number(event.target.value) } })} aria-label={t("welcome.vertical")} />
                      </div>
                    </FieldRow>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <label className="flex items-center justify-between gap-2 rounded-lg border border-border/80 px-3 py-2 text-xs">
                      {t("welcome.circular")}
                      <Switch checked={draft.image.avatar.circular} onCheckedChange={circular => patchImage({ ...draft.image, avatar: { ...draft.image.avatar, circular } })} aria-label={t("welcome.circular")} />
                    </label>
                    <FieldRow label={t("welcome.ringColor")}>
                      <input
                        type="color"
                        value={draft.image.avatar.strokeColor ?? "#3b82f6"}
                        onChange={event => patchImage({ ...draft.image, avatar: { ...draft.image.avatar, strokeColor: event.target.value } })}
                        className="h-9 w-full cursor-pointer rounded-md border border-input bg-background"
                        aria-label={t("welcome.ringColorAria")}
                      />
                    </FieldRow>
                    <FieldRow label={t("welcome.ringWidth", { px: draft.image.avatar.strokeWidth })}>
                      <input
                        type="range"
                        min={0}
                        max={32}
                        value={draft.image.avatar.strokeWidth}
                        onChange={event => patchImage({ ...draft.image, avatar: { ...draft.image.avatar, strokeWidth: Number(event.target.value) } })}
                        className="w-full accent-primary"
                      />
                    </FieldRow>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <FieldRow label={t("welcome.glowColor")}>
                      <input
                        type="color"
                        value={draft.image.avatar.glowColor ?? "#3b82f6"}
                        onChange={event =>
                          patchImage({ ...draft.image, avatar: { ...draft.image.avatar, glowColor: event.target.value } })
                        }
                        className="h-9 w-full cursor-pointer rounded-md border border-input bg-background"
                        aria-label={t("welcome.glowColorAria")}
                      />
                    </FieldRow>
      <FieldRow label={t("welcome.glowSize", { px: draft.image.avatar.glowSize ?? 0 })}>
                        <input
                          type="range"
                          min={0}
                          max={128}
                          value={draft.image.avatar.glowSize ?? 0}
                          // The size comes with a colour: a glow without a
                          // colour is not drawn at all.
                          onChange={event =>
                            patchImage({
                              ...draft.image,
                              avatar: {
                                ...draft.image.avatar,
                                glowSize: Number(event.target.value),
                                glowColor: draft.image.avatar.glowColor ?? "#3b82f6"
                              }
                            })
                          }
                          className="w-full accent-primary"
                          aria-label={t("welcome.glowSizeAria")}
                        />
                      </FieldRow>
                  </div>
                </>
              )}

              {canvasPanel === "username" && (
                <div className="space-y-3">
                  <FieldRow label={t("welcome.usernameText")}>
                    <Input value={draft.image.username.text} onChange={event => patchTextLayer(draft.image.username.id, { text: event.target.value })} />
                  </FieldRow>
                  <TextStyleFields
                    layer={draft.image.username}
                    canvas={draft.image}
                    colourLabel={t("welcome.usernameColor")}
                    onPatch={patch => patchTextLayer(draft.image.username.id, patch)}
                  />
                </div>
              )}

              {canvasPanel === "custom" && (
                <div className="space-y-3">
                  <Button type="button" variant="outline" size="sm" onClick={addCustomText}>
                    <Plus /> {t("welcome.addCustomText")}
                  </Button>
                  {selectedCustom ? (
                    <div className="space-y-3 rounded-lg border border-border/80 p-3">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-medium">{t("welcome.selectedText")}</span>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-8 hover:text-destructive"
                          aria-label={t("welcome.deleteSelected")}
                          onClick={() => {
                            patchImage({ ...draft.image, customTexts: draft.image.customTexts.filter(layer => layer.id !== selectedCustom.id) });
                            setSelection(null);
                          }}
                        >
                          <Trash2 />
                        </Button>
                      </div>
                      <Input value={selectedCustom.text} onChange={event => patchTextLayer(selectedCustom.id, { text: event.target.value })} />
                      <TextStyleFields
                        layer={selectedCustom}
                        canvas={draft.image}
                        colourLabel={t("welcome.customTextColor")}
                        onPatch={patch => patchTextLayer(selectedCustom.id, patch)}
                      />
                    </div>
                  ) : (
                    <p className="rounded-lg border border-dashed border-border/80 px-3 py-4 text-center text-xs text-muted-foreground">
                      {t("welcome.selectLayerHint")}
                    </p>
                  )}
                </div>
              )}

              {canvasPanel === "canvas-settings" && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <FieldRow label={t("welcome.width", { px: draft.image.width })}>
                    <input
                      type="range"
                      min={128}
                      max={2048}
                      step={32}
                      value={draft.image.width}
                      onChange={event => patchImage({ ...draft.image, width: Number(event.target.value) })}
                      className="w-full accent-primary"
                    />
                  </FieldRow>
                  <FieldRow label={t("welcome.height", { px: draft.image.height })}>
                    <input
                      type="range"
                      min={128}
                      max={2048}
                      step={32}
                      value={draft.image.height}
                      onChange={event => patchImage({ ...draft.image, height: Number(event.target.value) })}
                      className="w-full accent-primary"
                    />
                  </FieldRow>
                  <FieldRow label={t("welcome.quality", { percent: Math.round(draft.image.quality * 100) })}>
                    <input
                      type="range"
                      min={50}
                      max={100}
                      value={Math.round(draft.image.quality * 100)}
                      onChange={event => patchImage({ ...draft.image, quality: Number(event.target.value) / 100 })}
                      className="w-full accent-primary"
                      disabled={draft.image.background.type === "transparent"}
                    />
                  </FieldRow>
                  <p className="self-center text-mini text-muted-foreground">
                    {draft.image.background.type === "transparent"
                      ? t("welcome.transparentExport")
                      : t("welcome.filledExport")}
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* Bottom floating unsaved-changes bar — the shared contract. */}

      <Toaster toasts={toasts} onDismiss={dismiss} />

      {dirty && (
        <SaveBar
          message={t("welcome.unsaved")}
          saveLabel={t("welcome.save")}
          cancelLabel={t("welcome.discard")}
          canSave={blockedReason === null}
          blockedMessage={blockedReason}
          onCancel={reset}
          onSave={async () => {
            const result = await api.saveWelcomeMessages(guild.id, draft);
            commit(result.settings);
            push({ title: t("welcome.saved"), tone: "success" });
          }}
        />
      )}
    </div>
  );
}

/**
 * The style fields of one text layer on the canvas.
 *
 * The username layer and every custom text layer are edited with the same
 * six controls - font, size, alignment, colour, weight and position - and the
 * screen used to write them out twice, field by field. The two copies drifted
 * (one of them lost a label), and every future change to the set had to be
 * made in both places.
 *
 * One component, one contract: the layer, the canvas it lives on (for the
 * position bounds), and a patch callback.
 */
function TextStyleFields({
  layer,
  canvas,
  colourLabel,
  onPatch
}: {
  layer: WelcomeTextLayer;
  canvas: { width: number; height: number };
  colourLabel: string;
  onPatch: (patch: Partial<WelcomeTextLayer>) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <FieldRow label={t("welcome.font")}>
        <Select value={layer.fontFamily} onValueChange={value => onPatch({ fontFamily: value })}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {WELCOME_FONT_FAMILIES.map(family => (
              <SelectItem key={family} value={family}>
                {family}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FieldRow>
      <FieldRow label={t("welcome.fontSize", { px: layer.fontSize })}>
        <input
          type="range"
          min={8}
          max={512}
          value={layer.fontSize}
          onChange={event => onPatch({ fontSize: Number(event.target.value) })}
          className="w-full accent-primary"
          aria-label={t("welcome.fontSizeAria")}
        />
      </FieldRow>
      <FieldRow label={t("welcome.align")}>
        <Select value={layer.align} onValueChange={value => onPatch({ align: value as WelcomeTextLayer["align"] })}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="start">{t("welcome.align.start")}</SelectItem>
            <SelectItem value="center">{t("welcome.align.center")}</SelectItem>
            <SelectItem value="end">{t("welcome.align.end")}</SelectItem>
          </SelectContent>
        </Select>
      </FieldRow>
      <FieldRow label={t("welcome.color")}>
        <input
          type="color"
          value={layer.color}
          onChange={event => onPatch({ color: event.target.value })}
          className="h-9 w-full cursor-pointer rounded-md border border-input bg-background"
          aria-label={colourLabel}
        />
      </FieldRow>
      <FieldRow label={t("welcome.weight")}>
        <Select value={layer.weight} onValueChange={value => onPatch({ weight: value as WelcomeTextLayer["weight"] })}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="normal">{t("welcome.weight.normal")}</SelectItem>
            <SelectItem value="bold">{t("welcome.weight.bold")}</SelectItem>
          </SelectContent>
        </Select>
      </FieldRow>
      <FieldRow label={t("welcome.positionXy", { x: layer.x, y: layer.y })}>
        <div className="flex gap-2">
          <Input type="number" min={0} max={canvas.width} value={layer.x} onChange={event => onPatch({ x: Number(event.target.value) })} aria-label={t("welcome.horizontal")} />
          <Input type="number" min={0} max={canvas.height} value={layer.y} onChange={event => onPatch({ y: Number(event.target.value) })} aria-label={t("welcome.vertical")} />
        </div>
      </FieldRow>
      <FieldRow label={t("welcome.strokeColor")}>
        <input
          type="color"
          value={layer.strokeColor ?? "#000000"}
          onChange={event => onPatch({ strokeColor: event.target.value })}
          className="h-9 w-full cursor-pointer rounded-md border border-input bg-background"
          aria-label={t("welcome.strokeColor")}
        />
      </FieldRow>
      <FieldRow label={t("welcome.strokeWidth", { px: layer.strokeWidth ?? 0 })}>
        <input
          type="range"
          min={0}
          max={16}
          value={layer.strokeWidth ?? 0}
          // The size comes with a colour: a stroke without a colour is not
          // drawn at all, so moving the slider alone did nothing.
          onChange={event =>
            onPatch({
              strokeWidth: Number(event.target.value),
              strokeColor: layer.strokeColor ?? "#000000"
            })
          }
          className="w-full accent-primary"
          aria-label={t("welcome.strokeWidthAria")}
        />
      </FieldRow>
      <FieldRow label={t("welcome.shadowColor")}>
        <input
          type="color"
          value={layer.shadowColor ?? "#000000"}
          onChange={event => onPatch({ shadowColor: event.target.value })}
          className="h-9 w-full cursor-pointer rounded-md border border-input bg-background"
          aria-label={t("welcome.shadowColorAria")}
        />
      </FieldRow>
      <FieldRow label={t("welcome.shadowSize", { px: layer.shadowSize ?? 0 })}>
        <input
          type="range"
          min={0}
          max={64}
          value={layer.shadowSize ?? 0}
          onChange={event =>
            onPatch({
              shadowSize: Number(event.target.value),
              shadowColor: layer.shadowColor ?? "#000000"
            })
          }
          className="w-full accent-primary"
          aria-label={t("welcome.shadowSizeAria")}
        />
      </FieldRow>
      <FieldRow label={t("welcome.letterSpacing", { px: layer.letterSpacing ?? 0 })}>
        <input
          type="range"
          min={-20}
          max={40}
          value={layer.letterSpacing ?? 0}
          onChange={event => onPatch({ letterSpacing: Number(event.target.value) })}
          className="w-full accent-primary"
          aria-label={t("welcome.letterSpacingAria")}
        />
      </FieldRow>
    </div>
  );
}
