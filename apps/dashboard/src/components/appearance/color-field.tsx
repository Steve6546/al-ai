/**
 * The colour field: a real picker instead of the browser's RGB dialog.
 *
 * `<input type="color">` opens a native dialog that looks like a 1998 form
 * control, cannot be themed, offers no eyedropper, and on some platforms cannot
 * report a colour until the dialog is dismissed — so a live preview is impossible
 * while picking. `react-colorful` is 2.8 kB, has no dependencies, and is built
 * from two elements: a saturation/brightness area and a hue rail. That is the
 * control this file wraps, and everything around it is ours:
 *
 * - **A hex field** that accepts `#abc`, `#AABBCC`, `abc` and a pasted `rgb()`.
 *   Typing is the fastest way to reproduce a colour somebody has on a spec sheet,
 *   and it is the one input the browser dialog does not offer at all.
 * - **Copy**, because the first thing anybody does with a picked colour is paste
 *   it somewhere else.
 * - **The eyedropper**, when the browser has `EyeDropper`. It is feature-detected
 *   rather than assumed: it exists in Chromium and not in Firefox or Safari, and a
 *   button that silently does nothing is worse than no button.
 * - **Quick swatches**, which are the six hues the product already uses plus two
 *   neutrals — a starting point, not a palette.
 *
 * The commit discipline matters as much as the layout: dragging the saturation
 * area fires `onChange` continuously, so the parent decides what is live (queued
 * into the next animation frame) and what is final (written to the account).
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { HexColorPicker } from "react-colorful";
import { Check, Copy, Pipette } from "lucide-react";
import { contrastRatio, normaliseHex, readableText } from "@al-ai/core/browser";
import { cn } from "@/lib/utils";

/** Chromium-only today; feature-detected so the button simply is not rendered elsewhere. */
type EyeDropperConstructor = new () => { open: (options?: { signal?: AbortSignal }) => Promise<{ sRGBHex: string }> };

function eyeDropper(): EyeDropperConstructor | null {
  const candidate = (globalThis as { EyeDropper?: EyeDropperConstructor }).EyeDropper;
  return typeof candidate === "function" ? candidate : null;
}

/** `rgb(12, 34, 56)` and `12,34,56` in, hex out — a paste is a common input. */
export function parseColorInput(input: string): string | null {
  const value = input.trim();
  const direct = normaliseHex(value.startsWith("#") ? value : `#${value}`.replace("#rgb", "#rgb"));
  if (direct) return direct;
  const rgb = value.match(/^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})/i) ?? value.match(/^(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})$/);
  if (rgb) {
    const channels = rgb.slice(1, 4).map(part => Math.min(255, Math.max(0, Number(part))));
    return `#${channels.map(channel => channel.toString(16).padStart(2, "0")).join("")}`;
  }
  return null;
}

export function ColorField({
  label,
  value,
  onChange,
  onCommit,
  swatches = [],
  className,
  disabled,
  /** Shown beside the hue rail: the contrast of white and of black on this colour. */
  showContrast = false
}: {
  label: string;
  value: string;
  /** Fires continuously while dragging. */
  onChange: (hex: string) => void;
  /** Fires when a change is finished (picker closed, hex committed, swatch pressed). */
  onCommit?: (hex: string) => void;
  swatches?: readonly string[];
  className?: string;
  disabled?: boolean;
  showContrast?: boolean;
}) {
  const current = normaliseHex(value) ?? "#000000";
  const [draft, setDraft] = useState(current);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const id = useId();

  // The field follows the picker, but not while the operator is typing in it.
  useEffect(() => {
    setDraft(current);
  }, [current]);

  const commitDraft = useCallback(() => {
    const parsed = parseColorInput(draft);
    if (parsed && parsed !== current) {
      onChange(parsed);
      onCommit?.(parsed);
    } else {
      setDraft(current);
    }
  }, [current, draft, onChange, onCommit]);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(current);
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1200);
    } catch {
      // A blocked clipboard is not an error worth a dialog: the value is on
      // screen and selectable.
    }
  }, [current]);

  const pickFromScreen = useCallback(async () => {
    const Dropper = eyeDropper();
    if (!Dropper) return;
    try {
      const result = await new Dropper().open();
      const hex = normaliseHex(result.sRGBHex);
      if (hex) {
        onChange(hex);
        onCommit?.(hex);
      }
    } catch {
      // Dismissing the eyedropper throws; that is not a failure.
    }
  }, [onChange, onCommit]);

  const contrast = useMemo(() => {
    if (!showContrast) return null;
    const onColor = readableText(current);
    return {
      onColor,
      ratio: contrastRatio(onColor, current),
      light: contrastRatio("#ffffff", current),
      dark: contrastRatio("#0b0b0b", current)
    };
  }, [current, showContrast]);

  return (
    <div className={cn("space-y-2.5", className)}>
      <div className="appearance-picker">
        <HexColorPicker
          color={current}
          onChange={next => onChange(normaliseHex(next) ?? next)}
          onChangeEnd={next => onCommit?.(normaliseHex(next) ?? next)}
          aria-label={label}
          style={{ width: "100%", height: 168 }}
        />
      </div>

      <div className="flex items-center gap-1.5">
        <label
          htmlFor={`${id}-hex`}
          className="grid size-9 shrink-0 place-items-center rounded-lg border border-input"
          style={{ backgroundColor: current }}
          title={label}
        >
          <span className="sr-only">{label}</span>
          <span className="size-full rounded-lg ring-1 ring-inset ring-black/10" aria-hidden />
        </label>
        <input
          id={`${id}-hex`}
          value={draft}
          onChange={event => setDraft(event.target.value)}
          onBlur={commitDraft}
          onKeyDown={event => {
            if (event.key === "Enter") {
              event.preventDefault();
              commitDraft();
            }
            if (event.key === "Escape") setDraft(current);
          }}
          disabled={disabled}
          spellCheck={false}
          dir="ltr"
          aria-label={label}
          className="h-9 min-w-0 flex-1 rounded-lg border border-input bg-background px-2.5 font-mono text-xs uppercase tracking-wide outline-none ring-ring focus-visible:border-ring focus-visible:ring-1"
        />
        <button
          type="button"
          onClick={() => void copy()}
          disabled={disabled}
          title={copied ? "✓" : undefined}
          className="grid size-9 shrink-0 place-items-center rounded-lg border border-input text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
          aria-label={label}
        >
          {copied ? <Check className="size-4 text-success" aria-hidden /> : <Copy className="size-4" aria-hidden />}
        </button>
        {eyeDropper() ? (
          <button
            type="button"
            onClick={() => void pickFromScreen()}
            disabled={disabled}
            className="grid size-9 shrink-0 place-items-center rounded-lg border border-input text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
            aria-label={label}
          >
            <Pipette className="size-4" aria-hidden />
          </button>
        ) : null}
      </div>

      {swatches.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {swatches.map(swatch => {
            const hex = normaliseHex(swatch);
            if (!hex) return null;
            const active = hex === current;
            return (
              <button
                key={swatch}
                type="button"
                disabled={disabled}
                onClick={() => {
                  onChange(hex);
                  onCommit?.(hex);
                }}
                aria-pressed={active}
                aria-label={hex}
                title={hex}
                className={cn(
                  "size-6 rounded-md border transition-transform hover:scale-110 disabled:opacity-50",
                  active ? "border-foreground ring-1 ring-foreground/30" : "border-black/15"
                )}
                style={{ backgroundColor: hex }}
              />
            );
          })}
        </div>
      ) : null}

      {contrast ? (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-micro text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <span
              className="grid size-4 place-items-center rounded text-[9px] font-bold"
              style={{ backgroundColor: current, color: contrast.onColor }}
              aria-hidden
            >
              Aa
            </span>
            {contrast.ratio.toFixed(1)}:1
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="rounded bg-white px-1 text-[9px] font-bold text-black" aria-hidden>
              Aa
            </span>
            {contrast.light.toFixed(1)}:1
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="rounded bg-[#0b0b0b] px-1 text-[9px] font-bold text-white" aria-hidden>
              Aa
            </span>
            {contrast.dark.toFixed(1)}:1
          </span>
        </p>
      ) : null}
    </div>
  );
}
