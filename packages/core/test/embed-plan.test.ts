import test from "node:test";
import assert from "node:assert/strict";
import {
  EMBED_MAX_FIELDS,
  EMBED_MAX_VALUE,
  EMBEDS_PER_MESSAGE,
  chunkField,
  groupPagesIntoMessages,
  planEmbedFields,
  renderValue
} from "../src/embed-plan.ts";

/**
 * GOVERNANCE rule 11 — an event is never silently dropped or truncated.
 * These tests exist because the previous implementation sliced to 20 fields,
 * which lost data without telling anyone.
 */

test("a small payload becomes a single page", () => {
  const plan = planEmbedFields({ a: 1, b: "two" });
  assert.equal(plan.pages.length, 1);
  assert.equal(plan.overflowed, false);
  assert.deepEqual(plan.pages[0], [
    { name: "a", value: "1" },
    { name: "b", value: "two" }
  ]);
});

test("more than 25 fields spill into additional pages instead of being cut", () => {
  const data = Object.fromEntries(Array.from({ length: 60 }, (_, index) => [`field${index}`, index]));
  const plan = planEmbedFields(data);

  assert.equal(plan.pages.length, 3);
  assert.equal(plan.totalFields, 60);
  assert.equal(plan.overflowed, false);

  const names = plan.pages.flat().map(field => field.name);
  assert.equal(names.length, 60);
  for (let index = 0; index < 60; index += 1) {
    assert.ok(names.includes(`field${index}`), `field${index} survived`);
  }
});

test("every page respects Discord's 25-field ceiling", () => {
  const data = Object.fromEntries(Array.from({ length: 51 }, (_, index) => [`f${index}`, index]));
  const plan = planEmbedFields(data);
  for (const page of plan.pages) assert.ok(page.length <= EMBED_MAX_FIELDS);
});

test("a value longer than 1024 characters is chunked, not cut", () => {
  const long = "x".repeat(EMBED_MAX_VALUE * 2 + 5);
  const chunks = chunkField("body", long);

  assert.equal(chunks.length, 3);
  assert.equal(chunks.map(chunk => chunk.value).join(""), long, "no character is lost");
  assert.equal(chunks[0].name, "body (1/3)");
  assert.equal(chunks[2].name, "body (3/3)");
});

test("nested objects are serialised rather than discarded", () => {
  const plan = planEmbedFields({ before: { roles: ["a", "b"] } });
  assert.equal(plan.pages[0][0].value, '{"roles":["a","b"]}');
});

test("renderValue keeps zero and false instead of treating them as empty", () => {
  assert.equal(renderValue(0), "0");
  assert.equal(renderValue(false), "false");
  assert.equal(renderValue(null), "—");
});

test("an empty payload still produces one readable field", () => {
  const plan = planEmbedFields({});
  assert.equal(plan.pages.length, 1);
  assert.deepEqual(plan.pages[0], [{ name: "الحدث", value: "—" }]);
});

test("the safety valve flags overflow instead of failing silently", () => {
  const data = Object.fromEntries(Array.from({ length: 2000 }, (_, index) => [`f${index}`, index]));
  const plan = planEmbedFields(data);
  assert.equal(plan.overflowed, true, "overflow is reported so the audit trail can be pointed at");
});

test("pages are grouped into messages of at most 10 embeds", () => {
  const pages = Array.from({ length: 23 }, (_, index) => index);
  const messages = groupPagesIntoMessages(pages);
  assert.equal(messages.length, 3);
  assert.equal(messages[0].length, EMBEDS_PER_MESSAGE);
  assert.equal(messages[2].length, 3);
});
