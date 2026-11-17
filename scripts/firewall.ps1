# AL AI - Windows Firewall rule for the dashboard port.
#
#   powershell -File scripts/firewall.ps1 -Action status -Port 3000
#   powershell -File scripts/firewall.ps1 -Action ensure -Port 3000
#   powershell -File scripts/firewall.ps1 -Action prune  -Port 3000
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
#
# --- why this asks about the PORT, not only its own rule -------------------
#
# The first version of this script answered "missing" whenever a rule *named*
# `AL AI Dashboard (TCP <port>)` did not exist. Measured on this machine: a rule
# created by another tool (`00000000000`) already allowed inbound TCP 3000 on
# every profile, so the port was reachable while the dashboard showed
# «المنفذ 3000 محجوب». A check that reports a blocked port on an open one is
# worse than no check: it sends the operator to `netsh` to fix something that is
# not broken, and it hides the real cause (a VPN adapter, a stale tunnel).
#
# So `status` now answers the question the operator is actually asking — *can a
# packet from the LAN reach this port?* — by scanning every enabled inbound
# Allow TCP rule and testing whether its port spec covers this port. The AL AI
# rule is still preferred and still repaired; it is simply no longer the only
# evidence that counts.
#
# The technique is the one `netsh advfirewall firewall show rule` and every
# open-source wrapper around it use (match on port, protocol, direction, action,
# profile). It is implemented here with the built-in `NetSecurity` module rather
# than a third-party package: the cmdlets are Microsoft-signed, present on every
# supported Windows, and a firewall helper is not worth a supply-chain edge.
param(
  [ValidateSet('status', 'ensure', 'prune')]
  [string]$Action = 'status',
  [int]$Port = 3000
)

$ErrorActionPreference = 'Stop'
# `Remove-NetFirewallRule` draws a progress bar, which PowerShell renders to the
# host stream and which arrives as noise in the captured stdout the dashboard
# parses. Suppressing it keeps the report to one JSON line.
$ProgressPreference = 'SilentlyContinue'
$ruleName = "AL AI Dashboard (TCP $Port)"

function Test-Elevated {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  return ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# `LocalPort` is a string, `Any`, or a range such as `3000-3010`; it can also
# arrive as an array when one rule carries several ports.
function Test-PortCovers {
  param($LocalPort, [int]$Port)
  foreach ($value in @($LocalPort)) {
    $text = "$value".Trim()
    if (-not $text) { continue }
    if ($text -eq 'Any' -or $text -eq '*') { return $true }
    if ($text -match '^(\d+)\s*-\s*(\d+)$') {
      if ($Port -ge [int]$matches[1] -and $Port -le [int]$matches[2]) { return $true }
      continue
    }
    if ($text -match '^\d+$' -and [int]$text -eq $Port) { return $true }
  }
  return $false
}

function Get-RuleProfiles {
  param($Rule)
  return @("$($Rule.Profile)" -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
}

function Test-ProfileReachesLan {
  param($Rule)
  $profiles = Get-RuleProfiles -Rule $Rule
  return ($profiles -contains 'Any' -or $profiles -contains 'Public')
}

# The AL AI rule itself, matched by name *and* port: a rule of the same name on
# another port is a leftover, not this deployment's rule.
function Get-MatchingRule {
  foreach ($rule in @(Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue)) {
    $portFilter = $rule | Get-NetFirewallPortFilter -ErrorAction SilentlyContinue
    if (-not $portFilter -or $portFilter.Protocol -ne 'TCP') { continue }
    if (-not (Test-PortCovers -LocalPort $portFilter.LocalPort -Port $Port)) { continue }
    return $rule
  }
  return $null
}

# Every enabled inbound Allow TCP rule that actually admits this port to the LAN,
# whoever created it.
#
# `Program = Any` is required. Windows stores an application-scoped rule with
# `LocalPort = Any`, so a naive port test matches every game, browser and
# background service that ever asked for an inbound exception — measured here:
# 118 such rules on this machine. None of them opens port 3000 for the dashboard;
# only a rule that is *port-based* (or explicitly scoped to the serving
# executable, which cannot be known from here) is evidence.
function Get-CoveringRules {
  $covering = @()
  foreach ($rule in @(Get-NetFirewallRule -Direction Inbound -Action Allow -Enabled True -ErrorAction SilentlyContinue)) {
    $portFilter = $rule | Get-NetFirewallPortFilter -ErrorAction SilentlyContinue
    # A rule can carry no port filter at all (an ICMP or any-protocol rule).
    # `Get-NetFirewallPortFilter` raises ObjectNotFound for those, which is a
    # "not this rule" answer, not a failure.
    if (-not $portFilter -or $portFilter.Protocol -ne 'TCP') { continue }
    if (-not (Test-PortCovers -LocalPort $portFilter.LocalPort -Port $Port)) { continue }
    if (-not (Test-ProfileReachesLan -Rule $rule)) { continue }
    $application = $rule | Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue
    $program = "$($application.Program)".Trim()
    if ($program -and $program -ne 'Any' -and $program -ne '*') { continue }
    $covering += $rule
  }
  return $covering
}

function Get-Status {
  $rule = Get-MatchingRule
  $covering = @(Get-CoveringRules)
  # Always an array: an empty `if` expression becomes `$null`, and
  # `ConvertTo-Json` renders that as `{}` rather than `[]`, which the dashboard's
  # parser would then reject as a malformed `profiles` field.
  $profiles = @()
  if ($rule) { $profiles = @(Get-RuleProfiles -Rule $rule) }
  $ownOk = $false
  if ($rule) {
    $ownOk = ($rule.Enabled -eq 'True') -and ($rule.Action -eq 'Allow') -and ($rule.Direction -eq 'Inbound') -and (Test-ProfileReachesLan -Rule $rule)
  }

  if ($ownOk) {
    return [pscustomobject]@{
      status = 'allowed'; needsAdmin = $false; ruleName = $ruleName; port = $Port
      profiles = $profiles; detail = 'inbound TCP allowed by the AL AI rule'
      covering = @($covering | ForEach-Object { $_.DisplayName })
    }
  }

  # Reachable through someone else's rule is still reachable. Say so, and name
  # it, so the operator can tell an adopted port from a missing rule.
  $others = @($covering | Where-Object { -not $rule -or $_.Name -ne $rule.Name })
  if ($others.Count -gt 0) {
    return [pscustomobject]@{
      status = 'allowed'; needsAdmin = $false; ruleName = $ruleName; port = $Port
      profiles = $profiles
      detail = "inbound TCP already allowed by another rule: $($others.DisplayName -join ', ')"
      covering = @($others | ForEach-Object { $_.DisplayName })
    }
  }

  if ($rule) {
    return [pscustomobject]@{
      status = 'disabled'; needsAdmin = $true; ruleName = $ruleName; port = $Port
      profiles = $profiles
      detail = 'the AL AI rule exists but is disabled, blocking, or excludes the Public profile'
      covering = @()
    }
  }

  return [pscustomobject]@{
    status = 'missing'; needsAdmin = $true; ruleName = $ruleName; port = $Port
    profiles = @(); detail = 'no inbound rule for this port'; covering = @()
  }
}

try {
  if ($Action -eq 'status') {
    (Get-Status) | ConvertTo-Json -Compress
    exit 0
  }

  if ($Action -eq 'prune') {
    # Leftovers from an earlier port: rules carrying this name for a port that is
    # no longer served. They are dead weight in the firewall list and make
    # "which rule is ours?" ambiguous. Explicit action, never implicit.
    if (-not (Test-Elevated)) {
      [pscustomobject]@{ status = 'unknown'; needsAdmin = $true; ruleName = $ruleName; port = $Port; profiles = @(); detail = 'NEEDS_ADMIN: prune removes rules and needs an elevated shell' } | ConvertTo-Json -Compress
      exit 2
    }
    $removed = @()
    foreach ($rule in @(Get-NetFirewallRule -DisplayName 'AL AI Dashboard*' -ErrorAction SilentlyContinue)) {
      $portFilter = $rule | Get-NetFirewallPortFilter -ErrorAction SilentlyContinue
      if ($portFilter -and $portFilter.Protocol -eq 'TCP' -and (Test-PortCovers -LocalPort $portFilter.LocalPort -Port $Port)) { continue }
      $removed += $rule.DisplayName
      Remove-NetFirewallRule -Name $rule.Name
    }
    [pscustomobject]@{ status = 'pruned'; needsAdmin = $false; ruleName = $ruleName; port = $Port; profiles = @(); detail = "removed $($removed.Count) stale rule(s)"; removed = $removed } | ConvertTo-Json -Compress
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

  $existing = @(Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue | Where-Object {
    $pf = $_ | Get-NetFirewallPortFilter -ErrorAction SilentlyContinue
    $pf -and $pf.Protocol -eq 'TCP' -and (Test-PortCovers -LocalPort $pf.LocalPort -Port $Port)
  })

  if ($existing.Count -gt 0) {
    # Repair in place: a rule that exists but is disabled, blocking, or scoped
    # away from Public is the exact failure this script was written for. Any
    # duplicate beyond the first is removed, because two rules for one port is
    # how a later `Set-NetFirewallRule -DisplayName` starts editing both.
    foreach ($duplicate in @($existing | Select-Object -Skip 1)) { Remove-NetFirewallRule -Name $duplicate.Name }
    Set-NetFirewallRule -Name $existing[0].Name -Enabled True -Action Allow -Direction Inbound -Profile Any | Out-Null
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
