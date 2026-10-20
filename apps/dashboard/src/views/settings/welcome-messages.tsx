import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, Image as ImageIcon, Info, Plus, Trash2, Upload, X } from "lucide-react";
import { api } from "@/api";
import { useDraftForm } from "@/lib/use-draft-form";
import { LoadError, LoadingRow } from "@/components/view-states";
import { SaveBar } from "@/components/save-bar";
import { Toaster, useToasts } from "@/components/toaster";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import type { ChannelOption, Guild, WelcomeEmbedField, WelcomeMessageSettings, WelcomeTextLayer } from "@/types";

type Tab = "settings" | "message" | "image";
type CanvasPanel = "background" | "avatar" | "username" | "custom" | "canvas-settings";
type Selection =
  | { kind: "avatar" }
  | { kind: "username" }
  | { kind: "custom"; id: string }
  | null;

const IMAGE_SEND_LABELS: Record<WelcomeMessageSettings["imageMode"], string> = {
  with_message: "مع رسالة الترحيب",
  before_message: "قبل رسالة الترحيب",
  separate_channel: "إلى قناة منفصلة"
};

const NONE = "__none__";

/** Reads an image file into a capped data URL, or fails with an Arabic reason. */
function readImageAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!/^image\/(png|jpeg|jpg|webp|gif)$/.test(file.type)) {
      reject(new Error("صيغة الصورة غير مدعومة. استخدم PNG أو JPEG أو WEBP أو GIF."));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      if (dataUrl.length > MAX_IMAGE_BYTES) {
        reject(new Error("حجم الصورة يتجاوز الحد المسموح (500 كيلوبايت تقريباً). صغّرها ثم أعد المحاولة."));
        return;
      }
      resolve(dataUrl);
    };
    reader.onerror = () => reject(new Error("تعذّر قراءة الصورة."));
    reader.readAsDataURL(file);
  });
}

/**
 * رسائل الترحيب — three tabs over one draft: what is sent and where
 * (الإعدادات), the message and its embed (الرسالة), and the generated card
 * (الصورة). One `useDraftForm`, one save bar, exactly the contract every
 * other settings screen keeps.
 */
export function WelcomeMessagesView({ guild }: { guild: Guild }) {
  const [tab, setTab] = useState<Tab>("settings");
  const [settings, setSettings] = useState<WelcomeMessageSettings | null>(null);
  const [channels, setChannels] = useState<ChannelOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [canvasPanel, setCanvasPanel] = useState<CanvasPanel>("background");
  const [selection, setSelection] = useState<Selection>(null);
  const { draft, dirty, patch, reset, commit } = useDraftForm(settings);
  const { toasts, push, dismiss } = useToasts();

  // Caret targets: every text field that accepts tokens keeps a ref so the
  // strip inserts where the operator's cursor is, not at the end.
  const textRef = useRef<HTMLTextAreaElement>(null);
  const contentRef = useRef<HTMLTextAreaElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
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
      })
      .catch(cause => !cancelled && setError(cause instanceof Error ? cause.message : "تعذّر التحميل."));
    return () => {
      cancelled = true;
    };
  }, [guild.id]);

  const sampleValues = useMemo(
    () => ({
      userMention: "@العضو",
      username: "اسم_المستخدِم",
      server: guild.name,
      memberCount: guild.memberCount ?? 1234,
      inviterMention: "@الداعي",
      joinDate: new Date().toLocaleDateString("ar", { year: "numeric", month: "long", day: "numeric" })
    }),
    [guild.name, guild.memberCount]
  );

  if (error) return <LoadError message={error} />;
  if (!settings || !draft) return <LoadingRow />;

  const channelSelect = (value: string) => (value === NONE ? null : value);

  const tabs: { key: Tab; label: string }[] = [
    { key: "settings", label: "الإعدادات" },
    { key: "message", label: "الرسالة" },
    { key: "image", label: "الصورة" }
  ];

  /* ---------------- embed helpers ---------------- */
  const patchEmbed = (partial: Partial<WelcomeMessageSettings["embed"]>) => patch({ embed: { ...draft.embed, ...partial } });

  const addField = () => {
    if (draft.embed.fields.length >= 10) {
      push({ title: "الحد الأعلى 10 حقول للإيمبد الواحد.", tone: "error" });
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
      const dataUrl = await readImageAsDataUrl(file);
      if (imageInputTarget.current === "background") {
        patchImage({ ...draft.image, background: { ...draft.image.background, type: "image", imageDataUrl: dataUrl } });
        setFileNames(current => ({ ...current, background: file.name }));
      } else {
        patchEmbed({ imageMode: "upload", imageDataUrl: dataUrl });
        setFileNames(current => ({ ...current, embed: file.name }));
      }
    } catch (cause) {
      push({ title: cause instanceof Error ? cause.message : "تعذّر قراءة الصورة.", tone: "error" });
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
      push({ title: `الحد الأعلى ${MAX_WELCOME_CUSTOM_TEXTS} نصوص مخصصة.`, tone: "error" });
      return;
    }
    const id = `text-${Date.now()}`;
    const layer: WelcomeTextLayer = {
      id,
      text: "نص جديد",
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
  const usernameSelected = selection?.kind === "username";

  const canvasPanels: { key: CanvasPanel; label: string }[] = [
    { key: "background", label: "الخلفية" },
    { key: "avatar", label: "الصورة الرمزية" },
    { key: "username", label: "اسم المستخدم" },
    { key: "custom", label: "نص مخصص" },
    { key: "canvas-settings", label: "الإعدادات" }
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

      {/* Tab strip — the horizontal scroll contract from the commands screen. */}
      <div role="tablist" aria-label="أقسام رسائل الترحيب" className="scrollbar-none flex gap-1 overflow-x-auto rounded-xl border border-border/80 bg-card/70 p-1.5">
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
                تفعيل رسالة الترحيب
              </span>
              <Switch checked={draft.enabled} onCheckedChange={enabled => patch({ enabled })} aria-label="تفعيل رسالة الترحيب" />
            </label>

            <label className="flex items-center justify-between gap-2 rounded-lg border border-border/80 px-3 py-2">
              <span className="flex items-center gap-2 text-sm">
                <Info className="size-3.5 text-muted-foreground" aria-hidden />
                تفعيل صورة الترحيب
              </span>
              <Switch checked={draft.imageEnabled} onCheckedChange={imageEnabled => patch({ imageEnabled })} aria-label="تفعيل صورة الترحيب" />
            </label>

            {draft.imageEnabled && (
              <Alert>
                <Info className="size-4" />
                <AlertDescription>
                  يمكن إرسال صورة الترحيب مع الإيمبد في الرسالة نفسها. تفعيل الصورة لم يعد يخفي الإيمبد أو يعطله.
                </AlertDescription>
              </Alert>
            )}

            {draft.imageEnabled && (
              <>
                <FieldRow label="إرسال الصورة:">
                  <Select
                    value={draft.imageMode}
                    onValueChange={value => patch({ imageMode: value as WelcomeMessageSettings["imageMode"], imageChannelId: value === "separate_channel" ? draft.imageChannelId : null })}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(Object.keys(IMAGE_SEND_LABELS) as WelcomeMessageSettings["imageMode"][]).map(mode => (
                        <SelectItem key={mode} value={mode}>
                          {IMAGE_SEND_LABELS[mode]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FieldRow>

                {draft.imageMode === "separate_channel" && (
                  <FieldRow label="اختر قناة الصورة:">
                    <Select
                      value={draft.imageChannelId ?? NONE}
                      onValueChange={value => patch({ imageChannelId: channelSelect(value) })}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="اختر قناة..." />
                      </SelectTrigger>
                      <SelectContent>
                        {channels.map(channel => (
                          <SelectItem key={channel.id} value={channel.id}>
                            #{channel.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FieldRow>
                )}
              </>
            )}

            <FieldRow label="قناة الترحيب">
              <Select value={draft.channelId ?? NONE} onValueChange={value => patch({ channelId: channelSelect(value) })}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="اختر قناة..." />
                </SelectTrigger>
                <SelectContent>
                  {channels.map(channel => (
                    <SelectItem key={channel.id} value={channel.id}>
                      #{channel.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
              نص فقط
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
              رسالة Embed
            </button>
          </div>

          {draft.mode === "text" ? (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">رسالة الترحيب (نص عادي)</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="relative">
                  <Textarea
                    ref={textRef}
                    rows={4}
                    value={draft.text}
                    onChange={event => patch({ text: event.target.value })}
                    className="rounded-xl text-sm"
                  />
                  <span className="absolute top-2 start-2">
                    <EmojiPicker label="إدراج إيموجي" onPick={emoji => patch({ text: insertAtCursor(textRef.current, draft.text, emoji) })} />
                  </span>
                </div>
                <div className="space-y-1">
                  <span className="text-[11px] text-muted-foreground">المتغيرات المتاحة:</span>
                  <TokenStrip onInsert={token => patch({ text: insertAtCursor(textRef.current, draft.text, token) })} activeRef={textRef} />
                </div>
              </CardContent>
            </Card>
          ) : (
            <Card className="border-primary/20 bg-card/70 shadow-lg shadow-primary/5 backdrop-blur-sm">
              <CardHeader className="pb-3">
                <CardTitle className="text-base">المعاينة الحية — محرر موضعي</CardTitle>
                <CardDescription>
                  كل عنصر يُحرَّر مباشرة على البطاقة كما سيراه العضو. زر العين يجعلها معاينة نظيفة، وشريط المتغيرات يُدرج عند
                  مؤشر آخر حقل لمسته.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="rounded-lg bg-[#2b2d31] p-4">
                  <EmbedEditor
                    botName="AL AI"
                    botAvatarUrl={null}
                    embed={draft.embed}
                    onEmbedChange={patchEmbed}
                    values={sampleValues}
                    imageUpload={{
                      imageDataUrl: draft.embed.imageDataUrl,
                      fileName: fileNames.embed ?? "welcome-image.png",
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
                    ? "جاهز للحفظ والإرسال"
                    : "أضف عنواناً أو وصفاً أو حقلاً حتى يصبح الإيمبد جاهزاً"}
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
                صورة الترحيب معطّلة في تبويب «الإعدادات» — فعّلها ليراها البوت. التصميم هنا يُحفظ ويُطبَّق لحظة التفعيل.
              </AlertDescription>
            </Alert>
          )}

          <Card className="border-primary/20 bg-card/70 shadow-lg shadow-primary/5 backdrop-blur-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">مصمم الصورة</CardTitle>
              <CardDescription>معاينة حية بالأبعاد الحقيقية — اسحب الطبقات لتحريكها، والمقبض الدائري لتغيير حجمها.</CardDescription>
            </CardHeader>
            <CardContent>
              <WelcomeImageCanvas
                config={draft.image}
                values={sampleValues}
                selected={selection}
                onSelect={setSelection}
                onConfigChange={patchImage}
              />
            </CardContent>
          </Card>

          {/* Element control sub-tabs */}
          <div className="scrollbar-none flex gap-1 overflow-x-auto rounded-xl border border-border/80 bg-card/70 p-1.5">
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
                  <FieldRow label="نوع الخلفية">
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
                        <SelectItem value="transparent">شفافة</SelectItem>
                        <SelectItem value="color">لون</SelectItem>
                        <SelectItem value="image">صورة مرفوعة</SelectItem>
                      </SelectContent>
                    </Select>
                  </FieldRow>
                  {draft.image.background.type === "color" && (
                    <input
                      type="color"
                      value={draft.image.background.color ?? "#0b1020"}
                      onChange={event => patchImage({ ...draft.image, background: { ...draft.image.background, color: event.target.value } })}
                      className="h-9 w-full cursor-pointer rounded-md border border-input bg-background"
                      aria-label="لون الخلفية"
                    />
                  )}
                  {draft.image.background.type === "image" && (
                    draft.image.background.imageDataUrl ? (
                      <div className="flex items-center gap-2 rounded-lg border border-border/80 bg-muted/30 p-2">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={draft.image.background.imageDataUrl} alt="" className="size-10 rounded object-cover" />
                        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" dir="ltr">
                          {fileNames.background ?? "background.png"}
                        </span>
                        <Button variant="outline" size="sm" onClick={() => pickImage("background")}>استبدال</Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-8 hover:text-destructive"
                          aria-label="إزالة صورة الخلفية"
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
                        <span className="text-sm font-medium">رفع صورة الخلفية</span>
                      </button>
                    )
                  )}
                </>
              )}

              {canvasPanel === "avatar" && (
                <>
                  <label className="flex items-center justify-between gap-2 rounded-lg border border-border/80 px-3 py-2">
                    <span className="text-xs">إظهار الصورة الرمزية</span>
                    <Switch
                      checked={draft.image.avatar.enabled}
                      onCheckedChange={enabled => patchImage({ ...draft.image, avatar: { ...draft.image.avatar, enabled } })}
                      aria-label="إظهار الصورة الرمزية"
                    />
                  </label>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <FieldRow label={`الحجم: ${draft.image.avatar.size}px`}>
                      <input
                        type="range"
                        min={16}
                        max={512}
                        value={draft.image.avatar.size}
                        onChange={event => patchImage({ ...draft.image, avatar: { ...draft.image.avatar, size: Number(event.target.value) } })}
                        className="w-full accent-primary"
                      />
                    </FieldRow>
                    <FieldRow label={`X: ${draft.image.avatar.x} · Y: ${draft.image.avatar.y}`}>
                      <div className="flex gap-2">
                        <Input type="number" min={0} max={draft.image.width} value={draft.image.avatar.x} onChange={event => patchImage({ ...draft.image, avatar: { ...draft.image.avatar, x: Number(event.target.value) } })} aria-label="الموضع الأفقي" />
                        <Input type="number" min={0} max={draft.image.height} value={draft.image.avatar.y} onChange={event => patchImage({ ...draft.image, avatar: { ...draft.image.avatar, y: Number(event.target.value) } })} aria-label="الموضع الرأسي" />
                      </div>
                    </FieldRow>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <label className="flex items-center justify-between gap-2 rounded-lg border border-border/80 px-3 py-2 text-xs">
                      قص دائري
                      <Switch checked={draft.image.avatar.circular} onCheckedChange={circular => patchImage({ ...draft.image, avatar: { ...draft.image.avatar, circular } })} aria-label="قص دائري" />
                    </label>
                    <FieldRow label="لون الحلقة">
                      <input
                        type="color"
                        value={draft.image.avatar.strokeColor ?? "#3b82f6"}
                        onChange={event => patchImage({ ...draft.image, avatar: { ...draft.image.avatar, strokeColor: event.target.value } })}
                        className="h-9 w-full cursor-pointer rounded-md border border-input bg-background"
                        aria-label="لون حلقة الصورة"
                      />
                    </FieldRow>
                    <FieldRow label={`سماكة الحلقة: ${draft.image.avatar.strokeWidth}px`}>
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
                </>
              )}

              {canvasPanel === "username" && (
                <div className="space-y-3">
                  <FieldRow label="النص (يدعم المتغيرات)">
                    <Input value={draft.image.username.text} onChange={event => patchTextLayer(draft.image.username.id, { text: event.target.value })} />
                  </FieldRow>
                  <TextStyleFields
                    layer={draft.image.username}
                    canvas={draft.image}
                    colourLabel="لون اسم المستخدم"
                    onPatch={patch => patchTextLayer(draft.image.username.id, patch)}
                  />
                </div>
              )}

              {canvasPanel === "custom" && (
                <div className="space-y-3">
                  <Button type="button" variant="outline" size="sm" onClick={addCustomText}>
                    <Plus /> إضافة نص مخصص
                  </Button>
                  {selectedCustom ? (
                    <div className="space-y-3 rounded-lg border border-border/80 p-3">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-medium">النص المحدد (يدعم المتغيرات)</span>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-8 hover:text-destructive"
                          aria-label="حذف النص المحدد"
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
                        colourLabel="لون النص"
                        onPatch={patch => patchTextLayer(selectedCustom.id, patch)}
                      />
                    </div>
                  ) : (
                    <p className="rounded-lg border border-dashed border-border/80 px-3 py-4 text-center text-xs text-muted-foreground">
                      اختر نصاً من اللوحة أو أضف نصاً جديداً لتحريره.
                    </p>
                  )}
                </div>
              )}

              {canvasPanel === "canvas-settings" && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <FieldRow label={`العرض: ${draft.image.width}px`}>
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
                  <FieldRow label={`الارتفاع: ${draft.image.height}px`}>
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
                  <FieldRow label={`جودة التصدير: ${Math.round(draft.image.quality * 100)}%`}>
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
                  <p className="self-center text-[11px] text-muted-foreground">
                    {draft.image.background.type === "transparent"
                      ? "الخلفية الشفافة تُصدَّر PNG دائماً — الجودة تنطبق على الخلفيات المعبأة (JPEG)."
                      : "الخلفية المعبأة تُصدَّر JPEG بهذه الجودة."}
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* Bottom floating unsaved-changes bar — the shared contract. */}
      {dirty && (
        <SaveBar
          message="لديك تغييرات غير محفوظة"
          saveLabel="حفظ التغييرات"
          cancelLabel="تجاهل"
          onCancel={reset}
          onSave={async () => {
            const result = await api.saveWelcomeMessages(guild.id, draft);
            commit(result.settings);
            push({ title: "حُفظت رسائل الترحيب — تُطبَّق على البوت خلال نصف دقيقة.", tone: "success" });
          }}
        />
      )}

      <Toaster toasts={toasts} onDismiss={dismiss} />
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
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <FieldRow label="الخط">
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
      <FieldRow label={`الحجم: ${layer.fontSize}px`}>
        <input
          type="range"
          min={8}
          max={512}
          value={layer.fontSize}
          onChange={event => onPatch({ fontSize: Number(event.target.value) })}
          className="w-full accent-primary"
          aria-label="حجم الخط"
        />
      </FieldRow>
      <FieldRow label="المحاذاة">
        <Select value={layer.align} onValueChange={value => onPatch({ align: value as WelcomeTextLayer["align"] })}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="start">بداية</SelectItem>
            <SelectItem value="center">وسط</SelectItem>
            <SelectItem value="end">نهاية</SelectItem>
          </SelectContent>
        </Select>
      </FieldRow>
      <FieldRow label="اللون">
        <input
          type="color"
          value={layer.color}
          onChange={event => onPatch({ color: event.target.value })}
          className="h-9 w-full cursor-pointer rounded-md border border-input bg-background"
          aria-label={colourLabel}
        />
      </FieldRow>
      <FieldRow label="الوزن">
        <Select value={layer.weight} onValueChange={value => onPatch({ weight: value as WelcomeTextLayer["weight"] })}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="normal">عادي</SelectItem>
            <SelectItem value="bold">عريض</SelectItem>
          </SelectContent>
        </Select>
      </FieldRow>
      <FieldRow label={`X: ${layer.x} · Y: ${layer.y}`}>
        <div className="flex gap-2">
          <Input type="number" min={0} max={canvas.width} value={layer.x} onChange={event => onPatch({ x: Number(event.target.value) })} aria-label="الموضع الأفقي" />
          <Input type="number" min={0} max={canvas.height} value={layer.y} onChange={event => onPatch({ y: Number(event.target.value) })} aria-label="الموضع الرأسي" />
        </div>
      </FieldRow>
    </div>
  );
}