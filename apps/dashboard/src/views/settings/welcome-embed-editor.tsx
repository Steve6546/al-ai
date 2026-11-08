import { useEffect, useRef, useState, type FocusEvent } from "react";
import { Check, Eye, Image as ImageIcon, Link2, Pencil, Plus, SmilePlus, Trash2, Upload, X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { EMOJI_SET, TOKEN_KEYS, insertAtCursor } from "./welcome-messages-parts";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import { WELCOME_MESSAGE_TOKENS, type WelcomeEmbed } from "@al-ai/core/browser";
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

/** A textarea that grows with its content — no scrollbar, no fixed rows. */
function AutoTextarea({
  value,
  onValueChange,
  className,
  placeholder,
  maxLength,
  readOnly,
  onFocus,
  inputRef,
  "aria-label": ariaLabel
}: {
  value: string;
  onValueChange: (next: string) => void;
  className?: string;
  placeholder?: string;
  maxLength?: number;
  readOnly?: boolean;
  onFocus?: (event: FocusEvent<HTMLTextAreaElement>) => void;
  /** Lets the caller insert at this field's caret after focus moved away. */
  inputRef?: { current: HTMLTextAreaElement | null };
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
      ref={node => {
        ref.current = node;
        if (inputRef) inputRef.current = node;
      }}
      rows={1}
      value={value}
      maxLength={maxLength}
      placeholder={placeholder}
      dir="auto"
      readOnly={readOnly}
      aria-label={ariaLabel}
      onFocus={onFocus}
      onChange={event => onValueChange(event.target.value)}
      className={cn(
        "w-full min-w-0 resize-none overflow-hidden rounded-md bg-transparent px-1 py-0.5 text-[#dbdee1] outline-none transition-colors [overflow-wrap:anywhere] placeholder:text-[#6d6f78] hover:bg-black/20 focus:bg-black/30",
        className
      )}
    />
  );
}

function EmojiButton({ label, onPick, className }: { label: string; onPick: (emoji: string) => void; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className={cn("grid size-6 place-items-center rounded text-[#949ba4] transition-colors hover:bg-black/30 hover:text-white", className)}
        >
          <SmilePlus className="size-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" collisionPadding={12} className="w-[min(18rem,calc(100vw-2rem))] p-2">
        <div className="grid grid-cols-8 gap-0.5 sm:grid-cols-10">
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
      </PopoverContent>
    </Popover>
  );
}

/** The floating token strip: inserts into whichever field held focus last. */
function FocusTokenStrip({ targetRef }: { targetRef: { current: ((token: string) => void) | null } }) {
  const [open, setOpen] = useState(false);
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-t border-border/60 pt-2">
      <button
        type="button"
        aria-expanded={open}
        className={cn(
          "rounded-md border px-2 py-0.5 font-mono text-mini transition-colors",
          open ? "border-primary/60 bg-primary/10 text-primary" : "border-border/80 text-muted-foreground hover:text-foreground"
        )}
        onClick={() => setOpen(value => !value)}
      >
        {"{ }"} {t("welcome.embed.variablesButton")}
      </button>
      {open &&
        WELCOME_MESSAGE_TOKENS.map(token => (
          <button
            key={token}
            type="button"
            dir="ltr"
            title={t(TOKEN_KEYS[token])}
            className="rounded-md border border-border/80 bg-muted/40 px-2 py-0.5 font-mono text-mini text-muted-foreground transition-colors hover:border-primary/50 hover:text-primary"
            onClick={() => {
              targetRef.current?.(token);
              setOpen(false);
            }}
          >
            {token}
          </button>
        ))}
      <span className="text-micro text-muted-foreground">{t("welcome.embed.insertHint")}</span>
    </div>
  );
}

/**
 * A pasted address, drawn the way Discord will draw it.
 *
 * Every image URL on an embed — the big image, the thumbnail, the footer icon —
 * is fetched by **Discord's** servers when the message is sent, not by this
 * dashboard. That is the whole difference from the identity screen, whose links
 * our own server resolves and stores as bytes: an embed has no bytes to store,
 * so a share link (a Pinterest *page*, a Google Drive preview) has nothing for
 * Discord to attach and the member sees no picture.
 *
 * So the honest preview is the browser's own `<img>` against the same URL, and
 * an address that does not answer with an image says so here, before the
 * operator finds out from a silent greeting.
 */
function RemoteImage({ url, className, label }: { url: string | null; className: string; label: string }) {
  const { t } = useI18n();
  const [failed, setFailed] = useState(false);
  const trimmed = (url ?? "").trim();
  useEffect(() => setFailed(false), [trimmed]);

  if (!/^https?:\/\/.+/i.test(trimmed)) {
    return (
      <p className="px-1 text-micro text-[#949ba4]">
        {t("welcome.embed.invalidUrl", { label })}
      </p>
    );
  }
  if (failed) {
    return (
      <p className="rounded border border-dashed border-border/60 px-2 py-1 text-micro text-[#949ba4]">
        {t("welcome.embed.failedUrl", { label })}
      </p>
    );
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={trimmed} alt="" className={className} onError={() => setFailed(true)} />;
}

export type EmbedEditorProps = {
  botName: string;
  botAvatarUrl: string | null;
  /**
   * The bot's role colour in this guild. Discord paints a member's name in it,
   * so a preview that ignores it shows a white name for a bot whose name is
   * green in the member list.
   */
  roleColor: string | null;
  /**
   * A real face for the `member_avatar` thumbnail slot. The bot substitutes the
   * joiner's own picture at send time; the editor borrows one it can actually
   * reach, so the slot shows a face instead of the words “member picture”.
   */
  memberAvatarUrl: string | null;
  embed: WelcomeEmbed;
  /** Write-back into the shared draft — the editor owns no copy of its own. */
  onEmbedChange: (patch: Partial<WelcomeEmbed>) => void;
  /* The big-image upload plumbing stays with the screen (file input + naming). */
  imageUpload: {
    imageDataUrl: string | null;
    /** The picked file's name, or null: a stored image has no file behind it. */
    fileName: string | null;
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
  roleColor,
  memberAvatarUrl,
  embed,
  onEmbedChange,
  imageUpload,
  onAddField,
  onPatchField,
  onRemoveField
}: EmbedEditorProps) {
  const { t, language } = useI18n();
  // The eye on the action bar hides every editing affordance: the card reads
  // exactly like the message a member receives. `editing` is the single source
  // of that decision - it used to be spelled `chrome(true)` at some call sites
  // and `!editing` at others, so half of the tools showed in the clean preview
  // and disappeared while editing.
  const [editing, setEditing] = useState(true);
  const [titleLinkOpen, setTitleLinkOpen] = useState(embed.titleUrl !== null);
  const [titleLinkDraft, setTitleLinkDraft] = useState(embed.titleUrl ?? "");
  const [colorOpen, setColorOpen] = useState(false);
  const [footerIconOpen, setFooterIconOpen] = useState(embed.footerIconUrl !== null);
  const [footerIconDraft, setFooterIconDraft] = useState(embed.footerIconUrl ?? "");
  // Tracks which field the token strip inserts into.
  const insertTarget = useRef<((token: string) => void) | null>(null);
  // The fields themselves, so a later emoji click can still read the caret
  // position that belonged to the field the operator was editing.
  const contentRef = useRef<HTMLTextAreaElement>(null);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  const footerRef = useRef<HTMLTextAreaElement>(null);

  const accent = /^#[0-9a-fA-F]{3,6}$/.test(embed.color ?? "") ? embed.color! : "#4e5058";
  // A stored row is not a validated type: a colour Discord no longer recognises
  // must fall back to white rather than paint the name with an invalid value.
  const nameColor = roleColor && /^#[0-9a-f]{6}$/i.test(roleColor) ? roleColor : "#ffffff";
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

  return (
    <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:gap-3" dir="ltr">
      {/* -------- Action bar: eye (clean preview) + accent colour swatch -------- */}
      <div className="flex flex-row items-center gap-2 sm:flex-col sm:items-center">
        <span className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-full bg-[#5865f2]/40 text-micro text-[#dbdee1]">
          {botAvatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={botAvatarUrl} alt="" className="size-full object-cover" />
          ) : (
            "AI"
          )}
        </span>
        <button
          type="button"
          aria-label={editing ? t("welcome.embed.cleanPreview") : t("welcome.embed.backToEdit")}
          aria-pressed={!editing}
          className={cn(
            "grid size-7 place-items-center rounded-md border transition-colors",
            !editing ? "border-primary/50 bg-primary/10 text-primary" : "border-border/80 text-muted-foreground hover:text-foreground"
          )}
          onClick={() => setEditing(value => !value)}
        >
          {editing ? <Eye className="size-3.5" /> : <Pencil className="size-3.5" />}
        </button>
        <Popover open={colorOpen} onOpenChange={setColorOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={t("welcome.embed.sidebarColor")}
              className="grid size-7 place-items-center overflow-hidden rounded-md border border-border/80 shadow-inner transition-transform hover:scale-105"
            >
              <span className="size-full" style={{ background: accent }} aria-hidden />
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" collisionPadding={12} className="w-56 space-y-2 p-3">
            <input
              type="color"
              value={accent}
              onChange={event => onEmbedChange({ color: event.target.value })}
              className="h-8 w-full cursor-pointer rounded-md border border-input bg-background"
              aria-label={t("welcome.embed.sidebarPicker")}
            />
            <input
              dir="ltr"
              value={embed.color ?? ""}
              onChange={event => onEmbedChange({ color: event.target.value })}
              placeholder="#3b82f6"
              maxLength={7}
              className="w-full rounded-lg border border-input bg-background px-2 py-1 font-mono text-xs"
              aria-label={t("welcome.embed.hex")}
            />
          </PopoverContent>
        </Popover>
      </div>

      {/* -------- The message body -------- */}
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center gap-2">
          {/* Discord paints the sender's name in their highest role's colour, so a
              white name here describes a bot that does not look like this in the
              member list. */}
          <span className="text-sm font-semibold" style={{ color: nameColor }} dir="ltr">
            {botName}
          </span>
          <span className="rounded bg-[#5865f2] px-1 py-px text-[9px] font-bold uppercase text-white">Bot</span>
          {/* The card is Discord's layout, so it stays LTR — but the words are
              the ones the operator's own Arabic client prints. */}
          <span className="text-mini text-[#949ba4]">
            {t("welcome.embed.today", { time: now.toLocaleTimeString(language === "ar" ? "ar" : "en-GB", { hour: "2-digit", minute: "2-digit" }) })}
          </span>
        </div>

        {embed.content || editing ? (
          <div className="mb-2">
            <AutoTextarea
              value={embed.content}
              onValueChange={content => onEmbedChange({ content })}
              placeholder={editing ? t("welcome.embed.contentPlaceholder") : undefined}
              maxLength={2000}
              readOnly={!editing}
              inputRef={contentRef}
              aria-label={t("welcome.embed.contentAria")}
              onFocus={event => {
                const element = event.currentTarget;
                insertTarget.current = token =>
                  onEmbedChange({ content: insertAtCursor(element, embed.content, token) });
              }}
              className="text-sm"
            />
          </div>
        ) : null}

        {/* The embed card itself */}
        {embed.title || embed.description || embed.fields.length > 0 || embed.imageMode !== "none" || editing ? (
          <div className="relative overflow-hidden rounded bg-[#2f3136] ps-3 sm:ps-4" style={{ borderInlineStart: `4px solid ${accent}` }}>
            <div className="flex flex-col gap-3 p-2.5 sm:flex-row sm:p-3">
              <div className="min-w-0 flex-1 space-y-2">
                {/* Title + its link toggle */}
                <div className="space-y-1">
                  <div className="group/title flex items-center gap-1.5">
                    <AutoTextarea
                      value={embed.title}
                      onValueChange={title => onEmbedChange({ title })}
                      placeholder={editing ? t("welcome.embed.titlePlaceholder") : undefined}
                      maxLength={256}
                      readOnly={!editing}
                      inputRef={titleRef}
                      aria-label={t("welcome.embed.titleAria")}
                      onFocus={event => {
                        const element = event.currentTarget;
                        insertTarget.current = token =>
                          onEmbedChange({ title: insertAtCursor(element, embed.title, token) });
                      }}
                      className={cn("text-sm font-semibold", embed.titleUrl ? "text-[#00a8fc] underline decoration-[#00a8fc]/40" : "text-[#00a8fc]")}
                    />
                    <button
                      type="button"
                      aria-label={t("welcome.embed.titleLink")}
                      aria-expanded={titleLinkOpen}
                      className={cn(
                        "grid size-8 shrink-0 place-items-center rounded text-[#949ba4] transition-colors hover:bg-black/30 hover:text-white",
                        !editing && "opacity-0 group-hover/title:opacity-100 group-focus-within/title:opacity-100",
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
                  {titleLinkOpen && editing && (
                    <div className="animate-in fade-in slide-in-from-bottom-1 flex items-center gap-1.5 rounded-lg border border-border/60 bg-black/30 p-1.5">
                      <button
                        type="button"
                        aria-label={t("welcome.embed.confirmLink")}
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
                        className="min-w-0 flex-1 rounded bg-transparent px-1 text-xs text-[#dbdee1] outline-none placeholder:text-[#6d6f78] focus-visible:ring-1 focus-visible:ring-ring"
                        aria-label={t("welcome.embed.titleLink")}
                      />
                      {embed.titleUrl ? (
                        <span className="shrink-0 text-micro text-success" aria-label={t("welcome.embed.linkOn")}>✓</span>
                      ) : null}
                    </div>
                  )}
                </div>

                {/* Description with its emoji trigger */}
                <div className="group/desc">
                  <AutoTextarea
                    value={embed.description}
                    onValueChange={description => onEmbedChange({ description })}
                    placeholder={editing ? t("welcome.embed.descriptionPlaceholder") : undefined}
                    maxLength={4000}
                    readOnly={!editing}
                    inputRef={descriptionRef}
                    aria-label={t("welcome.embed.descriptionAria")}
                    onFocus={event => {
                      const element = event.currentTarget;
                      insertTarget.current = token =>
                        onEmbedChange({ description: insertAtCursor(element, embed.description, token) });
                    }}
                    className="text-sm"
                  />
                  {editing && (
                    <div className="flex justify-end">
                      <EmojiButton
                        label={t("welcome.embed.emojiInDescription")}
                        onPick={emoji =>
                          onEmbedChange({
                            description: insertAtCursor(descriptionRef.current, embed.description, emoji)
                          })
                        }
                      />
                    </div>
                  )}
                </div>

                {/* Custom fields, laid out like Discord renders them */}
                {rows.map((row, rowIndex) => (
                  <div
                    key={rowIndex}
                    className={cn(
                      "grid gap-2",
                      row.length === 3 ? "grid-cols-1 sm:grid-cols-3" : row.length === 2 ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-1"
                    )}
                  >
                    {row.map(field => (
                      <div
                        key={field.id}
                        className={cn(
                          "group/field min-w-0 rounded-md border border-transparent p-1 transition-colors",
                          editing && "hover:border-dashed hover:border-border"
                        )}
                      >
                        <div className="flex items-center gap-1">
                          <input
                            value={field.name}
                            maxLength={256}
                            dir="auto"
                            readOnly={!editing}
                            placeholder={editing ? t("welcome.embed.fieldName") : undefined}
                            aria-label={t("welcome.embed.fieldNameAria", { name: field.name || "" })}
                            onFocus={event => {
                              const element = event.currentTarget;
                              insertTarget.current = token =>
                                onPatchField(field.id, { name: insertAtCursor(element, field.name, token) });
                            }}
                            onChange={event => onPatchField(field.id, { name: event.target.value })}
                            className="min-w-0 flex-1 rounded bg-transparent px-1 text-xs font-semibold text-white outline-none placeholder:text-[#6d6f78] hover:bg-black/20 focus:bg-black/30"
                          />
                          {editing && (
                            <>
                            <label className="flex shrink-0 cursor-pointer items-center gap-1 text-micro text-[#949ba4]" title={t("welcome.embed.inline")}>
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
                              aria-label={t("welcome.embed.deleteField", { name: field.name || t("welcome.embed.empty") })}
                              className="grid size-8 shrink-0 place-items-center rounded text-[#949ba4] opacity-100 transition-all hover:bg-black/30 hover:text-destructive sm:opacity-0 sm:group-hover/field:opacity-100 sm:group-focus-within/field:opacity-100"
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
                          dir="auto"
                          readOnly={!editing}
                          placeholder={editing ? t("welcome.embed.fieldValue") : undefined}
                          aria-label={t("welcome.embed.fieldValueAria", { name: field.name || "" })}
                          onFocus={event => {
                            const element = event.currentTarget;
                            insertTarget.current = token =>
                              onPatchField(field.id, { value: insertAtCursor(element, field.value, token) });
                          }}
                          onChange={event => onPatchField(field.id, { value: event.target.value })}
                          className="w-full rounded bg-transparent px-1 text-xs text-[#dbdee1] outline-none placeholder:text-[#6d6f78] hover:bg-black/20 focus:bg-black/30"
                        />
                      </div>
                    ))}
                  </div>
                ))}
                {editing && (
                  <button
                    type="button"
                    onClick={onAddField}
                    className="flex items-center gap-1 text-xs font-medium text-[#00a8fc] transition-colors hover:text-[#3b9dff]"
                  >
                    <Plus className="size-3.5" /> {t("welcome.embed.addField")}
                  </button>
                )}

                {/* The big image belongs *below* the text and the thumbnail,
                    full width, because that is where Discord puts it — see the
                    block after the row closes. */}
              </div>

              {/* Thumbnail + its mode toggle. It is a 96px column on desktop,
                  but that column left the caption a few characters wide on a
                  phone; below `sm` it becomes a row under the text. */}
              {editing || embed.thumbnailMode !== "none" ? (
                <div className="flex w-full flex-wrap items-center gap-2 sm:w-24 sm:shrink-0 sm:flex-col sm:flex-nowrap sm:items-center sm:gap-1">
                  {/* The three states of the slot, in Discord's own order:
                      a custom picture, the member's picture (a real face here,
                      the joiner's at send time), then the labelled empty box. */}
                  {embed.thumbnailMode === "custom" && embed.thumbnailUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={embed.thumbnailUrl} alt="" className="size-14 rounded object-cover sm:size-20" />
                  ) : embed.thumbnailMode === "member_avatar" && memberAvatarUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={memberAvatarUrl} alt="" className="size-14 rounded object-cover sm:size-20" />
                  ) : (
                    <span className="grid size-14 place-items-center rounded border border-dashed border-border/60 bg-black/30 text-micro text-[#949ba4] sm:size-20">
                      {embed.thumbnailMode === "member_avatar" ? t("welcome.embed.memberAvatar") : t("welcome.embed.thumbnail")}
                    </span>
                  )}
                  {editing && (
                    <button
                      type="button"
                      aria-pressed={embed.thumbnailMode === "member_avatar"}
                      className={cn(
                        "w-auto rounded-md border px-2 py-1 text-micro transition-colors sm:w-full sm:px-1 sm:py-0.5",
                        embed.thumbnailMode === "member_avatar"
                          ? "border-primary/50 bg-primary/10 text-primary"
                          : "border-border/60 text-[#949ba4] hover:border-primary/40 hover:text-primary"
                      )}
                      onClick={() =>
                        onEmbedChange({ thumbnailMode: embed.thumbnailMode === "member_avatar" ? "custom" : "member_avatar" })
                      }
                    >
                      {embed.thumbnailMode === "member_avatar" ? `✓ ${t("welcome.embed.memberAvatar")}` : t("welcome.embed.memberAvatar")}
                    </button>
                  )}
                  {editing && embed.thumbnailMode === "custom" && (
                    <input
                      dir="ltr"
                      value={embed.thumbnailUrl ?? ""}
                      onChange={event => onEmbedChange({ thumbnailUrl: event.target.value })}
                      placeholder="https://..."
                      maxLength={512}
                      aria-label={t("welcome.embed.thumbnailUrl")}
                      className="w-full rounded border border-border/60 bg-black/30 px-1 py-0.5 text-micro text-[#dbdee1] outline-none focus:border-primary/50"
                    />
                  )}
                </div>
              ) : null}
            </div>

            {/* -------------------------------------------------- big image
              *
              * Discord draws the embed image under the text and the thumbnail,
              * across the whole card. It used to live inside the text column,
              * which left the thumbnail's column standing as a wall on its right
              * and shrank the picture to a 40px chip.
              *
              * Each mode now draws its own surface. Before, the upload zone was
              * the `else` of "upload mode with a picture", so it also appeared in
              * `none` and in `url` — which is why the three chips looked dead:
              * pressing any of them left the same box on screen.
              */}
            {editing && (
              <div className="flex flex-wrap items-center gap-1 px-2.5 pt-2 sm:px-3">
                {([
                  ["none", t("welcome.embed.noImage")],
                  ["upload", t("welcome.embed.uploadImage")],
                  ["url", t("welcome.embed.imageUrl")]
                ] as const).map(([mode, label]) => (
                  <button
                    key={mode}
                    type="button"
                    aria-pressed={embed.imageMode === mode}
                    className={cn(
                      "rounded-md border px-2 py-0.5 text-micro transition-colors",
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

            {embed.imageMode === "upload" ? (
              imageUpload.imageDataUrl ? (
                <div className="overflow-hidden rounded-lg border border-border/60">
                  {/* The picture at the card's own width — the size it will be,
                      not a thumbnail of it. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={imageUpload.imageDataUrl} alt="" className="max-h-80 w-full object-cover" />
                  <div className="flex items-center gap-2 bg-black/30 p-2">
                    {imageUpload.fileName ? (
                      <span className="min-w-0 flex-1 truncate text-mini text-[#949ba4]" dir="ltr">
                        {imageUpload.fileName}
                      </span>
                    ) : (
                      <span className="min-w-0 flex-1 text-mini text-[#949ba4]">{t("welcome.embed.savedImage")}</span>
                    )}
                    <button
                      type="button"
                      onClick={imageUpload.onPickFile}
                      className="shrink-0 rounded-md border border-border/60 px-2 py-0.5 text-mini text-[#dbdee1] transition-colors hover:border-primary/50 hover:text-primary"
                    >
                      {t("welcome.replace")}
                    </button>
                    <button
                      type="button"
                      aria-label={t("welcome.embed.removeImage")}
                      onClick={imageUpload.onRemove}
                      className="grid size-5 shrink-0 place-items-center rounded text-[#949ba4] hover:bg-black/30 hover:text-destructive"
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  className={cn(
                    "grid w-full place-items-center gap-1 rounded-lg border border-dashed py-6 text-center transition-all hover:border-primary/60 hover:bg-primary/5",
                    editing ? "" : "hidden"
                  )}
                  onClick={imageUpload.onPickFile}
                  onDragOver={event => event.preventDefault()}
                  onDrop={event => {
                    event.preventDefault();
                    imageUpload.onFileDrop(event.dataTransfer.files?.[0]);
                  }}
                >
                  <Upload className="size-4 text-[#949ba4]" aria-hidden />
                  <span className="text-xs font-medium text-[#dbdee1]">{t("welcome.embed.uploadHint")}</span>
                  <span className="text-micro text-[#949ba4]">{t("welcome.embed.uploadBody")}</span>
                </button>
              )
            ) : null}

            {embed.imageMode === "url" ? (
              <div className="space-y-1.5">
                {editing && (
                  <input
                    dir="ltr"
                    value={embed.imageUrl ?? ""}
                    onChange={event => onEmbedChange({ imageUrl: event.target.value })}
                    placeholder="https://..."
                    maxLength={512}
                    aria-label={t("welcome.embed.imageUrlAria")}
                    className="w-full rounded border border-border/60 bg-black/30 px-2 py-1 text-xs text-[#dbdee1] outline-none focus:border-primary/50"
                  />
                )}
                <RemoteImage url={embed.imageUrl} className="max-h-80 w-full rounded-lg object-cover" label={t("welcome.embed.imageAlt")} />
              </div>
            ) : null}

            {/* Footer: editable text, icon toggle, timestamp chip */}
            <div className="flex flex-col gap-2 px-3 pb-3 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1">
                {/* Discord draws the footer icon *inside* the footer line, before
                    its text. The field stored it and the bot sent it, but the
                    card never drew it — so the one URL control on this embed had
                    no preview at all, which reads as a dead control. */}
                <div className="flex items-start gap-1.5">
                  {embed.footerIconUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={embed.footerIconUrl} alt="" className="mt-0.5 size-4 shrink-0 rounded" />
                  ) : null}
                  <div className="min-w-0 flex-1">
                    <AutoTextarea
                      value={embed.footer}
                      onValueChange={footer => onEmbedChange({ footer })}
                      placeholder={editing ? t("welcome.embed.footerPlaceholder") : undefined}
                      maxLength={2048}
                      readOnly={!editing}
                      inputRef={footerRef}
                      aria-label={t("welcome.embed.footerAria")}
                      onFocus={event => {
                        const element = event.currentTarget;
                        insertTarget.current = token =>
                          onEmbedChange({ footer: insertAtCursor(element, embed.footer, token) });
                      }}
                      className="text-mini text-[#949ba4]"
                    />
                  </div>
                </div>
                {editing && footerIconOpen && (
                  <div className="space-y-1 pt-1">
                    <div className="animate-in fade-in flex items-center gap-1.5">
                    <button
                      type="button"
                      aria-label={t("welcome.embed.confirmFooterIcon")}
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
                      placeholder={t("welcome.embed.footerIconPlaceholder")}
                      maxLength={512}
                      className="min-w-0 flex-1 rounded border border-border/60 bg-black/30 px-1 py-0.5 text-micro text-[#dbdee1] outline-none focus:border-primary/50"
                      aria-label={t("welcome.embed.footerIconUrl")}
                    />
                    </div>
                    {/* The same check the big image gets: an address that is not
                        a picture is said here, not discovered in a greeting that
                        arrives without one. */}
                    <RemoteImage url={embed.footerIconUrl} className="size-8 rounded object-cover" label={t("welcome.embed.footerIcon")} />
                  </div>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {editing && (
                  <button
                    type="button"
                    aria-label={t("welcome.embed.footerIcon")}
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
                    <ImageIcon className="size-3.5" />
                  </button>
                )}
                <button
                  type="button"
                  aria-pressed={embed.timestamp}
                  className={cn(
                    "rounded-md border px-2 py-0.5 text-mini transition-colors",
                    embed.timestamp
                      ? "border-primary/50 bg-primary/10 text-primary"
                      : "border-border/60 text-[#949ba4] hover:text-foreground",
                    !editing && embed.timestamp ? "" : !editing ? "hidden" : ""
                  )}
                  onClick={() => onEmbedChange({ timestamp: !embed.timestamp })}
                >
                  {t("welcome.embed.time")}
                </button>
                {embed.timestamp ? (
                  <span className="whitespace-nowrap text-mini text-[#949ba4]" dir="ltr">
                    {now.toLocaleDateString("en-GB")} • {now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
                  </span>
                ) : null}
              </div>
            </div>
          </div>
        ) : (
          <p className="rounded bg-[#2f3136] p-3 text-xs text-[#949ba4]">{t("welcome.embed.emptyEmbed")}</p>
        )}

        <div className="pt-2">
          <FocusTokenStrip targetRef={insertTarget} />
        </div>
      </div>
    </div>
  );
}
