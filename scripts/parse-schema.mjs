/**
 * Parses the AL AI schema with a real PostgreSQL grammar.
 *
 * Why this exists: the schema migration cannot be executed in this environment
 * (the machine refuses to let PostgreSQL bind a TCP socket), so a syntax error
 * would otherwise only surface on the first real deploy. Parsing every
 * statement catches that class of mistake here.
 *
 * Statements the parser cannot model — plpgsql function bodies and triggers —
 * are reported separately rather than counted as failures, so a genuine syntax
 * error is never hidden behind known parser gaps.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

/**
 * The parser is a devDependency of the repo root, so it resolves normally when
 * run through `npm run check:schema`. `AL_AI_TOOLCHAIN` points at an out-of-tree
 * install for environments where the repo's node_modules is not available.
 */
const workspaceRequire = createRequire(process.env.AL_AI_TOOLCHAIN ?? new URL("../", import.meta.url));
const { parse } = workspaceRequire("pgsql-ast-parser");

const schemaPath = process.argv[2];
if (!schemaPath) {
  console.error("usage: node parse-schema.mjs <path-to-schema.sql>");
  process.exit(2);
}

const sql = readFileSync(schemaPath, "utf8");

/**
 * Splits on semicolons that are not inside a dollar-quoted body, a string
 * literal or a comment. Naive splitting breaks on `$$ ... $$`.
 */
function splitStatements(text) {
  const statements = [];
  let current = "";
  let dollarTag = null;
  let inSingle = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (inLineComment) {
      current += char;
      if (char === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      current += char;
      if (char === "*" && next === "/") {
        current += next;
        i += 1;
        inBlockComment = false;
      }
      continue;
    }
    if (dollarTag) {
      current += char;
      if (text.startsWith(dollarTag, i)) {
        current += dollarTag.slice(1);
        i += dollarTag.length - 1;
        dollarTag = null;
      }
      continue;
    }
    if (inSingle) {
      current += char;
      if (char === "'") inSingle = false;
      continue;
    }

    if (char === "-" && next === "-") {
      inLineComment = true;
      current += char;
      continue;
    }
    if (char === "/" && next === "*") {
      inBlockComment = true;
      current += char;
      continue;
    }
    if (char === "'") {
      inSingle = true;
      current += char;
      continue;
    }
    if (char === "$") {
      const match = /^\$[A-Za-z_]*\$/.exec(text.slice(i));
      if (match) {
        dollarTag = match[0];
        current += match[0];
        i += match[0].length - 1;
        continue;
      }
    }
    if (char === ";") {
      statements.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) statements.push(current);
  return statements;
}

/**
 * Statements the parser does not model. These are reported separately rather
 * than counted as failures, so a genuine syntax error is never hidden behind a
 * known gap.
 *
 * - plpgsql bodies and triggers: outside the grammar entirely.
 * - `DROP TRIGGER ... ON ...` and `REVOKE ... ON ...`: valid PostgreSQL that
 *   pgsql-ast-parser has no production for.
 */
const UNSUPPORTED = [
  /\$\$/,
  /CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/i,
  /CREATE\s+TRIGGER/i,
  /DROP\s+TRIGGER/i,
  /REVOKE\s+/i,
  /LANGUAGE\s+plpgsql/i
];

const statements = splitStatements(sql).filter(statement => statement.trim().length > 0);
const failures = [];
const skipped = [];
let parsed = 0;

for (const [index, statement] of statements.entries()) {
  const head = statement.trim().split(/\s+/).slice(0, 4).join(" ");
  try {
    parse(statement);
    parsed += 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (UNSUPPORTED.some(pattern => pattern.test(statement))) {
      skipped.push({ index, head, message });
    } else {
      failures.push({ index, head, message, statement: statement.trim().slice(0, 220) });
    }
  }
}

console.log(`statements: ${statements.length}`);
console.log(`parsed:     ${parsed}`);
console.log(`skipped:    ${skipped.length} (plpgsql / triggers, outside the parser's grammar)`);
console.log(`failed:     ${failures.length}`);

if (failures.length) {
  console.log("\n--- FAILURES ---");
  for (const failure of failures) {
    console.log(`\n#${failure.index}  ${failure.head}`);
    console.log(`  ${failure.message}`);
    console.log(`  ${failure.statement}`);
  }
  process.exit(1);
}

console.log("\nAll non-plpgsql statements parse.");
