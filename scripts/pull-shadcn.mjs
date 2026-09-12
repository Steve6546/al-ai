/**
 * Pulls official shadcn/ui component source into the dashboard.
 *
 * The interactive `shadcn add` CLI is unreliable in a non-interactive shell,
 * so this script talks to the public registry directly and writes the exact
 * upstream source. Re-run it to refresh components after an upstream change.
 *
 *   node scripts/pull-shadcn.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const STYLE = "new-york";
const REGISTRY = `https://ui.shadcn.com/r/styles/${STYLE}`;

const COMPONENTS = [
  "alert",
  "avatar",
  "badge",
  "button",
  "card",
  "checkbox",
  "collapsible",
  "dialog",
  "dropdown-menu",
  "input",
  "label",
  "scroll-area",
  "select",
  "separator",
  "sheet",
  "skeleton",
  "switch",
  "table",
  "tabs",
  "textarea",
  "tooltip"
];

const targetDir = join(fileURLToPath(new URL(".", import.meta.url)), "..", "apps", "dashboard", "src", "components", "ui");
mkdirSync(targetDir, { recursive: true });

const written = [];
const failed = [];

for (const name of COMPONENTS) {
  try {
    const response = await fetch(`${REGISTRY}/${name}.json`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const entry = await response.json();
    const file = entry.files?.[0];
    if (!file?.content) throw new Error("registry entry had no file content");

    const out = join(targetDir, `${name}.tsx`);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, file.content);
    written.push(`${name}${entry.registryDependencies?.length ? ` (needs: ${entry.registryDependencies.join(", ")})` : ""}`);
  } catch (error) {
    failed.push(`${name}: ${error.message}`);
  }
}

console.log(`Pulled ${written.length} shadcn/ui components into apps/dashboard/src/components/ui`);
for (const line of written) console.log(`  + ${line}`);
if (failed.length) {
  console.log(`Failed ${failed.length}:`);
  for (const line of failed) console.log(`  - ${line}`);
}
