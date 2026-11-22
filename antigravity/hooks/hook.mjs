// Rubato hook entry — one tiny, fast process per Antigravity lifecycle hook.
// Antigravity runs command hooks synchronously, so this script never touches
// the network: it drops one JSON event into <runtime>/queue/, ensures a single
// detached daemon (lib/daemon.mjs) is running, prints the required hook JSON
// response to stdout, and exits immediately (<15 ms).
//
// Usage (hooks.json): node ./hooks/hook.mjs <event>
//   session-start | pre-invocation | post-tool-use | post-invocation | stop
//
// Every failure is swallowed (exit 0) so the status plugin can never disturb
// or block an Antigravity session.
import { readFileSync, readSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import {
  loadConfig, configured, createConfigTemplate, runtimeDir,
  SETUP_MARKER, setupMarkdown,
} from '../lib/config.mjs'

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const event = process.argv[2]

function readStdinJson() {
  try {
    if (process.stdin.isTTY) return {}
    const chunks = []
    const buf = Buffer.allocUnsafe(65536)
    for (;;) {
      try {
        const n = readSync(0, buf, 0, buf.length, null)
        if (n === 0) break
        chunks.push(Buffer.from(buf.subarray(0, n)))
      } catch (e) {
        if (e && e.code === 'EAGAIN') continue
        break
      }
    }
    const raw = Buffer.concat(chunks).toString('utf8').trim()
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true } catch (e) { return e && e.code === 'EPERM' }
}

function pidFromFile(path) {
  try {
    const raw = readFileSync(path, 'utf8').trim()
    if (!raw) return 0
    if (raw.startsWith('{')) {
      const doc = JSON.parse(raw)
      return Number.isInteger(doc.pid) && doc.pid > 0 ? doc.pid : 0
    }
    const pid = parseInt(raw, 10)
    return Number.isInteger(pid) && pid > 0 ? pid : 0
  } catch {
    return 0
  }
}

function daemonRunning() {
  const dir = runtimeDir()
  const statusPid = pidFromFile(join(dir, 'daemon.json'))
  if (statusPid > 0 && isAlive(statusPid)) return true
  const lockPid = pidFromFile(join(dir, 'daemon.lock'))
  return lockPid > 0 && isAlive(lockPid)
}

function ensureDaemon() {
  if (daemonRunning()) return
  // Detached + stdio ignore + unref: the daemon outlives this hook process.
  // It exits by itself after 10 idle minutes and re-spawns on demand.
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
  const ts = String(Date.now()).padStart(15, '0')
  const pid = String(process.pid).padStart(7, '0')
  const rand = Math.random().toString(36).slice(2, 8)
  writeFileSync(join(queueDir, `${ts}-${pid}-${rand}.json`), JSON.stringify(payload), 'utf8')
}

function workspaceCwdOf(input) {
  if (typeof input.cwd === 'string' && input.cwd) return input.cwd
  if (Array.isArray(input.workspacePaths) && typeof input.workspacePaths[0] === 'string' && input.workspacePaths[0]) {
    return input.workspacePaths[0]
  }
  return null
}

function defaultOutput(ev) {
  return ev === 'stop' ? { decision: 'allow' } : {}
}

function main() {
  if (!event) return {}
  const input = readStdinJson()
  const conversationId = typeof input.conversationId === 'string' && input.conversationId
    ? input.conversationId
    : 'unknown'
  const transcriptPath = typeof input.transcriptPath === 'string' && input.transcriptPath
    ? input.transcriptPath
    : null
  const modelName = typeof input.modelName === 'string' && input.modelName
    ? input.modelName
    : null
  const cwd = workspaceCwdOf(input)

  switch (event) {
    case 'session-start':
      enqueue({ type: 'hello', conversationId, transcriptPath, modelName, cwd })
      break
    case 'pre-invocation':
      enqueue({
        type: 'pre-invocation',
        conversationId,
        transcriptPath,
        modelName,
        cwd,
        invocationNum: typeof input.invocationNum === 'number' ? input.invocationNum : null,
        initialNumSteps: typeof input.initialNumSteps === 'number' ? input.initialNumSteps : null,
        lastUserInput: typeof input.lastUserInput === 'string' ? input.lastUserInput : '',
      })
      break
    case 'post-tool-use':
      enqueue({
        type: 'post-tool-use',
        conversationId,
        transcriptPath,
        modelName,
        cwd,
        toolName: input.toolCall && typeof input.toolCall.name === 'string' ? input.toolCall.name : null,
        stepIdx: typeof input.stepIdx === 'number' ? input.stepIdx : null,
        error: typeof input.error === 'string' ? input.error : null,
      })
      break
    case 'post-invocation':
      enqueue({
        type: 'post-invocation',
        conversationId,
        transcriptPath,
        modelName,
        cwd,
        invocationNum: typeof input.invocationNum === 'number' ? input.invocationNum : null,
        initialNumSteps: typeof input.initialNumSteps === 'number' ? input.initialNumSteps : null,
      })
      break
    case 'stop':
      enqueue({
        type: 'stop',
        conversationId,
        transcriptPath,
        modelName,
        cwd,
        terminationReason: typeof input.terminationReason === 'string' ? input.terminationReason : null,
        error: typeof input.error === 'string' ? input.error : '',
        continuationActive: Boolean(input.continuationActive),
      })
      break
    default:
      return defaultOutput(event)
  }

  ensureDaemon()

  // One-time SETUP REQUIRED warning shown inline to the user via user_markdown
  // with empty systemMessage so it never enters the model's context. The daemon
  // clears the marker once credentials are present, so a later removal re-alerts.
  if (event === 'pre-invocation') {
    try {
      const cfg = loadConfig(cwd)
      if (!configured(cfg)) {
        const marker = join(runtimeDir(), SETUP_MARKER)
        if (!existsSync(marker)) {
          const templatePath = cfg._path || createConfigTemplate()
          writeFileSync(marker, String(Date.now()), 'utf8')
          return {
            injectSteps: [
              {
                systemMessage: {
                  systemMessage: '',
                  metadata: {
                    user_markdown: setupMarkdown({ ...cfg, _path: templatePath }),
                  },
                },
              },
            ],
            terminationBehavior: '',
          }
        }
      }
    } catch { /* best effort */ }
  }

  return defaultOutput(event)
}

let out = {}
try {
  out = main() || {}
} catch {
  out = defaultOutput(event)
}
try {
  process.stdout.write(JSON.stringify(out) + '\n')
} catch { /* ignore */ }
process.exitCode = 0
