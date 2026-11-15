# AL AI - Windows Firewall rule for the dashboard port.
#
#   powershell -File scripts/firewall.ps1 -Action status -Port 3000
#   powershell -File scripts/firewall.ps1 -Action ensure -Port 3000
#
# `status` is read-only and needs no elevation. `ensure` creates or repairs the
# inbound rule and DOES need an elevated shell; when it is not elevated it
# prints a JSON object with `needsAdmin: true` and exits 2, so the caller can
# offer a one-click UAC prompt instead of pretending the port is open.
#
# The profile is `Any` on purpose. Windows classifies most home Wi-Fi networks
# as **Public** (this machine's active Wi-Fi is Public), and the old rule only
# covered Private,Domain - so it was created and still did not admit a phone on
# the same router. The dashboard keeps its own Host gate and session auth; this
# rule only stops Windows from dropping the packet before the app sees it.
param(
  [ValidateSet('status', 'ensure')]
  [string]$Action = 'status',
  [int]$Port = 3000
)

$ErrorActionPreference = 'Stop'
$ruleName = "AL AI Dashboard (TCP $Port)"

function Test-Elevated {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  return ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-MatchingRule {
  foreach ($rule in @(Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue)) {
    $portFilter = $rule | Get-NetFirewallPortFilter
    if ($portFilter.Protocol -ne 'TCP') { continue }
    if ("$($portFilter.LocalPort)" -ne "$Port") { continue }
    return $rule
  }
  return $null
}

function Get-Status {
  $rule = Get-MatchingRule
  if (-not $rule) {
    return [pscustomobject]@{
      status    = 'missing'
      needsAdmin = $true
      ruleName  = $ruleName
      port      = $Port
      profiles  = @()
      detail    = 'no inbound rule for this port'
    }
  }
  $profiles = @("$($rule.Profile)" -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  $publicOk = $profiles -contains 'Any' -or $profiles -contains 'Public'
  $ok = ($rule.Enabled -eq 'True') -and ($rule.Action -eq 'Allow') -and ($rule.Direction -eq 'Inbound') -and $publicOk
  return [pscustomobject]@{
    status    = if ($ok) { 'allowed' } else { 'disabled' }
    needsAdmin = -not $ok
    ruleName  = $ruleName
    port      = $Port
    profiles  = $profiles
    detail    = if ($ok) { 'inbound TCP allowed' } else { 'rule exists but is disabled, blocking, or excludes the Public profile' }
  }
}

try {
  if ($Action -eq 'status') {
    (Get-Status) | ConvertTo-Json -Compress
    exit 0
  }

  if (-not (Test-Elevated)) {
    [pscustomobject]@{
      status     = 'missing'
      needsAdmin = $true
      ruleName   = $ruleName
      port       = $Port
      profiles   = @()
      detail     = 'NEEDS_ADMIN: run this script from an elevated shell, or use the dashboard button'
    } | ConvertTo-Json -Compress
    exit 2
  }

  $existing = Get-MatchingRule
  if ($existing) {
    # Repair in place: a rule that exists but is disabled, blocking, or scoped
    # away from Public is the exact failure this script was written for.
    Set-NetFirewallRule -DisplayName $existing.DisplayName -Enabled True -Action Allow -Direction Inbound -Profile Any | Out-Null
  } else {
    New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Protocol TCP `
      -LocalPort $Port -Action Allow -Profile Any -Description 'AL AI dashboard (LAN reach)' | Out-Null
  }

  (Get-Status) | ConvertTo-Json -Compress
  exit 0
} catch {
  [pscustomobject]@{
    status     = 'unknown'
    needsAdmin = $true
    ruleName   = $ruleName
    port       = $Port
    profiles   = @()
    detail     = "ERROR: $($_.Exception.Message)"
  } | ConvertTo-Json -Compress
  exit 1
}
