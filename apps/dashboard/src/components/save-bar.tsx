import { Button } from "@/components/ui/button";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { useState } from "react";

/**
 * Floating bar shown only while a form has unsaved changes.
 *
 * It sits at the bottom of the viewport, the way Discord's own settings screens
 * do, so the two things an operator needs after touching a switch — go back, or
 * commit — are always under the thumb rather than above the fold. It slides up
 * so the change is noticed without the operator having to hunt for the button.
 *
 * Cancelling must restore the caller's previous state. The bar deliberately
 * keeps **no copy** of the form data: it only calls `onCancel`, so the revert is
 * performed by the screen that owns the state and the bar can never disagree
 * with what is on screen.
 *
 * A failure is shown **inside the bar**, beside the button that caused it,
 * rather than only as a toast: the operator's eyes and pointer are already
 * there, and a toast can be dismissed before it is read.
 */
export function SaveBar({
  onSave,
  onCancel,
  message = "حذارِ — هناك تغييرات غير محفوظة!",
  saveLabel = "حفظ التغييرات",
  cancelLabel = "إعادة ضبط"
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
      /* Mobile contract: fixed, centred, never wider than the viewport minus
       * two 1rem gutters, capped at a comfortable reading width, and lifted by
       * the device's own safe-area inset so home-bar phones don't clip the
       * buttons. The row wraps before it squeezes: a narrow screen stacks the
       * message above the buttons instead of cutting either one. */
      className="animate-in slide-in-from-bottom-4 fade-in fixed inset-x-4 bottom-4 z-[60] mx-auto flex max-w-[500px] flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-2xl border border-border bg-popover px-4 py-3 text-popover-foreground shadow-lg sm:flex-nowrap sm:rounded-full sm:bottom-6"
      style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
    >
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
            <span className="min-w-0 text-muted-foreground">{message}</span>
          </>
        )}
      </span>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button variant="ghost" size="sm" className="rounded-full hover:text-destructive" onClick={onCancel} disabled={saving}>
          <RotateCcw />
          {cancelLabel}
        </Button>
        {/* `loading` on the shared Button owns the spinner and the disable —
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
          {/* The button's own `loading` state keeps the label in place and puts
              a spinner in front of it - swapping the text for "جارٍ الحفظ…" as
              well would move the button's contents twice for one event. */}
          {saveLabel}
        </Button>
      </div>
    </div>
  );
}
