import { useEffect, useRef, useState } from "react";
import { RefreshCw, Sparkles } from "lucide-react";
import { api } from "@/api";
import { useI18n } from "@/lib/i18n";
import { Button } from "@/components/ui/button";

/**
 * A thin bar that appears when the served build differs from the one this tab
 * loaded.
 *
 * The server publishes the hashed entry script `/api/version`; a rebuild mints
 * a new hash, so a change is exactly "there is a newer build". The check runs
 * on mount, on a short poll, and whenever the tab becomes visible or focused —
 * so a tab left open overnight learns about a deploy without a manual reload.
 * It never fires on a failed check, and it appears once per session, not as a
 * repeating toast.
 *
 * **The baseline is the bundle this document actually loaded**, read from its
 * own `<script type="module">` tag, not the first poll result. The old version
 * compared two polls, which made the check blind to the one case that matters
 * most: a tab opened *before* a deploy whose first poll lands after it — the
 * tab then adopts the new hash as its baseline and reports "up to date" while
 * running the old code. Reading the script tag is also self-correcting after a
 * reload: the loaded bundle and the served one are the same again.
 *
 * Reloading is the operator's choice: the bar never reloads on its own, so an
 * unsaved draft is not lost under them.
 */
const POLL_MS = 20_000;

/** The entry script this document loaded, in the server's own notation. */
function loadedBuild(): string | null {
  const script = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/"]');
  const src = script?.getAttribute("src");
  // `/api/version` answers with the path as `index.html` names it — no leading
  // slash — so the comparison is made on the same shape.
  return src ? src.replace(/^\//, "") : null;
}

export function UpdateBanner() {
  const { t } = useI18n();
  const [available, setAvailable] = useState(false);
  const baseline = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const check = async () => {
      try {
        const { version } = await api.version();
        if (cancelled || !version) return;
        if (baseline.current === null) {
          // A document with no script tag (a test harness, an unusual embed)
          // falls back to the served build, which is the old behaviour.
          baseline.current = loadedBuild() ?? version;
        }
        if (version !== baseline.current) setAvailable(true);
      } catch {
        /* a failed check is not an update */
      }
    };

    void check();
    const timer = setInterval(() => void check(), POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, []);

  if (!available) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-x-0 top-0 z-50 flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5 border-b border-primary/30 bg-primary px-3 py-2 text-sm text-primary-foreground shadow-lg"
    >
      <Sparkles className="size-4 shrink-0" aria-hidden />
      <span className="min-w-0">{t("update.available")}</span>
      <Button size="sm" variant="secondary" className="gap-1.5" onClick={() => window.location.reload()}>
        <RefreshCw className="size-3.5" aria-hidden />
        {t("update.reload")}
      </Button>
    </div>
  );
}
