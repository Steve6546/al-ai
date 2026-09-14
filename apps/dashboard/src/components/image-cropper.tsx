import { useCallback, useEffect, useRef, useState } from "react";
import { Image as ImageIcon, Loader2, Upload, ZoomIn } from "lucide-react";
import { IMAGE_TARGET_SIZES } from "@al-ai/core/browser";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * A dependency-free image cropper.
 *
 * The avatar, banner and role icon each have a different aspect ratio and a
 * different target size, and Discord rejects an image that is the wrong shape.
 * Rather than ask the operator to pre-crop in another program, the file is drawn
 * onto a `<canvas>` here at the exact size the API wants, so what they see in
 * the preview is literally the bytes that get sent.
 *
 * No cropping library: the whole interaction is an offset plus a zoom, clamped
 * so the image always covers the frame. That is why `coverScale` exists — at any
 * zoom, the minimum scale is the one that fills the box, so there is never a
 * transparent margin to explain.
 */

export const ACCEPTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

/** 8 MB. Generous for a 256px avatar, small enough to keep the request sane. */
export const MAX_SOURCE_FILE_BYTES = 8 * 1024 * 1024;

export type CropTarget = "avatar" | "banner" | "roleIcon";

/**
 * The exact pixel size Discord wants for each field.
 *
 * The sizes are read from `@al-ai/core` rather than restated here: Discord
 * rejects an image of the wrong shape, so a second copy of these numbers would be
 * a second chance to crop to the wrong one — and the copy that actually sends the
 * bytes is the one that would win. Only the Arabic label is local, because it is
 * a display concern the shared contract has no business knowing.
 */
export const CROP_TARGETS: Record<CropTarget, { width: number; height: number; label: string }> = {
  avatar: { ...IMAGE_TARGET_SIZES.avatar, label: "الأفاتار" },
  banner: { ...IMAGE_TARGET_SIZES.banner, label: "البانر" },
  roleIcon: { ...IMAGE_TARGET_SIZES.roleIcon, label: "أيقونة الرتبة" }
};

export type LoadedImage = { element: HTMLImageElement; objectUrl: string };

/**
 * Reads a file into an `<img>`, and rejects anything the browser cannot decode
 * or that exceeds the size cap.
 *
 * The object URL is returned so the caller can revoke it; leaking one keeps the
 * whole file in memory for the life of the tab.
 */
export async function readImageFile(file: File): Promise<LoadedImage> {
  if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) {
    throw new Error("صيغة الصورة غير مدعومة. استخدم PNG أو JPEG أو WebP أو GIF.");
  }
  if (file.size > MAX_SOURCE_FILE_BYTES) {
    throw new Error(`حجم الصورة أكبر من ${Math.round(MAX_SOURCE_FILE_BYTES / 1024 / 1024)} ميغابايت.`);
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const element = await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("تعذّر قراءة الصورة. جرّب ملفاً آخر."));
      image.src = objectUrl;
    });
    return { element, objectUrl };
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
}

/** The smallest scale at which the image still covers the frame. */
function coverScale(image: HTMLImageElement, frame: { width: number; height: number }): number {
  return Math.max(frame.width / image.naturalWidth, frame.height / image.naturalHeight);
}

type Props = {
  target: CropTarget;
  image: LoadedImage;
  onApply: (dataUrl: string) => void;
  onCancel: () => void;
};

export function ImageCropper({ target, image, onApply, onCancel }: Props) {
  const spec = CROP_TARGETS[target];
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState<{ x: number; y: number } | null>(null);

  /** The frame as drawn on screen — the canvas is CSS-scaled, so this is not `spec`. */
  const frame = { width: 320, height: Math.round((320 * spec.height) / spec.width) };
  const base = coverScale(image.element, frame);

  /**
   * Keep the image covering the frame.
   *
   * Clamped rather than free-dragged: allowing the image to move past the edge
   * would leave a transparent band, which Discord renders as a black stripe.
   */
  const clamp = useCallback(
    (next: { x: number; y: number }, scale: number) => {
      const drawnWidth = image.element.naturalWidth * scale;
      const drawnHeight = image.element.naturalHeight * scale;
      const maxX = Math.max(0, (drawnWidth - frame.width) / 2);
      const maxY = Math.max(0, (drawnHeight - frame.height) / 2);
      return {
        x: Math.min(maxX, Math.max(-maxX, next.x)),
        y: Math.min(maxY, Math.max(-maxY, next.y))
      };
    },
    [frame.height, frame.width, image.element]
  );

  // Redraw whenever the view changes. Doing it in an effect rather than on each
  // pointer event means the canvas and the state cannot drift apart.
  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;

    const scale = base * zoom;
    const drawnWidth = image.element.naturalWidth * scale;
    const drawnHeight = image.element.naturalHeight * scale;

    // Canvas defaults to `imageSmoothingQuality: "low"`, which resamples with a
    // cheap filter and is exactly what makes an upscaled banner look washed out
    // on screen. This context only draws the preview, but the operator judges
    // the crop by it, so it has to be as smooth as the export.
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(
      image.element,
      (canvas.width - drawnWidth) / 2 + offset.x,
      (canvas.height - drawnHeight) / 2 + offset.y,
      drawnWidth,
      drawnHeight
    );
  }, [base, image.element, offset.x, offset.y, zoom]);

  // Release the object URL when the cropper goes away, or the file stays in
  // memory for the life of the tab.
  useEffect(() => () => URL.revokeObjectURL(image.objectUrl), [image.objectUrl]);

  /** Export at the *real* target size, not the on-screen size. */
  const apply = () => {
    const output = document.createElement("canvas");
    output.width = spec.width;
    output.height = spec.height;
    const context = output.getContext("2d");
    if (!context) {
      onCancel();
      return;
    }

    // The on-screen frame is a preview of the same crop, so the visible geometry
    // is scaled up to the target — one transform, no second guess at the maths.
    const factor = spec.width / frame.width;
    const scale = base * zoom;
    // Smoothing matters most here: the crop is drawn at the target resolution
    // (600×240 for a banner) while the preview drew it smaller, so the default
    // low-quality filter would soften every edge in the exported image.
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(
      image.element,
      ((frame.width - image.element.naturalWidth * scale) / 2 + offset.x) * factor,
      ((frame.height - image.element.naturalHeight * scale) / 2 + offset.y) * factor,
      image.element.naturalWidth * scale * factor,
      image.element.naturalHeight * scale * factor
    );
    onApply(output.toDataURL("image/png"));
  };

  return (
    <div className="space-y-3 rounded-lg border border-border bg-card p-3">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <ImageIcon className="size-4" />
        <span>
          {spec.label} — {spec.width}×{spec.height}
        </span>
      </div>

      <div
        className={cn(
          "relative mx-auto overflow-hidden rounded-md border border-border bg-[repeating-conic-gradient(#80808033_0%_25%,transparent_0%_50%)] bg-[length:16px_16px]",
          dragging ? "cursor-grabbing" : "cursor-grab"
        )}
        style={{ width: frame.width, height: frame.height, touchAction: "none" }}
        onPointerDown={event => {
          event.currentTarget.setPointerCapture(event.pointerId);
          setDragging({ x: event.clientX - offset.x, y: event.clientY - offset.y });
        }}
        onPointerMove={event => {
          if (!dragging) return;
          setOffset(clamp({ x: event.clientX - dragging.x, y: event.clientY - dragging.y }, base * zoom));
        }}
        onPointerUp={() => setDragging(null)}
      >
        <canvas
          ref={canvasRef}
          width={frame.width}
          height={frame.height}
          className="size-full"
        />
      </div>

      <label className="flex items-center gap-2 text-sm">
        <ZoomIn className="size-4 shrink-0 text-muted-foreground" />
        <input
          type="range"
          min={1}
          max={3}
          step={0.05}
          value={zoom}
          aria-label="تكبير الصورة"
          onChange={event => {
            const next = Number(event.target.value);
            setZoom(next);
            setOffset(current => clamp(current, base * next));
          }}
          className="w-full accent-primary"
        />
      </label>

      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" type="button" onClick={onCancel}>
          إلغاء
        </Button>
        <Button size="sm" type="button" onClick={apply}>
          <Upload />
          استخدم هذه الصورة
        </Button>
      </div>
    </div>
  );
}

/** A compact placeholder used while no image is chosen. */
export function ImagePickerButton({
  label,
  busy,
  onPick
}: {
  label: string;
  busy?: boolean;
  onPick: () => void;
}) {
  return (
    <Button type="button" variant="outline" size="sm" onClick={onPick} disabled={busy}>
      {busy ? <Loader2 className="animate-spin" /> : <Upload />}
      {label}
    </Button>
  );
}
