#!/usr/bin/env node
/**
 * PostgreSQL for a host that does not give you PostgreSQL.
 *
 * AL AI expects a real PostgreSQL server — `infra/schema.sql` uses triggers,
 * partial indexes and `gen_random_uuid()`, and both processes talk the wire
 * protocol through `pg`. A managed platform that sells "one deployment, no
 * database add-on" therefore needs one of two things: an external database, or
 * a PostgreSQL that lives inside the deployment. This file is the second.
 *
 * It is a **bootstrapper, not a database**: the binaries come from
 * `@embedded-postgres/linux-x64` (the official PostgreSQL build the
 * `embedded-postgres` package ships), and this file only does what a minimal
 * container needs around them:
 *
 * 1. **Download once.** The 60 MB release is unpacked into `.al-ai-pg/` on the
 *    first boot and reused afterwards; the deployment's own volume keeps it.
 *    The version is pinned exactly: this package publishes prereleases only, so
 *    a range like `18` does not resolve at all.
 * 2. **Repair the loader.** npm does not preserve the version symlinks inside
 *    that package, so `libpq.so.5` and `libicuuc.so.60` are missing until they
 *    are recreated. Without them `initdb` dies with "cannot open shared object
 *    file".
 * 3. **Answer libc's question.** PostgreSQL calls `getpwuid()`. A container
 *    that runs as uid 999 with no `/etc/passwd` entry makes `initdb` abort with
 *    "could not look up effective user ID 999". A 12-line shim, compiled at
 *    boot with the image's `gcc`, answers for that one user. It is preloaded
 *    only for PostgreSQL's own processes.
 * 4. **Init once, tuned for 256 MB.** `shared_buffers=16MB`, one WAL sender,
 *    small WAL segments, autovacuum off: the defaults (128 MB of buffers, 16 MB
 *    WAL files) do not fit next to a Node process on a free plan.
 * 5. **Supervise.** `postgres` runs as a child; SIGTERM/SIGINT stop it with
 *    `-m fast` so the volume is consistent when the platform stops the
 *    deployment.
 *
 * Nothing here is used on a normal machine: `npm run dev` and Docker Compose
 * still start the real PostgreSQL. This file exists for `scripts/host/boot.sh`,
 * which is what a one-slot free plan runs.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { createConnection } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
/** Everything this bootstrap owns, so a wipe is one directory. */
const WORK = process.env.AL_AI_PG_HOME ? resolve(process.env.AL_AI_PG_HOME) : join(ROOT, ".al-ai-pg");const PKG = join(WORK, "pkg");
const NATIVE = join(PKG, "node_modules", "@embedded-postgres", "linux-x64", "native");
const BIN = join(NATIVE, "bin");
const LIB = join(NATIVE, "lib");
const DATA = process.env.PGDATA ? resolve(process.env.PGDATA) : join(WORK, "data");
const PORT = Number(process.env.PGPORT || 5432);
const USER = process.env.AL_AI_PG_USER || "al_ai";
const DATABASE = process.env.AL_AI_PG_DATABASE || "al_ai";
const PASSWORD_FILE = join(WORK, "password");
/**
 * The application role the two services connect as. Never the owner: the owner
 * is the cluster superuser (`initdb`'s own role), and a bug that reaches the
 * query layer must not also be able to read server files, drop a table, or
 * bypass row-level security. `infra/schema.sql` creates this role when it is
 * missing and grants it DML only; `ensureAppRole` is what gives it a password.
 */
const APP_USER = process.env.AL_AI_PG_APP_USER || "al_ai_app";
const APP_PASSWORD_FILE = join(WORK, "password-app");
const SHIM = join(WORK, "libnssshim.so");
const SHIM_SOURCE = join(WORK, "shim.c");

const log = message => console.log(`[db] ${message}`);

mkdirSync(WORK, { recursive: true });

/** The uid/gid the container actually runs as, for the passwd shim. */
function identity() {
  return { uid: process.getuid?.() ?? 999, gid: process.getgid?.() ?? 987 };
}

/**
 * A password this deployment generated and then kept.
 *
 * `POSTGRES_PASSWORD` wins when the operator set one; otherwise the first boot
 * mints 32 random bytes and stores them in `.al-ai-pg/password` (mode 600). The
 * value never leaves the volume: `boot.sh` builds `DATABASE_URL` from it.
 */
function password() {
  const fromEnv = process.env.POSTGRES_PASSWORD?.trim();
  if (fromEnv) return fromEnv;
  if (existsSync(PASSWORD_FILE)) return readFileSync(PASSWORD_FILE, "utf8").trim();
  const minted = randomBytes(24).toString("hex");
  writeFileSync(PASSWORD_FILE, minted, { mode: 0o600 });
  chmodSync(PASSWORD_FILE, 0o600);
  return minted;
}

function databaseUrl(secret) {
  return `postgres://${encodeURIComponent(USER)}:${encodeURIComponent(secret)}@127.0.0.1:${PORT}/${DATABASE}`;
}

/**
 * The application password: minted once, kept beside the owner's, mode 600.
 *
 * `POSTGRES_APP_PASSWORD` wins when the operator set one. The two passwords are
 * deliberately different files so losing one never widens the other, and a
 * rotation is `rm password-app` then restart — `ensureAppRole` writes the new
 * value into the role before printing the URL the services use.
 */
function appPassword() {
  const fromEnv = process.env.POSTGRES_APP_PASSWORD?.trim();
  if (fromEnv) return fromEnv;
  if (existsSync(APP_PASSWORD_FILE)) return readFileSync(APP_PASSWORD_FILE, "utf8").trim();
  const minted = randomBytes(24).toString("hex");
  writeFileSync(APP_PASSWORD_FILE, minted, { mode: 0o600 });
  chmodSync(APP_PASSWORD_FILE, 0o600);
  return minted;
}

function appDatabaseUrl(secret) {
  return `postgres://${encodeURIComponent(APP_USER)}:${encodeURIComponent(secret)}@127.0.0.1:${PORT}/${DATABASE}`;
}

function haveBinaries() {
  return existsSync(join(BIN, "postgres")) && existsSync(join(BIN, "initdb"));
}

/**
 * Download the PostgreSQL build once.
 *
 * `npm install --prefix` is used instead of a dependency in the repository so a
 * developer on Windows never downloads a Linux binary, and so the deployment
 * can fetch it without a lockfile change. The package is pinned to the major
 * version the schema was verified against.
 */
function ensureBinaries() {
  if (haveBinaries()) return;
  log("downloading the PostgreSQL 18 build (once)");
  mkdirSync(PKG, { recursive: true });
  const result = spawnSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["install", "--prefix", PKG, "--no-save", "--no-audit", "--no-fund", "--loglevel=error", "@embedded-postgres/linux-x64@18.6.0-beta.19"],
    { stdio: "inherit", env: { ...process.env, npm_config_fund: "false", npm_config_audit: "false" } }
  );
  if (result.status !== 0 || !haveBinaries()) {
    throw new Error("could not download the PostgreSQL build; the deployment needs outbound HTTPS to registry.npmjs.org once");
  }
  fixSharedLibraries();
}

/**
 * Recreate the `libX.so.N` symlinks npm dropped.
 *
 * The package ships `libpq.so.5.18` and expects `libpq.so.5`; the loader looks
 * for the short name. Only files that match `lib*.so.N.M` are linked, so this
 * cannot create a name that shadows a real file.
 */
function fixSharedLibraries() {
  for (const name of readdirSync(LIB)) {
    const match = /^(lib.+\.so\.\d+)\.\d+$/.exec(name);
    if (!match) continue;
    const link = join(LIB, match[1]);
    if (existsSync(link)) continue;
    symlinkSync(name, link);
  }
}

/**
 * Compile the `getpwuid` shim PostgreSQL needs in a container with no passwd
 * entry for its uid.
 *
 * The source is written next to the binary and compiled with the image's `cc`.
 * If a compiler is missing, the build is skipped: `initdb` then fails with a
 * clear message instead of this file pretending the database works.
 */
function ensurePasswdShim() {
  if (process.platform !== "linux") return null;
  if (existsSync(SHIM)) return SHIM;
  const { uid, gid } = identity();
  if (existsSync("/etc/passwd") && readFileSync("/etc/passwd", "utf8").includes(`:${uid}:`)) return null;
  const source = `/* Answers getpwuid() for a container uid with no /etc/passwd entry. */
#define _GNU_SOURCE
#include <pwd.h>
#include <grp.h>
#include <stddef.h>
#include <sys/types.h>

static struct passwd al_ai_user = {
  (char *)"container", (char *)"x", ${uid}, ${gid},
  (char *)"container", (char *)"/home/container", (char *)"/bin/sh"
};
static struct group al_ai_group = { (char *)"container", (char *)"x", ${gid}, NULL };

struct passwd *getpwuid(uid_t uid) { (void)uid; return &al_ai_user; }
int getpwuid_r(uid_t uid, struct passwd *pwd, char *buf, size_t len, struct passwd **out) {
  (void)uid; (void)buf; (void)len; if (pwd) *pwd = al_ai_user; *out = &al_ai_user; return 0;
}
struct group *getgrgid(gid_t gid) { (void)gid; return &al_ai_group; }
int getgrgid_r(gid_t gid, struct group *grp, char *buf, size_t len, struct group **out) {
  (void)gid; (void)buf; (void)len; if (grp) *grp = al_ai_group; *out = &al_ai_group; return 0;
}
`;
  writeFileSync(SHIM_SOURCE, source);
  const compiler = ["gcc", "cc"].find(name => spawnSync(name, ["--version"], { stdio: "ignore" }).status === 0);
  if (!compiler) {
    log("no C compiler: the passwd shim was not built (initdb will fail if the uid has no passwd entry)");
    return null;
  }
  const built = spawnSync(compiler, ["-shared", "-fPIC", "-O2", "-o", SHIM, SHIM_SOURCE], { stdio: "inherit" });
  if (built.status !== 0) throw new Error("could not compile the passwd shim");
  log("built the passwd shim");
  return SHIM;
}

/**
 * The settings that make PostgreSQL fit beside two Node processes.
 *
 * Written to a separate file and included from `postgresql.conf`, so a
 * re-initialise never stacks duplicates. `fsync=off` is deliberate: the volume
 * is a throwaway free-plan database, and surviving a host crash matters less
 * than the WAL writer not consuming the CPU share the bot needs.
 */
const TUNING = `# AL AI free-plan tuning (scripts/host/pg.mjs)
shared_buffers = 16MB
max_connections = 8
work_mem = 2MB
maintenance_work_mem = 16MB
effective_cache_size = 64MB
fsync = off
synchronous_commit = off
full_page_writes = off
wal_level = minimal
max_wal_senders = 0
autovacuum = off
`;

function initialise(secret) {
  const pwfile = join(WORK, "pwfile");
  writeFileSync(pwfile, `${secret}\n`, { mode: 0o600 });
  const env = withLoader();
  log(`initialising ${DATA}`);
  execFileSync(join(BIN, "initdb"), [
    "-D", DATA,
    "-U", USER,
    "--pwfile", pwfile,
    "-A", "scram-sha-256",
    "-E", "UTF8",
    "--locale=C",
    // 1 MB WAL segments instead of 16 MB: 16 segments of 16 MB is 256 MB of
    // files on a 512 MB disk before a single row exists.
    "--wal-segsize=1"
  ], { stdio: "inherit", env });
  rmSync(pwfile, { force: true });
  const tuning = join(DATA, "al-ai.conf");
  writeFileSync(tuning, TUNING);
  const conf = join(DATA, "postgresql.conf");
  const text = readFileSync(conf, "utf8");
  if (!text.includes("al-ai.conf")) writeFileSync(conf, `${text}\ninclude = 'al-ai.conf'\n`);
}

function withLoader() {
  const env = { ...process.env };
  env.LD_LIBRARY_PATH = [LIB, env.LD_LIBRARY_PATH].filter(Boolean).join(":");
  if (existsSync(SHIM)) env.LD_PRELOAD = [SHIM, env.LD_PRELOAD].filter(Boolean).join(" ");
  return env;
}

function ensureCluster(secret) {
  if (!existsSync(join(DATA, "PG_VERSION"))) {
    initialise(secret);
    return true;
  }
  fixSharedLibraries();
  return false;
}

/** True once PostgreSQL accepts a TCP connection on the loopback port. */
async function waitForPort(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const open = await new Promise(done => {
      const socket = createConnection({ host: "127.0.0.1", port: PORT });
      const finish = ok => {
        socket.destroy();
        done(ok);
      };
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
      socket.setTimeout(1000, () => finish(false));
    });
    if (open) return true;
    await new Promise(done => setTimeout(done, 400));
  }
  return false;
}

/**
 * `initdb` creates `postgres`, `template0` and `template1`; it does not create
 * the application's database. A first boot without it makes every connection
 * fail with `database "al_ai" does not exist`, which reads like a credentials
 * problem. Create it once, as the superuser that `initdb` just made.
 */
async function ensureDatabase(secret) {
  const { default: pg } = await import("pg");
  const url = new URL(databaseUrl(secret));
  url.pathname = "/postgres";
  const admin = new pg.Client({ connectionString: url.toString() });
  await admin.connect();
  try {
    const { rowCount } = await admin.query("select 1 from pg_database where datname = $1", [DATABASE]);
    if (!rowCount) {
      await admin.query(`create database "${DATABASE}"`);
      log(`created database ${DATABASE}`);
    }
  } finally {
    await admin.end();
  }
}

/**
 * Give the application role its password and prove it can log in.
 *
 * Runs as the owner, after PostgreSQL is up and before the schema pass (the
 * schema creates the role when it is missing). Every identifier and literal is
 * passed through `format(%I/%L)`, so a role name from the environment cannot
 * turn into SQL. Returns false when the role cannot be prepared here — the
 * caller then keeps the owner URL, which is the state this deployment was in
 * before, so a failure never takes the services down.
 */
async function ensureAppRole(secret) {
  const { default: pg } = await import("pg");
  const admin = new pg.Client({ connectionString: databaseUrl(secret) });
  await admin.connect();
  try {
    const appSecret = appPassword();
    const exists = await admin.query("select 1 from pg_roles where rolname = $1", [APP_USER]);
    const statement = exists.rowCount
      ? (await admin.query(
          "select format('ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', $1, $2) as sql",
          [APP_USER, appSecret]
        )).rows[0].sql
      : (await admin.query(
          "select format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', $1, $2) as sql",
          [APP_USER, appSecret]
        )).rows[0].sql;
    await admin.query(statement);
    // A role with LOGIN and the right flags is the whole contract; the login
    // probe is what proves the password just written is the one that works, so
    // a URL is never printed for a role the services cannot use.
    const probe = new pg.Client({ connectionString: appDatabaseUrl(appSecret) });
    try {
      await probe.connect();
      const flags = (await probe.query(
        "select rolsuper, rolbypassrls from pg_roles where rolname = current_user"
      )).rows[0];
      if (!flags || flags.rolsuper || flags.rolbypassrls) {
        log(`application role ${APP_USER} is not least-privilege; services keep the owner URL`);
        return false;
      }
    } finally {
      await probe.end().catch(() => {});
    }
    log(`application role ${APP_USER} ready (NOSUPERUSER, NOBYPASSRLS)`);
    return true;
  } catch (error) {
    log(`application role could not be prepared (${error.message}); services keep the owner URL`);
    return false;
  } finally {
    await admin.end().catch(() => {});
  }
}

/**
 * Apply `infra/schema.sql`.
 *
 * Idempotent by construction (`CREATE TABLE IF NOT EXISTS`), so it runs on
 * every start: a fresh volume gets the schema, and an existing one pays ~50 ms
 * to prove it is still there. The schema is read from the repository, never
 * duplicated here.
 */
async function applySchema(secret) {
  const { default: pg } = await import("pg");
  const sql = readFileSync(join(ROOT, "infra", "schema.sql"), "utf8");
  // The port opens a moment before the server finishes recovery, so a single
  // connect can still answer "the database system is starting up".
  let lastError = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const client = new pg.Client({ connectionString: databaseUrl(secret) });
    try {
      await client.connect();
      try {
        await client.query(sql);
        const { rows } = await client.query("select count(*)::int as n from information_schema.tables where table_schema='public'");
        log(`schema applied (${rows[0].n} tables)`);
        return;
      } finally {
        await client.end();
      }
    } catch (error) {
      lastError = error;
      await client.end().catch(() => {});
      await new Promise(done => setTimeout(done, 500));
    }
  }
  throw lastError ?? new Error("schema could not be applied");
}

/**
 * Remove a `postmaster.pid` left behind by a killed instance.
 *
 * A platform restart can SIGKILL the supervisor before PostgreSQL gets its
 * `-m fast` stop, leaving the lock file behind. On the next boot the new
 * postmaster then refuses to start ("lock file already exists") and the
 * deployment crash-loops. After a container restart PIDs are recycled, so a
 * live PID is not proof of a live cluster: the /proc cmdline must also name
 * this data directory.
 */
function clearStalePostmasterPid() {
  const pidFile = join(DATA, "postmaster.pid");
  if (!existsSync(pidFile)) return;
  const [pidLine, dirLine] = readFileSync(pidFile, "utf8").split("\n");
  const pid = Number(pidLine);
  if (dirLine && resolve(dirLine.trim()) !== resolve(DATA)) return; // a different cluster
  let alive = false;
  try {
    process.kill(pid, 0);
    alive = true;
  } catch {
    alive = false;
  }
  if (alive) {
    try {
      const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8");
      if (cmd.includes("postgres") && cmd.includes(DATA)) return; // genuinely running
    } catch {
      return; // no /proc: cannot prove it stale, leave it alone
    }
  }
  log(`removing stale postmaster.pid (pid ${pid})`);
  rmSync(pidFile, { force: true });
}

async function main() {
  const secret = password();
  if (process.argv.includes("--print-url")) {
    console.log(databaseUrl(secret));
    return;
  }
  // `--print-app-url` is read by boot.sh *after* PostgreSQL is ready. It mints
  // the application password when needed and answers with the least-privilege
  // URL only when that role can actually log in; otherwise the owner URL is
  // printed (and a warning logged) so a role problem is a downgrade, not an
  // outage.
  if (process.argv.includes("--print-app-url")) {
    const ownerUrl = databaseUrl(secret);
    const { default: pg } = await import("pg");
    let usable = false;
    try {
      const appSecret = appPassword();
      const probe = new pg.Client({ connectionString: appDatabaseUrl(appSecret) });
      await probe.connect();
      try {
        const flags = (await probe.query(
          "select rolsuper, rolbypassrls from pg_roles where rolname = current_user"
        )).rows[0];
        usable = Boolean(flags) && !flags.rolsuper && !flags.rolbypassrls;
      } finally {
        await probe.end().catch(() => {});
      }
      if (usable) console.log(appDatabaseUrl(appSecret));
    } catch (error) {
      log(`application role is not usable yet (${error.message})`);
    }
    if (!usable) {
      console.error(`[db] warning: ${APP_USER} cannot log in; printing the owner URL instead`);
      console.log(ownerUrl);
    }
    return;
  }

  ensureBinaries();
  fixSharedLibraries();
  ensurePasswdShim();
  if (!existsSync(PASSWORD_FILE) && !process.env.POSTGRES_PASSWORD) password();
  ensureCluster(secret);
  clearStalePostmasterPid();

  log(`starting PostgreSQL on 127.0.0.1:${PORT}`);
  const child = spawn(join(BIN, "postgres"), [
    "-D", DATA,
    "-p", String(PORT),
    "-k", WORK,
    "-c", "listen_addresses=127.0.0.1"
  ], { env: withLoader(), stdio: ["ignore", "pipe", "pipe"] });

  // PostgreSQL logs to stderr, which already reaches the platform's log view
  // through this process. Nothing is buffered here: a crash stays readable.
  const sink = (chunk) => {
    const text = String(chunk);
    process.stdout.write(text);
  };
  child.stdout.on("data", sink);
  child.stderr.on("data", sink);

  const stop = signal => {
    if (child.exitCode !== null) return;
    log(`${signal}: stopping PostgreSQL`);
    rmSync(join(WORK, "ready"), { force: true });
    try {
      execFileSync(join(BIN, "pg_ctl"), ["-D", DATA, "-m", "fast", "stop"], { env: withLoader(), stdio: "ignore" });
    } catch {
      child.kill("SIGTERM");
    }
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));

  if (!(await waitForPort())) {
    child.kill("SIGKILL");
    throw new Error(`PostgreSQL did not open 127.0.0.1:${PORT}`);
  }
  await ensureDatabase(secret);
  await ensureAppRole(secret);
  await applySchema(secret);
  writeFileSync(join(WORK, "ready"), `${new Date().toISOString()}\n`);  log("ready");

  child.on("exit", code => {
    log(`PostgreSQL exited (${code})`);
    process.exit(code ?? 1);
  });
}

main().catch(error => {
  console.error(`[db] ${error.message}`);
  process.exit(1);
});
