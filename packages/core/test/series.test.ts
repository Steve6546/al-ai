import test from "node:test";
import assert from "node:assert/strict";
import { changeSince, fillHourlySeries, sparklineArea, sparklinePath } from "../src/series.js";

/**
 * The overview chart, pinned.
 *
 * The reference design this screen was rebuilt from printed `Infinity%` next to
 * a card showing zero, so the empty-baseline cases are the point of these
 * tests, not an edge case bolted on afterwards.
 */

const HOUR = 60 * 60 * 1000;
// A fixed clock, so the grid does not move under the assertions.
const NOW = Date.parse("2026-11-17T12:00:00.000Z");
const hourAt = (offset: number) => new Date(NOW + offset * HOUR).toISOString();

// The grid ends on the hour in progress, which is why a row one hour old lands
// on the second-to-last bucket: the last one is the hour `now` is inside.
test("an empty hour is zero on the grid, not a missing point", () => {
  const series = fillHourlySeries(
    [
      { hour: hourAt(-24 + 1), events: 3, penalties: 1 },
      // Hours 2..22 are absent: a quiet run of the day.
      { hour: hourAt(0), events: 2, penalties: 0 }
    ],
    { hours: 24, now: NOW }
  );

  assert.equal(series.events.length, 24);
  assert.equal(series.penalties.length, 24);
  assert.equal(series.events[0], 3, "the oldest hour lands on the first bucket");
  assert.equal(series.events[23], 2, "the current hour lands on the last bucket");
  assert.deepEqual(
    series.events.slice(1, 23),
    new Array(22).fill(0),
    "the quiet hours are real zeros"
  );
});

test("rows outside the window are dropped, not clamped into the edge buckets", () => {
  const series = fillHourlySeries(
    [
      { hour: hourAt(-40), events: 99, penalties: 99 },
      { hour: hourAt(+2), events: 98, penalties: 98 },
      { hour: hourAt(-2), events: 1, penalties: 0 }
    ],
    { hours: 24, now: NOW }
  );

  assert.equal(series.events[0], 0, "a 40-hour-old row does not invent activity at the start");
  assert.equal(series.events[23], 0, "a future row does not invent activity at the end");
  assert.equal(series.events[21], 1, "two hours ago is third from the end");
  assert.equal(series.events.reduce((sum, value) => sum + value, 0), 1);
});

test("several rows in one hour add up, and junk counts as zero", () => {
  const series = fillHourlySeries(
    [
      { hour: hourAt(-1), events: 2, penalties: 1 },
      { hour: hourAt(-1), events: 3, penalties: 0 },
      { hour: hourAt(-1), events: -5, penalties: Number.NaN }
    ],
    { hours: 24, now: NOW }
  );

  assert.equal(series.events[22], 5);
  assert.equal(series.penalties[22], 1);
});

test("a change from an empty window is named, never a percentage", () => {
  // The defect in the reference: 0 → 4 printed «Infinity%» in green.
  assert.deepEqual(changeSince(4, 0), { kind: "new", percent: null, delta: 4 });
  // And 0 → 0 printed «-100%» in red, which is arithmetic, not information.
  assert.deepEqual(changeSince(0, 0), { kind: "flat", percent: 0, delta: 0 });
  // Neither side having data is still not «-100%».
  assert.deepEqual(changeSince(0, 3), { kind: "down", percent: -100, delta: -3 });
});

test("percentages are real, signed, and capped", () => {
  assert.deepEqual(changeSince(15, 10), { kind: "up", percent: 50, delta: 5 });
  assert.deepEqual(changeSince(6, 8), { kind: "down", percent: -25, delta: -2 });
  assert.deepEqual(changeSince(7, 7), { kind: "flat", percent: 0, delta: 0 });
  assert.equal(changeSince(50, 1).percent, 999, "a tiny baseline cannot print +4900%");
  assert.equal(changeSince(50, 1).kind, "up", "the cap keeps the direction");
});

test("a flat series draws a line on the baseline, never NaN", () => {
  const path = sparklinePath([0, 0, 0, 0], { width: 100, height: 32, inset: 2 });
  assert.ok(!path.includes("NaN"), path);
  assert.equal(path, "M2,30 L34,30 L66,30 L98,30");
});

test("the tallest hour fills the box without distorting the rest", () => {
  const path = sparklinePath([0, 10, 5], { width: 100, height: 32, inset: 2 });
  // 0 → baseline, 10 → the top inset, 5 → halfway.
  assert.equal(path, "M2,30 L50,2 L98,16");
});

test("a single point sits in the middle, and no points draw nothing", () => {
  assert.equal(sparklinePath([7], { width: 100, height: 32, inset: 2 }), "M50,2");
  assert.equal(sparklinePath([]), "");
  assert.equal(sparklineArea([]), "");
});

test("the area path closes to the baseline under the same line", () => {
  const area = sparklineArea([0, 10], { width: 100, height: 32, inset: 2 });
  assert.equal(area, "M2,30 L98,2 L98,30 L2,30 Z");
});
