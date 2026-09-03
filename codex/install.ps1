# Rubato for Codex — installer (Windows).
#  1. checks Node.js availability
#  2. creates the config template if missing (fill username + password after)
#  3. wires the Codex `notify` hook into ~/.codex/config.toml (backup first)
#  4. registers a hidden logon Scheduled Task running the watcher, starts it
# Usage:
#   powershell -ExecutionPolicy Bypass -File install.ps1            # full install
#   powershell -ExecutionPolicy Bypass -File install.ps1 -NoTask   # no scheduled task
#   powershell -ExecutionPolicy Bypass -File install.ps1 -NoNotify # don't touch config.toml
[CmdletBinding()]
param(
  [switch]$NoTask,
  [switch]$NoNotify
)
$ErrorActionPreference = 'Stop'

$PluginRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$CodexHome = Join-Path $env:USERPROFILE '.codex'
$TaskName = 'RubatoCodexWatcher'
$ConfigName = 'rubato-mqtt-config.json'

Write-Host "== Rubato for Codex install ==" -ForegroundColor Cyan

# 1. Node.js
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw 'Node.js not found on PATH. Install Node 18+ first: https://nodejs.org' }
$nodeVersion = (& node --version) 2>$null
Write-Host "[ok] node $nodeVersion"

# 2. config template — the generic Rubato config name shared by every harness
#    (spec §4). The plugin auto-derives clientId Codex-<username> and topic.
#    Written via .NET UTF8Encoding($false): the config must be BOM-free (§9.4).
$configPath = Join-Path $PluginRoot $ConfigName
if (-not (Test-Path $configPath)) {
  [IO.File]::WriteAllText($configPath, "{`n  `"username`": `"`",`n  `"password`": `"`"`n}`n", [Text.UTF8Encoding]::new($false))
  Write-Host "[ok] created $configPath (fill username = RUBATO-xxxxxx from the device sticker, password = its token)"
} else {
  Write-Host "[ok] config exists: $configPath"
}

# 3. notify hook in ~/.codex/config.toml
if (-not $NoNotify) {
  New-Item -ItemType Directory -Force $CodexHome | Out-Null
  $toml = Join-Path $CodexHome 'config.toml'
  if (-not (Test-Path $toml)) { [IO.File]::WriteAllText($toml, '', [Text.UTF8Encoding]::new($false)) }
  $content = [IO.File]::ReadAllText($toml)
  $notifyScript = Join-Path $PluginRoot 'lib\notify.js'
  if ($content -match '(?m)^\s*notify\s*=') {
    if ($content -like "*$notifyScript*") {
      Write-Host "[ok] notify hook already wired"
    } else {
      Write-Warning "config.toml already has a notify hook; leaving it untouched. To use Rubato, replace it manually with:"
      Write-Host "  notify = [`"node`", '$notifyScript']"
    }
  } else {
    Copy-Item $toml "$toml.bak-rubato" -Force
    [IO.File]::AppendAllText($toml, "notify = [`"node`", '$notifyScript'" + "]`n", [Text.UTF8Encoding]::new($false))
    Write-Host "[ok] added notify hook to $toml (backup: $toml.bak-rubato)"
  }
}

# 4. scheduled task for the watcher (runs hidden at logon, auto-restarts)
if (-not $NoTask) {
  $watcher = Join-Path $PluginRoot 'lib\watcher.js'
  $action = New-ScheduledTaskAction -Execute 'node.exe' -Argument "`"$watcher`"" -WorkingDirectory $PluginRoot
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $settings = New-ScheduledTaskSettingsSet -Hidden -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew
  try {
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
      -Description 'Rubato Codex plugin: publishes Codex CLI model state to the Rubato device over MQTT.' -Force | Out-Null
    Start-ScheduledTask -TaskName $TaskName
    Write-Host "[ok] scheduled task '$TaskName' registered and started (logon trigger, hidden)"
  } catch {
    Write-Warning "could not register the scheduled task ($($_.Exception.Message)); run the watcher manually:"
    Write-Host "  node `"$watcher`""
  }
}

Write-Host ''
Write-Host 'Next steps:' -ForegroundColor Yellow
Write-Host "  1. open  $ConfigName"
Write-Host '  2. fill  "username": RUBATO-xxxxxx (device sticker), "password": its token'
Write-Host '  3. save - the plugin auto-enables (no restart needed)'
Write-Host '  check:   the device leaves its idle state on the next Codex turn'
