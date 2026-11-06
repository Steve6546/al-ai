import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Copy text with the async Clipboard API when it exists, and fall back to the
 * legacy selection + `execCommand` path when it does not.
 *
 * `navigator.clipboard` is unavailable on insecure origins — a plain-HTTP LAN
 * address, for one — and there it is `undefined` rather than a rejected
 * promise. Trying only the async path made every copy button on such an origin
 * do nothing at all: no copy, no confirmation, no error. The fallback is what
 * makes the button work wherever the dashboard is reachable.
 */
function legacyCopy(value: string): boolean {
  try {
    const field = document.createElement("textarea");
    field.value = value;
    field.setAttribute("readonly", "");
    field.style.position = "fixed";
    field.style.top = "-1000px";
    field.style.opacity = "0";
    document.body.appendChild(field);
    field.select();
    field.setSelectionRange(0, field.value.length);
    const ok = document.execCommand("copy");
    field.remove();
    return ok;
  } catch {
    return false;
  }
}

export function useCopy(resetAfterMs = 1_800) {
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const copy = useCallback(
    async (value: string, key = value) => {
      let ok = false;
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(value);
          ok = true;
        }
      } catch {
        ok = false;
      }
      if (!ok) ok = legacyCopy(value);
      if (!ok) return false;
      setCopied(key);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(null), resetAfterMs);
      return true;
    },
    [resetAfterMs]
  );

  return { copied, copy };
}
