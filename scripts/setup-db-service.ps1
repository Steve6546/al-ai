# AL AI - register the project's PostgreSQL data directory as a Windows service.
#
# This is the "start automatically with the machine" option. It is optional: the
# bootstrapper (scripts/dev.ps1) already starts the database on demand without
# it. Register the service once, and every later `npm run dev` finds the port
# already open and skips its own start.
#
# Registering a service requires an elevated (Administrator) shell.
#
#   usage:  powershell -File scripts/setup-db-service.ps1 -Action install
#           powershell -File scripts/setup-db-service.ps1 -Action uninstall
[CmdletBinding()]
param(
  [ValidateSet("install", "uninstall")]
  [string]$Action = "install",
  [string]$ServiceName = "al-ai-postgres"
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "common.ps1")

$repoRoot = Get-RepoRoot
$dotenv = Import-DotEnv -Path (Join-Path $repoRoot ".env")
$port = Get-PostgresPort -Values $dotenv
$pgData = if ($env:PGDATA_DIR) { $env:PGDATA_DIR } else { Join-Path $env:USERPROFILE ".al-ai\pgdata" }
$pgBin = Get-PostgresBinDirectory
$pgCtlExe = Join-Path $pgBin "pg_ctl.exe"

# The address the service will serve on; used for the post-registration probe.
$serverTarget = [pscustomobject]@{ Host = "127.0.0.1"; Port = $port; User = $null; Database = $null }

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
  throw "Registering a Windows service needs an elevated shell. Re-run this script from 'Run as administrator'."
}
if (-not (Test-Path -LiteralPath $pgCtlExe)) {
  throw "pg_ctl.exe was not found at '$pgCtlExe'. Set PG_BIN to your PostgreSQL bin directory."
}

switch ($Action) {
  "install" {
    if (-not (Test-Path -LiteralPath $pgData)) {
      throw "The data directory '$pgData' does not exist. Set PGDATA_DIR, or create the cluster first."
    }
    # A detached instance started by the bootstrapper owns the data directory;
    # it must stop before the service can take it.
    if (Test-TcpPort -Port $port) {
      Write-Host "Stopping the running instance on $port so the service can take over..."
      & $pgCtlExe -D $pgData stop -m fast | Out-Null
    }
    if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
      Write-Host "Removing the existing '$ServiceName' registration first..."
      & $pgCtlExe unregister -N $ServiceName | Out-Null
    }
    & $pgCtlExe register -N $ServiceName -D $pgData -S auto -o "-p $port -c listen_addresses=127.0.0.1"
    Start-Service -Name $ServiceName
    if (-not (Wait-PostgresReady -Target $serverTarget -PgBin $pgBin -TimeoutSeconds 30).Ready) {
      throw "The '$ServiceName' service started but is not accepting connections on $port."
    }
    Write-Host "Registered and started '$ServiceName' on $port (auto-start)."
  }
  "uninstall" {
    if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
      Stop-Service -Name $ServiceName -ErrorAction SilentlyContinue
      & $pgCtlExe unregister -N $ServiceName | Out-Null
      Write-Host "Unregistered '$ServiceName'. The data directory is untouched."
    } else {
      Write-Host "No '$ServiceName' service is registered."
    }
  }
}
