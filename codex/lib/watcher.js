// Rubato for Codex — session watcher (the plugin's long-running half).
// User-side port of the DSH plugin per PLUGIN_SPEC.md: MINIMAL — no estimator
// (§3), no archive/stats (§5), no model tools (§6); the wire is the lean
// user-side message set (§2.3):
//   Estimate   { model, state, ts }            turn starting, no estSec
//   Thinking   { model, state, ts }            turn started
//   Generating { model, state, ts }            first agent_message/tool activity
//   Done       { model, state, ts }            turn really finished (lean)
//   Error      { model, state, ts, error }     call failed -> immediately Done
//
// Runtime model:
//   - Tails $CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl (poll-based, fully
//     cross-platform) and runs the per-session state machine (codex-state.js,
//     the hook mapping layer) over appended lines.
//   - Files already present at startup are fast-forwarded silently (state
//     advances, nothing publishes) so a fresh watcher never replays old turns.
//   - Tail handling: a last line without a trailing newline may still be
//     growing OR be genuinely final; pendingFrom/pendingEof re-reads it from
//     its start and, once the file size stalls for one poll, parses it as
//     final. Without this, a rollout ending in task_complete without a newline
//     would never publish Done.
//   - A watchdog unsticks a turn left open for more than 15 minutes (Codex
//     killed without a shutdown event): lean Done, no Error (§2.4.8 semantics).
//   - Heartbeat: {ts, pid} in the OS temp dir lets lib/notify.js detect
//     liveness. This is runtime process coordination, not diagnostics — the
//     only local writes outside the config live in the OS temp dir.
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'
import { loadConfig, createConfigTemplate, CONFIG_NAME } from './config.js'
import { createSessionState, applyLine } from './codex-state.js'
import { publishRecord, dropConnection } from './mqtt.js'

const WATCHDOG_MS = 15 * 60 * 1000 // open-turn unstuck threshold
const HEARTBEAT_TTL_MS = 15000 // notify hook considers the watcher alive below this age

// Diagnostics gate: RUBATO_DEBUG=1 enables one-line-per-event tracing on
// stderr. Off by default — the spec's console policy (config reminders only)
// applies to normal operation.
const DEBUG = process.env.RUBATO_DEBUG === '1'
const dbg = (msg) => { if (DEBUG) console.error('[Rubato:debug] ' + msg) }

export function heartbeatPath() {
  return join(os.tmpdir(), 'rubato-codex-watcher.json')
}

export function watcherAlive() {
  try {
    const hb = JSON.parse(readFileSync(heartbeatPath(), 'utf8'))
    if (hb.stopped) return false
    return Date.now() - (hb.ts || 0) < HEARTBEAT_TTL_MS
  } catch { return false }
}

function defaultCodexHome() {
  return join(os.homedir(), '.codex')
}

// Collect rollout files: sessions/YYYY/MM/DD/rollout-*.jsonl (three date
// levels; tolerate files placed directly under sessions/ as well).
function listSessionFiles(home) {
  const base = join(home, 'sessions')
  const out = []
  const pushIfRollout = (p) => {
    if (/rollout-.*\.jsonl$/.test(p)) out.push(p)
  }
  try {
    for (const y of readdirSafe(base)) {
      const yPath = join(base, y)
      if (!isDir(yPath)) { pushIfRollout(yPath); continue }
      for (const m of readdirSafe(yPath)) {
        const mPath = join(yPath, m)
        if (!isDir(mPath)) { pushIfRollout(mPath); continue }
        for (const d of readdirSafe(mPath)) {
          const dPath = join(mPath, d)
          if (!isDir(dPath)) { pushIfRollout(dPath); continue }
          for (const f of readdirSafe(dPath)) pushIfRollout(join(dPath, f))
        }
      }
    }
  } catch { /* sessions dir missing until Codex runs */ }
  return out
}

function readdirSafe(p) {
  try { return readdirSync(p) } catch { return [] }
}

function isDir(p) {
  try { return statSync(p).isDirectory() } catch { return false }
}

// Console policy (spec §4): configuration reminders ONLY.
function printSetupBannerIfUnconfigured(cfg) {
  if (cfg.enabled && (!cfg.host || !cfg.topic)) {
    console.error('[Rubato] enabled but host/topic missing; fix rubato-mqtt-config.json')
  }
  if (!cfg.username || !cfg.password) {
    console.error('============================================================')
    console.error('[Rubato] SETUP REQUIRED - MQTT credentials not configured')
    console.error('  1. open:        ' + (cfg._path || '<plugin root>/' + CONFIG_NAME))
    console.error('  2. "username":  the deviceId printed on the device sticker (RUBATO-xxxxxx)')
    console.error('  3. "password":  the token paired with that deviceId')
    console.error('  save the file and you are done - the plugin auto-enables once both')
    console.error('  fields are filled (next record, no restart).')
    console.error('============================================================')
  }
}

// Start the watcher loop. `publish` is injectable for the smoke test; by
// default records go to the broker when configured and are dropped otherwise
// (user-side plugins keep zero local persistence, spec §5).
export function startWatcher(opts = {}) {
  const injectPublish = opts.publish || null
  const pollMs = Math.max(30, opts.pollMs || 500)
  let cfg = loadConfig(opts.configPath ? { configPath: opts.configPath } : undefined)
  if (!cfg._path && !opts.configPath) createConfigTemplate()
  printSetupBannerIfUnconfigured(cfg)

  const files = new Map() // path -> { offset, sess, pendingFrom, pendingEof, openSince }
  let stopped = false

  const beat = () => {
    if (injectPublish) return // smoke mode: no temp-dir writes
    try { writeFileSync(heartbeatPath(), JSON.stringify({ ts: Date.now(), pid: process.pid }), 'utf8') } catch { /* best effort */ }
  }

  // Fast-forward or incrementally read one file; return ordered actions.
  function readActions(path, entry, o) {
    const fast = Boolean(o && o.fast)
    let forceFinal = Boolean(o && o.forceFinal)
    let size = 0
    try { size = statSync(path).size } catch { return [] }
    if (entry.offset > size) { // truncated/rotated: restart silently
      entry.offset = 0
      entry.sess = createSessionState()
      entry.pendingFrom = null
      entry.pendingEof = 0
    }
    if (entry.pendingFrom != null) {
      const grew = size > entry.pendingEof
      forceFinal = !grew // stalled: the pending tail is final, parse it now
      entry.offset = entry.pendingFrom // either way, re-read from its start
      entry.pendingFrom = null
      entry.pendingEof = 0
    }
    if (size === entry.offset) return []
    let text = ''
    try {
      const fd = readFileSync(path)
      text = fd.subarray(entry.offset).toString('utf8')
      entry.offset = size
    } catch { return [] }
    const actions = []
    const lines = text.split(/\r?\n/)
    // Last element is '' when the file ends with a newline; otherwise the
    // unterminated tail is parked (unless forceFinal) and re-read next poll.
    if (!forceFinal && lines.length > 0 && lines[lines.length - 1] !== '') {
      const partial = lines.pop()
      entry.pendingFrom = entry.offset - Buffer.byteLength(partial, 'utf8')
      entry.pendingEof = size
    }
    for (const line of lines) {
      const s = line.trim()
      if (!s) continue
      let obj
      try { obj = JSON.parse(s) } catch { continue }
      actions.push(...applyLine(entry.sess, obj, Date.now()))
    }
    if (fast) return [] // state advanced, events discarded
    return actions
  }

  function publishOpenPair(entry, ts, model) {
    // Estimate first (spec §2.4.1) — user-side plugins publish it WITHOUT
    // estSec (§2.3); the device treats Estimate as pure metadata. Thinking
    // fires at turn start (not on the first reasoning delta): prefill on
    // large contexts can delay the first delta by seconds — the device must
    // not trail it.
    void publish({ model, state: 'Estimate', ts })
    void publish({ model, state: 'Thinking', ts })
  }

  function flushActions(path, actions) {
    const entry = files.get(path)
    if (!entry) return
    for (const a of actions) {
      const model = entry.sess.model || 'unknown'
      if (a.kind === 'open-turn') {
        entry.openSince = Date.now()
        const ts = entry.sess.turn ? entry.sess.turn.tStart : Date.now()
        if (entry.sess.model) {
          publishOpenPair(entry, ts, model)
        } else {
          // Codex >= 0.153 announces the model in turn_context AFTER
          // task_started: stash the opening pair and flush on 'model-known'
          // (or at turn end) so the device never sees model "unknown".
          entry.pendingOpen = { ts }
        }
      } else if (a.kind === 'model-known') {
        if (entry.pendingOpen) {
          publishOpenPair(entry, entry.pendingOpen.ts, model)
          entry.pendingOpen = null
        }
      } else if (a.kind === 'emit') {
        void publish({ model, state: a.state, ts: Date.now() })
      } else if (a.kind === 'end') {
        if (entry.pendingOpen) {
          // Turn ended before the model ever became known (rare): still emit
          // the opening pair so the state sequence stays ordered.
          publishOpenPair(entry, entry.pendingOpen.ts, model)
          entry.pendingOpen = null
        }
        if (a.how === 'error') {
          void publish({ model, state: 'Error', ts: Date.now(), error: a.detail || 'error' })
        }
        // Complete, interrupted (user stop / shutdown / watchdog) and error all
        // end in the same lean Done — it is the only state that un-sticks the
        // device (spec §2.4.5/6/8).
        void publish({ model, state: 'Done', ts: Date.now() })
        entry.openSince = 0
      }
    }
  }

  function poll(fastForwardNewFiles) {
    cfg = loadConfig(opts.configPath ? { configPath: opts.configPath } : undefined)
    const home = opts.codexHome || defaultCodexHome()
    const seen = new Set()
    for (const path of listSessionFiles(home)) {
      seen.add(path)
      let entry = files.get(path)
      if (!entry) {
        entry = { offset: 0, sess: createSessionState(), openSince: 0, pendingFrom: null, pendingEof: 0, pendingOpen: null }
        files.set(path, entry)
      }
      // Files already on disk at startup (or first seen grown files) are
      // fast-forwarded silently; their unterminated tails are final.
      const fast = fastForwardNewFiles && entry.offset === 0 && !entry.live
      if (DEBUG && !fast && entry.offset === 0 && !entry.live) dbg('new live file: ' + path)
      const actions = readActions(path, entry, { fast, forceFinal: fast })
      if (fast && entry.sess.turn) {
        // The fast-forwarded session ended mid-turn (Codex was killed): arm
        // the watchdog from NOW so the stale turn still un-sticks the device.
        entry.openSince = Date.now()
      }
      if (DEBUG && actions.length) dbg('actions from ' + path.split(/[\\/]/).pop() + ': ' + JSON.stringify(actions))
      if (!fast && actions.length) flushActions(path, actions)
      if (!fast) entry.live = true
    }
    for (const path of [...files.keys()]) {
      if (!seen.has(path)) files.delete(path)
    }
  }

  function watchdog() {
    const now = Date.now()
    for (const [path, entry] of files) {
      if (entry.sess.turn && entry.openSince && now - entry.openSince > WATCHDOG_MS) {
        flushActions(path, [{ kind: 'end', how: 'interrupted' }])
        entry.sess.turn = null
        entry.openSince = 0
      }
    }
  }

  const publish = injectPublish || (async (record) => {
    // Hot reload per record (spec §4). User-side: drop when unconfigured —
    // no archive, no local fallback (spec §5).
    if (!cfg.enabled || !cfg.username || !cfg.password) {
      dbg('drop (unconfigured): ' + JSON.stringify(record))
      return
    }
    try {
      await publishRecord(cfg, record)
      dbg('published: ' + JSON.stringify(record))
    } catch (e) {
      dbg('publish FAILED (' + (e && e.message) + '): ' + JSON.stringify(record))
    }
  })

  beat()
  poll(true) // startup: fast-forward everything already on disk
  const pollTimer = setInterval(() => { if (!stopped) poll(false) }, pollMs)
  const beatTimer = setInterval(beat, 5000)
  const dogTimer = setInterval(watchdog, 30000)

  const stop = () => {
    if (stopped) return
    stopped = true
    clearInterval(pollTimer); clearInterval(beatTimer); clearInterval(dogTimer)
    if (!injectPublish) {
      try { writeFileSync(heartbeatPath(), JSON.stringify({ ts: 0, pid: process.pid, stopped: true }), 'utf8') } catch { /* best effort */ }
      dropConnection()
    }
  }
  return { stop, cfg }
}

// Run directly (node lib/watcher.js); no-op when imported for tests.
export function main() {
  const w = startWatcher({})
  const shutdown = () => { w.stop(); process.exit(0) }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  process.on('uncaughtException', (e) => {
    try { console.error('[Rubato] watcher error:', e && e.message) } catch { /* ignore */ }
  })
  return w
}

if (process.argv[1] && /watcher\.(c?js|mjs)$/.test(process.argv[1].replace(/\\/g, '/'))) {
  main()
}
