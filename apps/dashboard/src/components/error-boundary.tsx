import { Component, type ErrorInfo, type ReactNode } from "react";
import { RotateCcw, TriangleAlert } from "lucide-react";

/**
 * The last line of defence between a render error and a black page.
 *
 * A React render error does not degrade — it unmounts the whole tree, so the
 * operator gets the bare page background and nothing else. No message, no
 * console hint they would think to open, and no way back except a manual
 * reload. That is exactly what "هوية البوت" did when a hook ran on only one of
 * its two render passes: the spinner appeared, the data landed, and the screen
 * went black.
 *
 * This boundary turns that into a sentence a person can act on, and — just as
 * importantly — it keeps the failure contained. The shell, the sidebar and the
 * other screens survive, so the operator can navigate away instead of being
 * stranded.
 *
 * `resetKey` is what makes recovery possible. React does not retry a failed
 * subtree on its own, so without a key the boundary would stay latched on the
 * error for the life of the session: every other screen would render the error
 * card. Changing the key (guild or view) clears the latch and remounts the
 * children.
 *
 * The fallback is deliberately built from plain elements rather than the
 * `ui/` primitives: a boundary that depends on the component tree it is
 * guarding is not a boundary. If the failure is in a shared primitive, the
 * fallback has to still be able to draw itself.
 */

type Props = {
  children: ReactNode;
  /** Changing this clears a latched error. Use the guild id and view key. */
  resetKey?: string;
  /** What was being rendered, for the message. */
  scope?: string;
};

type State = { error: Error | null };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Kept in the console on purpose: the fallback is for the operator, this is
    // for whoever has to fix it, and a boundary that swallows the stack turns
    // a five-minute diagnosis into an afternoon.
    console.error("AL AI dashboard: a screen failed to render", error, info.componentStack);
  }

  componentDidUpdate(previous: Props) {
    if (this.state.error && previous.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const scope = this.props.scope ? `شاشة «${this.props.scope}»` : "هذه الشاشة";

    return (
      <div
        role="alert"
        className="space-y-3 rounded-lg border border-destructive/40 bg-destructive/10 p-4"
      >
        <div className="flex items-start gap-2.5">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
          <div className="space-y-1">
            <p className="text-sm font-medium">تعذّر عرض {scope}</p>
            <p className="text-xs leading-relaxed text-muted-foreground">
              حدث خطأ غير متوقع أثناء بناء الواجهة. بقية الصفحة تعمل — تنقّل إلى شاشة أخرى أو أعد
              المحاولة. التفاصيل التقنية في وحدة تحكّم المتصفّح (Console).
            </p>
            <p dir="ltr" className="pt-1 text-start font-mono text-[11px] break-all text-muted-foreground">
              {error.message}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => this.setState({ error: null })}
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
        >
          <RotateCcw className="size-3.5" />
          إعادة المحاولة
        </button>
      </div>
    );
  }
}
