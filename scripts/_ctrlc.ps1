# Internal helper for scripts/common.ps1 - not meant to be run by hand.
#
# Raise a real Ctrl-C in another process's console. FreeConsole / AttachConsole
# / GenerateConsoleCtrlEvent must run in a process that is willing to give up
# its own console (attaching to a second console requires detaching from the
# first). Doing that here, in a throwaway child, keeps the caller's console -
# and therefore the caller's own output - untouched.
#
# Exit 0 = the Ctrl-C was delivered (the target's own handler ran).
# Exit 1 = the target has no console to attach to; the caller force-kills.
param([Parameter(Mandatory)][int]$TargetPid)

if (-not ("AlAi.Win32" -as [type])) {
  Add-Type -Namespace AlAi -Name Win32 -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(uint dwProcessId);
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool FreeConsole();
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetConsoleCtrlHandler(System.IntPtr handler, bool add);
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool GenerateConsoleCtrlEvent(uint dwCtrlEvent, uint dwProcessGroupId);
'@
}

[void][AlAi.Win32]::FreeConsole()
if (-not [AlAi.Win32]::AttachConsole([uint32]$TargetPid)) { exit 1 }

# Ignore the Ctrl-C we are about to raise - we are in the same console group.
[void][AlAi.Win32]::SetConsoleCtrlHandler([IntPtr]::Zero, $true)
[void][AlAi.Win32]::GenerateConsoleCtrlEvent(0, 0)
Start-Sleep -Milliseconds 250
[void][AlAi.Win32]::FreeConsole()
exit 0
