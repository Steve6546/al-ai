/**
 * The colour dot Discord shows beside a role, rendered the same way everywhere
 * a role can be picked.
 *
 * Discord sends a role's colour as one packed RGB integer, and `0` is how it
 * says "no colour". That is not black — Discord itself shows those roles grey —
 * so a zero renders as *no* swatch rather than as a black one. Getting this
 * wrong in one picker and right in the others is exactly the kind of drift the
 * component exists to prevent.
 */

import { roleColorCss } from "@al-ai/core/browser";

export function RoleSwatch({ color }: { color: number | undefined | null }) {
  const css = roleColorCss(color ?? 0);
  if (!css) return null;
  return (
    <span
      aria-hidden
      className="size-2.5 shrink-0 rounded-full border border-border"
      style={{ background: css }}
    />
  );
}
