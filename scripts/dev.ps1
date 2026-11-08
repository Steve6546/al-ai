# AL AI - the one command that brings the local stack up.
#
#   npm run dev                 start database + dashboard + bot, then supervise
#   npm run dev -- -Tunnel      the same, with the dashboard's ngrok tunnel on
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
#   * the ngrok tunnel is owned by the dashboard, not by this script. It is
#     deliberately left up across a restart so a registered OAuth callback
#     survives; end it from the network screen's mode switch, or stop the whole
#     stack with `npm run dev:stop`.
[CmdletBinding()]
param(
  [ValidateSet("start", "stop", "restart", "status")]
  [string]$Action = "start",
  # Bring the dashboard's ngrok tunnel up for this run. Off by default: ordinary
  # local work does not need a public URL, and the saved mode is honoured when
  # this flag is absent.
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
    [Parameter(Mandatory)][string]$ErrLog,
    # Heap ceiling for this service, in MB. A runaway heap then stops at a known
    # number instead of taking the machine's memory with it — the difference
    # between a restart and a frozen desktop.
    [int]$HeapMb = 0
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
  # `NODE_OPTIONS` rather than an argv flag: the entry runs through `tsx`, so a
  # flag placed here would reach tsx, not the Node process that owns the heap.
  $previousOptions = $env:NODE_OPTIONS
  if ($HeapMb -gt 0) {
    $env:NODE_OPTIONS = ("--max-old-space-size=$HeapMb " + $previousOptions).Trim()
  }
  try {
    Start-Process -FilePath $env:ComSpec -ArgumentList ('/c ' + $inner) `
      -WorkingDirectory $WorkingDirectory -WindowStyle Hidden | Out-Null
  } finally {
    $env:NODE_OPTIONS = $previousOptions
  }
}

# Whom to name as "the dashboard" / "the bot": the process holding the port,
# falling back to a repository-owned node process running that entry point.
#
# A port owner is adopted only when its command line names this repository and
# the service's entry point. A foreign process that happens to hold the port
# (another checkout's service, a developer's scratch server) is never adopted:
# `start` must refuse rather than bless it into the state file, and `stop` must
# leave it alone. Ownership by port alone is how `dev:stop` once killed a
# process this script never started. When the command line cannot be read at
# all (CIM unavailable), the process is treated as foreign: for a *kill* path
# the safe direction is to leave what cannot be identified alone.
$script:ForeignPortOwner = $null

function Test-AlAiServiceProcess {
  param([int]$Id, [string]$EntrySuffix)

  try {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$Id" -ErrorAction Stop
  } catch {
    return $false
  }
  if (-not $proc -or -not $proc.CommandLine) { return $false }
  return $proc.CommandLine.Contains($repoRoot) -and $proc.CommandLine.Contains($EntrySuffix)
}

function Get-ServiceOwnerPid {
  param([int]$Port, [string]$EntrySuffix)

  $script:ForeignPortOwner = $null
  $owner = Get-PortOwnerPid -Port $Port
  if ($owner) {
    if (Test-AlAiServiceProcess -Id $owner -EntrySuffix $EntrySuffix) { return $owner }
    $script:ForeignPortOwner = $owner
    return $null
  }
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
    if ($owner -and (Test-AlAiServiceProcess -Id $owner -EntrySuffix "server/index.ts")) { [void]$found.Add($owner) }
    elseif ($owner -and (Test-AlAiServiceProcess -Id $owner -EntrySuffix "src/index.ts")) { [void]$found.Add($owner) }
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
    } elseif ($script:ForeignPortOwner) {
      throw ("port $dashboardPort is held by pid $($script:ForeignPortOwner), which is not an AL AI dashboard " +
        "- refusing to start over it and refusing to manage that process. Free the port or stop the other service first.")
    } else {
      Start-ManagedService -Entry "server/index.ts" -WorkingDirectory $dashboardDir `
        -OutLog $dashboardLog.out -ErrLog $dashboardLog.err -HeapMb 512
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
    } elseif ($script:ForeignPortOwner) {
      Write-Host "port $botAdapterPort is held by pid $($script:ForeignPortOwner), which is not an AL AI bot - the bot was NOT started."
    } else {
      # The bot caches Discord members and roles for every guild it serves, so it
      # legitimately needs more room than the dashboard; the ceiling is still a
      # ceiling, and it is below the 4 GB V8 would otherwise claim on 64-bit.
      Start-ManagedService -Entry "src/index.ts" -WorkingDirectory $botDir `
        -OutLog $botLog.out -ErrLog $botLog.err -HeapMb 2048
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
  # pid remembered from the last start. The port owner and the remembered pid
  # are adopted only when the process identifies itself as this repository's
  # service — a foreign process squatting the port, or a pid a stale state file
  # remembered for someone else, is never killed. The command-line pattern path
  # is identity-checked by construction (Find-AlAiProcesses).
  foreach ($servicePort in @($dashboardPort, $botAdapterPort)) {
    $owner = Get-PortOwnerPid -Port $servicePort
    if (-not $owner) { continue }
    if ((Test-AlAiServiceProcess -Id $owner -EntrySuffix "server/index.ts") -or
        (Test-AlAiServiceProcess -Id $owner -EntrySuffix "src/index.ts")) {
      [void]$targets.Add($owner)
    }
  }
  foreach ($process in Find-AlAiProcesses -RepoRoot $repoRoot) {
    if ($process.CommandLine -like "*server/index.ts*" -or $process.CommandLine -like "*src/index.ts*") {
      [void]$targets.Add($process.Id)
    }
  }
  foreach ($name in @("dashboardPid", "botPid")) {
    $candidate = Get-StatePid -State $state -Name $name
    if (-not ($candidate -and (Test-ProcessAlive -Id $candidate))) { continue }
    $suffix = if ($name -eq "dashboardPid") { "server/index.ts" } else { "src/index.ts" }
    if (Test-AlAiServiceProcess -Id $candidate -EntrySuffix $suffix) { [void]$targets.Add($candidate) }
  }

  if ($targets.Count -eq 0) {
    Write-Host "No AL AI services are running."
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

  if (Test-Path -LiteralPath $statePath) { Remove-Item -LiteralPath $statePath -Force }
}

function Invoke-Status {
  $target = Get-PostgresConnection -Values $dotenv
  $probe = Test-PostgresReady -Target $target -PgBin (Get-PostgresBinDirectory) -TimeoutSeconds 3
  Write-Host ("database:  " + $(if ($probe.Ready) { "up ($($probe.Method))" } else { "down" }) + " - $($target.Host):$($target.Port)")

  $dashboardPid = Get-ServiceOwnerPid -Port $dashboardPort -EntrySuffix "server/index.ts"
  $dashboardLine = if ($dashboardPid) { "up (pid $dashboardPid)" }
    elseif ($script:ForeignPortOwner) { "PORT HELD BY pid $($script:ForeignPortOwner) - not an AL AI process" }
    else { "down" }
  Write-Host ("dashboard: " + $dashboardLine + " - http://127.0.0.1:$dashboardPort")

  $botPid = Get-ServiceOwnerPid -Port $botAdapterPort -EntrySuffix "src/index.ts"
  $botLine = if ($botPid) { "up (pid $botPid)" }
    elseif ($script:ForeignPortOwner) { "PORT HELD BY pid $($script:ForeignPortOwner) - not an AL AI process" }
    else { "down" }
  Write-Host ("bot:       " + $botLine + " - adapter http://127.0.0.1:$botAdapterPort")

  # The dashboard owns the ngrok process; this reports the agent forwarding the
  # dashboard port and flags the one state that breaks a static domain: two
  # agents on the same endpoint.
  try {
    $ngrok = @(Get-CimInstance Win32_Process -Filter "Name='ngrok.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -and [regex]::IsMatch([string]$_.CommandLine, "http\s+$dashboardPort\b") })
  } catch {
    $ngrok = @()
  }
  $tunnelLine = if ($ngrok.Count -eq 0) { "off" } else { "up (pid $($ngrok[0].ProcessId), ngrok)" }
  if ($ngrok.Count -gt 1) { $tunnelLine += " - WARNING: $($ngrok.Count) agents on port $dashboardPort" }
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
