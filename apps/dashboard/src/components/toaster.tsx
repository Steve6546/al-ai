import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, X } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Global toast stack.
 *
 * Two deliberate asymmetries between success and failure:
 *
 * - A **failure** carries `role="alert"`, so a screen reader interrupts to read
 *   it, and it never auto-dismisses. A failure the operator never saw is a
 *   failure they will report as "it didn't work".
 * - A **success** carries `role="status"`, is polite, and disappears on a timer,
 *   because it needs no action.
 *
 * The detail string is what `describeAppearanceResult` produced: it names every
 * field that failed and why, rather than a generic "something went wrong".
 */

export type ToastTone = "success" | "error" | "info";

export type Toast = {
  id: string;
  tone: ToastTone;
  title: string;
  /** The detail line — what `describeAppearanceResult` produced. */
  description?: string;
};

let counter = 0;

/** Monotonic, so React keys stay stable even for two toasts in the same tick. */
export function nextToastId(): string {
  counter += 1;
  return `toast-${counter}`;
}

const TONE_STYLES: Record<ToastTone, { wrapper: string; Icon: typeof CheckCircle2 }> = {
  success: { wrapper: "border-emerald-500/40 bg-emerald-500/10 text-emerald-200", Icon: CheckCircle2 },
  error: { wrapper: "border-destructive/50 bg-destructive/10 text-destructive", Icon: AlertTriangle },
  info: { wrapper: "border-border bg-popover text-foreground", Icon: CheckCircle2 }
};

/** How long a success stays up. Failures stay until dismissed. */
const AUTO_DISMISS_MS = 6000;

export function Toaster({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: string) => void }) {
  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 top-4 z-50 mx-auto flex w-[min(34rem,calc(100%-2rem))] flex-col gap-2">
      {toasts.map(toast => (
        <ToastRow key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function ToastRow({ toast, onDismiss }: { toast: Toast; onDismiss: (id: string) => void }) {
  const { wrapper, Icon } = TONE_STYLES[toast.tone];

  useEffect(() => {
    if (toast.tone === "error") return;
    const timer = setTimeout(() => onDismiss(toast.id), AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [onDismiss, toast.id, toast.tone]);

  return (
    <div
      // `alert` interrupts; `status` waits for a pause. The severity decides.
      role={toast.tone === "error" ? "alert" : "status"}
      aria-live={toast.tone === "error" ? "assertive" : "polite"}
      className={cn(
        "animate-in slide-in-from-top-2 fade-in pointer-events-auto flex items-start gap-2 rounded-lg border px-3 py-2 shadow-lg backdrop-blur",
        wrapper
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-medium">{toast.title}</p>
        {toast.description ? <p className="mt-0.5 text-xs opacity-90">{toast.description}</p> : null}
      </div>
      <button
        type="button"
        onClick={() => onDismiss(toast.id)}
        aria-label="إغلاق الإشعار"
        className="shrink-0 rounded p-0.5 opacity-70 transition-opacity hover:opacity-100"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}

/** Convenience hook: `const { toasts, push, dismiss } = useToasts();` */
export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = (toast: Omit<Toast, "id">) => {
    setToasts(current => [...current, { ...toast, id: nextToastId() }]);
  };

  const dismiss = (id: string) => {
    setToasts(current => current.filter(toast => toast.id !== id));
  };

  return { toasts, push, dismiss };
}
