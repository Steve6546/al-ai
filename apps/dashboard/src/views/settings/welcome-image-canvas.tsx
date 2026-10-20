import { useCallback, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import {
  AVATAR_MAX_SIZE,
  AVATAR_MIN_SIZE,
  TEXT_MAX_FONT_SIZE,
  TEXT_MIN_FONT_SIZE,
  clampAnchor,
  clampBox,
  fontSizeFromHandle,
  renderWelcomeMessage,
  sizeFromHandle,
  textAscentRatio,
  toCardSpace,
  type WelcomeImageConfig,
  type WelcomeTemplateValues
} from "@al-ai/core/browser";

/**
 * The Image Builder canvas: a scaled, live preview of the card the bot will
 * draw, with the layers as real, draggable elements.
 *
 * **One coordinate system.** Everything here is in *card* pixels - the pixels
 * of the exported image - and the scale is only ever a conversion between the
 * pointer's screen pixels and those. The renderer (the bot) reads the same
 * numbers, so what the operator drags is what the joiner gets.
 *
 * **The text is SVG on purpose.** The renderer draws text with an alphabetic
 * *baseline* at `y`; an HTML box puts its *top* at `y`, a whole line-height
 * higher, and the gap grows with the font size. An SVG `<text>` with
 * `dominant-baseline="alphabetic"` and the matching `text-anchor` is the same
 * geometry the canvas uses, so the preview and the exported image agree to the
 * pixel.
 *
 * **The resize follows the pointer.** The handle sits at the bottom-right, so
 * the size is the distance from the box's *fixed* corner to the pointer - not
 * the horizontal movement. That is what stops a small layer from jumping when
 * it is scaled up: the corner the operator holds stays under their finger.
 */

type Selection = { kind: "avatar" } | { kind: "username" } | { kind: "custom"; id: string } | null;

type LayerBox = { x: number; y: number };

export function WelcomeImageCanvas({
  config,
  values,
  selected,
  onSelect,
  onConfigChange
}: {
  config: WelcomeImageConfig;
  values: WelcomeTemplateValues;
  selected: Selection;
  onSelect: (selection: Selection) => void;
  onConfigChange: (next: WelcomeImageConfig) => void;
}) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const dragState = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    origin: LayerBox;
    target: Exclude<Selection, null>;
    resizing: boolean;
  } | null>(null);
  const [scale, setScale] = useState(1);

  // The preview fits the available width; the canvas itself keeps the real
  // dimensions, so a 1024-wide card reads exactly like the file the bot sends.
  const measure = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node) return;
      const available = node.parentElement?.clientWidth ?? config.width;
      setScale(Math.min(1, available / config.width));
    },
    [config.width]
  );

  const layerOrigin = (target: Exclude<Selection, null>): LayerBox => {
    if (target.kind === "avatar") return { x: config.avatar.x, y: config.avatar.y };
    if (target.kind === "username") return { x: config.username.x, y: config.username.y };
    const layer = config.customTexts.find(entry => entry.id === target.id);
    return { x: layer?.x ?? 0, y: layer?.y ?? 0 };
  };

  const beginDrag = (event: React.PointerEvent, target: Exclude<Selection, null>, resizing: boolean) => {
    event.stopPropagation();
    onSelect(target);
    dragState.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: layerOrigin(target),
      target,
      resizing
    };
    // The capture goes to the canvas, not to the element: a handle that
    // captures the pointer would stop delivering the moves to the canvas, and
    // the drag would die the moment the pointer left the handle.
    canvasRef.current?.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const drag = dragState.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    // The pointer, in card pixels - the same units the config uses.
    const pointer = toCardSpace({ x: event.clientX, y: event.clientY }, { x: drag.startX, y: drag.startY }, scale);
    const dx = pointer.x - drag.origin.x;
    const dy = pointer.y - drag.origin.y;

    if (drag.target.kind === "avatar") {
      const size = drag.resizing
        ? sizeFromHandle(drag.origin, pointer, { min: AVATAR_MIN_SIZE, max: Math.min(AVATAR_MAX_SIZE, config.width, config.height) })
        : config.avatar.size;
      // The box's top-left corner is the anchor, and it never leaves the card.
      const box = clampBox({ x: drag.origin.x, y: drag.origin.y, width: size, height: size }, config);
      onConfigChange({
        ...config,
        avatar: { ...config.avatar, x: box.x, y: box.y, size: box.width }
      });
      return;
    }

    const isUsername = drag.target.kind === "username";
    const layer = isUsername
      ? config.username
      : config.customTexts.find(entry => entry.id === (drag.target as { kind: "custom"; id: string }).id);
    if (!layer) return;

    const fontSize = drag.resizing
      ? fontSizeFromHandle(drag.origin, pointer, { min: TEXT_MIN_FONT_SIZE, max: TEXT_MAX_FONT_SIZE })
      : layer.fontSize;
    // A text layer is anchored at its baseline origin, and the anchor stays
    // inside the card.
    const anchor = clampAnchor(drag.origin, config);
    const next = { ...layer, x: anchor.x, y: anchor.y, fontSize };
    onConfigChange(
      isUsername
        ? { ...config, username: next }
        : { ...config, customTexts: config.customTexts.map(entry => (entry.id === next.id ? next : entry)) }
    );
  };

  const endDrag = () => {
    dragState.current = null;
  };

  const isSelected = (target: Exclude<Selection, null>) =>
    target.kind === "avatar"
      ? selected?.kind === "avatar"
      : target.kind === "username"
        ? selected?.kind === "username"
        : selected?.kind === "custom" && selected.id === target.id;

  /** The SVG anchor of a text layer: the baseline, exactly where the renderer draws it. */
  const textAnchor = (layer: { x: number; y: number; align: "start" | "center" | "end" }) => ({
    x: layer.x * scale,
    y: layer.y * scale,
    textAnchor: layer.align === "center" ? "middle" : layer.align === "end" ? "end" : "start"
  });

  const handle = (visible: boolean) =>
    cn(
      "absolute -bottom-2 -end-2 size-4 cursor-nwse-resize rounded-full border-2 border-background bg-primary shadow",
      !visible && "hidden"
    );

  const backgroundStyle =
    config.background.type === "color"
      ? { background: config.background.color ?? "#0b1020" }
      : config.background.type === "image" && config.background.imageDataUrl
        ? { backgroundImage: `url(${config.background.imageDataUrl})`, backgroundSize: "cover", backgroundPosition: "center" }
        : {
            // The transparency checkerboard: what the PNG's alpha will keep.
            backgroundColor: "#1c1f26",
            backgroundImage:
              "linear-gradient(45deg, #262a33 25%, transparent 25%), linear-gradient(-45deg, #262a33 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #262a33 75%), linear-gradient(-45deg, transparent 75%, #262a33 75%)",
            backgroundSize: "16px 16px",
            backgroundPosition: "0 0, 0 8px, 8px -8px, -8px 0"
          };

  return (
    <div
      ref={node => {
        canvasRef.current = node;
        measure(node);
      }}
      className="relative mx-auto overflow-hidden rounded-lg border border-border shadow-inner select-none touch-none"
      style={{ width: config.width * scale, height: config.height * scale, ...backgroundStyle }}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onClick={() => onSelect(null)}
      role="application"
      aria-label="لوحة تصميم صورة الترحيب"
    >
      <span className="absolute top-2 start-2 z-10 rounded-md bg-background/80 px-2 py-0.5 text-[10px] text-muted-foreground backdrop-blur-sm">
        اسحب العناصر لتحريكها
      </span>

      {/* Avatar layer */}
      {config.avatar.enabled && (
        <div
          className={cn("absolute cursor-move", isSelected({ kind: "avatar" }) && "outline outline-2 outline-primary")}
          style={{ left: config.avatar.x * scale, top: config.avatar.y * scale, width: config.avatar.size * scale, height: config.avatar.size * scale }}
          onPointerDown={event => beginDrag(event, { kind: "avatar" }, false)}
          onClick={event => {
            event.stopPropagation();
            onSelect({ kind: "avatar" });
          }}
        >
          <span
            className="grid size-full place-items-center overflow-hidden bg-muted text-xs"
            style={{ borderRadius: config.avatar.circular ? "50%" : "0.5rem", border: config.avatar.strokeColor && config.avatar.strokeWidth > 0 ? `${Math.max(1, config.avatar.strokeWidth * scale)}px solid ${config.avatar.strokeColor}` : undefined }}
          >
            AI
          </span>
          <span className={handle(isSelected({ kind: "avatar" }))} onPointerDown={event => beginDrag(event, { kind: "avatar" }, true)} aria-hidden />
        </div>
      )}

      {/*
        The text layers, in an SVG over the canvas.

        `dominant-baseline="alphabetic"` and `text-anchor` are the two
        attributes that make this the *same* geometry the renderer uses, so the
        preview and the exported image land on the same pixels. The ascent
        offset is only used to place the hit area, never to place the text.
      */}
      <svg
        className="pointer-events-none absolute inset-0 size-full"
        viewBox={`0 0 ${config.width} ${config.height}`}
        preserveAspectRatio="none"
        aria-hidden
      >
        <text
          x={config.username.x}
          y={config.username.y}
          fontFamily={`"${config.username.fontFamily}", sans-serif`}
          fontSize={config.username.fontSize}
          fill={config.username.color}
          fontWeight={config.username.weight === "bold" ? 700 : 400}
          dominantBaseline="alphabetic"
          textAnchor={config.username.align === "center" ? "middle" : config.username.align === "end" ? "end" : "start"}
        >
          {renderWelcomeMessage(config.username.text, values)}
        </text>
        {config.customTexts.map(layer => (
          <text
            key={layer.id}
            x={layer.x}
            y={layer.y}
            fontFamily={`"${layer.fontFamily}", sans-serif`}
            fontSize={layer.fontSize}
            fill={layer.color}
            fontWeight={layer.weight === "bold" ? 700 : 400}
            dominantBaseline="alphabetic"
            textAnchor={layer.align === "center" ? "middle" : layer.align === "end" ? "end" : "start"}
          >
            {renderWelcomeMessage(layer.text, values)}
          </text>
        ))}
      </svg>

      {/* The interactive copies of the text layers: the same anchor, so the
          selection outline sits exactly on the drawn text. */}
      {[
        { kind: "username" as const, layer: config.username },
        ...config.customTexts.map(layer => ({ kind: "custom" as const, layer, id: layer.id }))
      ].map(entry => {
        const anchor = textAnchor(entry.layer);
        const width = Math.max(24, entry.layer.fontSize * 0.62 * entry.layer.text.length) * scale;
        const ascent = textAscentRatio(entry.layer.fontSize) * scale;
        return (
          <div
            key={entry.kind === "custom" ? entry.id : "username"}
            className={cn(
              "absolute cursor-move",
              isSelected(entry.kind === "custom" ? { kind: "custom", id: entry.id } : { kind: "username" }) &&
                "outline outline-2 outline-primary"
            )}
            style={{
              left: anchor.x,
              top: anchor.y - ascent,
              width,
              height: entry.layer.fontSize * scale,
              transform:
                entry.layer.align === "center" ? "translateX(-50%)" : entry.layer.align === "end" ? "translateX(-100%)" : undefined
            }}
            onPointerDown={event => beginDrag(event, entry.kind === "custom" ? { kind: "custom", id: entry.id } : { kind: "username" }, false)}
            onClick={event => {
              event.stopPropagation();
              onSelect(entry.kind === "custom" ? { kind: "custom", id: entry.id } : { kind: "username" });
            }}
          >
            <span className="invisible">{renderWelcomeMessage(entry.layer.text, values)}</span>
            <span
              className={handle(
                isSelected(entry.kind === "custom" ? { kind: "custom", id: entry.id } : { kind: "username" })
              )}
              onPointerDown={event =>
                beginDrag(event, entry.kind === "custom" ? { kind: "custom", id: entry.id } : { kind: "username" }, true)
              }
              aria-hidden
            />
          </div>
        );
      })}
    </div>
  );
}
