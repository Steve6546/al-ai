import { Button } from "@/components/ui/button";
import { AlertTriangle, Check, Loader2, RotateCcw } from "lucide-react";
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
      className="animate-in slide-in-from-bottom-4 fade-in fixed inset-x-0 bottom-4 z-40 mx-auto flex w-[min(46rem,calc(100%-2rem))] items-center justify-between gap-3 rounded-xl border border-border bg-popover/95 px-4 py-3 shadow-lg backdrop-blur"
    >
      <span className="flex items-center gap-2 text-sm">
        {error ? (
          <>
            <AlertTriangle className="size-4 shrink-0 text-destructive" />
            <span className="text-destructive">{error}</span>
          </>
        ) : (
          <>
            <AlertTriangle className="size-4 shrink-0 text-amber-500" />
            <span className="text-muted-foreground">{message}</span>
          </>
        )}
      </span>
      <div className="flex shrink-0 items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
          <RotateCcw />
          {cancelLabel}
        </Button>
        <Button
          size="sm"
          disabled={saving}
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
          {saving ? <Loader2 className="animate-spin" /> : <Check />}
          {saving ? "جارٍ الحفظ…" : saveLabel}
        </Button>
      </div>
    </div>
  );
}
