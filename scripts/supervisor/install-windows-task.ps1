# AIWorks registers the supervisor as a per-user Windows scheduled task.
# It starts at logon, runs `cli.mjs keep` hidden (which restarts `serve` after any exit),
# and has no execution time limit. A second trigger repeats every 5 minutes, so a keeper that died is started again
# (aiworks#18); while one runs, MultipleInstances IgnoreNew skips it. Stop with `node cli.mjs stop --data <dir>`.
# Usage: powershell -NoProfile -File scripts\supervisor\install-windows-task.ps1 -Checkout C:\example\aiworks\.local\runtime -DataDir C:\example\aiworks\.local\supervisor
# -DefinitionOnly prints the task definition as JSON and changes nothing (no registration, no STOP removal).
param(
  [Parameter(Mandatory = $true)] [string] $Checkout,
  [Parameter(Mandatory = $true)] [string] $DataDir,
  [string] $TaskName = 'AIWorks Supervisor',
  [switch] $DefinitionOnly
)
$ErrorActionPreference = 'Stop'
$node = (Get-Command node).Source
$cli = Join-Path $Checkout 'src\supervisor\cli.mjs'
if (-not (Test-Path $cli)) { throw "missing $cli" }
if (-not (Test-Path (Join-Path $DataDir 'config.json'))) { throw "missing config.json in $DataDir" }
if (-not (Get-Content -Raw (Join-Path $DataDir 'config.json') | ConvertFrom-Json).governanceRoot) { Write-Warning 'config.json has no governanceRoot: new campaigns will be refused and the roadmap panel stays empty (docs/SUPERVISOR.md section 6)' }
$command = "& '$node' --no-warnings '$cli' keep --data '$DataDir'"
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -Command `"$command`"" -WorkingDirectory $Checkout
$logon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
# No repetition duration means indefinitely; never stop the running keeper when a repetition ends.
$repeat = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5)
$repeat.Repetition.StopAtDurationEnd = $false
$trigger = @($logon, $repeat)
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 99 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
if ($DefinitionOnly) {
  [ordered]@{ taskName = $TaskName; execute = $action.Execute; arguments = $action.Arguments
    triggers = @($trigger | ForEach-Object { [ordered]@{ kind = $_.CimClass.CimClassName; startBoundary = $_.StartBoundary
      interval = $_.Repetition.Interval; duration = $_.Repetition.Duration; stopAtDurationEnd = $_.Repetition.StopAtDurationEnd } })
    multipleInstances = "$($settings.MultipleInstances)"; executionTimeLimit = $settings.ExecutionTimeLimit
    restartCount = $settings.RestartCount; restartInterval = $settings.RestartInterval } | ConvertTo-Json -Depth 4
  return
}
$stop = Join-Path $DataDir 'STOP'
if (Test-Path $stop) { Remove-Item $stop }
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Get-ScheduledTask -TaskName $TaskName | Select-Object TaskName, State
