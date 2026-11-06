import { useState, type ReactNode } from "react";
import { SmilePlus } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { WELCOME_MESSAGE_TOKENS } from "@al-ai/core/browser";
import { useI18n, type TranslationKey } from "@/lib/i18n";

export const TOKEN_KEYS: Record<(typeof WELCOME_MESSAGE_TOKENS)[number], TranslationKey> = {
  "{user}": "welcome.token.user",
  "{username}": "welcome.token.username",
  "{server}": "welcome.token.server",
  "{memberCount}": "welcome.token.memberCount",
  "{inviter}": "welcome.token.inviter",
  "{joinDate}": "welcome.token.joinDate"
};

/**
 * Shared editing pieces for the welcome-messages screen: the token strip that
 * inserts a variable at the caret, and the emoji popover. Both are plain React
 * against the shared draft - no second state machine.
 */

/** A common, hand-picked emoji set — enough for a greeting, no dependency. */
export const EMOJI_SET = [
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
export function TokenStrip({ onInsert }: { onInsert: (token: string) => void }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("welcome.tokensGroup")}>
      {WELCOME_MESSAGE_TOKENS.map(token => (
        <button
          key={token}
          type="button"
          dir="ltr"
          title={t(TOKEN_KEYS[token])}
          className="rounded-md border border-border/80 bg-muted/40 px-2.5 py-1.5 font-mono text-[11px] text-muted-foreground transition-colors hover:border-primary/50 hover:text-primary sm:px-2 sm:py-0.5"
          onClick={() => onInsert(token)}
        >
          {token}
        </button>
      ))}
      {/* No ref is mounted here on purpose. An earlier version took an
          `activeRef` and attached it to a hidden span rendered after the
          textarea, so React's commit order pointed the caller's ref at the
          span: `selectionStart` read as undefined and every token landed at the
          end of the text instead of at the caret. */}
    </div>
  );
}

/** The emoji popover: one grid, insert-on-click, closes on outside press. */
export function EmojiPicker({ onPick, label }: { onPick: (emoji: string) => void; label: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className="grid size-9 place-items-center rounded-md border border-border/80 text-muted-foreground transition-colors hover:text-foreground"
        >
          <SmilePlus className="size-4" />
        </button>
      </PopoverTrigger>
      {/* Portalled: the editor lives inside cards with `overflow-hidden`, and
          an in-flow panel was clipped at the card edge on a phone. Collision
          padding keeps it inside the viewport in both directions. */}
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

/** A labelled control row used across the canvas sub-tabs. */
export function FieldRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}
