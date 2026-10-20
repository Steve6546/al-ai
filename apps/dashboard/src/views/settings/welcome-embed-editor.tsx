import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Link2, Plus, SmilePlus, Trash2, Upload, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { renderWelcomeMessage, WELCOME_MESSAGE_TOKENS, WELCOME_TOKEN_LABELS_AR, type WelcomeEmbed, type WelcomeTemplateValues } from "@al-ai/core/browser";
import type { WelcomeEmbedField } from "@/types";

/**
 * The in-place WYSIWYG embed editor.
 *
 * Everything the operator edits — title, its link, the accent colour, the
 * thumbnail, the description, the custom fields, the big image, the footer
 * and its timestamp — lives directly ON the Discord-shaped card, the way the
 * member will see it. There is no second form: the card IS the form, and the
 * eye toggle on the action bar hides every editing affordance for a clean
 * read-only look.
 *
 * Discord's own surface colours (#2b2d31 / #2f3136) are used inside the card
 * because the card is a picture of Discord; every control AROUND the card
 * (action bar, popovers, chips) uses the platform's tokens.
 */

/** A common, hand-picked emoji set — enough for a greeting, no dependency. */
const EMOJI_SET = [
  "👋", "🎉", "✨", "🌟", "💫", "🔥", "❤️", "💚", "💙", "🧡",
  "🙏", "👏", "🙌", "🤝", "😎", "🥳", "😄", "😊", "🙂", "😉",
  "👑", "🎮", "🎧", "🚀", "⚡", "🍀", "🌹", "🕊️", "☕", "🍕"
] as const;

/** Inserts text at the caret of a field, restoring focus and caret afterwards. */
function insertAtCursor(
  element: HTMLTextAreaElement | HTMLInputElement | null,
  current: string,
  insertion: string
): string {
  if (!element) return current + insertion;
  const start = element.selectionStart ?? current.length;
  const end = element.selectionEnd ?? start;
  const caret = start + insertion.length;
  requestAnimationFrame(() => {
    element.focus();
    element.setSelectionRange(caret, caret);
  });
  return `${current.slice(0, start)}${insertion}${current.slice(end)}`;
}

/** A textarea that grows with its content — no scrollbar, no fixed rows. */
function AutoTextarea({
  value,
  onValueChange,
  className,
  placeholder,
  maxLength,
  onFocus,
  "aria-label": ariaLabel
}: {
  value: string;
  onValueChange: (next: string) => void;
  className?: string;
  placeholder?: string;
  maxLength?: number;
  onFocus?: () => void;
  "aria-label"?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  }, [value]);
  return (
    <textarea
      ref={ref}
      rows={1}
      value={value}
      maxLength={maxLength}
      placeholder={placeholder}
      aria-label={ariaLabel}
      onFocus={onFocus}
      onChange={event => onValueChange(event.target.value)}
      className={cn(
        "w-full resize-none overflow-hidden rounded-md bg-transparent px-1 py-0.5 text-[#dbdee1] outline-none transition-colors placeholder:text-[#6d6f78] hover:bg-black/20 focus:bg-black/30",
        className
      )}
    />
  );
}

function EmojiButton({ label, onPick, className }: { label: string; onPick: (emoji: string) => void; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span className={cn("relative inline-block", className)}>
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        className="grid size-6 place-items-center rounded text-[#949ba4] transition-colors hover:bg-black/30 hover:text-white"
        onClick={() => setOpen(value => !value)}
      >
        <SmilePlus className="size-3.5" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-hidden />
          <div className="animate-in fade-in slide-in-from-bottom-1 absolute bottom-full z-50 mb-1 grid w-72 grid-cols-10 gap-0.5 rounded-xl border border-border bg-popover p-2 shadow-xl start-0">
            {EMOJI_SET.map(emoji => (
              <button
                key={emoji}
                type="button"
                className="grid size-6 place-items-center rounded hover:bg-accent"
                onClick={() => {
                  onPick(emoji);
                  setOpen(false);
                }}
              >
                {emoji}
              </button>
            ))}
          </div>
        </>
      )}
    </span>
  );
}

/** The floating token strip: inserts into whichever field held focus last. */
function FocusTokenStrip({ targetRef }: { targetRef: { current: ((token: string) => void) | null } }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-t border-border/60 pt-2">
      <button
        type="button"
        aria-expanded={open}
        className={cn(
          "rounded-md border px-2 py-0.5 font-mono text-[11px] transition-colors",
          open ? "border-primary/60 bg-primary/10 text-primary" : "border-border/80 text-muted-foreground hover:text-foreground"
        )}
        onClick={() => setOpen(value => !value)}
      >
        {"{ }"} المتغيرات
      </button>
      {open &&
        WELCOME_MESSAGE_TOKENS.map(token => (
          <button
            key={token}
            type="button"
            dir="ltr"
            title={WELCOME_TOKEN_LABELS_AR[token as keyof typeof WELCOME_TOKEN_LABELS_AR]}
            className="rounded-md border border-border/80 bg-muted/40 px-2 py-0.5 font-mono text-[11px] text-muted-foreground transition-colors hover:border-primary/50 hover:text-primary"
            onClick={() => {
              targetRef.current?.(token);
              setOpen(false);
            }}
          >
            {token}
          </button>
        ))}
      <span className="text-[10px] text-muted-foreground">تُدرج عند مؤشر الكتابة في آخر حقل لمسته</span>
    </div>
  );
}

export type EmbedEditorProps = {
  botName: string;
  botAvatarUrl: string | null;
  embed: WelcomeEmbed;
  /** Write-back into the shared draft — the editor owns no copy of its own. */
  onEmbedChange: (patch: Partial<WelcomeEmbed>) => void;
  /** Sample facts the tokens resolve against in the display text. */
  values: WelcomeTemplateValues;
  /* The big-image upload plumbing stays with the screen (file input + naming). */
  imageUpload: {
    imageDataUrl: string | null;
    fileName: string;
    onPickFile: () => void;
    onFileDrop: (file: File | undefined) => void;
    onRemove: () => void;
  };
  onAddField: () => void;
  onPatchField: (id: string, patch: Partial<WelcomeEmbedField>) => void;
  onRemoveField: (id: string) => void;
};

export function EmbedEditor({
  botName,
  botAvatarUrl,
  embed,
  onEmbedChange,
  values,
  imageUpload,
  onAddField,
  onPatchField,
  onRemoveField
}: EmbedEditorProps) {
  // The eye on the action bar hides every editing affordance: the card reads
  // exactly like the message a member receives.
  const [chromeOn, setChromeOn] = useState(true);
  const [titleLinkOpen, setTitleLinkOpen] = useState(embed.titleUrl !== null);
  const [titleLinkDraft, setTitleLinkDraft] = useState(embed.titleUrl ?? "");
  const [colorOpen, setColorOpen] = useState(false);
  const [footerIconOpen, setFooterIconOpen] = useState(embed.footerIconUrl !== null);
  const [footerIconDraft, setFooterIconDraft] = useState(embed.footerIconUrl ?? "");
  // Tracks which field the token strip inserts into.
  const insertTarget = useRef<((token: string) => void) | null>(null);

  const accent = /^#[0-9a-fA-F]{3,6}$/.test(embed.color ?? "") ? embed.color! : "#4e5058";
  const now = new Date();

  // Inline field rows: inline fields flow side-by-side the way Discord lays
  // them out, a non-inline one always starts a fresh row.
  const rows: WelcomeEmbedField[][] = [];
  let row: WelcomeEmbedField[] = [];
  for (const field of embed.fields) {
    row.push(field);
    if (!field.inline || row.length === 3) {
      rows.push(row);
      row = [];
    }
  }
  if (row.length) rows.push(row);

  const chrome = (enabled: boolean) => !chromeOn || !enabled;

  return (
    <div className="flex gap-3" dir="ltr">
      {/* -------- Action bar: eye (clean preview) + accent colour swatch -------- */}
      <div className="flex flex-col items-center gap-2">
        <span className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-full bg-[#5865f2]/40 text-[10px] text-[#dbdee1]">
          {botAvatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={botAvatarUrl} alt="" className="size-full object-cover" />
          ) : (
            "AI"
          )}
        </span>
        <button
          type="button"
          aria-label={chromeOn ? "معاينة نظيفة بدون أدوات التحرير" : "إظهار أدوات التحرير"}
          aria-pressed={chromeOn}
          className={cn(
            "grid size-7 place-items-center rounded-md border transition-colors",
            chromeOn ? "border-primary/50 bg-primary/10 text-primary" : "border-border/80 text-muted-foreground hover:text-foreground"
          )}
          onClick={() => setChromeOn(value => !value)}
        >
          {chromeOn ? "✎" : "👁"}
        </button>
        <span className="relative">
          <button
            type="button"
            aria-label="لون الشريط الجانبي"
            aria-expanded={colorOpen}
            className="grid size-7 place-items-center overflow-hidden rounded-md border border-border/80 shadow-inner transition-transform hover:scale-105"
            onClick={() => setColorOpen(value => !value)}
          >
            <span className="size-full" style={{ background: accent }} aria-hidden />
          </button>
          {colorOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setColorOpen(false)} aria-hidden />
              <div className="animate-in fade-in slide-in-from-bottom-1 absolute top-full z-50 mt-1 space-y-2 rounded-xl border border-border bg-popover p-3 shadow-xl start-0">
                <input
                  type="color"
                  value={accent}
                  onChange={event => onEmbedChange({ color: event.target.value })}
                  className="h-8 w-full cursor-pointer rounded-md border border-input bg-background"
                  aria-label="منتقي لون الشريط"
                />
                <input
                  dir="ltr"
                  value={embed.color ?? ""}
                  onChange={event => onEmbedChange({ color: event.target.value })}
                  placeholder="#3b82f6"
                  maxLength={7}
                  className="w-full rounded-lg border border-input bg-background px-2 py-1 font-mono text-xs"
                  aria-label="اللون بصيغة HEX"
                />
              </div>
            </>
          )}
        </span>
      </div>

      {/* -------- The message body -------- */}
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center gap-2">
          <span className="text-sm font-semibold text-white" dir="ltr">{botName}</span>
          <span className="rounded bg-[#5865f2] px-1 py-px text-[9px] font-bold uppercase text-white">Bot</span>
          <span className="text-[11px] text-[#949ba4]">
            Today at {now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
          </span>
        </div>

        {embed.content || chromeOn ? (
          <div className="mb-2">
            <AutoTextarea
              value={embed.content}
              onValueChange={content => onEmbedChange({ content })}
              placeholder={chromeOn ? "نص عادي فوق الإيمبد (اختياري)…" : undefined}
              maxLength={2000}
              aria-label="نص فوق الإيمبد"
              onFocus={() => {
                insertTarget.current = token =>
                  onEmbedChange({ content: insertAtCursor(document.activeElement as HTMLTextAreaElement, embed.content, token) });
              }}
              className="text-sm"
            />
          </div>
        ) : null}

        {/* The embed card itself */}
        {embed.title || embed.description || embed.fields.length > 0 || embed.imageMode !== "none" || chromeOn ? (
          <div className="relative overflow-hidden rounded bg-[#2f3136] ps-4" style={{ borderInlineStart: `4px solid ${accent}` }}>
            <div className="flex gap-3 p-3">
              <div className="min-w-0 flex-1 space-y-2">
                {/* Title + its link toggle */}
                <div className="space-y-1">
                  <div className="group/title flex items-center gap-1.5">
                    <AutoTextarea
                      value={embed.title}
                      onValueChange={title => onEmbedChange({ title })}
                      placeholder={chromeOn ? "عنوان الإيمبد…" : undefined}
                      maxLength={256}
                      aria-label="عنوان الإيمبد"
                      onFocus={() => {
                        insertTarget.current = token =>
                          onEmbedChange({ title: insertAtCursor(document.activeElement as HTMLTextAreaElement, embed.title, token) });
                      }}
                      className={cn("text-sm font-semibold", embed.titleUrl ? "text-[#00a8fc] underline decoration-[#00a8fc]/40" : "text-[#00a8fc]")}
                    />
                    <button
                      type="button"
                      aria-label="رابط العنوان"
                      aria-expanded={titleLinkOpen}
                      className={cn(
                        "grid size-6 shrink-0 place-items-center rounded text-[#949ba4] transition-colors hover:bg-black/30 hover:text-white",
                        chrome(true) && "opacity-0 group-hover/title:opacity-100",
                        titleLinkOpen && "text-[#00a8fc] opacity-100"
                      )}
                      onClick={() => {
                        if (titleLinkOpen) {
                          // Toggling off detaches the link entirely.
                          onEmbedChange({ titleUrl: null });
                          setTitleLinkDraft("");
                          setTitleLinkOpen(false);
                        } else {
                          setTitleLinkOpen(true);
                        }
                      }}
                    >
                      <Link2 className="size-3.5" />
                    </button>
                  </div>
                  {titleLinkOpen && chromeOn && (
                    <div className="animate-in fade-in slide-in-from-bottom-1 flex items-center gap-1.5 rounded-lg border border-border/60 bg-black/30 p-1.5">
                      <button
                        type="button"
                        aria-label="تأكيد الرابط"
                        className="grid size-6 shrink-0 place-items-center rounded bg-primary text-primary-foreground transition-colors hover:bg-primary/90"
                        onClick={() => {
                          const url = titleLinkDraft.trim();
                          onEmbedChange({ titleUrl: /^https:\/\//.test(url) ? url : null });
                        }}
                      >
                        <Check className="size-3.5" />
                      </button>
                      <input
                        dir="ltr"
                        value={titleLinkDraft}
                        onChange={event => setTitleLinkDraft(event.target.value)}
                        placeholder="https://..."
                        maxLength={512}
                        className="min-w-0 flex-1 rounded bg-transparent px-1 text-xs text-[#dbdee1] outline-none placeholder:text-[#6d6f78]"
                        aria-label="رابط العنوان"
                      />
                      {embed.titleUrl ? (
                        <span className="shrink-0 text-[10px] text-success" aria-label="الرابط مفعّل">✓</span>
                      ) : null}
                    </div>
                  )}
                </div>

                {/* Description with its emoji trigger */}
                <div className="group/desc relative">
                  <AutoTextarea
                    value={embed.description}
                    onValueChange={description => onEmbedChange({ description })}
                    placeholder={chromeOn ? "وصف الإيمبد…" : undefined}
                    maxLength={4000}
                    aria-label="وصف الإيمبد"
                    onFocus={() => {
                      insertTarget.current = token =>
                        onEmbedChange({ description: insertAtCursor(document.activeElement as HTMLTextAreaElement, embed.description, token) });
                    }}
                    className="text-sm"
                  />
                  {chrome(true) && (
                    <EmojiButton
                      label="إدراج إيموجي في الوصف"
                      className="absolute bottom-0 end-0"
                      onPick={emoji => onEmbedChange({ description: `${embed.description}${emoji}` })}
                    />
                  )}
                </div>

                {/* Custom fields, laid out like Discord renders them */}
                {rows.map((row, rowIndex) => (
                  <div key={rowIndex} className={cn("grid gap-2", row.length === 3 ? "grid-cols-3" : row.length === 2 ? "grid-cols-2" : "grid-cols-1")}>
                    {row.map(field => (
                      <div
                        key={field.id}
                        className={cn(
                          "group/field min-w-0 rounded-md border border-transparent p-1 transition-colors",
                          chromeOn && "hover:border-dashed hover:border-border"
                        )}
                      >
                        <div className="flex items-center gap-1">
                          <input
                            value={field.name}
                            maxLength={256}
                            placeholder={chromeOn ? "اسم الحقل" : undefined}
                            aria-label={`اسم الحقل ${field.name || ""}`}
                            onFocus={() => {
                              insertTarget.current = token =>
                                onPatchField(field.id, { name: insertAtCursor(document.activeElement as HTMLInputElement, field.name, token) });
                            }}
                            onChange={event => onPatchField(field.id, { name: event.target.value })}
                            className="min-w-0 flex-1 rounded bg-transparent px-1 text-xs font-semibold text-white outline-none placeholder:text-[#6d6f78] hover:bg-black/20 focus:bg-black/30"
                          />
                          {chrome(true) && (
                            <>
                            <label className="flex shrink-0 cursor-pointer items-center gap-1 text-[10px] text-[#949ba4]" title="قسمي الصف">
                              <input
                                type="checkbox"
                                checked={field.inline}
                                onChange={event => onPatchField(field.id, { inline: event.target.checked })}
                                className="accent-primary"
                              />
                              ↔
                            </label>
                            <button
                              type="button"
                              aria-label={`حذف حقل ${field.name || "فارغ"}`}
                              className="grid size-5 shrink-0 place-items-center rounded text-[#949ba4] opacity-0 transition-all hover:bg-black/30 hover:text-destructive group-hover/field:opacity-100"
                              onClick={() => onRemoveField(field.id)}
                            >
                              <Trash2 className="size-3" />
                            </button>
                            </>
                          )}
                        </div>
                        <input
                          value={field.value}
                          maxLength={1024}
                          placeholder={chromeOn ? "قيمة الحقل" : undefined}
                          aria-label={`قيمة الحقل ${field.name || ""}`}
                          onFocus={() => {
                            insertTarget.current = token =>
                              onPatchField(field.id, { value: insertAtCursor(document.activeElement as HTMLInputElement, field.value, token) });
                          }}
                          onChange={event => onPatchField(field.id, { value: event.target.value })}
                          className="w-full rounded bg-transparent px-1 text-xs text-[#dbdee1] outline-none placeholder:text-[#6d6f78] hover:bg-black/20 focus:bg-black/30"
                        />
                      </div>
                    ))}
                  </div>
                ))}
                {chrome(true) && (
                  <button
                    type="button"
                    onClick={onAddField}
                    className="flex items-center gap-1 text-xs font-medium text-[#00a8fc] transition-colors hover:text-[#3b9dff]"
                  >
                    <Plus className="size-3.5" /> إضافة حقل جديد
                  </button>
                )}

                {/* Big image: mode chips + upload zone, all in place */}
                {chrome(true) && (
                  <div className="flex items-center gap-1">
                    {([
                      ["none", "بدون صورة"],
                      ["upload", "رفع صورة"],
                      ["url", "رابط صورة"]
                    ] as const).map(([mode, label]) => (
                      <button
                        key={mode}
                        type="button"
                        aria-pressed={embed.imageMode === mode}
                        className={cn(
                          "rounded-md border px-2 py-0.5 text-[10px] transition-colors",
                          embed.imageMode === mode
                            ? "border-primary/50 bg-primary/10 text-primary"
                            : "border-border/60 text-[#949ba4] hover:border-primary/40 hover:text-primary"
                        )}
                        onClick={() =>
                          onEmbedChange({ imageMode: mode, ...(mode === "none" ? { imageDataUrl: null, imageUrl: null } : {}) })
                        }
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                )}
                {embed.imageMode === "upload" && imageUpload.imageDataUrl ? (
                  <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-black/30 p-2">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={imageUpload.imageDataUrl} alt="" className="size-10 rounded object-cover" />
                    <span className="min-w-0 flex-1 truncate text-[11px] text-[#949ba4]" dir="ltr">
                      {imageUpload.fileName}
                    </span>
                    <button
                      type="button"
                      onClick={imageUpload.onPickFile}
                      className="shrink-0 rounded-md border border-border/60 px-2 py-0.5 text-[11px] text-[#dbdee1] transition-colors hover:border-primary/50 hover:text-primary"
                    >
                      استبدال
                    </button>
                    <button
                      type="button"
                      aria-label="إزالة الصورة"
                      onClick={imageUpload.onRemove}
                      className="grid size-5 shrink-0 place-items-center rounded text-[#949ba4] hover:bg-black/30 hover:text-destructive"
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className={cn(
                      "grid w-full place-items-center gap-1 rounded-lg border border-dashed py-6 text-center transition-all hover:border-primary/60 hover:bg-primary/5",
                      chrome(true) ? "" : "hidden"
                    )}
                    onClick={imageUpload.onPickFile}
                    onDragOver={event => event.preventDefault()}
                    onDrop={event => {
                      event.preventDefault();
                      imageUpload.onFileDrop(event.dataTransfer.files?.[0]);
                    }}
                  >
                    <Upload className="size-4 text-[#949ba4]" aria-hidden />
                    <span className="text-xs font-medium text-[#dbdee1]">اضغط للرفع أو اسحب الصورة هنا</span>
                    <span className="text-[10px] text-[#949ba4]">صورة الإيمبد الكبيرة — يتم تحسين ملفات JPG و PNG تلقائياً</span>
                  </button>
                )}
                {embed.imageMode === "url" && chrome(true) && (
                  <input
                    dir="ltr"
                    value={embed.imageUrl ?? ""}
                    onChange={event => onEmbedChange({ imageUrl: event.target.value })}
                    placeholder="https://..."
                    maxLength={512}
                    aria-label="رابط صورة الإيمبد"
                    className="w-full rounded border border-border/60 bg-black/30 px-2 py-1 text-xs text-[#dbdee1] outline-none focus:border-primary/50"
                  />
                )}
              </div>

              {/* Thumbnail + its mode toggle */}
              {chromeOn || embed.thumbnailMode !== "none" ? (
                <div className="flex w-24 shrink-0 flex-col items-center gap-1">
                  {embed.thumbnailMode === "custom" && embed.thumbnailUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={embed.thumbnailUrl} alt="" className="size-20 rounded object-cover" />
                  ) : (
                    <span className="grid size-20 place-items-center rounded border border-dashed border-border/60 bg-black/30 text-[10px] text-[#949ba4]">
                      {embed.thumbnailMode === "member_avatar" ? "صورة العضو" : "المصغرة"}
                    </span>
                  )}
                  {chrome(true) && (
                    <button
                      type="button"
                      aria-pressed={embed.thumbnailMode === "member_avatar"}
                      className={cn(
                        "w-full rounded-md border px-1 py-0.5 text-[10px] transition-colors",
                        embed.thumbnailMode === "member_avatar"
                          ? "border-primary/50 bg-primary/10 text-primary"
                          : "border-border/60 text-[#949ba4] hover:border-primary/40 hover:text-primary"
                      )}
                      onClick={() =>
                        onEmbedChange({ thumbnailMode: embed.thumbnailMode === "member_avatar" ? "custom" : "member_avatar" })
                      }
                    >
                      {embed.thumbnailMode === "member_avatar" ? "✓ صورة العضو" : "صورة العضو"}
                    </button>
                  )}
                  {chrome(true) && embed.thumbnailMode === "custom" && (
                    <input
                      dir="ltr"
                      value={embed.thumbnailUrl ?? ""}
                      onChange={event => onEmbedChange({ thumbnailUrl: event.target.value })}
                      placeholder="https://..."
                      maxLength={512}
                      aria-label="رابط الصورة المصغرة"
                      className="w-full rounded border border-border/60 bg-black/30 px-1 py-0.5 text-[10px] text-[#dbdee1] outline-none focus:border-primary/50"
                    />
                  )}
                </div>
              ) : null}
            </div>

            {/* Footer: editable text, icon toggle, timestamp chip */}
            <div className="flex items-center gap-2 px-3 pb-3">
              <div className="min-w-0 flex-1">
                <AutoTextarea
                  value={embed.footer}
                  onValueChange={footer => onEmbedChange({ footer })}
                  placeholder={chromeOn ? "نتمنى لك وقتاً ممتعاً" : undefined}
                  maxLength={2048}
                  aria-label="نص التذييل"
                  onFocus={() => {
                    insertTarget.current = token =>
                      onEmbedChange({ footer: insertAtCursor(document.activeElement as HTMLTextAreaElement, embed.footer, token) });
                  }}
                  className="text-[11px] text-[#949ba4]"
                />
                {chrome(true) && footerIconOpen && (
                  <div className="animate-in fade-in flex items-center gap-1.5 pt-1">
                    <button
                      type="button"
                      aria-label="تأكيد أيقونة التذييل"
                      className="grid size-5 shrink-0 place-items-center rounded bg-primary text-primary-foreground"
                      onClick={() => {
                        const url = footerIconDraft.trim();
                        onEmbedChange({ footerIconUrl: /^https:\/\//.test(url) ? url : null });
                      }}
                    >
                      <Check className="size-3" />
                    </button>
                    <input
                      dir="ltr"
                      value={footerIconDraft}
                      onChange={event => setFooterIconDraft(event.target.value)}
                      placeholder="https://... (أيقونة التذييل)"
                      maxLength={512}
                      className="min-w-0 flex-1 rounded border border-border/60 bg-black/30 px-1 py-0.5 text-[10px] text-[#dbdee1] outline-none focus:border-primary/50"
                      aria-label="رابط أيقونة التذييل"
                    />
                  </div>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {chrome(true) && (
                  <button
                    type="button"
                    aria-label="أيقونة التذييل"
                    aria-pressed={embed.footerIconUrl !== null}
                    className={cn(
                      "grid size-6 place-items-center rounded text-[#949ba4] transition-colors hover:bg-black/30 hover:text-white",
                      embed.footerIconUrl && "text-primary"
                    )}
                    onClick={() => {
                      if (footerIconOpen && embed.footerIconUrl) onEmbedChange({ footerIconUrl: null });
                      setFooterIconOpen(value => !value);
                    }}
                  >
                    🖼️
                  </button>
                )}
                <button
                  type="button"
                  aria-pressed={embed.timestamp}
                  className={cn(
                    "rounded-md border px-2 py-0.5 text-[11px] transition-colors",
                    embed.timestamp
                      ? "border-primary/50 bg-primary/10 text-primary"
                      : "border-border/60 text-[#949ba4] hover:text-foreground",
                    !chromeOn && embed.timestamp ? "" : !chromeOn ? "hidden" : ""
                  )}
                  onClick={() => onEmbedChange({ timestamp: !embed.timestamp })}
                >
                  الوقت
                </button>
                {embed.timestamp ? (
                  <span className="text-[11px] text-[#949ba4]">
                    {now.toLocaleDateString("en-GB")} • {now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
                  </span>
                ) : null}
              </div>
            </div>
          </div>
        ) : (
          <p className="rounded bg-[#2f3136] p-3 text-xs text-[#949ba4]">الإيمبد فارغ — اكتب عنواناً أو وصفاً لتبدأ.</p>
        )}

        <div className="pt-2">
          <FocusTokenStrip targetRef={insertTarget} />
        </div>
      </div>
    </div>
  );
}
