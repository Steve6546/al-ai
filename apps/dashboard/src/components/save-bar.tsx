import { Button } from "@/components/ui/button";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { useRef, useState } from "react";

/**
 * The unsaved-changes bar.
 *
 * It floats at the **bottom** of the window, the way a "you have unsaved
 * changes" bar is meant to be read: it is the last thing on the screen, and
 * the eye finds it there. Two things have to be true for a floating bar to be
 * usable, and both are enforced here:
 *
 * - **It must not cover the content.** The bar is out of the flow, so the
 *   screen's own bottom padding (the `pb-*` on the screen's root, and the
 *   `<main>`'s `pb-24`) is what keeps the last field of a long form clear of
 *   it.
 * - **It must not cover an open menu.** The dropdowns, the font picker and the
 *   colour menus are rendered in a **portal** at `z-50`; the bar sits at
 *   `z-40`, *below* them, so the option the operator is reaching for is never
 *   swallowed by the bar - the click lands on the menu, not on the bar.
 *
 * The rules the bar keeps:
 *
 * - It is **fixed to the bottom of the window**, inside the content column -
 *   the shell publishes the sidebar's width as `--sidebar-width`, so the bar
 *   never stretches over the sidebar - and it is *not* a modal: it never traps
 *   focus and never blocks the content underneath.
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
  cancelLabel = "تجاهل",
  canSave = true,
  blockedMessage = null
}: {
  onSave: () => Promise<void>;
  onCancel: () => void;
  message?: string;
  saveLabel?: string;
  cancelLabel?: string;
  /**
   * The screen knows a prerequisite the request would fail on - a channel that
   * was never chosen. Saying it in the bar, before the click, is the whole
   * point: the operator reads the reason instead of a rejection from a server
   * that already knew it.
   */
  canSave?: boolean;
  blockedMessage?: string | null;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /*
   * The re-entry guard is a ref, not `saving`. `setSaving(true)` only paints on
   * the next render, so a burst of clicks could pass the disabled check before
   * it lands - and each pass was another request. The ref flips in the same
   * tick the click arrives, so one press is one request.
   */
  const inFlight = useRef(false);
  const blocked = canSave ? null : blockedMessage;

  return (
    <div
      role="status"
      aria-live="polite"
      /*
       * **Fixed at the bottom of the window, inside the content column.**
       *
       * The column's left edge is the sidebar's width, and the shell publishes
       * it as `--sidebar-width` - so the bar spans the content, never the
       * sidebar, and it is pinned to the bottom of the window even on a short
       * screen where the content does not reach it.
       *
       * `z-40` puts it **above** the page content and **below** an open
       * menu: the dropdowns, the font picker and the colour menus are
       * rendered in a portal at `z-50`, so the option the operator is
       * reaching for is never swallowed by the bar.
       *
       * The bar is out of the flow, so it covers whatever is behind it; the
       * screen's own bottom padding is what keeps the last field of a long
       * form clear of it.
       */
      className="fixed inset-x-0 bottom-0 z-40 px-4 pb-4 lg:left-[var(--sidebar-width)]"
    >
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-2xl border border-warning/40 bg-card/95 px-4 py-2.5 shadow-lg backdrop-blur-md">
        <span className="flex min-w-0 flex-1 items-center gap-2 text-sm">
          {error ? (
            <>
              <AlertTriangle className="size-4 shrink-0 text-destructive" />
              <span className="min-w-0 text-destructive">{error}</span>
            </>
          ) : blocked ? (
            <>
              <AlertTriangle className="size-4 shrink-0 text-warning" />
              <span className="min-w-0 text-warning">{blocked}</span>
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
            disabled={!canSave}
            onClick={async () => {
              if (inFlight.current) return;
              inFlight.current = true;
              setSaving(true);
              setError(null);
              try {
                await onSave();
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : "تعذّر الحفظ.");
              } finally {
                inFlight.current = false;
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
