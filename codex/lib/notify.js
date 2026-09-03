// Rubato for Codex — Codex `notify` hook (the plugin's lightweight half).
// Codex invokes this program once per notification event, passing one JSON
// object as its LAST argv element (see codex docs/config.md -> notify):
//   { "type": "agent-turn-complete", "turn-id": "...",
//     "input-messages": [...], "last-assistant-message": "..." }
// Role division with the watcher (lib/watcher.js):
//   - Watcher alive (heartbeat in the OS temp dir < 15s old): do nothing —
//     the watcher sees the rollout's task_complete line and publishes the
//     lean Done itself.
//   - Watcher dead: publish the un-sticking lean Done ourselves (the model is
//     salvaged from the newest rollout tail), then revive the watcher so the
//     next turn is captured live again.
// The wire is the lean user-side record { model, state:'Done', ts } — no
// tokens (spec §2.3/§5), no local files beyond the OS temp-dir heartbeat.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { loadConfig } from './config.js'
import { publishRecord } from './mqtt.js'

const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')

function watcherAlive() {
  try {
    const hb = JSON.parse(readFileSync(join(os.tmpdir(), 'rubato-codex-watcher.json'), 'utf8'))
    if (hb.stopped) return false
    return Date.now() - (hb.ts || 0) < 15000
  } catch { return false }
}

function newestRollout(home) {
  const base = join(home, 'sessions')
  let best = null
  let bestM = -1
  const scan = (dir, depth) => {
    let entries = []
    try { entries = readdirSync(dir) } catch { return }
    for (const name of entries) {
      const p = join(dir, name)
      let st
      try { st = statSync(p) } catch { continue }
      if (st.isDirectory()) { if (depth < 3) scan(p, depth + 1); continue }
      if (/rollout-.*\.jsonl$/.test(name) && st.mtimeMs > bestM) { best = p; bestM = st.mtimeMs }
    }
  }
  scan(base, 0)
  return best
}

// Salvage the effective model from the rollout tail (last turn_context wins).
function salvageModel(path) {
  if (!path || !existsSync(path)) return null
  let text = ''
  try {
    const fd = readFileSync(path)
    const start = Math.max(0, fd.length - 256 * 1024)
    text = fd.subarray(start).toString('utf8')
  } catch { return null }
  const lines = text.split(/\r?\n/).filter((l) => l.trim())
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    let obj
    try { obj = JSON.parse(lines[i]) } catch { continue }
    const p = obj && obj.payload
    if (obj && obj.type === 'turn_context' && p && typeof p.model === 'string' && p.model) return p.model
  }
  return null
}

function reviveWatcher() {
  try {
    const child = spawn(process.execPath, [join(PLUGIN_DIR, 'lib', 'watcher.js')], {
      cwd: PLUGIN_DIR,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.unref()
  } catch { /* best effort */ }
}

function main() {
  // The JSON payload arrives as the last argv element; be liberal about which
  // argument it is (older builds / wrappers may shift it).
  let event = null
  for (let i = process.argv.length - 1; i >= 1; i -= 1) {
    const a = process.argv[i]
    if (a && a.trim().startsWith('{')) {
      try { event = JSON.parse(a); break } catch { /* try next */ }
    }
  }
  if (!event) return // nothing parseable: stay silent, never break the TUI
  if (event.type !== 'agent-turn-complete') return // future event types: ignore

  const cfg = loadConfig()
  if (!cfg.enabled || !cfg.username || !cfg.password) return // nothing to publish
  if (watcherAlive()) return // watcher owns Done publishing while alive

  // Watcher dead: publish the un-sticking lean Done, then bring it back.
  const model = salvageModel(newestRollout(join(os.homedir(), '.codex'))) || 'codex'
  const publish = publishRecord(cfg, { model, state: 'Done', ts: Date.now() })
  const timeout = new Promise((r) => setTimeout(r, 5000))
  Promise.race([publish.catch(() => {}), timeout]).then(() => {
    reviveWatcher()
    process.exit(0)
  })
}

process.on('uncaughtException', () => { /* never break the TUI */ })
main()
