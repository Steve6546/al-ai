import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Copy-to-clipboard with a short-lived confirmation.
 *
 * `navigator.clipboard` is unavailable on insecure origins, so the fallback
 * reports failure instead of pretending the copy worked.
 */
export function useCopy(resetAfterMs = 1_800) {
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const copy = useCallback(
    async (value: string, key = value) => {
      try {
        await navigator.clipboard.writeText(value);
      } catch {
        return false;
      }
      setCopied(key);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(null), resetAfterMs);
      return true;
    },
    [resetAfterMs]
  );

  return { copied, copy };
}
