import test from "node:test";
import assert from "node:assert/strict";
import { escapeEmbedText } from "../src/embed-plan.js";

/**
 * Member-authored text inside an embed field.
 *
 * A nickname, a thread name or a webhook name is rendered as markdown by
 * Discord, so without escaping it the bot appears to publish a link the member
 * chose. The escape set is only what Discord documents as escapable — escaping
 * `[`, `(` or `#` would print the backslash instead.
 */

test("markdown marks are escaped", () => {
  assert.equal(escapeEmbedText("**bold** _i_ ~s~ `c`"), "\\*\\*bold\\*\\* \\_i\\_ \\~s\\~ \\`c\\`");
});

test("a backslash is escaped first, so it cannot un-escape the rest", () => {
  assert.equal(escapeEmbedText("\\*"), "\\\\\\*");
});

test("a typed ping is broken without hiding the text", () => {
  assert.equal(escapeEmbedText("@everyone and @here"), "@\u200beveryone and @\u200bhere");
  assert.equal(escapeEmbedText("@everyoneish"), "@everyoneish", "a word that only starts like a ping is left alone");
});

test("a typed mention id is inert", () => {
  for (const mention of ["<@123>", "<@!123>", "<@&456>", "<#789>"]) {
    const escaped = escapeEmbedText(mention);
    assert.ok(escaped.includes("\u200b"), `${mention} is broken by a zero-width space`);
    assert.doesNotMatch(escaped, /<[@#][!&]?\d+>/, `${mention} no longer matches mention syntax`);
  }
});

test("link syntax cannot form a target", () => {
  assert.equal(escapeEmbedText("[القواعد](https://example)"), "[القواعد]\u200b(https://example)");
  assert.equal(escapeEmbedText("[a] (https://b)"), "[a]\u200b(https://b)", "whitespace between the halves still breaks the link");
});

test("ordinary text survives untouched", () => {
  const plain = "مرحباً، أحمد. عدد الأعضاء: 1,204 (تقريبًا)";
  assert.equal(escapeEmbedText(plain), plain);
});

test("the result is idempotent for text that had no syntax", () => {
  assert.equal(escapeEmbedText(escapeEmbedText("عادي")), "عادي");
});
