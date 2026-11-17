/**
 * Turning stored timestamps into a chart, and comparing two windows.
 *
 * The overview screen draws sparklines over the last 24 hours, and every point
 * on them is a row the database actually holds. Two rules follow from that and
 * are enforced here rather than in the component:
 *
 * 1. **An empty hour is zero, not missing.** `date_trunc … GROUP BY` returns
 *    only the hours that have rows. Plotting those in sequence would compress
 *    a quiet night into a spike, so the buckets are filled against a fixed grid
 *    that ends at the current hour.
 *
 * 2. **A change from nothing is not a percentage.** The reference design this
 *    screen was modelled on printed `Infinity%` and `-100%` in green and red,
 *    because it divided by a previous window of zero. Zero is a real value, so
 *    the caller gets a named case instead of a number it has to sanity-check:
 *    `new` when the previous window was empty and this one is not.
 */

/** One hour of the audit trail, as the database returns it. */
export type HourlyAuditPoint = {
  /** ISO timestamp already truncated to the hour by PostgreSQL. */
  hour: string;
  events: number;
  penalties: number;
};

/** A filled grid, oldest hour first, always exactly `hours` long. */
export type HourlySeries = { events: number[]; penalties: number[] };

const HOUR_MS = 60 * 60 * 1000;

/**
 * Place stored hours onto a fixed grid ending at `now`'s hour.
 *
 * Rows outside the grid are dropped rather than clamped into the first or last
 * bucket: a 30-hour-old row placed on the 24-hour grid would invent activity in
 * the oldest hour. Negative or non-finite counts are treated as zero for the
 * same reason — the chart's job is to show what was recorded, not to repair it.
 */
export function fillHourlySeries(
  rows: readonly HourlyAuditPoint[],
  { hours = 24, now = Date.now() }: { hours?: number; now?: number } = {}
): HourlySeries {
  const size = Math.max(1, Math.trunc(hours));
  const events = new Array<number>(size).fill(0);
  const penalties = new Array<number>(size).fill(0);
  const endHour = Math.floor(now / HOUR_MS);
  const startHour = endHour - (size - 1);

  for (const row of rows) {
    const at = Date.parse(row.hour);
    if (!Number.isFinite(at)) continue;
    const index = Math.floor(at / HOUR_MS) - startHour;
    if (index < 0 || index >= size) continue;
    events[index] += countOf(row.events);
    penalties[index] += countOf(row.penalties);
  }

  return { events, penalties };
}

function countOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * How this window compares with the one before it.
 *
 * `unknown` is the honest answer when the previous window is empty: the screen
 * says «لا بيانات سابقة» rather than inventing a baseline. `new` is the other
 * empty-baseline case, where something *did* happen this time.
 */
export type WindowChange = {
  kind: "unknown" | "new" | "flat" | "up" | "down";
  /** Signed percentage, or null when a percentage does not exist. */
  percent: number | null;
  /** Signed absolute difference, always a real number. */
  delta: number;
};

export function changeSince(current: number, previous: number): WindowChange {
  const now = countOf(current);
  const then = countOf(previous);
  const delta = now - then;

  if (then === 0) {
    return now === 0 ? { kind: "flat", percent: 0, delta: 0 } : { kind: "new", percent: null, delta };
  }
  if (delta === 0) return { kind: "flat", percent: 0, delta: 0 };

  // Clamped so a one-event baseline cannot print «+4000%». The sign is carried
  // by `kind`, so the cap never changes the direction the screen reports.
  const percent = Math.max(-999, Math.min(999, Math.round((delta / then) * 100)));
  return { kind: delta > 0 ? "up" : "down", percent, delta };
}

/**
 * An SVG path for a sparkline inside a `width × height` box.
 *
 * Flat series draw a line along the baseline instead of a division-by-zero
 * `NaN` path, which is what a naive `value / max` does on a quiet server. A
 * single point sits in the middle. Values are never normalised against a
 * hard-coded maximum: the tallest hour fills the box, so a busy day reads as
 * busy rather than as a flat line under a ceiling nobody reached.
 */
export function sparklinePath(
  values: readonly number[],
  { width = 100, height = 32, inset = 2 }: { width?: number; height?: number; inset?: number } = {}
): string {
  const points = values.map(countOf);
  if (points.length === 0) return "";

  const left = inset;
  const right = width - inset;
  const top = inset;
  const bottom = height - inset;
  const span = right - left;
  const heightSpan = bottom - top;
  const highest = Math.max(1, ...points);

  const at = (value: number, index: number) => {
    const x = points.length === 1 ? left + span / 2 : left + (span * index) / (points.length - 1);
    const y = bottom - (heightSpan * value) / highest;
    return `${round(x)},${round(y)}`;
  };

  return points.map((value, index) => `${index === 0 ? "M" : "L"}${at(value, index)}`).join(" ");
}

/** The same line closed to the baseline, for the soft fill under it. */
export function sparklineArea(
  values: readonly number[],
  options: { width?: number; height?: number; inset?: number } = {}
): string {
  const line = sparklinePath(values, options);
  if (!line) return "";
  const { width = 100, height = 32, inset = 2 } = options;
  const bottom = height - inset;
  const first = line.slice(1).split(" ")[0].split(",")[0];
  const last = line.split(" ").at(-1)!.slice(1).split(",")[0];
  return `${line} L${last},${round(bottom)} L${first},${round(bottom)} Z`;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
