import test from "node:test";
import assert from "node:assert/strict";
import { isProduction, missingEnv, readEnv } from "../src/index.ts";

/**
 * The blank-is-absent rule is the one that matters. `BOT_TOKEN=` is what a
 * freshly copied `.env` holds, and treating it as present is how the bot ends
 * up attempting a gateway login with an empty token instead of exiting with the
 * "waiting for secrets" message it is supposed to print.
 */
test("a blank value is absent, not present", () => {
  assert.equal(readEnv({ BOT_TOKEN: "" }, "BOT_TOKEN"), null);
  assert.equal(readEnv({ BOT_TOKEN: "   " }, "BOT_TOKEN"), null);
  assert.equal(readEnv({}, "BOT_TOKEN"), null);
  assert.deepEqual(missingEnv({ BOT_TOKEN: "  " }, ["BOT_TOKEN"]), ["BOT_TOKEN"]);
});

test("a value is returned trimmed", () => {
  assert.equal(readEnv({ PORT: " 3000 " }, "PORT"), "3000");
  assert.deepEqual(missingEnv({ A: "x", B: "" }, ["A", "B"]), ["B"]);
});

test("missingEnv reports every absent key in the order given", () => {
  const source = { A: "1", C: "   " };
  assert.deepEqual(missingEnv(source, ["A", "B", "C", "D"]), ["B", "C", "D"]);
  assert.deepEqual(missingEnv(source, []), []);
});

test("production is recognised, and only production", () => {
  assert.equal(isProduction({ NODE_ENV: "production" }), true);
  assert.equal(isProduction({ NODE_ENV: " production " }), true, "stray whitespace must not downgrade the deployment");
  assert.equal(isProduction({ NODE_ENV: "development" }), false);
  assert.equal(isProduction({ NODE_ENV: "" }), false);
  assert.equal(isProduction({}), false);
});
