# Shared helpers for the AL AI local bootstrapper.
#
# Dot-source this file; it is never executed on its own. Everything here is
# orchestration only - it starts, probes and stops processes, and it reads the
# repository's .env so the caller never has to restate a value. No helper ever
# writes a secret to the console or to a log.

# Captured at dot-source time: $PSScriptRoot inside a function reflects whichever
# script is *calling*, so functions that need this file's own directory must read
# this value instead.
$script:AlAiScriptsRoot = $PSScriptRoot

# The repository root, from this file's own location (...\scripts\common.ps1),
# so it is correct no matter which directory the caller was started from.
function Get-RepoRoot {
  return (Resolve-Path (Join-Path $script:AlAiScriptsRoot "..")).Path
}

# Parse a .env into a hashtable. Deliberately simple: split on the first "=" and
# keep everything after it verbatim (a password may contain "#" or "="). Only a
# fully quoted value is unquoted. Inline comments are NOT stripped, because in a
# secret file a stray "#" is far more likely to be part of the value.
function Import-DotEnv {
  param([Parameter(Mandatory)][string]$Path)

  $values = @{}
  if (-not (Test-Path -LiteralPath $Path)) { return $values }

  foreach ($line in Get-Content -LiteralPath $Path) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith("#")) { continue }
    $index = $trimmed.IndexOf("=")
    if ($index -lt 1) { continue }

    $key = $trimmed.Substring(0, $index).Trim()
    $value = $trimmed.Substring($index + 1).Trim()
    if ($value.Length -ge 2 -and $value.StartsWith('"') -and $value.EndsWith('"')) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    $values[$key] = $value
  }
  return $values
}

# Export a parsed .env into this process's environment so spawned children
# inherit it - without printing anything. A value already present in the
# process environment wins, so an explicit override on the command line is
# never clobbered by the file.
function Set-ProcessEnvFromDotEnv {
  param([Parameter(Mandatory)][hashtable]$Values)

  foreach ($key in $Values.Keys) {
    $existing = [Environment]::GetEnvironmentVariable($key, "Process")
    if ([string]::IsNullOrEmpty($existing)) {
      [Environment]::SetEnvironmentVariable($key, [string]$Values[$key], "Process")
    }
  }
}

# The PostgreSQL host port: POSTGRES_HOST_PORT when set, otherwise parsed from
# DATABASE_URL (...@host:port/db), otherwise the 5432 default. Never the password.
function Get-PostgresPort {
  param([Parameter(Mandatory)][hashtable]$Values)

  if ($Values.ContainsKey("POSTGRES_HOST_PORT") -and $Values["POSTGRES_HOST_PORT"]) {
    return [int]$Values["POSTGRES_HOST_PORT"]
  }
  if ($Values.ContainsKey("DATABASE_URL") -and $Values["DATABASE_URL"]) {
    $match = [regex]::Match($Values["DATABASE_URL"], '@[^/@]+:(\d+)/')
    if ($match.Success) { return [int]$match.Groups[1].Value }
  }
  return 5432
}

# Where PostgreSQL's binaries live: PG_BIN when set, else the newest standard
# Windows install (%ProgramFiles%\PostgreSQL\<version>\bin), else the 17 default
# as a last-resort guess so a "not found" error names a concrete, checkable path.
#
# One implementation, because three scripts used to carry the same literal and
# only one of them would have been updated when a different major version was
# installed.
function Get-PostgresBinDirectory {
  if ($env:PG_BIN) { return $env:PG_BIN }

  $default = "C:\Program Files\PostgreSQL\17\bin"
  if ($env:OS -ne "Windows_NT") { return $default }

  $root = "C:\Program Files\PostgreSQL"
  if (-not (Test-Path -LiteralPath $root)) { return $default }

  $candidates = Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue |
    Sort-Object -Property @{ Expression = { if ($_.Name -match '^\d+$') { [int]$_.Name } else { 0 } } } -Descending
  foreach ($candidate in $candidates) {
    $bin = Join-Path $candidate.FullName "bin"
    if (Test-Path -LiteralPath (Join-Path $bin "postgres.exe")) { return $bin }
  }
  return $default
}

# The PostgreSQL connection target, parsed from DATABASE_URL.
#
# The password is deliberately dropped. Nothing in the bootstrapper
# authenticates, and `pg_isready` is a protocol-level check that needs no
# credentials at all - so the secret never has to leave .env, appear on a command
# line, or survive in a process listing.
function Get-PostgresConnection {
  param([Parameter(Mandatory)][hashtable]$Values)

  $target = [ordered]@{
    Host     = "127.0.0.1"
    Port     = (Get-PostgresPort -Values $Values)
    User     = $null
    Database = $null
  }

  $url = if ($Values.ContainsKey("DATABASE_URL")) { [string]$Values["DATABASE_URL"] } else { "" }
  if (-not $url) { return [pscustomobject]$target }

  # postgresql://[user[:password]@]host[:port][/database][?params]
  # The authority is everything up to the LAST "@" in that span, because a
  # password may itself contain one - a user:pass@part@host URL must not be read
  # as the host being "part@host".
  $match = [regex]::Match($url, '^postgres(?:ql)?://(?:(?<userinfo>[^/?]+)@)?(?<host>[^/:?]+)(?::(?<port>\d+))?(?:/(?<db>[^?]*))?')
  if (-not $match.Success) { return [pscustomobject]$target }

  $userinfo = $match.Groups["userinfo"].Value
  if ($userinfo) {
    $user = $userinfo.Split(":", 2)[0]
    if ($user) { $target.User = $user }
  }
  if ($match.Groups["host"].Success) { $target.Host = $match.Groups["host"].Value }
  if ($match.Groups["port"].Success) { $target.Port = [int]$match.Groups["port"].Value }
  if ($match.Groups["db"].Success -and $match.Groups["db"].Value) { $target.Database = $match.Groups["db"].Value }

  return [pscustomobject]$target
}

# Resolve the `pg_isready` binary: PG_BIN first, then PATH. Returns $null when it
# is not present, which is a supported state - the caller degrades to a socket
# probe rather than failing.
function Resolve-PgIsReady {
  param([string]$PgBin = $env:PG_BIN)

  $exeName = if ($env:OS -eq "Windows_NT") { "pg_isready.exe" } else { "pg_isready" }
  if ($PgBin) {
    $candidate = Join-Path $PgBin $exeName
    if (Test-Path -LiteralPath $candidate) { return $candidate }
  }
  $onPath = Get-Command pg_isready -ErrorAction SilentlyContinue
  if ($onPath) { return $onPath.Source }
  return $null
}

# Is PostgreSQL accepting connections?
#
# `pg_isready` is the right probe: it opens a real connection and reports whether
# the server is accepting, without a password and without logging in. It also
# tells apart "not listening" from "listening but refusing" (starting up), which
# a raw socket test cannot. Without the binary the probe degrades to a TCP
# socket test - it proves less, but still catches a stopped server.
#
# Returns @{ Ready = <bool>; Method = "pg_isready" | "tcp" }.
function Test-PostgresReady {
  param(
    [Parameter(Mandatory)][pscustomobject]$Target,
    [string]$PgBin = $env:PG_BIN,
    [int]$TimeoutSeconds = 5
  )

  $probe = Resolve-PgIsReady -PgBin $PgBin
  if ($probe) {
    $arguments = @("-h", $Target.Host, "-p", "$($Target.Port)", "-t", "$([Math]::Max(1, $TimeoutSeconds))")
    if ($Target.User) { $arguments += @("-U", $Target.User) }
    if ($Target.Database) { $arguments += @("-d", $Target.Database) }
    & $probe @arguments *> $null
    return [pscustomobject]@{ Ready = ($LASTEXITCODE -eq 0); Method = "pg_isready" }
  }

  $ready = Test-TcpPort -ComputerName $Target.Host -Port $Target.Port -TimeoutMs ([Math]::Max(1, $TimeoutSeconds) * 1000)
  return [pscustomobject]@{ Ready = $ready; Method = "tcp" }
}

# Poll Test-PostgresReady until the target is ready or the window closes.
function Wait-PostgresReady {
  param(
    [Parameter(Mandatory)][pscustomobject]$Target,
    [string]$PgBin = $env:PG_BIN,
    [int]$TimeoutSeconds = 30
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ($true) {
    $probe = Test-PostgresReady -Target $Target -PgBin $PgBin -TimeoutSeconds 5
    if ($probe.Ready) { return $probe }
    if ((Get-Date) -ge $deadline) { return $probe }
    Start-Sleep -Milliseconds 400
  }
}

# A fast, non-blocking TCP probe. TcpClient's synchronous Connect has no
# timeout; the async form does.
function Test-TcpPort {
  param(
    [string]$ComputerName = "127.0.0.1",
    [Parameter(Mandatory)][int]$Port,
    [int]$TimeoutMs = 750
  )

  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $async = $client.BeginConnect($ComputerName, $Port, $null, $null)
    if (-not $async.AsyncWaitHandle.WaitOne($TimeoutMs)) { return $false }
    $client.EndConnect($async)
    return $true
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

function Wait-TcpPort {
  param(
    [string]$ComputerName = "127.0.0.1",
    [Parameter(Mandatory)][int]$Port,
    [int]$TimeoutSeconds = 30
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-TcpPort -ComputerName $ComputerName -Port $Port) { return $true }
    Start-Sleep -Milliseconds 400
  }
  return $false
}

# The pid listening on a local port. This is the authoritative way to name a
# running service: it does not depend on how the process was launched, and it
# cannot be confused with the shell or console host that started it.
function Get-PortOwnerPid {
  param([Parameter(Mandatory)][int]$Port, [string]$ComputerName = "127.0.0.1")

  try {
    $connection = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($connection) { return [int]$connection.OwningProcess }
  } catch { }
  return $null
}

function Test-ProcessAlive {
  param([Parameter(Mandatory)][int]$Id)
  return [bool](Get-Process -Id $Id -ErrorAction SilentlyContinue)
}

function Resolve-NodePath {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if ($node) { return $node.Source }
  throw "node was not found on PATH."
}

# The service processes this repository owns: node processes whose command line
# names this repository. Used as a fallback so `stop`/`status` also see a stack
# that was started by hand rather than through the bootstrapper.
function Find-AlAiProcesses {
  param([Parameter(Mandatory)][string]$RepoRoot)

  $found = @()
  try {
    $procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue
  } catch {
    return $found
  }
  foreach ($proc in $procs) {
    if ($proc.CommandLine -and $proc.CommandLine.Contains($RepoRoot)) {
      $found += [pscustomobject]@{ Id = [int]$proc.ProcessId; CommandLine = [string]$proc.CommandLine }
    }
  }
  return $found
}

# Wait until a process has exited, up to a limit. Returns $true when it is gone.
function Wait-ProcessGone {
  param([Parameter(Mandatory)][int]$Id, [int]$Seconds = 5)

  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    if (-not (Test-ProcessAlive -Id $Id)) { return $true }
    Start-Sleep -Milliseconds 200
  }
  return -not (Test-ProcessAlive -Id $Id)
}


# --- Graceful stop -----------------------------------------------------------
#
# On Windows a background console process cannot be asked to exit politely by
# signal: `taskkill` without /F refuses ("can only be terminated forcefully"),
# and `process.kill(pid, 'SIGTERM')` maps to TerminateProcess, which the target
# never sees. The one mechanism that does work is the console itself: attach to
# the child's console and raise CTRL_C_EVENT, which Windows delivers to the
# process group as a real Ctrl-C. Node then runs its SIGINT handler - the bot
# flushes its pipeline, the dashboard closes the pool - instead of being cut
# down mid-write. That call is made by scripts/_ctrlc.ps1 (see below).

# Ask one process to stop, gracefully when the platform allows it. Returns $true
# when the process is gone within the wait window.
function Stop-ProcessGracefully {
  param(
    [Parameter(Mandatory)][int]$Id,
    [int]$WaitSeconds = 10
  )

  if (-not (Test-ProcessAlive -Id $Id)) { return $true }

  if ($env:OS -eq "Windows_NT") {
    try {
      # The console dance runs in a throwaway child (scripts/_ctrlc.ps1): it has
      # to detach its own console to attach to the target's, which would blind
      # this process's output if it were done inline.
      $helper = Join-Path $script:AlAiScriptsRoot "_ctrlc.ps1"
      & powershell -NoProfile -ExecutionPolicy Bypass -File $helper $Id | Out-Null
    } catch {
      # Fall through to the force path.
    }
  } else {
    try { & kill -INT $Id } catch { }
  }

  $deadline = (Get-Date).AddSeconds($WaitSeconds)
  while ((Get-Date) -lt $deadline) {
    if (-not (Test-ProcessAlive -Id $Id)) { return $true }
    Start-Sleep -Milliseconds 200
  }
  return $false
}

# Force-remove a process and its children. The last resort after the graceful
# window, and the only path a stale, non-Node pid should ever need.
function Stop-ProcessTree {
  param([Parameter(Mandatory)][int]$Id)

  if ($env:OS -eq "Windows_NT") {
    # `taskkill` writes failures to stderr. Merging that into the pipeline (the
    # earlier `2>&1 | Out-Null`) turns it into a NativeCommandError, and a caller
    # running under $ErrorActionPreference = "Stop" aborts before it can check
    # the exit code or fall back. Let cmd discard the text at the source: the
    # exit status still lands in $LASTEXITCODE.
    & cmd /c "taskkill /PID $Id /T /F >nul 2>&1"
  } else {
    try { & kill -9 $Id } catch { }
  }
}


# --- The bot's instance lock ------------------------------------------------
#
# The bot writes `.al-ai-bot.lock` before it logs in and refuses to boot while a
# live owner holds it (apps/bot/src/runtime/supervisor.ts). That file — not the
# adapter port — is the authoritative answer to "is the bot running?".
#
# The port was the old answer, and it was the wrong one: a bot can be alive and
# connected to Discord while its adapter failed to bind, and a bot launched from
# `apps/bot` by hand carries no absolute path in its command line, so
# `Find-AlAiProcesses` cannot see it either. Both cases read as "bot down" to
# the bootstrapper, which then started a second copy — and a second copy is
# exactly what the lock exists to prevent.
#
# The record is `{ pid, execPath, startedAt }`. Validating it here mirrors
# `isLiveOwner` on the TypeScript side, including the pid-recycling defence: a
# number the OS handed out again belongs to a process that started *after* the
# lock was written, so its start time rejects it.

function Get-BotLockPath {
  param(
    [Parameter(Mandatory)][string]$RepoRoot,
    [hashtable]$Values
  )

  # Same rule as `resolveLockPath`: a bare name means "at the repository root",
  # and only an absolute value names its own place. Reading a relative value as
  # cwd-relative is what once produced two lock files and two live bots.
  $configured = ""
  if ($Values -and $Values.ContainsKey("BOT_LOCK_FILE")) { $configured = ([string]$Values["BOT_LOCK_FILE"]).Trim() }
  if (-not $configured) { return (Join-Path $RepoRoot ".al-ai-bot.lock") }
  if ([System.IO.Path]::IsPathRooted($configured)) { return $configured }
  return (Join-Path $RepoRoot $configured)
}

# The pid of a bot that is genuinely running right now, or $null.
function Get-BotLockOwner {
  param([Parameter(Mandatory)][string]$Path)

  if (-not (Test-Path -LiteralPath $Path)) { return $null }

  $record = $null
  try { $record = (Get-Content -LiteralPath $Path -Raw).Trim() | ConvertFrom-Json } catch { return $null }
  if (-not $record) { return $null }

  $processId = 0
  if (-not [int]::TryParse([string]$record.pid, [ref]$processId) -or $processId -le 0) { return $null }
  if (-not (Test-ProcessAlive -Id $processId)) { return $null }

  $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
  if (-not $process) { return $null }

  # A recycled pid now belongs to something else. Only a Node process can be the
  # bot; anything else holding the number is a stale lock and must be reclaimed.
  $image = $process.ProcessName.ToLowerInvariant() -replace '\.exe$', ''
  if ($image -ne "node" -and $image -ne "nodejs") { return $null }

  # And a Node process that started after the lock was written cannot be its
  # author either. An unreadable start time is not evidence of recycling, so the
  # owner is trusted then — refusing wrongly is a lockout.
  $recorded = $null
  try {
    $recorded = if ($record.startedAt -is [datetime]) {
      $record.startedAt.ToUniversalTime()
    } else {
      [datetime]::Parse([string]$record.startedAt, [System.Globalization.CultureInfo]::InvariantCulture).ToUniversalTime()
    }
  } catch { $recorded = $null }

  if ($recorded) {
    $liveStart = $null
    try { $liveStart = $process.StartTime.ToUniversalTime() } catch { $liveStart = $null }
    if ($liveStart -and $liveStart -gt $recorded.AddSeconds(2)) { return $null }
  }

  return $processId
}
