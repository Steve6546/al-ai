/**
 * Fitting a picked picture inside the image budget, instead of refusing it.
 *
 * The screens used to compare the encoded string against a ceiling and reject
 * the file with «حجم الصورة يتجاوز الحد». That is a dead end for the operator:
 * a photo from a phone is 3–8 MB, and the only advice the message can give is
 * "shrink it yourself". A browser can shrink it perfectly well — decode, draw,
 * re-encode — so the ceiling becomes something the app *meets* rather than
 * something it *enforces*.
 *
 * Three rules keep this honest:
 *
 * - **An image that already fits is not touched.** Re-encoding a small file
 *   would change its bytes for nothing, and would flatten an animated GIF.
 * - **An animated GIF that does not fit is refused, not silently stilled.**
 *   There is no animated-GIF encoder in this app, so "shrinking" one would
 *   quietly replace the animation with its first frame. A sentence the operator
 *   can act on beats a picture that moves when they look and not when it sends.
 * - **WebP first, JPEG as the fallback.** WebP keeps transparency and compresses
 *   better; Discord accepts both. PNG is not used for output because a
 *   re-encoded PNG is often *larger* than the JPEG it came from.
 */

export type FittedImage = {
  /** What to store: the original bytes when they fit, otherwise a re-encode. */
  dataUrl: string;
  width: number;
  height: number;
  /** Bytes of the decoded image, not of the string. */
  bytes: number;
  /** True when the picture was re-encoded to get under the ceiling. */
  downscaled: boolean;
};

/** Decodes a picked file into something drawable, without a canvas yet. */
async function decode(file: File): Promise<{ source: CanvasImageSource; width: number; height: number; release: () => void }> {
  // `createImageBitmap` applies EXIF orientation and is far cheaper than an
  // <img> round trip; the object-URL path is the fallback for older engines.
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
  }
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error("undecodable"));
      element.src = url;
    });
    return {
      source: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      release: () => URL.revokeObjectURL(url)
    };
  } catch (cause) {
    URL.revokeObjectURL(url);
    throw cause;
  }
}

function encode(source: CanvasImageSource, width: number, height: number, type: string, quality: number): string | null {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return null;
  // WebP and JPEG have no alpha: without this, a transparent PNG's holes turn
  // black. White is what Discord's own uploader paints behind them.
  if (type !== "image/png") {
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
  }
  context.drawImage(source, 0, 0, width, height);
  const encoded = canvas.toDataURL(type, quality);
  // A browser that cannot encode the requested type answers with a PNG data URL;
  // treating that as success would hand back a *larger* file than the original.
  return encoded.startsWith(`data:${type}`) ? encoded : null;
}

/**
 * The same picture at or under `maxBytes`, re-encoded if it has to be.
 *
 * `maxBytes` is image bytes, the same unit as `MAX_IMAGE_UPLOAD_BYTES`; the
 * comparison is made on the encoded string, because that is what gets stored.
 */
export async function fitImageUnder(file: File, maxBytes: number): Promise<FittedImage> {
  const original = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("read-failed"));
    reader.readAsDataURL(file);
  });

  // The budget is stated in image bytes, so the comparison is made in image
  // bytes. Comparing the *encoded* length here is what re-encoded a 1.6 MB file
  // that already fitted: base64 is four characters per three bytes, so a picture
  // under the ceiling looked a third larger than it was.
  const decodedBytes = Math.floor((original.length - original.indexOf(",") - 1) * 0.75);
  if (decodedBytes <= maxBytes) {
    const { width, height, release } = await decode(file).catch(() => ({ width: 0, height: 0, release: () => undefined }));
    release();
    return { dataUrl: original, width, height, bytes: decodedBytes, downscaled: false };
  }

  // Refused on purpose: see the note at the top about animation.
  if (file.type === "image/gif") {
    throw new Error("animated-gif-too-large");
  }

  const { source, width, height, release } = await decode(file);
  try {
    // Step down by 15% a side until it fits. Two passes over quality first
    // (0.92, then 0.85) keep a picture that is only slightly over from losing
    // its dimensions, which is the change the eye notices.
    let scale = 1;
    for (let attempt = 0; attempt < 14; attempt += 1) {
      const targetWidth = Math.max(1, Math.round(width * scale));
      const targetHeight = Math.max(1, Math.round(height * scale));
      for (const quality of [0.92, 0.85]) {
        for (const type of ["image/webp", "image/jpeg"]) {
          const dataUrl = encode(source, targetWidth, targetHeight, type, quality);
          if (!dataUrl) continue;
          const bytes = Math.floor((dataUrl.length - dataUrl.indexOf(",") - 1) * 0.75);
          if (bytes <= maxBytes) {
            return { dataUrl, width: targetWidth, height: targetHeight, bytes, downscaled: true };
          }
        }
      }
      if (targetWidth <= 256) break;
      scale *= 0.85;
    }
    throw new Error("cannot-fit");
  } finally {
    release();
  }
}
