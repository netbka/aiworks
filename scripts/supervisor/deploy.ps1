param(
  [string] $Sha = '',
  [ValidateSet('origin', 'local')] [string] $Main = 'origin',
  [string] $Root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path,
  [string] $Node = (Get-Command node -ErrorAction Stop).Source
)
# Upgrade the pinned AIWorks runtime to a reviewed commit of the trusted main, refresh the governance checkout, and
# restart the supervisor and dashboard tasks. Follows docs/SUPERVISOR.md section 6.
# -Main origin (default): the commit is origin/main after a fetch, as before. -Main local (AW-005, with config.json
# "selfHosting": { "trustedMain": "local" }): the commit is the trusted tip of the main ledger, read through the pinned
# runtime's `cli.mjs trusted-main`; no fetch, a -Sha must be that tip or an ancestor of it, and a failed governance pull
# keeps the current governance checkout with a warning.
# Campaigns are not touched: pause them before and resume them after (see AGENTS.md).
# Both tasks repeat every 5 minutes (aiworks#18), so they are disabled for the whole deploy: no trigger can start the
# keeper or the dashboard from a half-updated runtime. A failed deploy leaves them disabled and STOP in place, so the
# supervisor stays stopped (and status says so) until the next deploy succeeds.
$ErrorActionPreference = 'Stop'
$data = "$Root/.local/supervisor"
$runtime = "$Root/.local/runtime"
$governance = "$Root/.local/governance"
function Note([string]$m) { Write-Output "$([DateTime]::UtcNow.ToString('o')) $m" }

# Choose the commit before anything is stopped, so a refusal leaves the running system as it was.
$trustedTip = ''
if ($Main -eq 'local') {
  # Never raw `git rev-parse main`: a commit on main that the main ledger does not record is not trusted (AW-005).
  $cli = "$runtime/src/supervisor/cli.mjs"
  if (-not (Test-Path $cli)) { throw "deploy stopped: -Main local reads the trusted tip through $cli, which is missing; nothing was changed" }
  $out = @(& $Node $cli trusted-main --data $data)
  if ($LASTEXITCODE -ne 0) { throw "deploy stopped: trusted-main refused (exit $LASTEXITCODE); nothing was changed" }
  $trustedTip = "$($out[0])".Trim()
  if ($trustedTip -notmatch '^[0-9a-f]{40}$') { throw "deploy stopped: trusted-main printed no commit; nothing was changed" }
  Note "trusted tip of local main $trustedTip ($("$($out[1])".Trim()))"
  if (-not $Sha) { $Sha = $trustedTip }
} elseif (-not $Sha) {
  & git -C $Root fetch -q origin
  $Sha = (& git -C $Root rev-parse origin/main).Trim()
}
if ($Sha -notmatch '^[0-9a-f]{40}$') { throw "not a full commit SHA: $Sha" }
if ($trustedTip) {
  & git -C $Root merge-base --is-ancestor $Sha $trustedTip
  if ($LASTEXITCODE -ne 0) { throw "deploy stopped: $Sha is not the trusted tip of local main or an ancestor of it; nothing was changed" }
}
Note "deploying $Sha"

# 0. Disable both tasks so their triggers cannot start anything until step 5. A running instance keeps running.
# A missing task is fine (nothing to trigger). Any other failure (access denied, Task Scheduler down) would leave a live
# 5-minute trigger, so the deploy stops here, before STOP is written or any process is stopped; an existing STOP stays.
$disabled = @()
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
if (Test-Path "$runtime/src/supervisor/cli.mjs") { & $Node "$runtime/src/supervisor/cli.mjs" stop --data $data | Out-Null; Note 'STOP written' }
$deadline = (Get-Date).AddSeconds(90)
do {
  Start-Sleep -Seconds 2
  $procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'aiworks[\\/]\.local[\\/]runtime[\\/]src[\\/]supervisor[\\/]cli\.mjs' }
} while ($procs -and (Get-Date) -lt $deadline)
if ($procs) { throw "supervisor processes still running: $($procs.ProcessId -join ',')" }
Note 'supervisor processes exited'

# 2. Stop the scheduled tasks (the dashboard runs from the pinned runtime too).
Stop-ScheduledTask -TaskName 'AIWorks Supervisor' -ErrorAction SilentlyContinue
Stop-ScheduledTask -TaskName 'AIWorks Dashboard' -ErrorAction SilentlyContinue
$dash = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'aiworks[\\/]\.local[\\/]runtime[\\/]src[\\/]dashboard[\\/]main\.mjs' }
foreach ($p in $dash) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
Note 'scheduled tasks stopped'

# 3. Pin the runtime worktree at the reviewed commit and install its locked dependencies.
if (-not (Test-Path $runtime)) {
  & git -C $Root worktree add --detach $runtime $Sha | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "git worktree add failed (exit $LASTEXITCODE)" }
}
$dirty = & git -C $runtime status --porcelain
if ($dirty) { throw "runtime worktree is dirty: $dirty" }
& git -C $runtime checkout -q --detach $Sha
if ($LASTEXITCODE -ne 0) { throw "git checkout failed (exit $LASTEXITCODE)" }
$head = (& git -C $runtime rev-parse HEAD).Trim()
if ($head -ne $Sha) { throw "runtime HEAD is $head, expected $Sha" }
# npm ci never rewrites package-lock.json, so the runtime stays clean for the coordinator's integrity check.
Push-Location $runtime; try { & npm ci --no-audit --no-fund --silent | Out-Null; $npmExit = $LASTEXITCODE } finally { Pop-Location }
if ($npmExit -ne 0) { throw "npm ci failed (exit $npmExit); the supervisor stays stopped" }
$after = & git -C $runtime status --porcelain
if ($after) { Note "WARNING: runtime checkout is not clean after install: $after" }
Note "runtime pinned at $head"

# 4. Refresh the read-only governance checkout (governance provider main).
if (Test-Path "$governance/.git") {
  $gdirty = & git -C $governance status --porcelain
  if ($gdirty) { throw "governance checkout has local changes: $gdirty" }
  & git -C $governance pull -q --ff-only
  $pullExit = $LASTEXITCODE
  $gHead = (& git -C $governance rev-parse HEAD).Trim()
  if ($pullExit -ne 0) {
    # With local trust the network is not on the deploy's critical path: governance changes take effect only once pulled,
    # so the checkout stays at its current commit. With origin trust a failed pull stops the deploy, as before.
    if ($Main -ne 'local') { throw "governance pull failed (exit $pullExit); the supervisor stays stopped" }
    $gAfter = & git -C $governance status --porcelain
    if ($gAfter) { throw "governance pull failed (exit $pullExit) and left local changes: $gAfter; the supervisor stays stopped" }
    Note "WARNING: governance pull failed (exit $pullExit); the governance checkout stays at $gHead"
  } else { Note "governance checkout at $gHead" }
} else { Note "WARNING: no governance checkout at $governance" }

# 5. Remove STOP, enable the tasks and start them again.
Remove-Item -LiteralPath "$data/STOP" -Force -ErrorAction SilentlyContinue
Enable-ScheduledTask -TaskName 'AIWorks Supervisor' | Out-Null
Enable-ScheduledTask -TaskName 'AIWorks Dashboard' | Out-Null
Start-ScheduledTask -TaskName 'AIWorks Supervisor'
Start-ScheduledTask -TaskName 'AIWorks Dashboard'
Note 'done: open http://127.0.0.1:4318'
