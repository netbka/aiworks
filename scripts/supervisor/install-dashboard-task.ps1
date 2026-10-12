# AIWorks registers the operations dashboard as a per-user Windows scheduled task.
# It starts at logon and serves http://127.0.0.1:<Port> hidden from the pinned runtime checkout. The governance
# checkout comes from <DataDir>/config.json (governanceRoot). Output goes to <Checkout>/../dashboard-task.*.log.
# Usage: powershell -NoProfile -File scripts\supervisor\install-dashboard-task.ps1 -Checkout D:\Git\aiworks\.local\runtime -DataDir D:\Git\aiworks\.local\supervisor
param(
  [Parameter(Mandatory = $true)] [string] $Checkout,
  [Parameter(Mandatory = $true)] [string] $DataDir,
  [int] $Port = 4318,
  [string] $TaskName = 'AIWorks Dashboard'
)
$ErrorActionPreference = 'Stop'
$node = (Get-Command node).Source
$main = Join-Path $Checkout 'src\dashboard\main.mjs'
if (-not (Test-Path $main)) { throw "missing $main" }
if (-not (Test-Path (Join-Path $DataDir 'config.json'))) { throw "missing config.json in $DataDir" }
$local = Split-Path -Parent ([IO.Path]::GetFullPath($Checkout))
$cache = Join-Path $local 'dashboard-cache'
$out = Join-Path $local 'dashboard-task.stdout.log'
$err = Join-Path $local 'dashboard-task.stderr.log'
$exit = Join-Path $local 'dashboard-task.exit.txt'

$script = @"
`$ErrorActionPreference='Stop'
`$dash = Start-Process -FilePath '$node' -ArgumentList @('--no-warnings','$main','--data','$DataDir','--port','$Port','--cache','$cache') -WorkingDirectory '$Checkout' -WindowStyle Hidden -RedirectStandardOutput '$out' -RedirectStandardError '$err' -Wait -PassThru
`$dash.ExitCode | Set-Content -LiteralPath '$exit'
exit `$dash.ExitCode
"@
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script))
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand $encoded" -WorkingDirectory $Checkout
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Get-ScheduledTask -TaskName $TaskName | Select-Object TaskName, State
