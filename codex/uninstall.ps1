# Rubato for Codex — uninstaller (Windows).
#  1. stops and removes the logon Scheduled Task
#  2. removes the notify hook line we added from ~/.codex/config.toml
#  3. with -Purge: also deletes the config (credentials), archive, stats, state
# Usage: powershell -ExecutionPolicy Bypass -File uninstall.ps1 [-Purge]
[CmdletBinding()]
param(
  [switch]$Purge
)
$ErrorActionPreference = 'Continue'

$PluginRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$CodexHome = Join-Path $env:USERPROFILE '.codex'
$TaskName = 'RubatoCodexWatcher'

Write-Host "== Rubato for Codex uninstall ==" -ForegroundColor Cyan

# 1. scheduled task
try {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
  Write-Host "[ok] scheduled task removed"
} catch {
  Write-Host "[ok] no scheduled task found"
}

# 2. notify hook line (only the one pointing at this plugin's notify.js)
$toml = Join-Path $CodexHome 'config.toml'
if (Test-Path $toml) {
  $lines = Get-Content $toml
  $notifyScript = Join-Path $PluginRoot 'lib\notify.js'
  $kept = $lines | Where-Object { $_ -notmatch '^\s*notify\s*=' -or $_ -notlike "*$notifyScript*" }
  if ($kept.Count -ne $lines.Count) {
    Set-Content -Path $toml -Encoding UTF8 -Value $kept
    Write-Host "[ok] notify hook removed from $toml"
  } else {
    Write-Host "[ok] notify hook not found in config.toml"
  }
}

# 3. purge runtime files (config only — user-side plugins keep no other local
#    files; the watcher heartbeat lives in the OS temp dir and expires alone)
if ($Purge) {
  foreach ($f in @(
    (Join-Path $PluginRoot 'rubato-mqtt-config.json'),
    (Join-Path $PluginRoot 'dsh-mqtt-config.json')
  )) { if (Test-Path $f) { Remove-Item $f -Force; Write-Host "[ok] deleted $f" } }
} else {
  Write-Host "[ok] kept config (use -Purge to delete it too)"
}

Write-Host 'Done.'
