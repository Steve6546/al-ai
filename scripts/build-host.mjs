#!/usr/bin/env node
/**
 * Precompile the two long-running services for hosting.
 *
 * Why this exists: `scripts/host/boot.sh` used to start the bot and the
 * dashboard with `node --import tsx`, which keeps a TypeScript transpiler and
 * an `esbuild --service` child alive inside each process for its whole life —
 * ~31 MB of RSS on a 256 MB cgroup, before a single request. This script turns
 * both entries into one plain ESM file each, at build time, on a workstation.
 * The container then runs `node host-build/bot.mjs` with no transpiler.
 *
 * What stays external (resolved from node_modules at runtime):
 *   - native addons (@napi-rs/canvas, the optional ws accelerators) — they
 *     cannot be bundled and are loaded lazily by the code that needs them;
 *   - nothing else. Everything else (fastify, discord.js, pg, core) is inlined,
 *     so a bundle is one file and startup does not walk a module graph.
 *
 * Output is deterministic and committed under `host-build/`, so
 * "Auto-Pull on Restart" brings runnable JS to the 256 MB host, which cannot
 * build it (vite build needs ~320 MB).
 *
 * Usage: node scripts/build-host.mjs
 */
import { build } from "esbuild";
import { rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "host-build");

/** Native / optional modules that must resolve from node_modules at runtime. */
const EXTERNAL = [
  "@napi-rs/canvas",
  "pg-native",
  "bufferutil",
  "utf-8-validate",
  "zlib-sync"
];

const TARGETS = [
  { name: "bot", entry: join(ROOT, "apps/bot/src/index.ts"), outfile: join(OUT, "bot.mjs") },
  { name: "server", entry: join(ROOT, "apps/dashboard/server/index.ts"), outfile: join(OUT, "server.mjs") }
];

rmSync(OUT, { recursive: true, force: true });

for (const target of TARGETS) {
  const started = Date.now();
  await build({
    entryPoints: [target.entry],
    outfile: target.outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    // Keep the runtime source readable in a stack trace; this is not a browser
    // bundle and bytes on disk are cheap next to an opaque failure at 3 a.m.
    minify: false,
    sourcemap: false,
    legalComments: "none",
    external: EXTERNAL,
    // CommonJS dependencies (fastify/avvio, parts of discord.js) call
    // require() for Node builtins. In an ESM output esbuild replaces that with
    // a shim that throws; giving the bundle a real `require` (and the __dirname
    // / __filename those modules also expect) is the documented fix and keeps
    // everything in one file.
    banner: {
      js: [
        'import { createRequire as __cr } from "node:module";',
        'import { fileURLToPath as __f } from "node:url";',
        'import { dirname as __d } from "node:path";',
        "const require = __cr(import.meta.url);",
        "const __filename = __f(import.meta.url);",
        "const __dirname = __d(__filename);"
      ].join("\n")
    },
    // `import.meta.url` is preserved by esbuild for esm output; the three code
    // sites that depend on their own location honour AL_AI_ROOT (set by the
    // launcher) so they stay correct once flattened into a bundle.
    logLevel: "warning"
  });
  const kb = (statSync(target.outfile).size / 1024).toFixed(0);
  console.log(`[build:host] ${target.name} -> host-build/${target.name}.mjs (${kb} KB, ${Date.now() - started} ms)`);
}

console.log("[build:host] done");
