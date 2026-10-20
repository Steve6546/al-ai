import test from "node:test";
import assert from "node:assert/strict";
import { logCategories } from "@/types";
import { eventHints, eventIcons } from "../src/views/settings/logs.js";

/**
 * The two log tables have to agree.
 *
 * The screen keeps one table of icons and one table of hints, both keyed by
 * event id, and both are written by hand. They were separate for a long time
 * without anything checking that they covered the same events, so an event
 * could appear in one and not the other - an event with an icon and no
 * explanation, or the reverse.
 *
 * A test that compares the two key sets catches that the moment it happens,
 * and it is cheaper than merging the tables: a merged table would have to be
 * retyped wholesale, and a retyped table is a table that can lose an entry.
 */
const eventIds = logCategories.flatMap(category => category.events.map(event => event.id));

test("every log event has an icon", () => {
  const missing = eventIds.filter(id => !(id in eventIcons));
  assert.deepEqual(missing, [], "these events would render without an icon");
});

test("every log event has a hint", () => {
  const missing = eventIds.filter(id => !(id in eventHints));
  assert.deepEqual(missing, [], "these events would render without an explanation");
});

test("the tables carry nothing the log categories do not", () => {
  const known = new Set(eventIds);
  const extraIcons = Object.keys(eventIcons).filter(id => !known.has(id));
  const extraHints = Object.keys(eventHints).filter(id => !known.has(id));
  assert.deepEqual(extraIcons, [], "an icon for an event that does not exist");
  assert.deepEqual(extraHints, [], "a hint for an event that does not exist");
});

test("the two tables cover exactly the same events", () => {
  assert.deepEqual(
    Object.keys(eventIcons).sort(),
    Object.keys(eventHints).sort(),
    "an event with an icon but no hint (or the other way round) would read as a broken row"
  );
});
