import { useCallback, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { renderWelcomeMessage, type WelcomeImageConfig, type WelcomeTemplateValues } from "@al-ai/core/browser";

/**
 * The Image Builder canvas: a scaled, live preview of the card the bot will
 * draw, with the layers as real, draggable elements.
 *
 * The canvas is the preview AND the editor: each layer is positioned with the
 * same coordinates the renderer reads, so what you drag is what the joiner
 * gets — no second geometry. Dragging uses pointer events (mouse and touch
 * both) and writes back through `onConfigChange`; a corner handle on the
 * selected layer resizes it.
 */

type Selection = { kind: "avatar" } | { kind: "username" } | { kind: "custom"; id: string } | null;

function dragDistance(event: React.PointerEvent) {
  return { x: event.clientX, y: event.clientY };
}

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
    originX: number;
    originY: number;
    target: Exclude<Selection, null>;
    resizing: boolean;
  } | null>(null);
  const [scale, setScale] = useState(1);

  // The preview fits the available width; the canvas itself keeps the real
  // dimensions, so a 1024-wide card reads exactly like the file the bot sends.
  const measure = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    const available = node.parentElement?.clientWidth ?? config.width;
    setScale(Math.min(1, available / config.width));
  }, [config.width]);

  const beginDrag = (event: React.PointerEvent, target: Exclude<Selection, null>, resizing: boolean) => {
    event.stopPropagation();
    onSelect(target);
    const origin =
      target.kind === "avatar"
        ? { x: config.avatar.x, y: config.avatar.y }
        : target.kind === "username"
          ? { x: config.username.x, y: config.username.y }
          : { x: config.customTexts.find(layer => layer.id === target.id)?.x ?? 0, y: config.customTexts.find(layer => layer.id === target.id)?.y ?? 0 };
    dragState.current = {
      pointerId: event.pointerId,
      startX: dragDistance(event).x,
      startY: dragDistance(event).y,
      originX: origin.x,
      originY: origin.y,
      target,
      resizing
    };
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const drag = dragState.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = Math.round((event.clientX - drag.startX) / scale);
    const dy = Math.round((event.clientY - drag.startY) / scale);
    if (drag.target.kind === "avatar") {
      const size = drag.resizing
        ? Math.max(16, Math.min(512, config.avatar.size + dx))
        : config.avatar.size;
      onConfigChange({
        ...config,
        avatar: {
          ...config.avatar,
          x: drag.resizing ? config.avatar.x : Math.max(0, Math.min(config.width - size, drag.originX + dx)),
          y: drag.resizing ? config.avatar.y : Math.max(0, Math.min(config.height - size, drag.originY + dy)),
          size
        }
      });
      return;
    }
    const isUsername = drag.target.kind === "username";
    const layer = isUsername
      ? config.username
      : config.customTexts.find(entry => entry.id === (drag.target as { kind: "custom"; id: string }).id);
    if (!layer) return;
    const fontSize = drag.resizing ? Math.max(8, Math.min(512, layer.fontSize + dy)) : layer.fontSize;
    const next = {
      ...layer,
      x: drag.resizing ? layer.x : Math.max(0, Math.min(config.width, drag.originX + dx)),
      y: drag.resizing ? layer.y : Math.max(0, Math.min(config.height, drag.originY + dy)),
      fontSize
    };
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

  const textLayerStyle = (layer: { x: number; y: number; fontFamily: string; fontSize: number; color: string; weight: "normal" | "bold"; align: "start" | "center" | "end"; text: string }) => ({
    position: "absolute" as const,
    left: layer.x * scale,
    top: layer.y * scale,
    transform: layer.align === "center" ? "translateX(-50%)" : layer.align === "end" ? "translateX(-100%)" : undefined,
    fontFamily: `"${layer.fontFamily}", sans-serif`,
    fontSize: layer.fontSize * scale,
    lineHeight: 1,
    color: layer.color,
    fontWeight: layer.weight === "bold" ? 700 : 400,
    whiteSpace: "nowrap" as const
  });

  const handle = (visible: boolean) =>
    cn(
      "absolute -bottom-1.5 -end-1.5 size-3 cursor-nwse-resize rounded-full border border-background bg-primary shadow",
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
      className="relative mx-auto overflow-hidden rounded-lg border border-border shadow-inner select-none"
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

      {/* Username layer */}
      <div
        className={cn("absolute cursor-move", isSelected({ kind: "username" }) && "outline outline-2 outline-primary")}
        style={textLayerStyle(config.username)}
        onPointerDown={event => beginDrag(event, { kind: "username" }, false)}
        onClick={event => {
          event.stopPropagation();
          onSelect({ kind: "username" });
        }}
      >
        {renderWelcomeMessage(config.username.text, values)}
        <span className={handle(isSelected({ kind: "username" }))} onPointerDown={event => beginDrag(event, { kind: "username" }, true)} aria-hidden />
      </div>

      {/* Custom text layers */}
      {config.customTexts.map(layer => (
        <div
          key={layer.id}
          className={cn("absolute cursor-move", isSelected({ kind: "custom", id: layer.id }) && "outline outline-2 outline-primary")}
          style={textLayerStyle(layer)}
          onPointerDown={event => beginDrag(event, { kind: "custom", id: layer.id }, false)}
          onClick={event => {
            event.stopPropagation();
            onSelect({ kind: "custom", id: layer.id });
          }}
        >
          {renderWelcomeMessage(layer.text, values)}
          <span
            className={handle(isSelected({ kind: "custom", id: layer.id }))}
            onPointerDown={event => beginDrag(event, { kind: "custom", id: layer.id }, true)}
            aria-hidden
          />
        </div>
      ))}
    </div>
  );
}
