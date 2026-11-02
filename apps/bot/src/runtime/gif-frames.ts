/**
 * A dependency-free GIF89a frame decoder.
 *
 * Why this file exists: `@napi-rs/canvas` decodes a GIF to **one** image — the
 * first frame — and exposes no frame API (`pages`, `frames`, `numFrames` are all
 * `undefined`; `welcome-card-animation.test.ts` pins that). The engine can
 * *encode* GIFs but not step through one, so an animated avatar could never be
 * animated on the welcome card while the card is composited from that avatar.
 *
 * The alternative was a dependency. A GIF is a small, frozen format — the
 * 1990s spec has never changed — and the decoder below is the whole of it for
 * the features real avatars use: global and local colour tables, transparency,
 * the four disposal methods, per-frame delays, and LZW as GIF packs it.
 *
 * Two things are deliberately **not** supported, and both make the caller fall
 * back to a still image rather than guess: interlaced frames (rare, and a wrong
 * row order is invisible until somebody notices a scrambled avatar), and frames
 * past `maxFrames` (a card is composited per frame, so the frame count is the
 * memory bill).
 */

export type GifFrame = {
  /** RGBA, `width * height * 4`, already flattened by the disposal method. */
  rgba: Uint8Array;
  /** Delay in hundredths of a second, as the file says. */
  delayCs: number;
};

export type DecodedGif = {
  width: number;
  height: number;
  frames: GifFrame[];
};

const BLOCK_EXTENSION = 0x21;
const BLOCK_IMAGE = 0x2c;
const BLOCK_TRAILER = 0x3b;
const LABEL_GRAPHIC_CONTROL = 0xf9;

/** Reads the little-endian unsigned integer GIF uses everywhere. */
function u16(bytes: Uint8Array, at: number): number {
  return bytes[at]! + (bytes[at + 1]! << 8);
}

/**
 * LZW, as GIF packs it: codes pushed LSB-first into a byte stream, the table
 * starting at `minCodeSize` bits, growing to 12, reset by the clear code.
 *
 * Returns the decoded indices for one image block. `expected` is the number of
 * pixels the block covers — a decoder that trusts the stream's own length can
 * overrun the frame, so the loop stops there as well as at the end code.
 */
function lzwDecode(stream: Uint8Array, minCodeSize: number, expected: number): Int32Array | null {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  let codeSize = minCodeSize + 1;

  // index -> the sequence it stands for. The first entries are single pixels;
  // the codes above `endCode` are built as [prefix, lastByte] pairs so the whole
  // run can be walked without copying strings.
  let table: Int32Array[] = [];
  const resetTable = () => {
    table = [];
    for (let i = 0; i < clearCode; i += 1) table[i] = Int32Array.of(i);
    table[clearCode] = new Int32Array(0);
    table[endCode] = new Int32Array(0);
    codeSize = minCodeSize + 1;
  };
  resetTable();

  const out = new Int32Array(expected);
  let written = 0;
  let bitBuffer = 0;
  let bitsInBuffer = 0;
  let previous: Int32Array | null = null;
  let at = 0;

  while (at < stream.length) {
    while (bitsInBuffer < codeSize && at < stream.length) {
      bitBuffer |= stream[at]! << bitsInBuffer;
      bitsInBuffer += 8;
      at += 1;
    }
    if (bitsInBuffer < codeSize) break;

    const code = bitBuffer & ((1 << codeSize) - 1);
    bitBuffer >>= codeSize;
    bitsInBuffer -= codeSize;

    if (code === clearCode) {
      resetTable();
      previous = null;
      continue;
    }
    if (code === endCode) break;

    let entry = table[code];
    if (!entry) {
      // The KwKwK case: the code was just created and is the previous sequence
      // with its own first byte repeated.
      if (!previous) return null;
      entry = new Int32Array(previous.length + 1);
      entry.set(previous);
      entry[previous.length] = previous[0]!;
    }
    if (written + entry.length > expected) return null;
    out.set(entry, written);
    written += entry.length;

    if (previous) {
      // The new code is the previous sequence plus this entry's first byte.
      // Typed arrays are fixed length, so the pair is copied into a longer one
      // rather than indexed past the end — writing past it is silently dropped,
      // and every frame after the first would decode as the first.
      const next = new Int32Array(previous.length + 1);
      next.set(previous);
      next[previous.length] = entry[0]!;
      table.push(next);
      // The bit width grows the moment the next index would not fit in it.
      if (table.length >= (1 << codeSize) && codeSize < 12) codeSize += 1;
    }
    previous = entry;
  }

  return written === expected ? out : null;
}

/**
 * One image block's indices, laid into the accumulator at its offset.
 *
 * The transparency index from the graphic control extension is honoured here,
 * because that is where the file says which palette entry means "show what was
 * underneath".
 */
function paint(
  accumulator: Uint8Array,
  width: number,
  height: number,
  indices: Int32Array,
  palette: Uint8Array,
  x: number,
  y: number,
  w: number,
  h: number,
  transparent: number | null
): void {
  for (let row = 0; row < h; row += 1) {
    const targetY = y + row;
    if (targetY < 0 || targetY >= height) continue;
    for (let column = 0; column < w; column += 1) {
      const targetX = x + column;
      if (targetX < 0 || targetX >= width) continue;
      const index = indices[row * w + column]!;
      const at = (targetY * width + targetX) * 4;
      if (transparent !== null && index === transparent) continue;
      // Four bytes per entry: `paletteOf` expanded the file's RGB triples into
      // RGBA, and reading them with a stride of three shifts every channel one
      // entry back — a red frame comes out yellow, a green one magenta. The
      // first fixture hid it, because its palette happened to start with red.
      accumulator[at] = palette[index * 4]!;
      accumulator[at + 1] = palette[index * 4 + 1]!;
      accumulator[at + 2] = palette[index * 4 + 2]!;
      accumulator[at + 3] = 255;
    }
  }
}

/** RGB triples in, RGBA out — alpha is added once here, not in the hot loop. */
function paletteOf(table: Uint8Array): Uint8Array {
  const size = Math.floor(table.length / 3);
  const rgba = new Uint8Array(size * 4);
  for (let i = 0; i < size; i += 1) {
    rgba[i * 4] = table[i * 3]!;
    rgba[i * 4 + 1] = table[i * 3 + 1]!;
    rgba[i * 4 + 2] = table[i * 3 + 2]!;
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

/**
 * Decodes every frame of a GIF, flattened to full-size RGBA.
 *
 * Returns null for anything that is not a plain, non-interlaced GIF89a, or when
 * the stream does not add up — the caller then draws the still frame it already
 * knows how to draw.
 */
export function decodeGifFrames(bytes: Uint8Array, maxFrames = 12): DecodedGif | null {
  if (bytes.length < 13) return null;
  const signature = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!, bytes[4]!, bytes[5]!);
  if (signature !== "GIF89a" && signature !== "GIF87a") return null;

  const width = u16(bytes, 6);
  const height = u16(bytes, 8);
  if (width <= 0 || height <= 0 || width > 2048 || height > 2048) return null;

  const packed = bytes[10]!;
  let at = 13;
  let globalTable: Uint8Array | null = null;
  if (packed & 0x80) {
    const size = 2 << (packed & 0x07);
    globalTable = bytes.slice(at, at + size * 3);
    at += size * 3;
  }

  const accumulator = new Uint8Array(width * height * 4);
  const frames: GifFrame[] = [];
  let delayCs = 0;
  let transparent: number | null = null;
  let disposal = 0;

  while (at < bytes.length) {
    const marker = bytes[at]!;
    at += 1;

    if (marker === BLOCK_TRAILER) break;

    if (marker === BLOCK_EXTENSION) {
      const label = bytes[at]!;
      at += 1;
      if (label === LABEL_GRAPHIC_CONTROL) {
        const blockLength = bytes[at]!;
        at += 1;
        if (blockLength >= 4) {
          const flags = bytes[at]!;
          delayCs = u16(bytes, at + 1);
          const transparencyFlag = flags & 0x01;
          const index = bytes[at + 3]!;
          transparent = transparencyFlag ? index : null;
          disposal = (flags >> 2) & 0x07;
        }
        at += blockLength;
      }
      // Skip the sub-block chain of any extension.
      while (at < bytes.length && bytes[at] !== 0) {
        at += 1 + bytes[at]!;
      }
      at += 1;
      continue;
    }

    if (marker === BLOCK_IMAGE) {
      const x = u16(bytes, at);
      const y = u16(bytes, at + 2);
      const w = u16(bytes, at + 4);
      const h = u16(bytes, at + 6);
      const imagePacked = bytes[at + 8]!;
      at += 9;
      if (imagePacked & 0x40) return null; // interlaced — not attempted

      let localTable: Uint8Array | null = null;
      if (imagePacked & 0x80) {
        const size = 2 << (imagePacked & 0x07);
        localTable = bytes.slice(at, at + size * 3);
        at += size * 3;
      }
      const colourTable = localTable ?? globalTable ?? new Uint8Array(0);
      const palette = paletteOf(colourTable);
      if (palette.length < 4) return null;

      const minCodeSize = bytes[at]!;
      at += 1;
      if (minCodeSize < 2 || minCodeSize > 8) return null;

      const chunks: Uint8Array[] = [];
      let total = 0;
      while (at < bytes.length && bytes[at] !== 0) {
        const length = bytes[at]!;
        at += 1;
        chunks.push(bytes.slice(at, at + length));
        at += length;
        total += length;
      }
      at += 1;
      const stream = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        stream.set(chunk, offset);
        offset += chunk.length;
      }

      const indices = lzwDecode(stream, minCodeSize, w * h);
      if (!indices) return null;

      // Disposal 3 needs what was underneath, so the accumulator is copied
      // before this frame is painted and restored after it is emitted.
      const before = disposal === 3 ? accumulator.slice() : null;
      paint(accumulator, width, height, indices, palette, x, y, w, h, transparent);
      frames.push({ rgba: accumulator.slice(), delayCs });

      if (disposal === 2) {
        // Restore to background: the painted rectangle becomes transparent for
        // the next frame.
        for (let row = 0; row < h; row += 1) {
          for (let column = 0; column < w; column += 1) {
            const at2 = ((y + row) * width + (x + column)) * 4;
            if (at2 + 3 < accumulator.length) accumulator[at2 + 3] = 0;
          }
        }
      } else if (before) {
        accumulator.set(before);
      }

      if (frames.length >= maxFrames) break;
      continue;
    }

    return null; // an unknown block means the file is not what we think it is
  }

  return frames.length >= 1 ? { width, height, frames } : null;
}

/**
 * Does this byte stream hold more than one frame?
 *
 * Counting image descriptors is approximate on purpose — a full parse to answer
 * a yes/no question costs the same as decoding, so the caller decodes once and
 * checks `frames.length` instead. This helper exists for the cheap pre-check
 * that keeps a static avatar off the animated path entirely.
 */
export function looksLikeAnimatedGif(bytes: Uint8Array): boolean {
  if (bytes.length < 10) return false;
  if (String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!, bytes[4]!, bytes[5]!) !== "GIF89a") return false;
  let images = 0;
  for (let i = 0; i < bytes.length - 1; i += 1) {
    if (bytes[i] === BLOCK_IMAGE) images += 1;
    if (images > 1) return true;
  }
  return false;
}
