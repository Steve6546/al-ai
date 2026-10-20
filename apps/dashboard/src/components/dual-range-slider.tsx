import { useCallback, useRef } from "react";

/**
 * A dual-thumb range slider: two native range inputs stacked over one track,
 * each clamped so the thumbs can never cross. Native inputs keep keyboard and
 * screen-reader behaviour for free (arrows, Home/End, aria-valuetext); the
 * visual track and filled span are drawn underneath, driven by the values.
 *
 * Built after Spectrum UI's dual-range pattern without adding a Radix slider
 * dependency — the project had no slider primitive, and two native inputs give
 * the same two-thumb result with zero install.
 */
export function DualRangeSlider({
  valueMin,
  valueMax,
  floor,
  ceiling,
  step = 1,
  onMinChange,
  onMaxChange,
  label,
  formatValue
}: {
  valueMin: number;
  valueMax: number;
  floor: number;
  ceiling: number;
  step?: number;
  onMinChange: (value: number) => void;
  onMaxChange: (value: number) => void;
  label: string;
  formatValue?: (value: number) => string;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const span = Math.max(1, ceiling - floor);
  const loPct = ((Math.min(valueMin, valueMax) - floor) / span) * 100;
  const hiPct = ((Math.max(valueMin, valueMax) - floor) / span) * 100;
  const format = formatValue ?? ((value: number) => String(value));

  const handle = useCallback(
    (which: "min" | "max") => (event: React.ChangeEvent<HTMLInputElement>) => {
      const next = Number(event.target.value);
      if (which === "min") onMinChange(Math.min(next, valueMax));
      else onMaxChange(Math.max(next, valueMin));
    },
    [onMinChange, onMaxChange, valueMin, valueMax]
  );

  const thumbProps = (which: "min" | "max", value: number) => ({
    type: "range" as const,
    min: floor,
    max: ceiling,
    step,
    value,
    onChange: handle(which),
    "aria-label": `${label} — ${which === "min" ? "الأدنى" : "الأقصى"}`,
    dir: "ltr" as const
  });

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs text-muted-foreground" dir="ltr">
        <span>{format(valueMin)}</span>
        <span>{format(valueMax)}</span>
      </div>
      <div ref={trackRef} className="relative flex h-6 w-full touch-none select-none items-center" dir="ltr">
        {/* Track */}
        <div className="absolute h-1.5 w-full rounded-full bg-muted" />
        {/* Filled span between the thumbs */}
        <div
          className="absolute h-1.5 rounded-full bg-primary"
          style={{ left: `${loPct}%`, width: `${Math.max(2, hiPct - loPct)}%` }}
        />
        {/* The two stacked native inputs — pointer-events pass through the
            empty half of each so both thumbs stay grabbable. */}
        <input
          {...thumbProps("min", Math.max(floor, Math.min(valueMin, valueMax)))}
          className="pointer-events-none absolute h-6 w-full appearance-none bg-transparent
            [&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4
            [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2
            [&::-webkit-slider-thumb]:border-primary [&::-webkit-slider-thumb]:bg-background [&::-webkit-slider-thumb]:shadow
            [&::-moz-range-thumb]:pointer-events-auto [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4
            [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2
            [&::-moz-range-thumb]:border-primary [&::-moz-range-thumb]:bg-background"
        />
        <input
          {...thumbProps("max", Math.min(ceiling, Math.max(valueMax, valueMin)))}
          className="pointer-events-none absolute h-6 w-full appearance-none bg-transparent
            [&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4
            [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2
            [&::-webkit-slider-thumb]:border-primary [&::-webkit-slider-thumb]:bg-primary [&::-webkit-slider-thumb]:shadow
            [&::-moz-range-thumb]:pointer-events-auto [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4
            [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2
            [&::-moz-range-thumb]:border-primary [&::-moz-range-thumb]:bg-primary"
        />
      </div>
    </div>
  );
}
