param(
  [string] $Sha = '',
  [string] $Root = 'D:/Git/aiworks',
  [string] $Node = 'C:/nvm4w/nodejs/node.exe'
)
# Upgrade the pinned AIWorks runtime to a reviewed commit (default: origin/main), refresh the governance
# checkout, and restart the supervisor and dashboard tasks. Follows docs/SUPERVISOR.md section 6.
# Campaigns are not touched: pause them before and resume them after (see AGENTS.md).
$ErrorActionPreference = 'Stop'
$data = "$Root/.local/supervisor"
$runtime = "$Root/.local/runtime"
$governance = "$Root/.local/governance"
function Note([string]$m) { Write-Output "$([DateTime]::UtcNow.ToString('o')) $m" }

if (-not $Sha) {
  & git -C $Root fetch -q origin
  $Sha = (& git -C $Root rev-parse origin/main).Trim()
}
if ($Sha -notmatch '^[0-9a-f]{40}$') { throw "not a full commit SHA: $Sha" }
Note "deploying $Sha"

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
if (-not (Test-Path $runtime)) { & git -C $Root worktree add --detach $runtime $Sha | Out-Null }
$dirty = & git -C $runtime status --porcelain
if ($dirty) { throw "runtime worktree is dirty: $dirty" }
& git -C $runtime checkout -q --detach $Sha
$head = (& git -C $runtime rev-parse HEAD).Trim()
if ($head -ne $Sha) { throw "runtime HEAD is $head, expected $Sha" }
# npm ci never rewrites package-lock.json, so the runtime stays clean for the coordinator's integrity check.
Push-Location $runtime; try { & npm ci --no-audit --no-fund --silent | Out-Null } finally { Pop-Location }
$after = & git -C $runtime status --porcelain
if ($after) { Note "WARNING: runtime checkout is not clean after install: $after" }
Note "runtime pinned at $head"

# 4. Refresh the read-only governance checkout (Engineering Platform main).
if (Test-Path "$governance/.git") {
  $gdirty = & git -C $governance status --porcelain
  if ($gdirty) { throw "governance checkout has local changes: $gdirty" }
  & git -C $governance pull -q --ff-only
  Note "governance checkout at $((& git -C $governance rev-parse HEAD).Trim())"
} else { Note "WARNING: no governance checkout at $governance" }

# 5. Remove STOP and start the tasks again.
Remove-Item -LiteralPath "$data/STOP" -Force -ErrorAction SilentlyContinue
Start-ScheduledTask -TaskName 'AIWorks Supervisor'
Start-ScheduledTask -TaskName 'AIWorks Dashboard'
Note 'done: open http://127.0.0.1:4318'
