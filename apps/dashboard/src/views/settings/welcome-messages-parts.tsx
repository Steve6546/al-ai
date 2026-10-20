import { useRef, useState, type ReactNode } from "react";
import { SmilePlus } from "lucide-react";
import { cn } from "@/lib/utils";
import { WELCOME_MESSAGE_TOKENS, WELCOME_TOKEN_LABELS_AR } from "@al-ai/core/browser";

/**
 * Shared editing pieces for the welcome-messages screen: the token strip that
 * inserts a variable at the caret, and the emoji popover. Both are plain React
 * against the shared draft - no second state machine.
 */

/** A common, hand-picked emoji set — enough for a greeting, no dependency. */
const EMOJI_SET = [
  "👋", "🎉", "✨", "🌟", "💫", "🔥", "❤️", "💚", "💙", "🧡",
  "🙏", "👏", "🙌", "🤝", "😎", "🥳", "😄", "😊", "🙂", "😉",
  "👑", "🎮", "🎧", "🚀", "⚡", "🍀", "🌹", "🕊️", "☕", "🍕"
] as const;

/**
 * Inserts a token (or any text) into a controlled textarea at the caret,
 * reporting the next value and restoring focus + caret afterwards.
 */
export function insertAtCursor(
  textarea: HTMLTextAreaElement | HTMLInputElement | null,
  current: string,
  insertion: string
): string {
  if (!textarea) return current + insertion;
  const start = textarea.selectionStart ?? current.length;
  const end = textarea.selectionEnd ?? start;
  const next = `${current.slice(0, start)}${insertion}${current.slice(end)}`;
  const caret = start + insertion.length;
  requestAnimationFrame(() => {
    textarea.focus();
    textarea.setSelectionRange(caret, caret);
  });
  return next;
}

/** The variable strip: every token, labelled, one click to insert. */
export function TokenStrip({
  onInsert,
  activeRef
}: {
  onInsert: (token: string) => void;
  /** The textarea the caret belongs to — tokens insert where it points. */
  activeRef: React.RefObject<HTMLTextAreaElement | HTMLInputElement | null>;
}) {
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="المتغيرات المتاحة">
      {WELCOME_MESSAGE_TOKENS.map(token => (
        <button
          key={token}
          type="button"
          dir="ltr"
          title={WELCOME_TOKEN_LABELS_AR[token as keyof typeof WELCOME_TOKEN_LABELS_AR]}
          className="rounded-md border border-border/80 bg-muted/40 px-2 py-0.5 font-mono text-[11px] text-muted-foreground transition-colors hover:border-primary/50 hover:text-primary"
          onClick={() => onInsert(token)}
        >
          {token}
        </button>
      ))}
      {/* The hidden anchor keeps the API simple: the caller passes the field
          whose caret the token targets. */}
      <span className="hidden" ref={activeRef as never} />
    </div>
  );
}

/** The emoji popover: one grid, insert-on-click, closes on outside press. */
export function EmojiPicker({ onPick, label }: { onPick: (emoji: string) => void; label: string }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={containerRef} className="relative inline-block">
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        className="grid size-8 place-items-center rounded-md border border-border/80 text-muted-foreground transition-colors hover:text-foreground"
        onClick={() => setOpen(value => !value)}
      >
        <SmilePlus className="size-4" />
      </button>
      {open && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <div className="absolute bottom-full z-50 mb-1 grid w-72 grid-cols-10 gap-0.5 rounded-xl border border-border bg-popover p-2 shadow-xl start-0">
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
    </div>
  );
}

/** A labelled control row used across the canvas sub-tabs. */
export function FieldRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}
