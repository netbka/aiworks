param(
  [string] $Sha = '',
  [ValidateSet('origin', 'local')] [string] $Main = 'origin',
  [string] $Root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path,
  [string] $Node = (Get-Command node -ErrorAction Stop).Source,
  [ValidateSet('All', 'Stop', 'Install', 'Start')] [string] $Step = 'All',
  [ValidateSet('yes', 'no')] [string] $Governance = 'yes',
  [ValidateSet('yes', 'no')] [string] $KeepStop = 'no'
)
# Upgrade the pinned AIWorks runtime to a reviewed commit of the trusted main, refresh the governance checkout, and
# restart the supervisor and dashboard tasks. Follows docs/SUPERVISOR.md section 6.
# -Main origin (default): the commit is origin/main after a fetch, as before. -Main local (AW-005, with config.json
# "selfHosting": { "trustedMain": "local" }): the commit is the trusted tip of the main ledger, read through the pinned
# runtime's `cli.mjs trusted-main`; no fetch, a -Sha must be that tip or an ancestor of it, and a failed governance pull
# keeps the current governance checkout with a warning.
# Campaigns are not touched: pause them before and resume them after (see AGENTS.md), or use `npm run rebuild`, which
# does both and runs this script one step at a time:
#   -Step Stop     steps 0 to 2: disable the tasks, write STOP and prove the supervisor and dashboard exited.
#   -Step Install  step 3 only, at the given -Sha, which the caller has already checked against the trusted main; it
#                  refuses unless the supervisor is stopped. -Governance no (what the rebuild passes) skips step 4.
#   -Step Start    step 5 only. -KeepStop yes leaves a STOP that was there before the rebuild, so the supervisor stays stopped.
# Every external command runs hidden through hidden-exec.ps1 (ProcessStartInfo, no window), its output captured.
# Both tasks repeat every 5 minutes (aiworks#18), so they are disabled for the whole deploy: no trigger can start the
# keeper or the dashboard from a half-updated runtime. A failed deploy leaves them disabled and STOP in place, so the
# supervisor stays stopped (and status says so) until the next deploy succeeds.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'hidden-exec.ps1')
$data = "$Root/.local/supervisor"
$runtime = "$Root/.local/runtime"
$governance = "$Root/.local/governance"
function Note([string]$m) { Write-Output "$([DateTime]::UtcNow.ToString('o')) $m" }
function Run([string]$file, [string[]]$arguments, [string]$cwd = $Root) { Invoke-Hidden -File $file -Arguments $arguments -WorkingDirectory $cwd }
function Git([string[]]$arguments) { Run 'git' $arguments }
# The runtime's own processes, found by their full script path, so an installation root of any name is matched.
$runtimePattern = (([IO.Path]::GetFullPath($runtime)) -split '[\\/]+' | Where-Object { $_ } | ForEach-Object { [regex]::Escape($_) }) -join '[\\/]+'
function RuntimeProcesses([string]$script) {
  $pattern = "$runtimePattern[\\/]+$script"
  @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match $pattern })
}
$supervisorScript = 'src[\\/]+supervisor[\\/]+cli\.mjs'
$dashboardScript = 'src[\\/]+dashboard[\\/]+main\.mjs'

# Choose the commit before anything is stopped, so a refusal leaves the running system as it was.
function Select-Commit {
  $trustedTip = ''
  if ($Main -eq 'local') {
    # Never raw `git rev-parse main`: a commit on main that the main ledger does not record is not trusted (AW-005).
    $cli = "$runtime/src/supervisor/cli.mjs"
    if (-not (Test-Path $cli)) { throw "deploy stopped: -Main local reads the trusted tip through $cli, which is missing; nothing was changed" }
    $out = Run $Node @($cli, 'trusted-main', '--data', $data) $runtime
    if ($out.exitCode -ne 0) { throw "deploy stopped: trusted-main refused (exit $($out.exitCode)): $($out.stderr.Trim()); nothing was changed" }
    $lines = @($out.stdout -split "`r?`n")
    $trustedTip = "$($lines[0])".Trim()
    if ($trustedTip -notmatch '^[0-9a-f]{40}$') { throw "deploy stopped: trusted-main printed no commit; nothing was changed" }
    Note "trusted tip of local main $trustedTip ($("$($lines[1])".Trim()))"
    if (-not $script:Sha) { $script:Sha = $trustedTip }
  } elseif (-not $script:Sha) {
    $fetch = Git @('-C', $Root, 'fetch', '-q', 'origin')
    if ($fetch.exitCode -ne 0) { throw "deploy stopped: git fetch failed (exit $($fetch.exitCode)): $($fetch.stderr.Trim()); nothing was changed" }
    $script:Sha = (Git @('-C', $Root, 'rev-parse', 'origin/main')).stdout.Trim()
  }
  if ($script:Sha -notmatch '^[0-9a-f]{40}$') { throw "not a full commit SHA: $($script:Sha)" }
  if ($trustedTip) {
    $ancestor = Git @('-C', $Root, 'merge-base', '--is-ancestor', $script:Sha, $trustedTip)
    if ($ancestor.exitCode -ne 0) { throw "deploy stopped: $($script:Sha) is not the trusted tip of local main or an ancestor of it; nothing was changed" }
  }
  Note "deploying $($script:Sha)"
}

# Steps 0 to 2: nothing runs from the runtime afterwards.
function Stop-Runtime {
  # 0. Disable both tasks so their triggers cannot start anything until step 5. A running instance keeps running.
  # A missing task is fine (nothing to trigger). Any other failure (access denied, Task Scheduler down) would leave a live
  # 5-minute trigger, so the deploy stops here, before STOP is written or any process is stopped; an existing STOP stays.
  $script:disabled = @()
  function Disable-Task([string]$name) {
    try { Disable-ScheduledTask -TaskName $name -ErrorAction Stop | Out-Null; $script:disabled += $name }
    catch {
      if ($_.CategoryInfo.Category -eq 'ObjectNotFound') { Note "no task '$name' to disable"; return }
      $already = if ($script:disabled) { " Already disabled: $($script:disabled -join ', ')." } else { '' }
      throw "deploy stopped: could not disable task '$name': $($_.Exception.Message). Its 5-minute trigger is still live, so no process was stopped and the runtime is unchanged; STOP is left as it was.$already Fix the cause and run deploy.ps1 again."
    }
  }
  Disable-Task 'AIWorks Supervisor'
  Disable-Task 'AIWorks Dashboard'
  Note 'scheduled tasks disabled'

  # 1. Ask the running supervisor to stop (STOP file) and wait for serve and keep to exit.
  if (Test-Path "$runtime/src/supervisor/cli.mjs") {
    $stop = Run $Node @("$runtime/src/supervisor/cli.mjs", 'stop', '--data', $data) $runtime
    if ($stop.exitCode -ne 0) { throw "deploy stopped: cli.mjs stop failed (exit $($stop.exitCode)): $($stop.stderr.Trim())" }
    Note 'STOP written'
  }
  $deadline = (Get-Date).AddSeconds(90)
  do {
    Start-Sleep -Seconds 2
    $procs = RuntimeProcesses $supervisorScript
  } while ($procs.Count -and (Get-Date) -lt $deadline)
  if ($procs.Count) { throw "supervisor processes still running: $($procs.ProcessId -join ',')" }
  Note 'supervisor processes exited'

  # 2. Stop the scheduled tasks (the dashboard runs from the pinned runtime too) and prove the dashboard exited.
  Stop-ScheduledTask -TaskName 'AIWorks Supervisor' -ErrorAction SilentlyContinue
  Stop-ScheduledTask -TaskName 'AIWorks Dashboard' -ErrorAction SilentlyContinue
  foreach ($p in (RuntimeProcesses $dashboardScript)) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  $deadline = (Get-Date).AddSeconds(15)
  while (($dash = RuntimeProcesses $dashboardScript).Count -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
  if ($dash.Count) { throw "dashboard processes still running: $($dash.ProcessId -join ',')" }
  Note 'scheduled tasks stopped'
}

# 3. Pin the runtime worktree at the reviewed commit and install its locked dependencies.
function Install-Runtime([switch]$Guard) {
  if ($Guard -and (-not (Test-Path "$data/STOP") -or (RuntimeProcesses $supervisorScript).Count -or (RuntimeProcesses $dashboardScript).Count)) {
    throw 'install refused: the supervisor and dashboard must be stopped first (-Step Stop); nothing was changed'
  }
  if (-not (Test-Path $runtime)) {
    $add = Git @('-C', $Root, 'worktree', 'add', '--detach', $runtime, $script:Sha)
    if ($add.exitCode -ne 0) { throw "git worktree add failed (exit $($add.exitCode)): $($add.stderr.Trim())" }
  }
  $dirty = (Git @('-C', $runtime, 'status', '--porcelain')).stdout.Trim()
  if ($dirty) { throw "runtime worktree is dirty: $dirty" }
  $checkout = Git @('-C', $runtime, 'checkout', '-q', '--detach', $script:Sha)
  if ($checkout.exitCode -ne 0) { throw "git checkout failed (exit $($checkout.exitCode)): $($checkout.stderr.Trim())" }
  $head = (Git @('-C', $runtime, 'rev-parse', 'HEAD')).stdout.Trim()
  if ($head -ne $script:Sha) { throw "runtime HEAD is $head, expected $($script:Sha)" }
  # npm ci never rewrites package-lock.json, so the runtime stays clean for the coordinator's integrity check. npm runs
  # through node and npm-cli.js where Node ships them, so no cmd.exe is started.
  $npmCli = Join-Path (Split-Path -Parent $Node) 'node_modules/npm/bin/npm-cli.js'
  $npm = if (Test-Path $npmCli) { Run $Node @($npmCli, 'ci', '--no-audit', '--no-fund', '--silent') $runtime }
    else { Run 'npm.cmd' @('ci', '--no-audit', '--no-fund', '--silent') $runtime }
  if ($npm.exitCode -ne 0) { throw "npm ci failed (exit $($npm.exitCode)): $($npm.stderr.Trim()); the supervisor stays stopped" }
  $after = (Git @('-C', $runtime, 'status', '--porcelain')).stdout.Trim()
  if ($after) { Note "WARNING: runtime checkout is not clean after install: $after" }
  Note "runtime pinned at $head"
}

# 4. Refresh the read-only governance checkout (governance provider main).
function Update-Governance {
  if (Test-Path "$governance/.git") {
    $gdirty = (Git @('-C', $governance, 'status', '--porcelain')).stdout.Trim()
    if ($gdirty) { throw "governance checkout has local changes: $gdirty" }
    $pull = Git @('-C', $governance, 'pull', '-q', '--ff-only')
    $gHead = (Git @('-C', $governance, 'rev-parse', 'HEAD')).stdout.Trim()
    if ($pull.exitCode -ne 0) {
      # With local trust the network is not on the deploy's critical path: governance changes take effect only once pulled,
      # so the checkout stays at its current commit. With origin trust a failed pull stops the deploy, as before.
      if ($Main -ne 'local') { throw "governance pull failed (exit $($pull.exitCode)); the supervisor stays stopped" }
      $gAfter = (Git @('-C', $governance, 'status', '--porcelain')).stdout.Trim()
      if ($gAfter) { throw "governance pull failed (exit $($pull.exitCode)) and left local changes: $gAfter; the supervisor stays stopped" }
      Note "WARNING: governance pull failed (exit $($pull.exitCode)); the governance checkout stays at $gHead"
    } else { Note "governance checkout at $gHead" }
  } else { Note "WARNING: no governance checkout at $governance" }
}

# 5. Remove STOP, enable the tasks and start them again.
function Start-Runtime {
  if ($KeepStop -eq 'yes') { Note 'STOP kept: it was there before this maintenance' }
  else { Remove-Item -LiteralPath "$data/STOP" -Force -ErrorAction SilentlyContinue }
  foreach ($name in 'AIWorks Supervisor', 'AIWorks Dashboard') {
    if (-not (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue)) { Note "no task '$name' to start"; continue }
    Enable-ScheduledTask -TaskName $name | Out-Null
    Start-ScheduledTask -TaskName $name
  }
  Note 'done: open http://127.0.0.1:4318'
}

switch ($Step) {
  'All' { Select-Commit; Stop-Runtime; Install-Runtime; if ($Governance -eq 'yes') { Update-Governance }; Start-Runtime }
  'Stop' { Stop-Runtime }
  'Install' {
    if ($Sha -notmatch '^[0-9a-f]{40}$') { throw 'install refused: -Step Install needs the full -Sha the caller checked; nothing was changed' }
    Note "installing $Sha"; Install-Runtime -Guard; if ($Governance -eq 'yes') { Update-Governance }
  }
  'Start' { Start-Runtime }
}
