/**
 * Authenticated database check.
 *
 * `pg_isready` answers "is the server accepting connections", which is not the
 * same question as "can this application use its database": PostgreSQL's own
 * documentation says readiness succeeds even when the credentials are wrong.
 * This script connects with the exact `DATABASE_URL` the services use, runs one
 * read-only query, and exits non-zero on any failure - missing variable, bad
 * URL, refused connection, failed authentication, or a different database.
 *
 * It never prints the URL or the password. Any occurrence of either in an error
 * message is redacted before it reaches the console.
 *
 * `pg` is borrowed from the dashboard workspace, which declares it: that is the
 * same driver and version the services use, so the check exercises the real
 * client instead of a second copy, and the root package does not gain a
 * dependency for a script it never ships.
 */
import { createRequire } from "node:module";

const { Client } = createRequire(new URL("../apps/dashboard/package.json", import.meta.url))("pg");

const raw = process.env.DATABASE_URL?.trim();

function fail(message, target) {
  console.error(`AL AI PostgreSQL: VERIFY FAILED - ${message}`);
  if (target) console.error(`  target: ${target.user}@${target.host}:${target.port}/${target.database}`);
  process.exitCode = 1;
}

/**
 * A connection refusal arrives as an AggregateError with an *empty* message and
 * the reason in `code`, so `error.message` alone printed "VERIFY FAILED - " and
 * nothing else. Name the code, then the message, then anything nested.
 */
function describeError(error) {
  if (!error) return "unknown error";
  const own = [error.code, error.message].filter(part => part !== undefined && part !== null && part !== "").join(": ");
  if (own) return own;
  const nested = Array.isArray(error.errors)
    ? error.errors.map(inner => inner?.message || inner?.code).filter(Boolean).join("; ")
    : "";
  return nested || error.name || "connection failed";
}

function redact(text, secrets) {
  let out = String(text);
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join("***");
  }
  return out.split(raw ?? "").join("<DATABASE_URL>");
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    // A malformed escape is a URL problem the connection attempt will report;
    // it must not crash the checker before that message is printed.
    return value;
  }
}

if (!raw) {
  fail("DATABASE_URL is not set (run through npm so --env-file=.env applies)");
} else {
  let target;
  try {
    const url = new URL(raw);
    if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
      throw new Error("not a postgres:// URL");
    }
    if (!url.hostname) throw new Error("no host");
    target = {
      user: safeDecode(url.username || "?"),
      host: url.hostname,
      port: url.port || "5432",
      database: safeDecode(url.pathname.replace(/^\//, "") || "?")
    };
  } catch (error) {
    // The URL itself is never echoed: only the fact that it could not be read.
    fail(`DATABASE_URL is not a valid postgres URL (${redact(describeError(error), [])})`);
  }

  if (target) {
    const secrets = [raw];
    try {
      const url = new URL(raw);
      secrets.push(url.password, safeDecode(url.password));
    } catch {
      // Already handled above; keep whatever was collected.
    }

    const client = new Client({
      connectionString: raw,
      application_name: "al-ai-db-verify",
      connectionTimeoutMillis: 5_000,
      query_timeout: 5_000
    });

    try {
      await client.connect();
      const { rows } = await client.query("select current_database() as database, current_user as username, 1 as ok");
      const row = rows[0];
      if (!row || Number(row.ok) !== 1) throw new Error("unexpected result from SELECT 1");
      if (target.database !== "?" && row.database !== target.database) {
        throw new Error(`connected to database "${row.database}" instead of "${target.database}"`);
      }
      console.log(
        `AL AI PostgreSQL: AUTHENTICATED ${row.username}@${target.host}:${target.port}/${row.database} (SELECT 1 ok)`
      );
    } catch (error) {
      fail(redact(describeError(error), secrets), target);
    } finally {
      await client.end().catch(() => undefined);
    }
  }
}
