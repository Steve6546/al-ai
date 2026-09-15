import test from "node:test";
import assert from "node:assert/strict";
import { logCategories } from "../src/types";

/**
 * Every event the logs screen offers must carry an Arabic label.
 *
 * `logCategories` derives its event list straight from the compiled schema and
 * falls back to the raw id when no copy exists:
 *
 *     events: eventsByCategory(id).map(eventId => ({ id: eventId, label: eventCopy[eventId] ?? eventId }))
 *
 * That fallback is what makes the gap invisible. The screen renders fine, the
 * toggle works, the category counts line up — and one row quietly reads
 * `moderation.clearwarns` in a list where every sibling reads Arabic. Nothing
 * fails, so nothing gets fixed.
 *
 * `moderation.clearwarns` was exactly that row. It is in the schema, routed to
 * moderation-log, emitted by the command handler when a moderator clears a
 * member's warnings — and it had no entry in `eventCopy`.
 *
 * The assertion is deliberately "the label is not the id" rather than a
 * hard-coded list of names: it catches a missing label for an event that does
 * not exist yet, which is the point of a guard.
 */
test("every event in a log category has an operator-facing label", () => {
  const unlabelled: string[] = [];

  for (const category of logCategories) {
    for (const event of category.events) {
      // A label identical to the id means the fallback fired.
      if (event.label === event.id) unlabelled.push(`${category.id} → ${event.id}`);
    }
  }

  assert.deepEqual(
    unlabelled,
    [],
    "these events would render as their raw ids in the logs screen: " + unlabelled.join(", ")
  );
});

test("every destination an operator configures carries a label and a description", () => {
  const unlabelled = logCategories.filter(category => category.label === category.id || !category.description);

  assert.deepEqual(
    unlabelled.map(category => category.id),
    [],
    "a destination with no copy falls back to its raw id in the screen's section header"
  );
});
