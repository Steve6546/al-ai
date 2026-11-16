#!/usr/bin/env node
"use strict";
/**
 * Universal entry point.
 *
 * The deployment's real start command is `bash scripts/host/boot.sh` (it starts
 * PostgreSQL, the dashboard and the bot together). Several hosts, though, only
 * offer a single "entry file" box — Bot-Hosting's `STARTUP_FILE`, Pterodactyl's
 * startup, Railway/Render's start field, a bare `node .`. This file makes the
 * repository run under any of them by delegating to the same script, so there
 * is exactly one startup path to reason about.
 *
 * Written as CommonJS on purpose: the root package.json is not `"type":
 * "module"`, so a `require`-based file runs under a plain `node index.js`
 * without flags. `AL_AI_ROOT` is exported so the precompiled bundles resolve
 * their config/lock paths against the repository root.
 */
const { spawn } = require("node:child_process");
const { existsSync } = require("node:fs");
const { join } = require("node:path");

const ROOT = __dirname;
process.env.AL_AI_ROOT = process.env.AL_AI_ROOT || ROOT;
process.env.NODE_ENV = process.env.NODE_ENV || "production";

const boot = join(ROOT, "scripts", "host", "boot.sh");
if (!existsSync(boot)) {
  console.error("index.js: scripts/host/boot.sh not found; nothing to start.");
  process.exit(1);
}

// Forward the platform's stop signals to the supervisor so PostgreSQL gets its
// `-m fast` shutdown instead of being killed mid-write.
const child = spawn("bash", [boot], { stdio: "inherit", env: process.env, cwd: ROOT });
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  });
}
child.on("error", error => {
  console.error("index.js: could not start scripts/host/boot.sh —", error.message);
  process.exit(1);
});
child.on("exit", code => process.exit(code == null ? 1 : code));
