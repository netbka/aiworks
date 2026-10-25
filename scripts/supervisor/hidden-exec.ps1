param([string] $Request = '')
# Hidden external commands for deploy.ps1 and npm run rebuild (docs/SUPERVISOR.md section 6, Rebuild). Every command
# starts through System.Diagnostics.ProcessStartInfo with CreateNoWindow on and UseShellExecute off, so no console
# window opens, and its stdout, stderr and exit code are captured.
# Dot-source this file for Invoke-Hidden, or run it with -Request <base64 of UTF-8 JSON { file, args, cwd, timeoutMs }>:
# it prints { exitCode, stdout, stderr, timedOut } as JSON. The Node launcher starts powershell.exe itself hidden.

# One argument quoted for CommandLineToArgvW, the parser of git, node and every other C runtime program.
function ConvertTo-WindowsArgument([string] $Value) {
  if ($Value -ne '' -and $Value -notmatch '[\s"]') { return $Value }
  $quoted = '"'; $slashes = 0
  foreach ($ch in $Value.ToCharArray()) {
    if ($ch -eq '\') { $slashes++; continue }
    if ($ch -eq '"') { $quoted += ('\' * ($slashes * 2 + 1)) + '"' } else { $quoted += ('\' * $slashes) + $ch }
    $slashes = 0
  }
  return $quoted + ('\' * ($slashes * 2)) + '"'
}

function Invoke-Hidden {
  param([string] $File, [string[]] $Arguments = @(), [string] $WorkingDirectory = (Get-Location).Path, [int] $TimeoutMs = 0)
  # A bare name (git, node) is resolved to its executable here, never to a function, alias or shell built-in.
  if ($File -notmatch '[\\/]') { $File = (Get-Command $File -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source }
  $start = New-Object System.Diagnostics.ProcessStartInfo
  $start.FileName = $File
  $start.Arguments = (@($Arguments) | ForEach-Object { ConvertTo-WindowsArgument $_ }) -join ' '
  $start.WorkingDirectory = $WorkingDirectory
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $start.StandardOutputEncoding = [Text.Encoding]::UTF8
  $start.StandardErrorEncoding = [Text.Encoding]::UTF8
  $process = [System.Diagnostics.Process]::Start($start)
  # Both streams are read at once, so a command that fills one pipe never blocks on the other.
  $out = $process.StandardOutput.ReadToEndAsync()
  $err = $process.StandardError.ReadToEndAsync()
  $timedOut = $false
  if ($TimeoutMs -gt 0 -and -not $process.WaitForExit($TimeoutMs)) { $timedOut = $true; try { $process.Kill() } catch { } }
  $process.WaitForExit()
  [pscustomobject]@{ exitCode = $(if ($timedOut) { -1 } else { $process.ExitCode }); stdout = $out.Result; stderr = $err.Result; timedOut = $timedOut }
}

if ($Request) {
  $ErrorActionPreference = 'Stop'
  $call = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Request)) | ConvertFrom-Json
  $list = @(); if ($call.args) { $list = @($call.args | ForEach-Object { [string]$_ }) }
  $result = Invoke-Hidden -File $call.file -Arguments $list -WorkingDirectory $call.cwd -TimeoutMs ([int]$call.timeoutMs)
  [Console]::OutputEncoding = [Text.Encoding]::UTF8
  [Console]::Out.Write(($result | ConvertTo-Json -Compress))
}
