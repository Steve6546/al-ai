# AL AI - the watchdog that keeps the stack up unattended.
#
#   powershell -File scripts/watchdog.ps1                  run the probe loop
#   powershell -File scripts/watchdog.ps1 -Action register     logon task + start now
#   powershell -File scripts/watchdog.ps1 -Action unregister   remove task + stop loop
#
# Why a loop and not dev.ps1's supervise mode: supervise only *reports* a service
# that exited, and shuts the rest down when all of them are gone. Nothing in the
# bootstrapper restarts a fallen service, which is exactly how a dead dashboard
# became a public ERR_NGROK_3200 with nobody at the keyboard.
#
# Contract:
#   * probes the database port, the dashboard health route and the bot adapter;
#     two consecutive failed rounds call `dev.ps1 -Action start -SavedMode
#     -Detach`, which adopts whatever still lives and starts only what is missing;
#   * -SavedMode leaves AL_AI_REMOTE_ACCESS unset so the dashboard boots with the
#     operator's saved reach mode from instance_settings. A watchdog that forced
#     -Tunnel (or the plain default `off`) would override that choice on every
#     unattended boot — the lock-out trap the bootstrapper's header warns about;
#   * a deliberate `npm run dev:stop` writes .al-ai/watchdog.pause, and the loop
#     idles while that file exists. A stop is a decision, not a fall; the pause
#     survives reboots, so a machine restarted after a deliberate stop stays down;
#   * the tunnel is NOT probed here. The dashboard owns the ngrok agent and
#     re-mints it after failed reachability probes (server/network.ts); probing
#     the public edge from this loop would judge one ngrok edge's weather as a
#     stack failure;
#   * one loop at a time, by pid file. The logon task and a manual run therefore
#     cannot stack two supervisors on the same ports.
[CmdletBinding()]
param(
  [ValidateSet("run", "register", "unregister")]
  [string]$Action = "run",
  [int]$IntervalSeconds = 20,
  [int]$FailuresBeforeRestart = 2
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "common.ps1")

$repoRoot = Get-RepoRoot
$runDir = Join-Path $repoRoot ".al-ai"
$logDir = Join-Path $runDir "logs"
$pidPath = Join-Path $runDir "watchdog.pid"
$pausePath = Join-Path $runDir "watchdog.pause"
$logPath = Join-Path $logDir "watchdog.log"
$taskName = "AL AI Watchdog"

$dotenv = Import-DotEnv -Path (Join-Path $repoRoot ".env")
$dashboardPort = if ($dotenv.ContainsKey("PORT") -and $dotenv["PORT"]) { [int]$dotenv["PORT"] } else { 3000 }
$botAdapterPort = 3400
$postgresPort = Get-PostgresPort -Values $dotenv
# The bot's own lock. `/ping` is the honest liveness probe while the adapter is
# enabled, but a deployment with the adapter switched off is healthy without it,
# and reading the port as the only signal made this loop restart a running bot
# every other round - each attempt a process the operator sees in the task list.
$botLockPath = Get-BotLockPath -RepoRoot $repoRoot -Values $dotenv

function Write-WatchdogLog {
  param([string]$Message)
  if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
  $line = "{0} {1}" -f (Get-Date).ToString("yyyy-MM-dd HH:mm:ss"), $Message
  Add-Content -LiteralPath $logPath -Value $line -Encoding utf8
  Write-Host $line
}

function Test-TcpPort {
  param([int]$Port)
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $async = $client.BeginConnect("127.0.0.1", $Port, $null, $null)
    if (-not $async.AsyncWaitHandle.WaitOne(3000)) { return $false }
    $client.EndConnect($async)
    return $true
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

function Test-HttpOk {
  param([string]$Url)
  try {
    $response = Invoke-WebRequest -Uri $Url -TimeoutSec 5 -UseBasicParsing
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

function Get-LoopPid {
  if (-not (Test-Path -LiteralPath $pidPath)) { return $null }
  $raw = (Get-Content -LiteralPath $pidPath -Raw).Trim()
  $parsed = 0
  if (-not [int]::TryParse($raw, [ref]$parsed)) { return $null }
  if (Test-ProcessAlive -Id $parsed) { return $parsed }
  return $null
}

function Invoke-Register {
  $existing = Get-LoopPid
  $argument = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -Action run' -f (Join-Path $PSScriptRoot "watchdog.ps1")
  $taskAction = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $argument
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger $trigger -Settings $settings `
    -Description "Restarts the AL AI stack (database, dashboard, bot) when it falls; honours a deliberate dev:stop." -Force | Out-Null
  Write-WatchdogLog "registered logon task '$taskName'"
  if (-not $existing) {
    Start-Process -FilePath "powershell.exe" -ArgumentList $argument -WindowStyle Hidden | Out-Null
    Write-WatchdogLog "probe loop started now (the task starts it again at logon)"
  }
}

function Invoke-Unregister {
  if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-WatchdogLog "removed logon task '$taskName'"
  }
  $loop = Get-LoopPid
  if ($loop) {
    Stop-Process -Id $loop -Force
    Write-WatchdogLog "stopped probe loop pid $loop"
  }
  if (Test-Path -LiteralPath $pidPath) { Remove-Item -LiteralPath $pidPath -Force }
}

function Invoke-Run {
  $existing = Get-LoopPid
  if ($existing -and $existing -ne $PID) {
    Write-Host "watchdog already running (pid $existing); this instance exits."
    return
  }
  if (-not (Test-Path -LiteralPath $runDir)) { New-Item -ItemType Directory -Path $runDir -Force | Out-Null }
  Set-Content -LiteralPath $pidPath -Value $PID -Encoding utf8
  Write-WatchdogLog "probe loop up (pid $PID, every ${IntervalSeconds}s, restart after $FailuresBeforeRestart failed rounds)"

  $failures = 0
  $firstRound = $true
  $idled = $false
  try {
    while ($true) {
      if (Test-Path -LiteralPath $pausePath) {
        if (-not $idled) { Write-WatchdogLog "paused: a deliberate dev:stop is in force"; $idled = $true }
        Start-Sleep -Seconds $IntervalSeconds
        continue
      }
      $idled = $false

      $dbUp = Test-TcpPort -Port $postgresPort
      $dashboardUp = Test-HttpOk -Url "http://127.0.0.1:$dashboardPort/api/health"
      $botUp = Test-HttpOk -Url "http://127.0.0.1:$botAdapterPort/ping"
      # A bot that owns its lock is running. The port is only its control surface,
      # and that surface is optional by configuration.
      if (-not $botUp) { $botUp = [bool](Get-BotLockOwner -Path $botLockPath) }
      $down = @()
      if (-not $dbUp) { $down += "database" }
      if (-not $dashboardUp) { $down += "dashboard" }
      if (-not $botUp) { $down += "bot" }

      if ($down.Count -eq 0) {
        $failures = 0
      } else {
        $failures++
        Write-WatchdogLog ("down: {0} (failed round {1}/{2})" -f ($down -join ", "), $failures, $FailuresBeforeRestart)
        # A cold boot finds everything down at once; waiting two rounds to notice
        # would leave the logon task's first minute silent for no reason.
        $coldBoot = $firstRound -and $down.Count -eq 3
        if ($failures -ge $FailuresBeforeRestart -or $coldBoot) {
          Write-WatchdogLog ("restarting missing services via dev.ps1 -SavedMode -Detach ({0})" -f ($down -join ", "))
          & (Join-Path $PSScriptRoot "dev.ps1") -Action start -SavedMode -Detach
          $failures = 0
          Start-Sleep -Seconds 10
          if ($coldBoot) {
            # The standing request: after a machine restart, say whether the
            # tunnel actually answers. Evidence only — a bad edge here never
            # triggers a restart, because the dashboard owns tunnel healing.
            $domain = if ($dotenv.ContainsKey("NGROK_DOMAIN")) { $dotenv["NGROK_DOMAIN"] } else { "" }
            if ($domain) {
              $ok = Test-HttpOk -Url "https://$domain/api/health"
              Write-WatchdogLog ("post-boot tunnel probe: https://$domain/api/health -> {0}" -f $(if ($ok) { "reachable" } else { "NOT reachable yet (ngrok retry ladder owns it)" }))
            } else {
              Write-WatchdogLog "post-boot tunnel probe skipped: no NGROK_DOMAIN in .env (random tunnel URL)"
            }
          }
        }
      }
      $firstRound = $false
      Start-Sleep -Seconds $IntervalSeconds
    }
  } finally {
    $owner = Get-LoopPid
    if ($owner -eq $PID) { Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue }
  }
}

switch ($Action) {
  "run" { Invoke-Run }
  "register" { Invoke-Register }
  "unregister" { Invoke-Unregister }
}