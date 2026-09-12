import { Button } from "@/components/ui/button";
import { Check, Loader2, X } from "lucide-react";
import { useState } from "react";

/**
 * Fixed bar shown only while a form has unsaved changes.
 *
 * Cancelling must restore the caller's previous state — the bar never keeps a
 * copy of the data itself, so the revert can never disagree with the screen.
 */
export function SaveBar({
  onSave,
  onCancel,
  message = "توجد تغييرات غير محفوظة"
}: {
  onSave: () => Promise<void>;
  onCancel: () => void;
  message?: string;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div
      role="status"
      className="fixed inset-x-0 bottom-4 z-40 mx-auto flex w-[min(46rem,calc(100%-2rem))] items-center justify-between gap-3 rounded-xl border border-border bg-popover/95 px-4 py-3 shadow-lg backdrop-blur"
    >
      <span className="text-sm text-muted-foreground">
        {error ? <span className="text-destructive">{error}</span> : message}
      </span>
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
          <X />
          إلغاء
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
          حفظ
        </Button>
      </div>
    </div>
  );
}

