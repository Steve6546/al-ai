import { Button } from "@/components/ui/button";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { useState } from "react";

/**
 * The unsaved-changes bar.
 *
 * It sits at the **top** of the screen, not at the bottom. A bar pinned to the
 * bottom sits *over* the last control of every long form and - worse - over the
 * open dropdown menus (the font picker, the channel picker), because a floating
 * element with a high z-index swallows the click that should have chosen an
 * option. At the top it can never cover a menu that opens downwards, and the
 * thing it reports is the thing the reader is looking at.
 *
 * The rules the bar keeps:
 *
 * - It is **fixed** at the top, so it stays where it says it is while the
 *   screen scrolls, and it is *not* a modal: it never traps focus and never
 *   blocks the content underneath.
 * - It keeps **no copy** of the form data: it only calls `onCancel`, so the
 *   revert is performed by the screen that owns the state and the bar can
 *   never disagree with what is on screen.
 * - A failure is shown **inside the bar**, beside the button that caused it,
 *   rather than only as a toast.
 */
export function SaveBar({
  onSave,
  onCancel,
  message = "لديك تغييرات غير محفوظة",
  saveLabel = "حفظ التغييرات",
  cancelLabel = "تجاهل"
}: {
  onSave: () => Promise<void>;
  onCancel: () => void;
  message?: string;
  saveLabel?: string;
  cancelLabel?: string;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div
      role="status"
      aria-live="polite"
      /*
       * Fixed at the top, across the width of the frame, above the content but
       * below an open menu: a dropdown portal renders at z-50, and the bar at
       * z-40 stays behind it - so a menu that opens *downwards* from a control
       * under the bar is reachable, and the bar never covers a choice.
       */
      className="sticky top-0 z-40 -mx-4 mb-4 border-b border-warning/40 bg-warning/10 px-4 py-2.5 backdrop-blur-md lg:-mx-6 lg:px-6"
    >
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <span className="flex min-w-0 flex-1 items-center gap-2 text-sm">
          {error ? (
            <>
              <AlertTriangle className="size-4 shrink-0 text-destructive" />
              <span className="min-w-0 text-destructive">{error}</span>
            </>
          ) : (
            <>
              <span className="relative flex size-2 shrink-0" aria-hidden>
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-warning opacity-60" />
                <span className="relative inline-flex size-2 rounded-full bg-warning" />
              </span>
              {/* The message may wrap on a narrow screen; only the pointer's
                  layout is fixed. Nothing is truncated, because "there are
                  unsaved changes" cut to half a sentence reads as a different
                  message. */}
              <span className="min-w-0 text-foreground">{message}</span>
            </>
          )}
        </span>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button variant="ghost" size="sm" className="rounded-full hover:text-destructive" onClick={onCancel} disabled={saving}>
            <RotateCcw />
            {cancelLabel}
          </Button>
          {/* `loading` on the shared Button owns the spinner and the disable -
              the bar states the intent once and the component applies the rule. */}
          <Button
            size="sm"
            className="rounded-full"
            loading={saving}
            onClick={async () => {
              setSaving(true);
              setError(null);
              try {
                await onSave();
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : "تعذّر الحفظ.");
              } finally {
                setSaving(false);
              }
            }}
          >
            {/* The button's own `loading` state keeps the label in place and
                puts a spinner in front of it - swapping the text for
                "جارٍ الحفظ…" as well would move the button's contents twice
                for one event. */}
            {saveLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
