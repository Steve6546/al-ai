import { useCallback, useEffect, useRef, useState } from "react";
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
 * pixel. The SVG is **left-to-right** on purpose: `text-anchor="start"` is
 * direction-relative, so in a right-to-left page it would anchor the text at
 * the *right* while the canvas anchors it at the left - the preview would have
 * been mirrored against the exported image.
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
  onConfigChange,
  avatarUrl
}: {
  config: WelcomeImageConfig;
  values: WelcomeTemplateValues;
  selected: Selection;
  onSelect: (selection: Selection) => void;
  onConfigChange: (next: WelcomeImageConfig) => void;
  /** The bot's own picture, drawn in the avatar layer as a stand-in. */
  avatarUrl?: string | null;
}) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const dragState = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    origin: LayerBox;
    target: Exclude<Selection, null>;
    resizing: boolean;
  } | null>(null);
  /** Set when a drag ends, so the click that follows it does not deselect. */
  const draggedRef = useRef(false);
  const [scale, setScale] = useState(1);

  // The preview fits the available width; the canvas itself keeps the real
  // dimensions, so a 1024-wide card reads exactly like the file the bot sends.
  // The measurement is repeated on every resize of the frame - not only on the
  // first render - so a window that changes size re-fits the card instead of
  // leaving a canvas that overflows its column.
  const measure = useCallback(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const available = frame.clientWidth;
    if (available <= 0) return;
    setScale(Math.min(1, available / config.width));
  }, [config.width]);

  useEffect(() => {
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => measure());
    if (frameRef.current) observer.observe(frameRef.current);
    return () => observer.disconnect();
  }, [measure]);

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
    draggedRef.current = false;
    // The capture goes to the canvas, not to the element: a handle that
    // captures the pointer would stop delivering the moves to the canvas, and
    // the drag would die the moment the pointer left the handle.
    canvasRef.current?.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const drag = dragState.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    draggedRef.current = true;

    // The pointer, in card pixels - the same units the config uses.
    const pointer = toCardSpace({ x: event.clientX, y: event.clientY }, { x: drag.startX, y: drag.startY }, scale);
    const dx = pointer.x - drag.origin.x;
    const dy = pointer.y - drag.origin.y;

    if (drag.target.kind === "avatar") {
      const size = drag.resizing
        ? sizeFromHandle(drag.origin, pointer, {
            min: AVATAR_MIN_SIZE,
            max: Math.min(AVATAR_MAX_SIZE, config.width, config.height)
          })
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

  const endDrag = (event: React.PointerEvent) => {
    if (!dragState.current) return;
    dragState.current = null;
    // The click that follows a drag belongs to the drag, not to the canvas: it
    // must not deselect the layer the operator was working on.
    draggedRef.current = true;
    if (event.pointerId !== undefined) {
      try {
        canvasRef.current?.releasePointerCapture(event.pointerId);
      } catch {
        /* the pointer was already released */
      }
    }
  };

  /** A click on the canvas clears the selection - unless it ended a drag. */
  const onCanvasClick = () => {
    if (draggedRef.current) {
      draggedRef.current = false;
      return;
    }
    onSelect(null);
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
      // The handle sits at the *physical* bottom-right of the box, in both
      // directions: a logical `end` would jump to the left in a right-to-left
      // page, away from the corner the operator is holding.
      "absolute -bottom-2 -right-2 size-4 cursor-nwse-resize rounded-full border-2 border-background bg-primary shadow",
      !visible && "hidden"
    );

  // The background is painted in its own layer, so the opacity the operator
  // sets in the editor is the opacity of the *background* - the card's
  // transparent checkerboard shows through, exactly as it would in the PNG.
  const backgroundOpacity = config.background.opacity ?? 1;
  const backgroundLayer =
    config.background.type === "color"
      ? { background: config.background.color ?? "#0b1020" }
      : config.background.type === "gradient"
        ? {
            background: `linear-gradient(135deg, ${config.background.gradientFrom ?? "#1d4ed8"} 0%, ${
              config.background.gradientTo ?? "#7c3aed"
            } 100%)`
          }
        : config.background.type === "image" && config.background.imageDataUrl
          ? { backgroundImage: `url(${config.background.imageDataUrl})`, backgroundSize: "cover", backgroundPosition: "center" }
          : null;

  return (
    <div ref={frameRef} className="w-full min-w-0">
      <div
        ref={node => {
          canvasRef.current = node;
        }}
        className="relative mx-auto overflow-hidden rounded-lg border border-border shadow-inner select-none touch-none"
        style={{
          width: config.width * scale,
          height: config.height * scale,
          // The transparency checkerboard: what the PNG's alpha will keep.
          backgroundColor: "#1c1f26",
          backgroundImage:
            "linear-gradient(45deg, #262a33 25%, transparent 25%), linear-gradient(-45deg, #262a33 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #262a33 75%), linear-gradient(-45deg, transparent 75%, #262a33 75%)",
          backgroundSize: "16px 16px",
          backgroundPosition: "0 0, 0 8px, 8px -8px, -8px 0"
        }}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onClick={onCanvasClick}
        role="application"
        aria-label="لوحة تصميم صورة الترحيب"
      >
        {backgroundLayer ? (
          <div className="absolute inset-0" style={{ ...backgroundLayer, opacity: backgroundOpacity }} aria-hidden />
        ) : null}
        <span className="absolute top-2 start-2 z-10 rounded-md bg-background/80 px-2 py-0.5 text-[10px] text-muted-foreground backdrop-blur-sm">
          اسحب العناصر لتحريكها
        </span>

        {/*
          The avatar layer is drawn *before* the text, exactly as the renderer
          draws it, so the preview's stacking is the exported card's stacking.
        */}
        {config.avatar.enabled ? (
          <div
            className={cn("absolute cursor-move", isSelected({ kind: "avatar" }) && "outline outline-2 outline-primary")}
            style={{
              left: config.avatar.x * scale,
              top: config.avatar.y * scale,
              width: config.avatar.size * scale,
              height: config.avatar.size * scale
            }}
            onPointerDown={event => beginDrag(event, { kind: "avatar" }, false)}
            onClick={event => {
              event.stopPropagation();
              onSelect({ kind: "avatar" });
            }}
          >
            <span
              className="grid size-full place-items-center overflow-hidden bg-muted text-xs"
              style={{
                borderRadius: config.avatar.circular ? "50%" : "0.5rem",
                border:
                  config.avatar.strokeColor && config.avatar.strokeWidth > 0
                    ? `${Math.max(1, config.avatar.strokeWidth * scale)}px solid ${config.avatar.strokeColor}`
                    : undefined,
                // The glow mirrors the renderer's shadow: a soft light around
                // the picture, in the same colour and radius.
                boxShadow:
                  config.avatar.glowColor && (config.avatar.glowSize ?? 0) > 0
                    ? `0 0 ${(config.avatar.glowSize ?? 0) * scale}px ${config.avatar.glowColor}`
                    : undefined
              }}
            >
              {avatarUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={avatarUrl} alt="" className="size-full object-cover" />
              ) : (
                "AI"
              )}
            </span>
            <span
              className={handle(isSelected({ kind: "avatar" }))}
              onPointerDown={event => beginDrag(event, { kind: "avatar" }, true)}
              aria-hidden
            />
          </div>
        ) : null}

        {/*
          The text layers, in an SVG over the canvas.

          `dominant-baseline="alphabetic"` and `text-anchor` are the two
          attributes that make this the *same* geometry the renderer uses. The
          SVG is left-to-right on purpose: `text-anchor="start"` is
          direction-relative, and in a right-to-left page it would anchor the
          text at the right while the canvas anchors it at the left.
        */}
        <svg
          className="pointer-events-none absolute inset-0 size-full"
          viewBox={`0 0 ${config.width} ${config.height}`}
          preserveAspectRatio="none"
          direction="ltr"
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
            stroke={config.username.strokeColor ?? undefined}
            strokeWidth={config.username.strokeWidth ?? 0}
            strokeLinejoin="round"
            // The stroke is painted *under* the fill, the same order the
            // renderer uses, so the glyphs stay readable.
            paintOrder="stroke"
            style={
              config.username.shadowColor && (config.username.shadowSize ?? 0) > 0
                ? { filter: `drop-shadow(0 0 ${config.username.shadowSize}px ${config.username.shadowColor})` }
                : undefined
            }
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
              stroke={layer.strokeColor ?? undefined}
              strokeWidth={layer.strokeWidth ?? 0}
              strokeLinejoin="round"
              paintOrder="stroke"
              style={
                layer.shadowColor && (layer.shadowSize ?? 0) > 0
                  ? { filter: `drop-shadow(0 0 ${layer.shadowSize}px ${layer.shadowColor})` }
                  : undefined
              }
            >
              {renderWelcomeMessage(layer.text, values)}
            </text>
          ))}
        </svg>

        {/*
          The interactive copies of the text layers: the same anchor, so the
          selection outline sits exactly on the drawn text. The box hugs the
          text (`w-max`) - an estimated width drew a box far wider than the
          text and put the handle in empty space.
        */}
        {[
          { kind: "username" as const, layer: config.username },
          ...config.customTexts.map(layer => ({ kind: "custom" as const, layer, id: layer.id }))
        ].map(entry => {
          const anchor = textAnchor(entry.layer);
          const ascent = textAscentRatio(entry.layer.fontSize) * scale;
          const target = entry.kind === "custom" ? { kind: "custom" as const, id: entry.id } : { kind: "username" as const };
          return (
            <div
              key={entry.kind === "custom" ? entry.id : "username"}
              className={cn("absolute w-max cursor-move", isSelected(target) && "outline outline-2 outline-primary")}
              style={{
                left: anchor.x,
                top: anchor.y - ascent,
                height: entry.layer.fontSize * scale,
                transform:
                  entry.layer.align === "center" ? "translateX(-50%)" : entry.layer.align === "end" ? "translateX(-100%)" : undefined
              }}
              onPointerDown={event => beginDrag(event, target, false)}
              onClick={event => {
                event.stopPropagation();
                onSelect(target);
              }}
            >
              <span className="invisible whitespace-nowrap">{renderWelcomeMessage(entry.layer.text, values)}</span>
              <span
                className={handle(isSelected(target))}
                onPointerDown={event => beginDrag(event, target, true)}
                aria-hidden
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
