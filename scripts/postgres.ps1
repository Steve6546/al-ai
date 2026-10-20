# AL AI - the project's PostgreSQL instance.
#
# One entry point for the database the stack talks to, so the bootstrapper (and
# a human) never has to remember the data directory, the port or the binary
# path. Every value comes from the repository's .env (POSTGRES_HOST_PORT or
# DATABASE_URL) - the password is never read, echoed, or needed here, and
# readiness is probed with `pg_isready` (which needs no credentials), falling
# back to a TCP socket test when that binary is absent.
#
# The data directory is intentionally outside the repository
# (...\.al-ai\pgdata) and belongs to this project alone; it is unrelated to any
# machine-wide PostgreSQL service on 5432.
#
#   usage:  powershell -File scripts/postgres.ps1 -Action start|stop|status|restart|verify
#
# `verify` is the *protocol-level* probe: it reads the target out of
# DATABASE_URL and asks `pg_isready`, which needs no credentials. PostgreSQL
# documents that this succeeds even when the password is wrong, so it answers
# "is the server accepting connections", not "can the app log in". The
# authenticated check is `npm run db:verify` (scripts/verify-db.mjs), which
# connects with the real credentials and runs one read-only query; use that to
# gate a deploy. This action stays for the fast, dependency-free liveness check
# that the bootstrapper and `dev.ps1 status` need.
#
# To make this a permanent, auto-starting Windows service instead, see
# scripts/setup-db-service.ps1.
[CmdletBinding()]
param(
  [ValidateSet("start", "stop", "status", "restart", "verify")]
  [string]$Action = "start",
  [int]$ReadyTimeoutSeconds = 30
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "common.ps1")

$repoRoot = Get-RepoRoot
$dotenv = Import-DotEnv -Path (Join-Path $repoRoot ".env")
$environment = Get-PostgresPort -Values $dotenv

$hostAddress = "127.0.0.1"
$port = $environment
$pgData = if ($env:PGDATA_DIR) { $env:PGDATA_DIR } else { Join-Path $env:USERPROFILE ".al-ai\pgdata" }
$pgBin = Get-PostgresBinDirectory
$postgresExe = Join-Path $pgBin "postgres.exe"
$pgCtlExe = Join-Path $pgBin "pg_ctl.exe"
$serviceName = "al-ai-postgres"

# The address the server itself was started on. Used for start-up readiness: it
# is what this script just launched, independent of whatever DATABASE_URL says.
$serverTarget = [pscustomobject]@{ Host = $hostAddress; Port = $port; User = $null; Database = $null }

function Get-ServiceState {
  $service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
  if ($null -eq $service) { return $null }
  return $service.Status
}

function Invoke-Status {
  $state = Get-ServiceState
  $listening = Test-TcpPort -ComputerName $hostAddress -Port $port
  if ($listening) {
    $owner = Get-PortOwnerPid -Port $port
    Write-Host "AL AI PostgreSQL: RUNNING on ${hostAddress}:$port (pid $owner)"
  } else {
    Write-Host "AL AI PostgreSQL: STOPPED (port $port is free)"
  }
  if ($null -ne $state) { Write-Host "  Windows service '$serviceName': $state" }
  Write-Host "  data directory: $pgData"
  return $listening
}

# Probe the database the application will actually reach, as written in
# DATABASE_URL, and report the verdict. The password is not printed and not
# needed: pg_isready does not authenticate.
function Invoke-Verify {
  $target = Get-PostgresConnection -Values $dotenv
  $label = "$($target.Host):$($target.Port)"
  Write-Host "AL AI PostgreSQL target (from .env): $(if ($target.User) { $target.User } else { '?' })@$label/$(if ($target.Database) { $target.Database } else { '?' })"

  $probe = Test-PostgresReady -Target $target -PgBin $pgBin -TimeoutSeconds $ReadyTimeoutSeconds
  if ($probe.Ready) {
    $owner = Get-PortOwnerPid -Port $target.Port
    Write-Host "AL AI PostgreSQL: PROTOCOL-READY ($($probe.Method) probe on $label)$(if ($owner) { " (pid $owner)" })"
    Write-Host "  This does not prove the credentials. For an authenticated check: npm run db:verify"
    $state = Get-ServiceState
    if ($null -ne $state) { Write-Host "  Windows service '$serviceName': $state" }
    return $true
  }

  Write-Host "AL AI PostgreSQL: NOT READY on $label ($($probe.Method) probe)"
  Write-Host "  Start it with:  npm run db:start"
  Write-Host "  If this is the wrong address, fix DATABASE_URL / POSTGRES_HOST_PORT in .env first."
  return $false
}

function Invoke-Start {
  if (Test-TcpPort -ComputerName $hostAddress -Port $port) {
    Write-Host "AL AI PostgreSQL is already running on $port."
    return
  }

  # A registered service owns the data directory; starting a detached process
  # against the same directory would fail on the lock file.
  $state = Get-ServiceState
  if ($null -ne $state) {
    if ($state -ne "Running") {
      Start-Service -Name $serviceName
      if (-not (Wait-PostgresReady -Target $serverTarget -PgBin $pgBin -TimeoutSeconds $ReadyTimeoutSeconds).Ready) {
        throw "The '$serviceName' service did not accept connections on $port within $ReadyTimeoutSeconds s."
      }
    }
    Write-Host "AL AI PostgreSQL started (service '$serviceName')."
    return
  }

  if (-not (Test-Path -LiteralPath $postgresExe)) {
    throw "postgres.exe was not found at '$postgresExe'. Set PG_BIN to your PostgreSQL bin directory."
  }
  if (-not (Test-Path -LiteralPath $pgData)) {
    throw "The data directory '$pgData' does not exist. Set PGDATA_DIR, or create the cluster first."
  }

  # Detached on purpose: a `pg_ctl start` forks a child that this shell's session
  # may reclaim when the command returns, leaving the server to die silently a
  # moment later. A directly-spawned, windowless postgres.exe keeps running.
  Start-Process -FilePath $postgresExe `
    -ArgumentList @("-D", $pgData, "-p", "$port", "-c", "listen_addresses=$hostAddress") `
    -WindowStyle Hidden | Out-Null

  if (-not (Wait-PostgresReady -Target $serverTarget -PgBin $pgBin -TimeoutSeconds $ReadyTimeoutSeconds).Ready) {
    throw "PostgreSQL did not become ready on $port within $ReadyTimeoutSeconds s. Check $pgData\server.log."
  }
  Write-Host "AL AI PostgreSQL started on $port (data: $pgData)."
}

function Invoke-Stop {
  $state = Get-ServiceState
  if ($null -ne $state -and $state -ne "Stopped") {
    Stop-Service -Name $serviceName
    Write-Host "AL AI PostgreSQL service stopped."
    return
  }
  if (-not (Test-TcpPort -ComputerName $hostAddress -Port $port)) {
    Write-Host "AL AI PostgreSQL is not running."
    return
  }
  if (Test-Path -LiteralPath $pgCtlExe) {
    # "fast": disconnect clients, checkpoint, exit - let the data directory be
    # consistent without waiting on every open connection.
    & $pgCtlExe -D $pgData stop -m fast | Out-Null
  }
  if (-not (Wait-TcpPort -ComputerName $hostAddress -Port $port -TimeoutSeconds 1)) {
    Write-Host "AL AI PostgreSQL stopped."
    return
  }
  $owner = Get-PortOwnerPid -Port $port
  if ($owner) { Stop-ProcessTree -Id $owner }
  Write-Host "AL AI PostgreSQL stopped (forced)."
}

switch ($Action) {
  "start" { Invoke-Start }
  "stop" { Invoke-Stop }
  "restart" { Invoke-Stop; Invoke-Start }
  "status" { Invoke-Status | Out-Null }
  "verify" { if (-not (Invoke-Verify)) { exit 1 } }
}
