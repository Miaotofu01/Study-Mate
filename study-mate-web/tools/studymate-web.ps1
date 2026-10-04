param(
  [Parameter(Mandatory = $true)][ValidateSet('state', 'stop')][string]$Action,
  [string]$Frontend,
  # Two plain ints on purpose: a comma separated list such as "-Ports 8101,3800" is parsed by
  # PowerShell itself and silently collapses into a single number (81013800), so never wire
  # ports through a list argument here.
  [int]$BackendPort = 8101,
  [int]$FrontendPort = 3800,
  [int]$StaleMarginSeconds = 2
)

# StudyMate Web launcher helper. ASCII ONLY on purpose: Windows PowerShell 5.1 reads
# -File scripts as ANSI when they carry no BOM, so non-ASCII bytes here would corrupt
# parsing (see the windows-bat-encoding skill notes). All Chinese text lives in the .bat
# wrappers, which are stored as GBK + CRLF.

$ErrorActionPreference = 'Stop'

function Get-ListenerPids([int]$port) {
  $found = @()
  try {
    $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($conns) { $found = @($conns | Select-Object -ExpandProperty OwningProcess -Unique) }
  } catch { }

  if (-not $found -or $found.Count -eq 0) {
    # Fallback for hosts without the NetTCPConnection cmdlet.
    $pattern = ':' + $port + '\s'
    $rows = & "$env:SystemRoot\System32\netstat.exe" -ano | Select-String -Pattern $pattern | Select-String -Pattern 'LISTENING'
    foreach ($row in $rows) {
      $cells = ($row.Line -replace '\s+', ' ').Trim().Split(' ')
      $last = $cells[$cells.Length - 1]
      if ($last -match '^\d+$') { $found += [int]$last }
    }
    $found = @($found | Sort-Object -Unique)
  }

  return @($found)
}

# Snapshot the process table once per run: walking the chain with repeated CIM queries can
# lose an ancestor to a transient WMI hiccup, which would leave the service window behind.
function Get-ProcessTable {
  $table = @{}
  foreach ($p in Get-CimInstance Win32_Process -ErrorAction SilentlyContinue) {
    $table[[int]$p.ProcessId] = $p
  }
  return $table
}

# A parent only counts as part of the service chain when its own command line actually
# mentions a service command. Without this guard the walk would climb out of the service
# window and kill the terminal the user launched the .bat from.
function Test-ServiceWrapper($proc) {
  if (-not $proc) { return $false }
  if ($proc.Name -ne 'cmd.exe' -and $proc.Name -ne 'node.exe') { return $false }
  if (-not $proc.CommandLine) { return $false }
  return ($proc.CommandLine -match '(?i)(uvicorn|next|npm|npx|study-mate-web)')
}

# Walk up the shell wrappers so that stopping a service also closes the console window it
# lives in, instead of leaving an abandoned window behind.
function Get-TreeRootPid([int]$procId, $table) {
  $cur = $procId
  for ($i = 0; $i -lt 4; $i++) {
    $p = $table[$cur]
    if (-not $p) { break }
    $parentId = [int]$p.ParentProcessId
    if ($parentId -le 0) { break }
    if (-not (Test-ServiceWrapper $table[$parentId])) { break }
    $cur = $parentId
  }
  return $cur
}

if ($Action -eq 'state') {
  if (-not $Frontend) { Write-Output 'ERROR -Frontend is required for -Action state'; exit 3 }

  $buildId = Join-Path $Frontend '.next\BUILD_ID'
  if (-not (Test-Path $buildId)) { Write-Output 'STALE-NOBUILD'; exit 0 }

  $sources = @()
  foreach ($dir in @('app', 'components', 'lib', 'public')) {
    $full = Join-Path $Frontend $dir
    if (Test-Path $full) {
      $sources += Get-ChildItem -Path $full -Recurse -File -ErrorAction SilentlyContinue
    }
  }
  foreach ($pattern in @('*.ts', '*.tsx', '*.js', '*.mjs', '*.json', '*.css')) {
    $sources += Get-ChildItem -Path $Frontend -Filter $pattern -File -ErrorAction SilentlyContinue
  }

  $newest = $sources | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
  if (-not $newest) { Write-Output 'FRESH'; exit 0 }

  $buildTime = (Get-Item $buildId).LastWriteTimeUtc
  if ($newest.LastWriteTimeUtc -gt $buildTime.AddSeconds($StaleMarginSeconds)) {
    Write-Output 'STALE'
    Write-Output ('  newest source : {0}  {1}' -f $newest.LastWriteTimeUtc.ToString('yyyy-MM-dd HH:mm:ss'), $newest.FullName)
    Write-Output ('  last build    : {0}' -f $buildTime.ToString('yyyy-MM-dd HH:mm:ss'))
  } else {
    Write-Output 'FRESH'
  }
  exit 0
}

if ($Action -eq 'stop') {
  $busy = 0
  $table = Get-ProcessTable
  $portList = @($BackendPort, $FrontendPort) | Select-Object -Unique
  foreach ($port in $portList) {
    $pids = Get-ListenerPids $port
    if ($pids.Count -eq 0) {
      Write-Output ('NOTRUNNING {0}' -f $port)
      continue
    }

    foreach ($listenerPid in $pids) {
      $root = Get-TreeRootPid $listenerPid $table
      Write-Output ('STOPPING {0} listener={1} window={2}' -f $port, $listenerPid, $root)
      & "$env:SystemRoot\System32\taskkill.exe" /F /T /PID $root 2>&1 | Out-Null
    }

    Start-Sleep -Milliseconds 900
    $left = Get-ListenerPids $port
    if ($left.Count -gt 0) {
      # The listener outlived its wrapper: kill the listener itself.
      foreach ($listenerPid in $left) {
        Write-Output ('KILLING {0} listener={1}' -f $port, $listenerPid)
        & "$env:SystemRoot\System32\taskkill.exe" /F /T /PID $listenerPid 2>&1 | Out-Null
      }
      Start-Sleep -Milliseconds 900
      $left = Get-ListenerPids $port
    }

    if ($left.Count -eq 0) {
      Write-Output ('STOPPED {0}' -f $port)
    } else {
      Write-Output ('FAILED {0} pid={1}' -f $port, ($left -join ','))
      $busy++
    }
  }
  if ($busy -gt 0) { exit 1 }
  exit 0
}
