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
 * on mount, on a slow poll, and whenever the tab becomes visible again — so a
 * tab left open overnight learns about a deploy without a manual reload. It
 * never fires on a failed check, and it appears once per session, not as a
 * repeating toast.
 *
 * Reloading is the operator's choice: the bar never reloads on its own, so an
 * unsaved draft is not lost under them.
 */
const POLL_MS = 60_000;

export function UpdateBanner() {
  const { t } = useI18n();
  const [available, setAvailable] = useState(false);
  const first = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const check = async () => {
      try {
        const { version } = await api.version();
        if (cancelled || !version) return;
        if (first.current === null) first.current = version;
        else if (version !== first.current) setAvailable(true);
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
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  if (!available) return null;

  return (
    <div className="fixed inset-x-0 top-0 z-50 flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5 border-b border-primary/30 bg-primary px-3 py-2 text-sm text-primary-foreground shadow-lg">
      <Sparkles className="size-4 shrink-0" aria-hidden />
      <span className="min-w-0">{t("update.available")}</span>
      <Button size="sm" variant="secondary" className="gap-1.5" onClick={() => window.location.reload()}>
        <RefreshCw className="size-3.5" aria-hidden />
        {t("update.reload")}
      </Button>
    </div>
  );
}
