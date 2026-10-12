# AIWorks registers the supervisor as a per-user Windows scheduled task.
# It starts at logon, runs `cli.mjs keep` hidden (which restarts `serve` after any exit),
# and has no execution time limit. Stop with `node cli.mjs stop --data <dir>`.
# Usage: powershell -NoProfile -File scripts\supervisor\install-windows-task.ps1 -Checkout D:\Git\aiworks\.local\runtime -DataDir D:\Git\aiworks\.local\supervisor
param(
  [Parameter(Mandatory = $true)] [string] $Checkout,
  [Parameter(Mandatory = $true)] [string] $DataDir,
  [string] $TaskName = 'AIWorks Supervisor'
)
$ErrorActionPreference = 'Stop'
$node = (Get-Command node).Source
$cli = Join-Path $Checkout 'src\supervisor\cli.mjs'
if (-not (Test-Path $cli)) { throw "missing $cli" }
if (-not (Test-Path (Join-Path $DataDir 'config.json'))) { throw "missing config.json in $DataDir" }
if (-not (Get-Content -Raw (Join-Path $DataDir 'config.json') | ConvertFrom-Json).governanceRoot) { Write-Warning 'config.json has no governanceRoot: new campaigns will be refused and the roadmap panel stays empty (docs/SUPERVISOR.md section 6)' }
$stop = Join-Path $DataDir 'STOP'
if (Test-Path $stop) { Remove-Item $stop }

$command = "& '$node' --no-warnings '$cli' keep --data '$DataDir'"
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -Command `"$command`"" -WorkingDirectory $Checkout
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 99 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Get-ScheduledTask -TaskName $TaskName | Select-Object TaskName, State
