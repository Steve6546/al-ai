import { useEffect, useRef, useState } from "react";
import { Pipette } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * A dependency-free colour picker.
 *
 * The native `<input type="color">` opens the operating system's own picker,
 * which is a different dialog on every platform, cannot be styled, and on some
 * Linux builds opens nothing at all. This replaces it with a control the
 * dashboard owns: a hue strip, a saturation/brightness square, a hex field and
 * the swatches Discord itself uses for roles.
 *
 * Everything is plain DOM — no colour maths is needed to *render*. The hue strip
 * is a CSS gradient and the square is two stacked gradients (white → hue
 * horizontally, transparent → black vertically), which is exactly how an HSV
 * editor is drawn. Conversion is needed only to speak the `#rrggbb` the rest of
 * the system uses.
 */

/** Discord's role colours, in the order its own picker shows them. */
export const DISCORD_ROLE_SWATCHES = [
  "#1abc9c",
  "#2ecc71",
  "#3498db",
  "#9b59b6",
  "#e91e63",
  "#f1c40f",
  "#e67e22",
  "#e74c3c",
  "#95a5a6",
  "#607d8b",
  "#11806a",
  "#1f8b4c",
  "#206694",
  "#71368a",
  "#ad1457",
  "#c27c0e",
  "#a84300",
  "#992d22",
  "#979c9f",
  "#546e7a"
] as const;

export type Rgb = { r: number; g: number; b: number };
export type Hsv = { h: number; s: number; v: number };

export function hexToRgb(hex: string): Rgb | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const value = Number.parseInt(match[1], 16);
  return { r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff };
}

/** `#rrggbb`, lowercase, zero-padded — the only spelling the BFF accepts. */
export function rgbToHex({ r, g, b }: Rgb): string {
  const part = (channel: number) => Math.max(0, Math.min(255, Math.round(channel))).toString(16).padStart(2, "0");
  return `#${part(r)}${part(g)}${part(b)}`;
}

export function rgbToHsv({ r, g, b }: Rgb): Hsv {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;

  let hue = 0;
  if (delta !== 0) {
    if (max === red) hue = ((green - blue) / delta) % 6;
    else if (max === green) hue = (blue - red) / delta + 2;
    else hue = (red - green) / delta + 4;
  }
  return {
    // The hue is deliberately *not* rounded to a whole degree. A single degree
    // is enough to shift a channel across a rounding boundary, so rounding here
    // makes the round trip lossy: `#e74c3c` comes back as `#e74d3c`. The picker
    // calls this on every render to seed its HSV state, so an operator who clicks
    // a Discord swatch and then nudges saturation would be handed a colour that
    // is *not* the one they clicked. The hue track rounds for display on its own.
    h: ((hue * 60) % 360 + 360) % 360,
    s: max === 0 ? 0 : delta / max,
    v: max
  };
}

export function hsvToRgb({ h, s, v }: Hsv): Rgb {
  // Hue wraps. Without this, a hue of exactly 360 (the hue track's right edge)
  // fell through every branch and produced the sixth sector's colour instead of
  // red — and any negative hue would have done the same.
  const hue = ((h % 360) + 360) % 360;
  const chroma = v * s;
  const sector = hue / 60;
  const second = chroma * (1 - Math.abs((sector % 2) - 1));
  const offset = v - chroma;

  const [red, green, blue] =
    sector < 1 ? [chroma, second, 0]
    : sector < 2 ? [second, chroma, 0]
    : sector < 3 ? [0, chroma, second]
    : sector < 4 ? [0, second, chroma]
    : sector < 5 ? [second, 0, chroma]
    : [chroma, 0, second];

  return { r: (red + offset) * 255, g: (green + offset) * 255, b: (blue + offset) * 255 };
}

/** Best-effort readable text colour for an arbitrary background. */
export function contrastingText(hex: string): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return "#ffffff";
  // Rec. 709 luma. The 0.45 threshold sits where white text stops reading
  // clearly on the mid-tones, which is where Discord's own swatches turn over.
  const luma = (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255;
  return luma > 0.45 ? "#111827" : "#ffffff";
}

type Props = {
  /** Current value as `#rrggbb`, or null for "Discord's default". */
  value: string | null;
  onChange: (hex: string | null) => void;
  /** What a null value means here, for the clear button. */
  unsetLabel?: string;
  id?: string;
};

export function ColorPicker({ value, onChange, unsetLabel = "بلا لون", id }: Props) {
  // The HSV state is kept separately from the hex prop. Round-tripping through
  // hex on every drag would lose the hue whenever saturation or brightness hits
  // zero — every dark colour becomes black, and the hue slider would snap to red
  // the moment the operator dragged to the bottom of the square.
  const [hsv, setHsv] = useState<Hsv>(() => {
    const rgb = hexToRgb(value ?? "#3b82f6");
    return rgb ? rgbToHsv(rgb) : { h: 217, s: 0.91, v: 0.96 };
  });
  const [hexDraft, setHexDraft] = useState(value ?? "");
  const squareRef = useRef<HTMLDivElement | null>(null);
  const hueRef = useRef<HTMLDivElement | null>(null);

  // Reflect an external change — a swatch click, a reset, a reload — without
  // fighting the operator's own drag, which is why this depends on `value` and
  // not on `hsv`.
  useEffect(() => {
    setHexDraft(value ?? "");
    if (!value) return;
    const rgb = hexToRgb(value);
    if (!rgb) return;
    setHsv(current => {
      const next = rgbToHsv(rgb);
      // Hue is meaningless at zero saturation or brightness, so it is carried
      // over rather than taken from the (undefined) conversion.
      return { h: next.s === 0 || next.v === 0 ? current.h : next.h, s: next.s, v: next.v };
    });
  }, [value]);

  const commit = (next: Hsv) => {
    setHsv(next);
    onChange(rgbToHex(hsvToRgb(next)));
  };

  const trackSquare = (event: React.PointerEvent<HTMLDivElement>) => {
    const box = squareRef.current?.getBoundingClientRect();
    if (!box) return;
    const x = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
    const y = Math.min(1, Math.max(0, (event.clientY - box.top) / box.height));
    commit({ h: hsv.h, s: x, v: 1 - y });
  };

  const trackHue = (event: React.PointerEvent<HTMLDivElement>) => {
    const box = hueRef.current?.getBoundingClientRect();
    if (!box) return;
    const x = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
    commit({ h: Math.round(x * 360) % 360, s: hsv.s, v: hsv.v });
  };

  /** Press-and-drag, with the capture taken on the track itself. */
  const draggable = (track: (event: React.PointerEvent<HTMLDivElement>) => void) => ({
    onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => {
      event.currentTarget.setPointerCapture(event.pointerId);
      track(event);
    },
    onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) track(event);
    }
  });

  const current = value ?? null;
  const resolved = current ?? "#4e5058";
  const pureHue = rgbToHex(hsvToRgb({ h: hsv.h, s: 1, v: 1 }));

  return (
    <div className="space-y-3">
      <div className="flex gap-3">
        <div
          ref={squareRef}
          role="slider"
          aria-label="اللون والتشبّع"
          aria-valuetext={resolved}
          aria-valuenow={Math.round(hsv.s * 100)}
          tabIndex={0}
          className="relative h-32 w-full cursor-crosshair rounded-md border border-border touch-none"
          style={{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${pureHue})` }}
          {...draggable(trackSquare)}
        >
          <span
            className="pointer-events-none absolute size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow"
            style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, backgroundColor: pureHue }}
          />
        </div>

        <div className="flex flex-col gap-3">
          <div
            className="grid h-32 w-14 shrink-0 place-items-center rounded-md border border-border"
            style={{ backgroundColor: resolved }}
            title={current ?? unsetLabel}
          >
            <Pipette className="size-4 opacity-70" style={{ color: contrastingText(resolved) }} />
          </div>
          <Input
            dir="ltr"
            className="w-24"
            aria-label="قيمة اللون"
            placeholder="#rrggbb"
            value={hexDraft}
            onChange={event => {
              const next = event.target.value;
              setHexDraft(next);
              // Committed only when complete: a half-typed value would otherwise
              // be pushed upward on every keystroke and wipe the stored colour.
              if (/^#[0-9a-f]{6}$/i.test(next.trim())) onChange(next.trim().toLowerCase());
            }}
            onBlur={() => setHexDraft(value ?? "")}
          />
        </div>
      </div>

      <div
        ref={hueRef}
        role="slider"
        aria-label="درجة اللون"
        aria-valuemin={0}
        aria-valuemax={360}
        aria-valuenow={Math.round(hsv.h)}
        tabIndex={0}
        className="relative h-4 w-full cursor-pointer rounded-full border border-border touch-none"
        style={{
          background:
            "linear-gradient(to right, #f00 0%, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00 100%)"
        }}
        {...draggable(trackHue)}
      >
        <span
          className="pointer-events-none absolute top-1/2 size-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow"
          style={{ left: `${(hsv.h / 360) * 100}%`, backgroundColor: pureHue }}
        />
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {DISCORD_ROLE_SWATCHES.map(swatch => (
          <button
            key={swatch}
            type="button"
            aria-label={swatch}
            title={swatch}
            onClick={() => onChange(swatch)}
            className={cn(
              "size-6 rounded-md border transition-transform hover:scale-110",
              current?.toLowerCase() === swatch ? "border-foreground ring-2 ring-ring" : "border-border"
            )}
            style={{ backgroundColor: swatch }}
          />
        ))}
        <button
          type="button"
          onClick={() => onChange(null)}
          className={cn(
            "ms-1 rounded-md border px-2 py-1 text-xs transition-colors",
            current === null ? "border-foreground bg-accent text-accent-foreground" : "border-border text-muted-foreground hover:bg-accent"
          )}
          id={id}
        >
          {unsetLabel}
        </button>
      </div>
    </div>
  );
}
