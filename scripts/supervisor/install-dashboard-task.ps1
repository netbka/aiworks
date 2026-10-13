# AIWorks registers the operations dashboard as a per-user Windows scheduled task.
# It starts at logon and serves http://127.0.0.1:<Port> hidden from the pinned runtime checkout. A second trigger repeats
# every 5 minutes, so a dashboard that died is started again (aiworks#18); while one runs, MultipleInstances IgnoreNew
# skips it. The governance checkout comes from <DataDir>/config.json (governanceRoot). Output goes to
# <Checkout>/../dashboard-task.*.log.
# Usage: powershell -NoProfile -File scripts\supervisor\install-dashboard-task.ps1 -Checkout C:\example\aiworks\.local\runtime -DataDir C:\example\aiworks\.local\supervisor
# -DefinitionOnly prints the task definition as JSON and changes nothing.
param(
  [Parameter(Mandatory = $true)] [string] $Checkout,
  [Parameter(Mandatory = $true)] [string] $DataDir,
  [int] $Port = 4318,
  [string] $TaskName = 'AIWorks Dashboard',
  [switch] $DefinitionOnly
)
$ErrorActionPreference = 'Stop'
$node = (Get-Command node).Source
$main = Join-Path $Checkout 'src\dashboard\main.mjs'
if (-not (Test-Path $main)) { throw "missing $main" }
if (-not (Test-Path (Join-Path $DataDir 'config.json'))) { throw "missing config.json in $DataDir" }
if (-not (Get-Content -Raw (Join-Path $DataDir 'config.json') | ConvertFrom-Json).governanceRoot) { Write-Warning 'config.json has no governanceRoot: new campaigns will be refused and the roadmap panel stays empty (docs/SUPERVISOR.md section 6)' }
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
$logon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
# No repetition duration means indefinitely; never stop the running dashboard when a repetition ends.
$repeat = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5)
$repeat.Repetition.StopAtDurationEnd = $false
$trigger = @($logon, $repeat)
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
if ($DefinitionOnly) {
  [ordered]@{ taskName = $TaskName; execute = $action.Execute; arguments = $action.Arguments
    triggers = @($trigger | ForEach-Object { [ordered]@{ kind = $_.CimClass.CimClassName; startBoundary = $_.StartBoundary
      interval = $_.Repetition.Interval; duration = $_.Repetition.Duration; stopAtDurationEnd = $_.Repetition.StopAtDurationEnd } })
    multipleInstances = "$($settings.MultipleInstances)"; executionTimeLimit = $settings.ExecutionTimeLimit
    restartCount = $settings.RestartCount; restartInterval = $settings.RestartInterval } | ConvertTo-Json -Depth 4
  return
}
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Get-ScheduledTask -TaskName $TaskName | Select-Object TaskName, State
