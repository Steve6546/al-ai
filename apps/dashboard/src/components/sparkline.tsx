import { sparklineArea, sparklinePath } from "@al-ai/core/browser";
import { cn } from "@/lib/utils";

/**
 * A 24-point activity line drawn from real rows.
 *
 * Two details are deliberate:
 *
 * - The SVG uses `preserveAspectRatio="none"` with a fixed 100 × 32 viewBox, so
 *   the line fills whatever width the card gives it. Drawing it at its natural
 *   size would either leave a gap on a wide card or squeeze it on a phone.
 * - The stroke is `currentColor`, so the caller's tone class decides the hue and
 *   the chart follows the account's accent without knowing what an accent is.
 *
 * A series of zeros still draws a flat line along the baseline (`sparklinePath`
 * guarantees that), because "no activity" is a fact worth showing, and an empty
 * box reads like a chart that failed to load.
 */
export function Sparkline({
  values,
  label,
  className,
  height = 40
}: {
  values: readonly number[];
  /** Accessible name: a screen reader gets the trend, not 24 path commands. */
  label: string;
  className?: string;
  height?: number;
}) {
  const options = { width: 100, height: 32, inset: 2 };
  const line = sparklinePath(values, options);
  const area = sparklineArea(values, options);

  if (!line) return null;

  const total = values.reduce((sum, value) => sum + value, 0);

  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 100 32`}
      preserveAspectRatio="none"
      style={{ height }}
      className={cn("block w-full overflow-visible", className)}
    >
      {/* The numbers go to assistive technology through <title>, so the chart is
          not a decorative image with a text alternative bolted on by a caller. */}
      <title>{`${label} · ${total}`}</title>
      <path d={area} fill="currentColor" opacity={0.14} />
      <path d={line} fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round"
        vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
