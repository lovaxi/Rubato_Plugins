// Rubato (musical term: stolen time) — resident model-state monitor for Claude Code.
// User-side port of the DSH plugin (Rubato_Plugins/dsh, the authoritative
// implementation). Per PLUGIN_SPEC.md §1/§3/§5/§6 it stays MINIMAL: no local
// estimator/calibration, no archive/stats on disk (zero persistent local
// files except the config), no model tools. The daemon exists because Claude
// Code has no in-process plugin API — hooks are external processes — so one
// detached daemon owns the single persistent MQTT connection (spec §2.1) and
// the hook->daemon queue is the CC hook-mapping layer's transport (spec §7).
//
// Spawned detached by hooks/hook.mjs (single instance per user, lock file).
// Claude Code event -> Rubato message mapping:
//   UserPromptSubmit            -> Estimate (lean, no estSec) + Thinking
//   transcript: first text or
//   tool_use block              -> Generating (no first-delta hook exists)
//   transcript: stop_reason
//   end_turn / Stop hook        -> Done (lean wire: { model, state, ts })
//   StopFailure (API error)     -> Error followed by Done (un-stick, §2.4.6)
//   Notification idle_prompt /
//   SessionEnd / new prompt /
//   20-min stale guard          -> lean Done (the §2.4.8 finally-equivalent:
//                                  interrupted turns un-stick the device; on
//                                  user-side plugins there is no calibration
//                                  to skip)
//
// Broker/auth mirror the device firmware: username = deviceId
// (RUBATO-<mac6>), password = the per-unit token; clientId derives as
// CC-RUBATO-<mac6> (registered prefix, spec §2.2).
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, statSync, openSync, readSync, closeSync, writeSync as writeFdSync } from 'node:fs'
import { join } from 'node:path'
import { publishRecord, resetConn } from './mqtt.mjs'
import { loadConfig, configured, createConfigTemplate, runtimeDir, SETUP_MARKER } from './config.mjs'

const TICK_MS = 250            // queue scan cadence
const TRANSCRIPT_EVERY = 2     // transcript poll every 2nd tick (500 ms)
const IDLE_EXIT_MS = 10 * 60000    // no turns + no events -> exit (covers idle_prompt at ~60 s)
const STALE_TURN_MS = 20 * 60000   // hard un-stick guard (long-tool silence)
const HB_MS = 30000

const runtime = runtimeDir()
const queueDir = join(runtime, 'queue')
const statusPath = join(runtime, 'daemon.json')
const lockPath = join(runtime, 'daemon.lock')
try { mkdirSync(queueDir, { recursive: true }) } catch { /* exists */ }

// ---- single-instance lock ---------------------------------------------------

function isAlive(pid) {
  try { process.kill(pid, 0); return true } catch (e) { return e && e.code === 'EPERM' }
}

function acquireLock() {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockPath, 'wx')
      try { writeFdSync(fd, String(process.pid)) } catch { /* best effort */ }
      try { closeSync(fd) } catch { /* ignore */ }
      return true
    } catch {
      let pid = NaN
      try { pid = parseInt(readFileSync(lockPath, 'utf8').trim(), 10) } catch { /* gone */ }
      if (Number.isInteger(pid) && pid > 0) {
        if (isAlive(pid)) return false // a live daemon owns the queue; exit
      } else {
        // Empty/racing lock file: give the writer a beat, then re-check.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300)
        try { pid = parseInt(readFileSync(lockPath, 'utf8').trim(), 10) } catch { /* gone */ }
        if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) return false
      }
      try { unlinkSync(lockPath) } catch { /* someone else broke it */ }
    }
  }
  return false
}

// ---- state ------------------------------------------------------------------
const state = {
  published: 0,
  failed: 0,
  last: null, // { ok, at, state }
}
const sessions = new Map() // sessionId -> { model, lastModel, transcriptPath, turn, lastEventAt }
let lastEventAt = Date.now()
let lastHbAt = 0
let tickPhase = 0
let shuttingDown = false
let publishChain = Promise.resolve()

function getSession(id) {
  let s = sessions.get(id)
  if (!s) {
    s = { model: null, lastModel: null, transcriptPath: null, turn: null, lastEventAt: Date.now() }
    sessions.set(id, s)
  }
  return s
}

// ---- publish (lean wire, spec §2.3/§2.4.5) ----------------------------------
// User-side plugins have no archive, so there is no wire separation — every
// record is published exactly as built. Done carries only { model, state, ts }.
function publish(record) {
  const cfg = loadConfig() // hot reload per record (spec §4)
  // Clear the one-time setup marker once credentials are present, so a later
  // misconfiguration re-alerts.
  if (configured(cfg)) {
    const marker = join(runtime, SETUP_MARKER)
    if (existsSync(marker)) { try { unlinkSync(marker) } catch { /* ignore */ } }
  }
  publishChain = publishChain.then(
    () => publishNow(cfg, record),
    () => publishNow(cfg, record),
  )
  return publishChain
}

function publishNow(cfg, record) {
  if (!cfg.enabled || !configured(cfg)) return Promise.resolve()
  return publishRecord(cfg, record).then(
    () => {
      state.published += 1
      state.last = { ok: true, at: Date.now(), state: record.state }
      writeStatus()
    },
    (e) => {
      state.failed += 1
      state.last = { ok: false, at: Date.now(), state: record.state, detail: String(e && e.message || e) }
      writeStatus()
    },
  )
}

// ---- turn lifecycle ---------------------------------------------------------
// Tail-scan the transcript for the model id of the most recent assistant
// message. The estimator (spec §3) stays dsh-only, but the model name on the
// wire still needs a best-effort source at turn start.
function tailModel(path) {
  try {
    const st = statSync(path)
    if (!st.isFile() || st.size === 0) return null
    const fd = openSync(path, 'r')
    try {
      const len = Math.min(st.size, 65536)
      const buf = Buffer.alloc(len)
      const got = readSync(fd, buf, 0, len, st.size - len)
      const text = buf.toString('utf8', 0, got)
      let hit
      let model = null
      const re = /"model"\s*:\s*"([^"]+)"/g
      while ((hit = re.exec(text))) model = hit[1]
      return model
    } finally {
      try { closeSync(fd) } catch { /* ignore */ }
    }
  } catch { return null }
}

function startTurn(session, event) {
  const now = Date.now()
  // A still-active turn here means the previous turn ended without a terminal
  // event (user interrupt / crash): un-stick the device before the new turn
  // (spec §2.4.8 semantics, hook-mapped).
  if (session.turn && !session.turn.finalized) finalizeDone(session)
  session.transcriptPath = event.transcriptPath || session.transcriptPath
  if (session.transcriptPath && !session.lastModel) session.lastModel = tailModel(session.transcriptPath)
  const model = session.model || session.lastModel || 'unknown'
  let offset = 0
  try { offset = statSync(session.transcriptPath).size } catch { offset = 0 }
  session.turn = {
    startedAt: now,
    model,
    generatingAt: 0,
    error: null,
    finalized: false,
    transcriptPath: session.transcriptPath,
    offset,
    remainder: '',
    lastActivityAt: now,
  }
  publish({ model, state: 'Estimate', ts: now }) // lean: estSec is dsh-only (§3)
  // Thinking fires at prompt time (spec §2.4.2 — at stream start, not on the
  // first reasoning chunk): the device must not trail the real rhythm.
  publish({ model, state: 'Thinking', ts: now })
  writeStatus()
}

function handleAssistantRecord(session, rec) {
  const turn = session.turn
  if (!turn || turn.finalized) return
  const m = rec.message
  if (!m || typeof m !== 'object') return
  if (typeof m.model === 'string' && m.model) {
    if (turn.model === 'unknown') turn.model = m.model
    session.lastModel = m.model
  }
  const content = Array.isArray(m.content) ? m.content : []
  for (const b of content) {
    // First answer/tool block of the turn -> Generating (spec §2.3).
    if (b && (b.type === 'text' || b.type === 'tool_use') && !turn.generatingAt) {
      turn.generatingAt = Date.now()
      publish({ model: turn.model, state: 'Generating', ts: turn.generatingAt })
      break
    }
  }
  if (rec.isApiErrorMessage) {
    turn.error = typeof m.content === 'string'
      ? m.content
      : (Array.isArray(m.content) && m.content[0] && m.content[0].text) || 'api error'
  }
  // stop_reason end_turn = the turn really finished (spec §2.4.3: intermediate
  // tool-calls steps carry stop_reason tool_use and never finalize here).
  if (m.stop_reason === 'end_turn') finalizeDone(session)
}

function readNewTranscriptLines(session) {
  const turn = session.turn
  let st = null
  try { st = statSync(turn.transcriptPath) } catch { return }
  if (st.size < turn.offset) { // transcript rewritten (e.g. auto-compact)
    turn.offset = 0
    turn.remainder = ''
  }
  if (st.size === turn.offset) return
  turn.lastActivityAt = Date.now()
  const fd = openSync(turn.transcriptPath, 'r')
  let chunk = ''
  try {
    const buf = Buffer.alloc(st.size - turn.offset)
    const got = readSync(fd, buf, 0, buf.length, turn.offset)
    turn.offset += got
    chunk = turn.remainder + buf.toString('utf8', 0, got)
  } finally {
    try { closeSync(fd) } catch { /* ignore */ }
  }
  const lines = chunk.split('\n')
  turn.remainder = lines.pop() || '' // last line may be incomplete
  for (const line of lines) {
    const t = line.trim()
    if (!t) continue
    let rec
    try { rec = JSON.parse(t) } catch { continue }
    if (rec && rec.type === 'assistant') handleAssistantRecord(session, rec)
  }
}

// Turn over for the device — always the lean wire Done (spec §2.4.5). There is
// no user-side distinction between "natural" and "un-stick" completions on the
// wire: no tokens, no calibration (§3/§5 are dsh-only).
function finalizeDone(session) {
  const turn = session.turn
  if (!turn || turn.finalized) return
  turn.finalized = true
  publish({ model: turn.model, state: 'Done', ts: Date.now() })
  session.turn = null
  writeStatus()
}

// Error must be followed by Done: the device only exits the breathing state
// on Done (spec §2.4.6).
function finalizeError(session, errorText) {
  const turn = session.turn
  if (!turn || turn.finalized) return
  publish({ model: turn.model, state: 'Error', ts: Date.now(), error: String(errorText || 'error') })
  finalizeDone(session)
}

// ---- queue dispatch ---------------------------------------------------------
function dispatch(ev) {
  if (!ev || typeof ev !== 'object' || !ev.type) return
  lastEventAt = Date.now()
  switch (ev.type) {
    case 'hello': {
      const s = getSession(ev.sessionId)
      s.lastEventAt = lastEventAt
      if (ev.model && typeof ev.model === 'string') s.model = ev.model
      if (ev.transcriptPath) s.transcriptPath = ev.transcriptPath
      break
    }
    case 'model': {
      const s = getSession(ev.sessionId)
      s.lastEventAt = lastEventAt
      if (ev.toModel && typeof ev.toModel === 'string') s.model = ev.toModel
      break
    }
    case 'prompt': {
      if (typeof ev.prompt !== 'string' || !ev.prompt) break
      const s = getSession(ev.sessionId)
      s.lastEventAt = lastEventAt
      startTurn(s, ev)
      break
    }
    case 'stop': {
      const s = getSession(ev.sessionId)
      s.lastEventAt = lastEventAt
      if (s.turn && !s.turn.finalized) finalizeDone(s)
      break
    }
    case 'stopfailure': {
      const s = getSession(ev.sessionId)
      s.lastEventAt = lastEventAt
      if (s.turn && !s.turn.finalized) finalizeError(s, ev.error || 'api error')
      break
    }
    case 'idle': {
      // idle_prompt fires ~60 s after Claude finished responding with no user
      // input — the safety net for interrupted turns (Esc fires no Stop).
      const s = getSession(ev.sessionId)
      s.lastEventAt = lastEventAt
      if (s.turn && !s.turn.finalized) finalizeDone(s)
      break
    }
    case 'end': {
      const s = sessions.get(ev.sessionId)
      if (s) {
        s.lastEventAt = lastEventAt
        if (s.turn && !s.turn.finalized) finalizeDone(s)
        sessions.delete(ev.sessionId)
      }
      break
    }
    default:
      break
  }
}

function processQueue() {
  let files = []
  try { files = readdirSync(queueDir).filter((f) => f.endsWith('.json')).sort() } catch { return }
  for (const f of files) {
    const p = join(queueDir, f)
    let ev = null
    try { ev = JSON.parse(readFileSync(p, 'utf8')) } catch { ev = null }
    try { unlinkSync(p) } catch { /* daemon race: skip */ }
    if (ev) dispatch(ev)
  }
}

// ---- status file in the runtime dir (read by tools/status.mjs) --------------
function writeStatus() {
  const cfg = loadConfig()
  const doc = {
    pid: process.pid,
    startedAt: state.startedAt,
    hb: Date.now(),
    running: true,
    configured: configured(cfg),
    enabled: cfg.enabled,
    host: cfg.host,
    clientId: cfg.clientId || null,
    topic: cfg.topic || null,
    configPath: cfg._path,
    published: state.published,
    failed: state.failed,
    lastPublish: state.last,
  }
  try { writeFileSync(statusPath, JSON.stringify(doc), 'utf8') } catch { /* best effort */ }
}

// ---- lifecycle --------------------------------------------------------------
if (!acquireLock()) process.exit(0) // a live daemon already owns the queue

state.startedAt = Date.now()
const bootCfg = loadConfig()
if (!bootCfg._path) createConfigTemplate()
writeStatus()

function shutdown(reason) {
  if (shuttingDown) return
  shuttingDown = true
  if (timer) clearInterval(timer)
  resetConn()
  try { unlinkSync(lockPath) } catch { /* ignore */ }
  try { unlinkSync(statusPath) } catch { /* ignore */ }
  process.exit(0)
}

const timer = setInterval(() => {
  try {
    processQueue()
    tickPhase += 1
    for (const [id, s] of sessions) {
      if (!s.turn || s.turn.finalized) continue
      if (tickPhase % TRANSCRIPT_EVERY === 0) readNewTranscriptLines(s)
      // The transcript poll above may have finalized the turn (end_turn):
      // re-check before touching turn fields.
      if (s.turn && !s.turn.finalized
        && Date.now() - Math.max(s.turn.startedAt, s.turn.lastActivityAt) > STALE_TURN_MS) {
        finalizeDone(s)
      }
    }
    const anyTurn = [...sessions.values()].some((s) => s.turn && !s.turn.finalized)
    // Prune idle session records so a long-lived daemon cannot grow unbounded.
    for (const [id, s] of sessions) {
      if ((!s.turn || s.turn.finalized) && Date.now() - s.lastEventAt > 3600000) sessions.delete(id)
    }
    if (!anyTurn && Date.now() - lastEventAt > IDLE_EXIT_MS) shutdown('idle')
    if (Date.now() - lastHbAt > HB_MS) {
      lastHbAt = Date.now()
      writeStatus()
    }
  } catch {
    // Spec console policy: config reminders only. A malformed event or a
    // transient fs error must never kill the daemon — the desk device depends
    // on it for the un-stick Done messages.
  }
}, TICK_MS)

// Registered after the timer exists so an early signal never hits the
// temporal dead zone on `timer`.
process.on('SIGINT', () => shutdown('sigint'))
process.on('SIGTERM', () => shutdown('sigterm'))
