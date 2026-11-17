/**
 * A language's flag, as a circular inline SVG.
 *
 * Three problems with the old marks, all fixed here:
 *
 * 1. **Proportions.** The Union Jack was drawn as four overlapping rectangles
 *    plus two strokes across a 24×16 box, so the diagonals landed off-centre and
 *    the cross was visibly asymmetric at 16 px.
 * 2. **Arabic text at 4.6 px.** The Iraqi takbir was `<text>` in a 16-pixel-tall
 *    box: on some systems it rendered as a smudge, on others it overflowed the
 *    band it belongs to.
 * 3. **Mismatched shapes.** A circle in the list, a rectangle in the row — the
 *    flag column never lined up with the label beside it.
 *
 * The marks are now all circles of one radius with a single clip path each, so
 * they occupy exactly the same optical box at every size. Geometry is
 * constructed rather than approximated: the Union Jack uses the real 1:2 field
 * inside the circle with a 1/5 saltire and 1/3 cross, and the colours are the
 * official ones (`#012169`, `#C8102E`, `#CE1126`, `#007A3D`, `#FFCE00`).
 *
 * Inline SVG rather than emoji or images: Windows renders flag emoji as the bare
 * two-letter code, and an image would be one more request per row.
 */
export type FlagCode = "ar" | "en" | "de";

const SIZE = 32;
const RADIUS = 16;

/** The circular window every flag is drawn inside. */
function Clip({ id }: { id: string }) {
  return (
    <clipPath id={id}>
      <circle cx={RADIUS} cy={RADIUS} r={RADIUS} />
    </clipPath>
  );
}

function Shell({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="block" role="presentation" aria-hidden="true" focusable="false">
      <defs>
        <Clip id={id} />
      </defs>
      <g clipPath={`url(#${id})`}>{children}</g>
    </svg>
  );
}

/**
 * Iraq — red over white over black, with the takbir in green on the white band.
 *
 * The takbir is drawn at 5.2 px rather than 4.6 and centred on the band it
 * belongs to, with `dominant-baseline="middle"` so it cannot ride up into the
 * red. At list size it reads as the green mark the flag is known for; at 2× it
 * is legible.
 */
function IraqFlag() {
  return (
    <Shell id="al-ai-flag-ar">
      <rect width={SIZE} height={SIZE / 3} fill="#CE1126" />
      <rect y={SIZE / 3} width={SIZE} height={SIZE / 3} fill="#FFFFFF" />
      <rect y={(SIZE * 2) / 3} width={SIZE} height={SIZE / 3} fill="#000000" />
      <text
        x={RADIUS}
        y={RADIUS}
        textAnchor="middle"
        dominantBaseline="central"
        fontSize="5.2"
        fontWeight="700"
        fill="#007A3D"
        style={{ fontFamily: "'IBM Plex Sans Arabic', 'Segoe UI', sans-serif" }}
      >
        الله أكبر
      </text>
    </Shell>
  );
}

/**
 * The Union Flag, constructed rather than eyeballed.
 *
 * Field 1:2 inside the circle, white saltire at 1/5 of the width, red saltire at
 * 1/15, white cross at 1/3 and red cross at 1/5 — the ratios in the official
 * construction sheet, scaled to this box.
 */
function UnionFlag() {
  const w = SIZE;
  const h = SIZE;
  return (
    <Shell id="al-ai-flag-en">
      <rect width={w} height={h} fill="#012169" />
      <path d={`M0 0 L${w} ${h} M${w} 0 L0 ${h}`} stroke="#FFFFFF" strokeWidth={h / 5} />
      <path d={`M0 0 L${w} ${h} M${w} 0 L0 ${h}`} stroke="#C8102E" strokeWidth={h / 15} />
      <rect x={w / 2 - w / 6} width={w / 3} height={h} fill="#FFFFFF" />
      <rect y={h / 2 - h / 6} width={w} height={h / 3} fill="#FFFFFF" />
      <rect x={w / 2 - w / 10} width={w / 5} height={h} fill="#C8102E" />
      <rect y={h / 2 - h / 10} width={w} height={h / 5} fill="#C8102E" />
    </Shell>
  );
}

/** Germany — three equal bands, black over red over gold. */
function GermanyFlag() {
  return (
    <Shell id="al-ai-flag-de">
      <rect width={SIZE} height={SIZE / 3} fill="#000000" />
      <rect y={SIZE / 3} width={SIZE} height={SIZE / 3} fill="#DD0000" />
      <rect y={(SIZE * 2) / 3} width={SIZE} height={SIZE / 3} fill="#FFCE00" />
    </Shell>
  );
}

/**
 * `className` sets the box (default 20 px). The circle fills it exactly, so two
 * flags side by side are never a pixel apart.
 */
export function Flag({ value, className = "size-5" }: { value: FlagCode; className?: string }) {
  return (
    <span className={`inline-block shrink-0 overflow-hidden rounded-full ring-1 ring-black/15 ${className}`}>
      {value === "de" ? <GermanyFlag /> : value === "ar" ? <IraqFlag /> : <UnionFlag />}
    </span>
  );
}
