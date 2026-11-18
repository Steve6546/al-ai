/**
 * The gradient's stops: add, select, delete, reorder.
 *
 * The bar at the top is the real gradient — the same function the engine uses to
 * paint the page — so what is dragged here is what the page becomes, not an
 * illustration of it.
 *
 * Reordering is HTML5 drag and drop, which is a pointer affordance and therefore
 * unavailable to a keyboard. Rather than make the feature pointer-only, the two
 * arrow buttons on the selected chip move it one place; both paths end in the same
 * `reorder` call, so a reorder is one operation with two ways to reach it.
 */
import { useCallback, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Plus, Trash2 } from "lucide-react";
import { MAX_THEME_COLORS, normaliseHex } from "@al-ai/core/browser";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";

export function GradientBar({ colors, angle, className }: { colors: readonly string[]; angle: number; className?: string }) {
  const stops = colors.filter(normaliseHex);
  const background =
    stops.length > 1
      ? `linear-gradient(${angle}deg, ${stops.join(", ")})`
      : stops[0] ?? "var(--muted)";
  return (
    <div
      className={cn("h-10 w-full overflow-hidden rounded-xl border border-border", className)}
      style={{ background }}
      aria-hidden
    />
  );
}

export function ColorStops({
  colors,
  angle,
  selected,
  onSelect,
  onChange,
  onAdd,
  onRemove,
  labels
}: {
  colors: string[];
  angle: number;
  selected: number;
  onSelect: (index: number) => void;
  onChange: (colors: string[], options: { live?: boolean }) => void;
  onAdd: () => void;
  onRemove: (index: number) => void;
  labels: { add: string; remove: string; moveStart: string; moveEnd: string; current: string };
}) {
  const { language } = useI18n();
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const dragIndex = useRef<number | null>(null);

  const reorder = useCallback(
    (from: number, to: number) => {
      if (to < 0 || to >= colors.length || from === to) return;
      const next = [...colors];
      const [moved] = next.splice(from, 1);
      if (!moved) return;
      next.splice(to, 0, moved);
      onChange(next, { live: false });
      onSelect(to);
    },
    [colors, onChange, onSelect]
  );

  // In RTL the "start" edge is the right one, so the arrow glyphs flip with the
  // document direction rather than always pointing left.
  const StartArrow = language === "ar" ? ArrowRight : ArrowLeft;
  const EndArrow = language === "ar" ? ArrowLeft : ArrowRight;

  return (
    <div className="space-y-2.5">
      <GradientBar colors={colors} angle={angle} />

      <div className="flex flex-wrap items-center gap-2" role="list">
        {colors.map((color, index) => {
          const active = index === selected;
          return (
            <div
              key={`${color}-${index}`}
              role="listitem"
              draggable
              onDragStart={event => {
                dragIndex.current = index;
                setDragging(index);
                event.dataTransfer.effectAllowed = "move";
                // Firefox refuses to start a drag without data on the transfer.
                event.dataTransfer.setData("text/plain", String(index));
              }}
              onDragOver={event => {
                event.preventDefault();
                setOver(index);
              }}
              onDragLeave={() => setOver(current => (current === index ? null : current))}
              onDrop={event => {
                event.preventDefault();
                const from = dragIndex.current ?? Number(event.dataTransfer.getData("text/plain"));
                setDragging(null);
                setOver(null);
                dragIndex.current = null;
                if (Number.isFinite(from)) reorder(from, index);
              }}
              onDragEnd={() => {
                setDragging(null);
                setOver(null);
                dragIndex.current = null;
              }}
              className={cn(
                "relative flex items-center gap-1 rounded-xl border bg-card p-1 transition-ui",
                active ? "border-primary ring-1 ring-primary/40" : "border-border",
                dragging === index && "opacity-50",
                over === index && dragging !== index && "border-dashed border-primary"
              )}
            >
              <button
                type="button"
                onClick={() => onSelect(index)}
                aria-pressed={active}
                aria-label={`${labels.current} ${index + 1}`}
                className={cn(
                  "size-8 rounded-lg border transition-transform",
                  active ? "border-foreground/60" : "border-black/15 hover:scale-105"
                )}
                style={{ backgroundColor: color }}
              />
              {active ? (
                <span className="flex items-center gap-0.5">
                  <button
                    type="button"
                    onClick={() => reorder(index, index - 1)}
                    disabled={index === 0}
                    aria-label={labels.moveStart}
                    className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
                  >
                    <StartArrow className="size-3.5" aria-hidden />
                  </button>
                  <button
                    type="button"
                    onClick={() => reorder(index, index + 1)}
                    disabled={index === colors.length - 1}
                    aria-label={labels.moveEnd}
                    className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
                  >
                    <EndArrow className="size-3.5" aria-hidden />
                  </button>
                  <button
                    type="button"
                    onClick={() => onRemove(index)}
                    disabled={colors.length <= 1}
                    aria-label={labels.remove}
                    className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-30"
                  >
                    <Trash2 className="size-3.5" aria-hidden />
                  </button>
                </span>
              ) : null}
            </div>
          );
        })}

        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-10 gap-1.5"
          onClick={onAdd}
          disabled={colors.length >= MAX_THEME_COLORS}
        >
          <Plus className="size-4" aria-hidden />
          {labels.add}
        </Button>
      </div>
    </div>
  );
}
