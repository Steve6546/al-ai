import { dom } from "./dom-env.js";
import test from "node:test";
import assert from "node:assert/strict";
import { messages, LANGUAGES, type TranslationKey } from "../src/lib/i18n";

/**
 * The three dictionaries must be the *same* dictionary.
 *
 * The type system already ties `ar` and `de` to the English keys, so a missing
 * key is a compile error. These tests are the runtime half: they catch an empty
 * value, a key that was renamed in one file and not the other, and — the one a
 * compiler cannot see — a placeholder that a translation dropped or renamed,
 * which would make `{count}` render literally instead of the number.
 */

const languages = ["en", "ar", "de"] as const;

test("every language has exactly the English key set", () => {
  const enKeys = Object.keys(messages.en).sort();
  assert.ok(enKeys.length > 0, "the English dictionary is not empty");
  for (const language of languages) {
    assert.deepEqual(
      Object.keys(messages[language]).sort(),
      enKeys,
      `${language} has the same keys as English (no missing, no extra)`
    );
  }
});

test("no translation is empty", () => {
  for (const language of languages) {
    for (const [key, value] of Object.entries(messages[language])) {
      assert.equal(typeof value, "string", `${language}.${key} is a string`);
      assert.ok(value.trim() !== "", `${language}.${key} is not empty`);
    }
  }
});

test("placeholders survive translation", () => {
  const placeholders = (value: string) => (value.match(/\{[a-zA-Z0-9_]+\}/g) ?? []).sort().join(",");
  for (const key of Object.keys(messages.en) as TranslationKey[]) {
    const expected = placeholders(messages.en[key]);
    for (const language of languages) {
      assert.equal(placeholders(messages[language][key]), expected, `${language}.${key} keeps its placeholders`);
    }
  }
});

test("German is offered alongside Arabic and English, with the right direction", () => {
  assert.deepEqual(
    LANGUAGES.map(item => item.value),
    ["ar", "en", "de"]
  );
  assert.equal(LANGUAGES.find(item => item.value === "ar")?.dir, "rtl", "Arabic is right-to-left");
  assert.equal(LANGUAGES.find(item => item.value === "en")?.dir, "ltr", "English is left-to-right");
  assert.equal(LANGUAGES.find(item => item.value === "de")?.dir, "ltr", "German is left-to-right");
});
