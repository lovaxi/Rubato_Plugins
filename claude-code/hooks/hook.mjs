// Rubato hook entry — one tiny, fast process per Claude Code hook event.
// It never talks to the network: it drops one JSON file into the runtime
// dir's queue/ and, when no live daemon is found, spawns one detached daemon
// (lib/daemon.mjs) that owns the persistent MQTT connection, tails the session
// transcripts and publishes Estimate/Thinking/Generating/Done.
//
// Usage (exec-form hooks, hooks.json): node hook.mjs <event>
//   sessionstart | prompt | stop | stopfailure | idle | sessionend | modelswitch
//
// Hook stdin JSON is read but only a few fields are used; every failure is
// swallowed (exit 0, silent) so the plugin can never disturb a session.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import {
  loadConfig, configured, createConfigTemplate, runtimeDir,
  SETUP_MARKER, setupNotice,
} from '../lib/config.mjs'

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const event = process.argv[2]

function readStdinJson() {
  try {
    if (process.stdin.isTTY) return {}
    const raw = readFileSync(0, 'utf8').trim()
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true } catch (e) { return e && e.code === 'EPERM' }
}

function daemonRunning() {
  try {
    const doc = JSON.parse(readFileSync(join(runtimeDir(), 'daemon.json'), 'utf8'))
    return Number.isInteger(doc.pid) && doc.pid > 0 && isAlive(doc.pid)
  } catch {
    return false
  }
}

function ensureDaemon() {
  if (daemonRunning()) return
  // Detached + stdio ignore + unref: the daemon outlives this hook process.
  // It exits by itself after 10 idle minutes and re-spawns on demand. The
  // environment passes through untouched: the daemon resolves its own config
  // candidates (cwd / CLAUDE_PLUGIN_DATA / plugin root) and runtime dir; a
  // user-set RUBATO_DATA_DIR overrides both (tests, manual runs).
  const child = spawn(process.execPath, [join(PLUGIN_ROOT, 'lib', 'daemon.mjs')], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env },
  })
  child.unref()
}

function enqueue(payload) {
  const queueDir = join(runtimeDir(), 'queue')
  mkdirSync(queueDir, { recursive: true })
  const name = Date.now() + '-' + process.pid + '-' + Math.random().toString(36).slice(2, 8) + '.json'
  writeFileSync(join(queueDir, name), JSON.stringify(payload), 'utf8')
}

function main() {
  if (!event) return
  const input = readStdinJson()
  const sessionId = typeof input.session_id === 'string' ? input.session_id : 'unknown'

  switch (event) {
    case 'sessionstart':
      enqueue({
        type: 'hello', sessionId,
        transcriptPath: input.transcript_path || null,
        model: typeof input.model === 'string' ? input.model : null,
        source: input.source || null,
      })
      break
    case 'prompt':
      enqueue({
        type: 'prompt', sessionId,
        transcriptPath: input.transcript_path || null,
        prompt: typeof input.prompt === 'string' ? input.prompt : '',
      })
      break
    case 'stop':
      enqueue({ type: 'stop', sessionId })
      break
    case 'stopfailure':
      enqueue({ type: 'stopfailure', sessionId, error: input.error || null })
      break
    case 'idle': // Notification matcher: idle_prompt
      enqueue({ type: 'idle', sessionId })
      break
    case 'sessionend':
      enqueue({ type: 'end', sessionId })
      break
    case 'modelswitch': // PostModelSwitch
      enqueue({ type: 'model', sessionId, toModel: input.to_model || null })
      break
    default:
      return
  }

  ensureDaemon()

  // One-time SETUP REQUIRED warning (shown to the user as a systemMessage, so
  // it never enters Claude's context). The daemon clears the marker once
  // credentials are present, so a later misconfiguration re-alerts.
  if (event === 'prompt') {
    try {
      const cfg = loadConfig()
      if (!configured(cfg)) {
        const marker = join(runtimeDir(), SETUP_MARKER)
        if (!existsSync(marker)) {
          createConfigTemplate()
          writeFileSync(marker, String(Date.now()), 'utf8')
          process.stdout.write(JSON.stringify({ systemMessage: setupNotice(cfg) }) + '\n')
        }
      }
    } catch { /* best effort */ }
  }
}

try {
  main()
} catch {
  // Never block or error a session because of the status gadget.
}
process.exitCode = 0
