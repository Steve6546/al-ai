# AL AI - the one command that brings the local stack up.
#
#   npm run dev                 start database + dashboard + bot, then supervise
#   npm run dev -- -Tunnel      the same, but bring the Cloudflare tunnel up
#   npm run dev -- -Detach      start and return to the prompt (fire and forget)
#   npm run dev -- -NoBot       dashboard only
#   npm run dev:stop            graceful stop
#   npm run dev:status          what is up, on which ports, and is it healthy
#   npm run dev:restart         stop, then start
#
# What it guarantees that a row of hand-typed commands did not:
#   * the database is started on demand (scripts/postgres.ps1) and its port is
#     waited on before either service is launched, so nothing races a cold DB;
#   * every value comes from .env - the password is never read or printed;
#   * both services write to files under .al-ai/logs, so the console stays quiet
#     and readable;
#   * in the default (foreground) mode a Ctrl+C here stops *everything*: the
#     trap below turns the interrupt into a graceful stop of each service, so the
#     bot flushes its pipeline and releases its lock while the dashboard closes
#     its pool - with a forced kill only as the last resort. Nothing is orphaned
#     because every child is named (by port owner, command line, and remembered
#     pid) rather than assumed to have died with us;
#   * a quick tunnel *this run started* is ended too. The dashboard deliberately
#     leaves its tunnel up across a restart, which is what keeps a named tunnel's
#     OAuth callback alive - but for a dev quick tunnel that is pure leftover.
#     Ownership is decided by birth time, not by the port: a cloudflared serving
#     the same port that predates this run belongs to someone else and is left
#     alone, and a named (token) tunnel never matches the quick-tunnel pattern.
[CmdletBinding()]
param(
  [ValidateSet("start", "stop", "restart", "status")]
  [string]$Action = "start",
  # Bring the Cloudflare tunnel up for this run. Off by default: a quick tunnel
  # mints a new public URL every boot, which is neither wanted nor fast for
  # ordinary local work.
  [switch]$Tunnel,
  # Start and return instead of supervising. A detached stack is stopped later
  # with `npm run dev:stop`.
  [switch]$Detach,
  [switch]$NoDb,
  [switch]$NoDashboard,
  [switch]$NoBot,
  [int]$WaitSeconds = 60
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "common.ps1")

$repoRoot = Get-RepoRoot
# Runtime state and logs live under the repository's own .al-ai/ - distinct from
# the database cluster at %USERPROFILE%\.al-ai\pgdata, which is deliberately
# outside the repository.
$runDir = Join-Path $repoRoot ".al-ai"
$logDir = Join-Path $runDir "logs"
$statePath = Join-Path $runDir "dev.json"
$dashboardDir = Join-Path $repoRoot "apps\dashboard"
$botDir = Join-Path $repoRoot "apps\bot"
$dashboardLog = @{ out = Join-Path $logDir "dashboard.out.log"; err = Join-Path $logDir "dashboard.err.log" }
$botLog = @{ out = Join-Path $logDir "bot.out.log"; err = Join-Path $logDir "bot.err.log" }

# Everything the children need, from the single source of truth. Real process
# values (e.g. an override on the command line) are left in place.
$dotenv = Import-DotEnv -Path (Join-Path $repoRoot ".env")
Set-ProcessEnvFromDotEnv -Values $dotenv

$dashboardPort = if ($dotenv.ContainsKey("PORT") -and $dotenv["PORT"]) { [int]$dotenv["PORT"] } else { 3000 }
$botAdapterPort = 3400
$postgresPort = Get-PostgresPort -Values $dotenv

# The reach mode for this run, forced one way or the other. It is not saved, so
# a `dev.ps1 start` without -Tunnel never rewrites the operator's dashboard
# choice; it only decides what this process does.
$env:AL_AI_REMOTE_ACCESS = if ($Tunnel) { "on" } else { "off" }

function Ensure-RunDirectory {
  if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
}

function Read-State {
  if (-not (Test-Path -LiteralPath $statePath)) { return $null }
  try { return (Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json) } catch { return $null }
}

function Write-State {
  param([hashtable]$Values)
  Ensure-RunDirectory
  ($Values | ConvertTo-Json -Depth 5) | Set-Content -LiteralPath $statePath -Encoding utf8
}

function Get-StatePid {
  param($State, [string]$Name)
  if ($null -eq $State) { return $null }
  $property = $State.PSObject.Properties[$Name]
  if ($null -eq $property -or -not $property.Value) { return $null }
  return [int]$property.Value
}

function Start-ManagedService {
  param(
    [Parameter(Mandatory)][string]$Entry,
    [Parameter(Mandatory)][string]$WorkingDirectory,
    [Parameter(Mandatory)][string]$OutLog,
    [Parameter(Mandatory)][string]$ErrLog
  )

  Ensure-RunDirectory
  $node = Resolve-NodePath
  # Launched through cmd, for two reasons that both matter:
  #   * cmd /c gives the service its own hidden console, which is what makes a
  #     graceful Ctrl-C possible later (scripts/_ctrlc.ps1);
  #   * cmd, not this script, owns the redirected log handles, so the services
  #     neither inherit this script's stdout nor write over its console.
  # `node --import tsx` runs the source in a single process (no tsx wrapper to
  # orphan). The env file is named by absolute path so the process's command
  # line always carries the repository root, which is how Find-AlAiProcesses
  # recognises a stack that was started outside the bootstrapper.
  $envFile = Join-Path $repoRoot ".env"
  $inner = '""' + $node + '" --import tsx --env-file="' + $envFile + '" ' + $Entry +
    ' 1>"' + $OutLog + '" 2>"' + $ErrLog + '""'
  Start-Process -FilePath $env:ComSpec -ArgumentList ('/c ' + $inner) `
    -WorkingDirectory $WorkingDirectory -WindowStyle Hidden | Out-Null
}

# Whom to name as "the dashboard" / "the bot": the process holding the port,
# falling back to a repository-owned node process running that entry point.
function Get-ServiceOwnerPid {
  param([int]$Port, [string]$EntrySuffix)

  $owner = Get-PortOwnerPid -Port $Port
  if ($owner) { return $owner }
  $match = Find-AlAiProcesses -RepoRoot $repoRoot |
    Where-Object { $_.CommandLine -like "*$EntrySuffix*" } | Select-Object -First 1
  if ($match) { return $match.Id }
  return $null
}

# Every pid that is plausibly one of our services right now, cheapest probes
# first. Used both to stop the stack and, while supervising, to notice that a
# service has exited on its own.
function Get-LiveServicePids {
  $found = New-Object System.Collections.Generic.List[int]
  foreach ($servicePort in @($dashboardPort, $botAdapterPort)) {
    $owner = Get-PortOwnerPid -Port $servicePort
    if ($owner) { [void]$found.Add($owner) }
  }
  $state = Read-State
  foreach ($name in @("dashboardPid", "botPid")) {
    $candidate = Get-StatePid -State $state -Name $name
    if ($candidate -and (Test-ProcessAlive -Id $candidate)) { [void]$found.Add($candidate) }
  }
  return @($found | Sort-Object -Unique)
}

function Invoke-Start {
  # Stamped before anything launches, and written immediately: the dashboard
  # starts its tunnel during boot, so a start time recorded at the *end* of this
  # function would be later than the tunnel's birth and the tunnel would look
  # like someone else's. Writing state first also lets a stop during startup
  # still know which tunnel this run owns.
  $runStart = (Get-Date).ToString("o")
  Write-State -Values @{
    dashboardPid = $null
    botPid       = $null
    tunnel       = [bool]$Tunnel
    startedAt    = $runStart
  }

  if (-not $NoDb) {
    & (Join-Path $PSScriptRoot "postgres.ps1") -Action start | Out-Null
  }

  $dashboardPid = $null
  $botPid = $null

  if (-not $NoDashboard) {
    $dashboardPid = Get-ServiceOwnerPid -Port $dashboardPort -EntrySuffix "server/index.ts"
    if ($dashboardPid) {
      Write-Host "dashboard already running (pid $dashboardPid)"
    } else {
      Start-ManagedService -Entry "server/index.ts" -WorkingDirectory $dashboardDir `
        -OutLog $dashboardLog.out -ErrLog $dashboardLog.err
      if (-not (Wait-TcpPort -Port $dashboardPort -TimeoutSeconds $WaitSeconds)) {
        throw "The dashboard did not answer on port $dashboardPort within $WaitSeconds s - see $($dashboardLog.out)."
      }
      $dashboardPid = Get-ServiceOwnerPid -Port $dashboardPort -EntrySuffix "server/index.ts"
      Write-Host "dashboard: http://127.0.0.1:$dashboardPort  (pid $dashboardPid, log $($dashboardLog.out))"
    }
  }

  if (-not $NoBot) {
    $botPid = Get-ServiceOwnerPid -Port $botAdapterPort -EntrySuffix "src/index.ts"
    if ($botPid) {
      Write-Host "bot already running (pid $botPid)"
    } else {
      Start-ManagedService -Entry "src/index.ts" -WorkingDirectory $botDir `
        -OutLog $botLog.out -ErrLog $botLog.err
      if (-not (Wait-TcpPort -Port $botAdapterPort -TimeoutSeconds $WaitSeconds)) {
        Write-Host "bot is not listening on $botAdapterPort yet - see $($botLog.out)."
        $botPid = Get-ServiceOwnerPid -Port $botAdapterPort -EntrySuffix "src/index.ts"
      } else {
        $botPid = Get-ServiceOwnerPid -Port $botAdapterPort -EntrySuffix "src/index.ts"
        Write-Host "bot: adapter http://127.0.0.1:$botAdapterPort  (pid $botPid, log $($botLog.out))"
      }
    }
  }

  Write-State -Values @{
    dashboardPid = $dashboardPid
    botPid       = $botPid
    tunnel       = [bool]$Tunnel
    startedAt    = $runStart
  }

  if ($Tunnel) { Write-Host "tunnel: requested (the dashboard mints the URL; it appears in $($dashboardLog.out))" }
}

function Invoke-Stop {
  $state = Read-State
  $targets = New-Object System.Collections.Generic.HashSet[int]

  # Every way we can name one of our services, most reliable first: the port
  # owner, then a repository-owned node process for the entry point, then the
  # pid remembered from the last start.
  foreach ($servicePort in @($dashboardPort, $botAdapterPort)) {
    $owner = Get-PortOwnerPid -Port $servicePort
    if ($owner) { [void]$targets.Add($owner) }
  }
  foreach ($process in Find-AlAiProcesses -RepoRoot $repoRoot) {
    if ($process.CommandLine -like "*server/index.ts*" -or $process.CommandLine -like "*src/index.ts*") {
      [void]$targets.Add($process.Id)
    }
  }
  foreach ($name in @("dashboardPid", "botPid")) {
    $candidate = Get-StatePid -State $state -Name $name
    if ($candidate -and (Test-ProcessAlive -Id $candidate)) { [void]$targets.Add($candidate) }
  }

  if ($targets.Count -eq 0) {
    Write-Host "No AL AI services are running."
    Remove-OwnedCloudflared -State $state
    if (Test-Path -LiteralPath $statePath) { Remove-Item -LiteralPath $statePath -Force }
    return
  }

  foreach ($processId in $targets) {
    if (Stop-ProcessGracefully -Id $processId -WaitSeconds 12) {
      Write-Host "stopped pid $processId (graceful)"
    } else {
      Stop-ProcessTree -Id $processId
      Write-Host "stopped pid $processId (forced)"
    }
  }

  # The dashboard's own shutdown leaves its tunnel running (see scripts/common.ps1
  # - a named tunnel must survive so the OAuth callback does). This ends the one
  # *this run* created, after the services are gone and cannot re-adopt it.
  Remove-OwnedCloudflared -State $state

  if (Test-Path -LiteralPath $statePath) { Remove-Item -LiteralPath $statePath -Force }
}

# End the quick tunnel this run created, and nothing else.
#
# The port is not ownership: another checkout can run a quick tunnel pointed at
# the same local port. The state file's `startedAt` is the evidence - a tunnel
# that was born before this run began belongs to whoever started it, and stop
# must not end it. A tunnel started while the run is active is our dashboard's
# (nothing else can own the dashboard's own port bind) and is cleaned up.
# The state file's `startedAt`, or $null when it is absent or unreadable.
function Get-RunStart {
  param($State)

  if (-not $State -or -not $State.startedAt) { return $null }
  try {
    return [datetime]::Parse(
      [string]$State.startedAt,
      [System.Globalization.CultureInfo]::InvariantCulture,
      [System.Globalization.DateTimeStyles]::RoundtripKind
    )
  } catch {
    return $null
  }
}

function Remove-OwnedCloudflared {
  param($State)

  $runStart = Get-RunStart -State $State
  if ($null -eq $runStart) {
    if (@(Find-CloudflaredForPort -Port $dashboardPort).Count -gt 0) {
      Write-Host "left any cloudflared alone: there is no run state to prove which one this stack started"
    }
    return
  }

  foreach ($tunnel in @(Find-CloudflaredForPort -Port $dashboardPort)) {
    if (-not (Test-CloudflaredOwnedByRun -Tunnel $tunnel -RunStart $runStart)) {
      Write-Host "left cloudflared pid $($tunnel.Id) alone: it predates this run"
      continue
    }

    # Re-read immediately before acting: the number must still be the same
    # cloudflared creation, not a recycled pid wearing the old command line.
    $same = @(Find-CloudflaredForPort -Port $dashboardPort | Where-Object {
      $_.Id -eq $tunnel.Id -and $_.CreationDate -eq $tunnel.CreationDate
    })
    if ($same.Count -eq 0) { continue }

    # Forced by design on Windows, not a shortcut. Measured twice: a detached
    # cloudflared has no console, and `taskkill` without /F refuses immediately
    # ("can only be terminated forcefully"). Running it anyway was worse than
    # dead code: its stderr became a NativeCommandError under
    # $ErrorActionPreference = "Stop", which aborted this function *before* the
    # forced kill. The stack reported "stopped" while its tunnel was still up.
    Stop-ProcessTree -Id $tunnel.Id
    if (Wait-ProcessGone -Id $tunnel.Id -Seconds 3) {
      Write-Host "stopped cloudflared pid $($tunnel.Id) (forced, quick tunnel for port $dashboardPort)"
    } else {
      Write-Host "WARNING: cloudflared pid $($tunnel.Id) survived the stop request"
    }
  }
}

function Invoke-Status {
  $target = Get-PostgresConnection -Values $dotenv
  $probe = Test-PostgresReady -Target $target -PgBin (Get-PostgresBinDirectory) -TimeoutSeconds 3
  Write-Host ("database:  " + $(if ($probe.Ready) { "up ($($probe.Method))" } else { "down" }) + " - $($target.Host):$($target.Port)")

  $dashboardPid = Get-ServiceOwnerPid -Port $dashboardPort -EntrySuffix "server/index.ts"
  Write-Host ("dashboard: " + $(if ($dashboardPid) { "up (pid $dashboardPid)" } else { "down" }) + " - http://127.0.0.1:$dashboardPort")

  $botPid = Get-ServiceOwnerPid -Port $botAdapterPort -EntrySuffix "src/index.ts"
  Write-Host ("bot:       " + $(if ($botPid) { "up (pid $botPid)" } else { "down" }) + " - adapter http://127.0.0.1:$botAdapterPort")

  # Report this run's tunnel, not whichever quick tunnel the machine happens to
  # have. A second checkout pointed at the same port is not this stack's status.
  $state = Read-State
  $runStart = Get-RunStart -State $state
  $tunnels = @(Find-CloudflaredForPort -Port $dashboardPort)
  $owned = @()
  if ($null -ne $runStart) {
    $owned = @($tunnels | Where-Object { Test-CloudflaredOwnedByRun -Tunnel $_ -RunStart $runStart })
  }
  $tunnelLine = if ($owned.Count) {
    "up (pid $($owned[0].Id), quick tunnel)"
  } elseif ($tunnels.Count) {
    "none (pid $($tunnels[0].Id) is a quick tunnel this run did not start)"
  } else {
    "none"
  }
  Write-Host ("tunnel:    " + $tunnelLine)

  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$dashboardPort/api/health" -TimeoutSec 5
    Write-Host ("health:    " + ($health | ConvertTo-Json -Compress))
  } catch {
    Write-Host "health:    dashboard not answering yet"
  }
}

# Supervise the stack until Ctrl+C, or until every service has exited.
#
# The Ctrl+C trap is a compiled .NET delegate, not a PowerShell scriptblock. The
# ConsoleCancelKeyPress event is raised on a thread-pool thread, and invoking a
# scriptblock there has to borrow the runspace that the main thread is holding -
# which is the very thread parked waiting for the event. A real delegate runs on
# the event thread, flips a ManualResetEvent the loop is waiting on, and cancels
# the default termination so the graceful stop below can run at all.
#
# The delegate is exposed as a static *field* on purpose. `[AlAi.Interrupt]::
# OnCancelKeyPress` evaluated from PowerShell is a PSMethod, and casting that to
# ConsoleCancelEventHandler fails ("Cannot convert ... PSMethod"); the field
# hands over a real, already-typed delegate.
function Invoke-Supervise {
  if (-not ("AlAi.Interrupt" -as [type])) {
    Add-Type -TypeDefinition @"
namespace AlAi {
  public static class Interrupt {
    public static readonly System.Threading.ManualResetEvent Requested = new System.Threading.ManualResetEvent(false);
    public static readonly System.ConsoleCancelEventHandler Handler = OnCancelKeyPress;
    public static void OnCancelKeyPress(object sender, System.ConsoleCancelEventArgs eventArgs) {
      eventArgs.Cancel = true;
      Requested.Set();
    }
  }
}
"@
  }
  $handler = [AlAi.Interrupt]::Handler
  [Console]::add_CancelKeyPress($handler)

  Write-Host ""
  Write-Host "AL AI is up. Press Ctrl+C to stop it gracefully (bot flushes, dashboard closes its pool)."
  Write-Host ""

  $seen = $null
  try {
    while (-not [AlAi.Interrupt]::Requested.WaitOne(2000)) {
      $live = @(Get-LiveServicePids)
      if ($live.Count -eq 0) {
        Write-Host "every service has exited; shutting down."
        break
      }
      if ($null -ne $seen) {
        foreach ($gone in @($seen | Where-Object { $live -notcontains $_ })) {
          Write-Host "service pid $gone exited on its own - see .al-ai/logs/"
        }
      }
      $seen = $live
    }
  } finally {
    [Console]::remove_CancelKeyPress($handler)
  }

  Write-Host ""
  Write-Host "stopping the AL AI stack..."
  Invoke-Stop
}

switch ($Action) {
  "start" {
    Invoke-Start
    if (-not $Detach) { Invoke-Supervise }
  }
  "stop" { Invoke-Stop }
  "restart" {
    Invoke-Stop
    Invoke-Start
    if (-not $Detach) { Invoke-Supervise }
  }
  "status" { Invoke-Status }
}
