// Rubato (musical term: stolen time) — resident model-state monitor for Antigravity.
// User-side port of the DSH plugin (Rubato_Plugins/dsh, the authoritative
// implementation). Per PLUGIN_SPEC.md §1/§3/§5/§6 it stays MINIMAL: no local
// estimator/calibration, no archive/stats on disk (zero persistent local
// files except the config), no model tools. Because Antigravity hooks run as
// short-lived synchronous command processes, one detached daemon owns the
// single persistent MQTT connection (spec §2.1) and consumes queued hook events.
//
// Antigravity hook + transcript mapping -> Rubato wire messages (spec §2.3/§2.4):
//   PreInvocation             -> Estimate (lean, no estSec) + Thinking
//   transcript PLANNER_RESPONSE
//   (text content or tool_calls)
//   or PostToolUse            -> Generating
//   PLANNER_RESPONSE w/ tool_calls
//   or PostToolUse            -> intermediate step: NO Done (§2.4.3)
//   PostInvocation (no tools) -> arms 1500ms debounced Done (cancelled if Stop
//                                or next PreInvocation arrives)
//   Stop (NO_TOOL_CALL /
//   USER_CANCELED / MAX_*)    -> lean Done ({ model, state, ts }; §2.4.5/§2.4.8)
//   Stop (ERROR or .error)    -> Error + immediate lean Done (un-stick, §2.4.6)
//   Abandoned open turn or
//   20-min stale guard        -> lean Done (§2.4.8 safety net)
//
// Broker/auth mirror the device firmware: username = deviceId (RUBATO-<mac6>),
// password = per-unit token; clientId derives as AGY-<username>.
import {
  readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync,
  unlinkSync, statSync, openSync, readSync, closeSync, writeSync as writeFdSync,
} from 'node:fs'
import { join } from 'node:path'
import { publishRecord, resetConn } from './mqtt.mjs'
import { loadConfig, configured, createConfigTemplate, runtimeDir, SETUP_MARKER } from './config.mjs'

const TICK_MS = 250               // queue scan cadence
const TRANSCRIPT_EVERY = 2        // transcript poll every 2nd tick (500 ms)
const DONE_DEBOUNCE_MS = 1500     // safety net if Stop does not follow PostInvocation
const IDLE_EXIT_MS = 10 * 60000   // no active turns + no events -> exit
const STALE_TURN_MS = 20 * 60000  // hard un-stick guard (long-running turn)
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
  last: null, // { ok, at, state, detail? }
  lastCwd: null,
}
const sessions = new Map()
let lastEventAt = Date.now()
let lastHbAt = 0
let tickPhase = 0
let shuttingDown = false
let publishChain = Promise.resolve()

function getSession(id) {
  let s = sessions.get(id)
  if (!s) {
    s = {
      id,
      cwd: null,
      model: null,
      lastModel: null,
      transcriptPath: null,
      transcriptOffset: 0,
      transcriptSize: 0,
      transcriptMtimeMs: 0,
      transcriptRemainder: '',
      lastPlannerStepIdx: -1,
      fallbackLineIdx: 0,
      fastForwarded: false,
      turn: null,
      lastEventAt: Date.now(),
    }
    sessions.set(id, s)
  }
  return s
}

// ---- publish (lean wire, spec §2.3/§2.4.5) ----------------------------------
// User-side plugins have no archive, so there is no wire separation — every
// record is published exactly as built. Done carries only { model, state, ts }.
function publish(workspaceCwd, record) {
  if (workspaceCwd) state.lastCwd = workspaceCwd
  const cfg = loadConfig(workspaceCwd || state.lastCwd) // hot reload per record (spec §4)
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
      state.last = { ok: false, at: Date.now(), state: record.state, detail: String((e && e.message) || e) }
      writeStatus()
    },
  )
}

// ---- transcript inspection --------------------------------------------------
// Tail-scan transcript.jsonl for the most recent concrete model id when hooks
// report "auto" on an existing session.
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

function fastForwardTranscript(session) {
  session.fastForwarded = true
  if (!session.transcriptPath) return
  let st
  try { st = statSync(session.transcriptPath) } catch { return }
  if (!st.isFile() || st.size === 0) return
  try {
    const text = readFileSync(session.transcriptPath, 'utf8')
    const lines = text.split(/\r?\n/)
    let lineCount = 0
    for (const line of lines) {
      const t = line.trim()
      if (!t) continue
      lineCount += 1
      let rec
      try { rec = JSON.parse(t) } catch { continue }
      if (rec && rec.type === 'PLANNER_RESPONSE') {
        if (typeof rec.model === 'string' && rec.model) session.lastModel = rec.model
        if (typeof rec.step_index === 'number' && rec.step_index > session.lastPlannerStepIdx) {
          session.lastPlannerStepIdx = rec.step_index
        }
      }
    }
    session.transcriptOffset = st.size
    session.transcriptSize = st.size
    session.transcriptMtimeMs = st.mtimeMs
    session.transcriptRemainder = ''
    session.fallbackLineIdx = lineCount
  } catch { /* best effort */ }
}

function applyPlannerRecord(session, rec, stepKey) {
  if (typeof rec.model === 'string' && rec.model) session.lastModel = rec.model
  if (stepKey <= session.lastPlannerStepIdx) return
  session.lastPlannerStepIdx = stepKey

  const turn = session.turn
  if (!turn || turn.finalized) return
  turn.lastActivityAt = Date.now()
  if (typeof rec.model === 'string' && rec.model) {
    turn.model = rec.model
    if (turn.step) turn.step.model = rec.model
  }
  const hasText = typeof rec.content === 'string' && rec.content.length > 0
  const hasTools = Array.isArray(rec.tool_calls) && rec.tool_calls.length > 0
  if (hasTools && turn.step) turn.step.hadToolCalls = true
  if ((hasText || hasTools) && turn.step && !turn.step.generatingAt) {
    turn.step.generatingAt = Date.now()
    const model = turn.step.model || turn.model || 'unknown'
    publish(session.cwd, { model, state: 'Generating', ts: turn.step.generatingAt })
  }
}

function readNewTranscriptLines(session) {
  if (!session.transcriptPath) return
  let st
  try { st = statSync(session.transcriptPath) } catch { return }
  if (!st.isFile()) return
  if (st.size === session.transcriptSize && st.mtimeMs === session.transcriptMtimeMs) return

  // Antigravity may append lines or rewrite transcript.jsonl on step updates.
  let rewritten = st.size < session.transcriptOffset
    || (st.mtimeMs !== session.transcriptMtimeMs && st.size <= session.transcriptOffset)

  let chunk = ''
  const fd = openSync(session.transcriptPath, 'r')
  try {
    // If continuing mid-file with an empty remainder, verify the byte right
    // before offset is still '\n'; otherwise an in-place rewrite shifted lines.
    if (!rewritten && session.transcriptOffset > 0 && !session.transcriptRemainder) {
      const probe = Buffer.alloc(1)
      const pn = readSync(fd, probe, 0, 1, session.transcriptOffset - 1)
      if (pn !== 1 || probe[0] !== 0x0a) rewritten = true
    }
    if (rewritten) {
      session.transcriptOffset = 0
      session.transcriptRemainder = ''
      session.fallbackLineIdx = 0
    }
    if (st.size === session.transcriptOffset) {
      session.transcriptSize = st.size
      session.transcriptMtimeMs = st.mtimeMs
      return
    }
    const buf = Buffer.alloc(st.size - session.transcriptOffset)
    const got = readSync(fd, buf, 0, buf.length, session.transcriptOffset)
    session.transcriptOffset += got
    session.transcriptSize = st.size
    session.transcriptMtimeMs = st.mtimeMs
    chunk = session.transcriptRemainder + buf.toString('utf8', 0, got)
  } finally {
    try { closeSync(fd) } catch { /* ignore */ }
  }

  const lines = chunk.split(/\r?\n/)
  session.transcriptRemainder = lines.pop() || ''
  for (const line of lines) {
    const t = line.trim()
    if (!t) continue
    session.fallbackLineIdx += 1
    let rec
    try { rec = JSON.parse(t) } catch { continue }
    if (!rec || typeof rec !== 'object') continue
    if (rec.type === 'PLANNER_RESPONSE') {
      const stepKey = typeof rec.step_index === 'number' ? rec.step_index : session.fallbackLineIdx
      applyPlannerRecord(session, rec, stepKey)
    } else if ((rec.type === 'GENERIC' || rec.type === 'ERROR_MESSAGE') && session.turn && !session.turn.finalized) {
      session.turn.lastActivityAt = Date.now()
    }
  }
}

// ---- turn lifecycle ---------------------------------------------------------
function clearDoneTimer(turn) {
  if (turn && turn.doneTimer) {
    clearTimeout(turn.doneTimer)
    turn.doneTimer = null
  }
}

function resolveModel(session, hookModelName) {
  const raw = typeof hookModelName === 'string' ? hookModelName.trim() : ''
  if (raw && raw.toLowerCase() !== 'auto') {
    session.model = raw
    session.lastModel = raw
    return raw
  }
  if (session.lastModel) return session.lastModel
  if (session.transcriptPath) {
    const m = tailModel(session.transcriptPath)
    if (m) {
      session.lastModel = m
      return m
    }
  }
  return raw || 'unknown'
}

function isNewTurn(turn, ev) {
  if (ev.invocationNum != null && turn.lastInvocationNum != null && ev.invocationNum <= turn.lastInvocationNum) {
    return true
  }
  if (ev.lastUserInput && turn.lastUserInput && ev.lastUserInput !== turn.lastUserInput) {
    return true
  }
  return false
}

// Turn over for the device — always the lean wire Done (spec §2.4.5).
function finalizeDone(session) {
  const turn = session.turn
  if (!turn || turn.finalized) return
  clearDoneTimer(turn)
  turn.finalized = true
  const model = (turn.step && turn.step.model) || turn.model || session.lastModel || 'unknown'
  publish(session.cwd, { model, state: 'Done', ts: Date.now() })
  session.turn = null
  writeStatus()
}

// Error must be followed by Done: the device only exits the breathing state
// on Done (spec §2.4.6).
function finalizeError(session, errorText) {
  const turn = session.turn
  if (!turn || turn.finalized) return
  clearDoneTimer(turn)
  const model = (turn.step && turn.step.model) || turn.model || session.lastModel || 'unknown'
  publish(session.cwd, { model, state: 'Error', ts: Date.now(), error: String(errorText || 'error') })
  finalizeDone(session)
}

function syncSessionMeta(session, ev) {
  if (ev.cwd) session.cwd = ev.cwd
  if (ev.transcriptPath) {
    if (session.transcriptPath && session.transcriptPath !== ev.transcriptPath) {
      session.transcriptOffset = 0
      session.transcriptSize = 0
      session.transcriptMtimeMs = 0
      session.transcriptRemainder = ''
      session.lastPlannerStepIdx = -1
      session.fallbackLineIdx = 0
      session.fastForwarded = false
    }
    session.transcriptPath = ev.transcriptPath
  }
}

function handleHello(session, ev) {
  syncSessionMeta(session, ev)
  if (typeof ev.modelName === 'string' && ev.modelName && ev.modelName.toLowerCase() !== 'auto') {
    session.model = ev.modelName
    session.lastModel = ev.modelName
  }
  if (session.transcriptPath && !session.fastForwarded) fastForwardTranscript(session)
}

function handlePreInvocation(session, ev) {
  const now = Date.now()
  syncSessionMeta(session, ev)
  if (session.transcriptPath && !session.fastForwarded) {
    fastForwardTranscript(session)
  } else if (session.turn && !session.turn.finalized) {
    // Drain the previous step's PLANNER_RESPONSE before opening the next step.
    readNewTranscriptLines(session)
  }

  // An open turn whose invocation counter restarted (or prompt changed) means
  // the prior turn exited without Stop — un-stick with lean Done first (§2.4.8).
  if (session.turn && !session.turn.finalized && isNewTurn(session.turn, ev)) {
    finalizeDone(session)
  }

  const model = resolveModel(session, ev.modelName)
  if (!session.turn || session.turn.finalized) {
    session.turn = {
      startedAt: now,
      lastActivityAt: now,
      initialNumSteps: ev.initialNumSteps ?? null,
      lastInvocationNum: ev.invocationNum ?? null,
      lastUserInput: ev.lastUserInput || '',
      model,
      finalized: false,
      doneTimer: null,
      step: null,
    }
  } else {
    clearDoneTimer(session.turn)
    session.turn.lastActivityAt = now
    session.turn.model = model
    if (ev.invocationNum != null) session.turn.lastInvocationNum = ev.invocationNum
    if (ev.lastUserInput) session.turn.lastUserInput = ev.lastUserInput
  }

  session.turn.step = {
    invocationNum: ev.invocationNum ?? 1,
    startedAt: now,
    generatingAt: 0,
    hadToolCalls: false,
    model,
  }

  publish(session.cwd, { model, state: 'Estimate', ts: now }) // lean: estSec is dsh-only (§3)
  // Thinking fires at invocation start (spec §2.4.2 — before any delta):
  // prefill on large contexts can delay the first output, so the device must not trail.
  publish(session.cwd, { model, state: 'Thinking', ts: now })
  writeStatus()
}

function handlePostToolUse(session, ev) {
  syncSessionMeta(session, ev)
  const turn = session.turn
  if (!turn || turn.finalized) return
  readNewTranscriptLines(session)
  clearDoneTimer(turn)
  turn.lastActivityAt = Date.now()
  if (turn.step) {
    turn.step.hadToolCalls = true
    if (!turn.step.generatingAt) {
      turn.step.generatingAt = Date.now()
      const model = turn.step.model || turn.model || 'unknown'
      publish(session.cwd, { model, state: 'Generating', ts: turn.step.generatingAt })
    }
  }
}

function handlePostInvocation(session, ev) {
  syncSessionMeta(session, ev)
  const turn = session.turn
  if (!turn || turn.finalized) return
  readNewTranscriptLines(session)
  turn.lastActivityAt = Date.now()
  // Intermediate tool-calls steps NEVER emit Done (spec §2.4.3).
  if (turn.step && turn.step.hadToolCalls) return
  // No tool calls seen: arm a short debounced Done in case Stop does not arrive;
  // Stop, PostToolUse, or the next PreInvocation cancels it immediately.
  clearDoneTimer(turn)
  turn.doneTimer = setTimeout(() => {
    const current = sessions.get(session.id)
    if (current && current.turn === turn && !turn.finalized) {
      finalizeDone(current)
    }
  }, DONE_DEBOUNCE_MS)
}

function handleStop(session, ev) {
  syncSessionMeta(session, ev)
  const turn = session.turn
  if (!turn || turn.finalized) return
  readNewTranscriptLines(session)
  clearDoneTimer(turn)
  const errStr = typeof ev.error === 'string' && ev.error.trim() ? ev.error.trim() : ''
  if (ev.terminationReason === 'ERROR' || errStr) {
    finalizeError(session, errStr || 'error')
  } else {
    finalizeDone(session)
  }
}

// ---- queue dispatch ---------------------------------------------------------
function dispatch(ev) {
  if (!ev || typeof ev !== 'object' || !ev.type) return
  lastEventAt = Date.now()
  const cid = typeof ev.conversationId === 'string' && ev.conversationId ? ev.conversationId : 'unknown'
  const session = getSession(cid)
  session.lastEventAt = lastEventAt

  switch (ev.type) {
    case 'hello':
      handleHello(session, ev)
      break
    case 'pre-invocation':
      handlePreInvocation(session, ev)
      break
    case 'post-tool-use':
      handlePostToolUse(session, ev)
      break
    case 'post-invocation':
      handlePostInvocation(session, ev)
      break
    case 'stop':
      handleStop(session, ev)
      break
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
  const cfg = loadConfig(state.lastCwd)
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

function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  if (timer) clearInterval(timer)
  for (const [, s] of sessions) clearDoneTimer(s.turn)
  resetConn()
  try { unlinkSync(lockPath) } catch { /* ignore */ }
  try { unlinkSync(statusPath) } catch { /* ignore */ }
  process.exit(0)
}

function tick() {
  try {
    processQueue()
    tickPhase += 1
    for (const [, s] of sessions) {
      if (!s.turn || s.turn.finalized) continue
      if (tickPhase % TRANSCRIPT_EVERY === 0) readNewTranscriptLines(s)
      if (s.turn && !s.turn.finalized
        && Date.now() - Math.max(s.turn.startedAt, s.turn.lastActivityAt) > STALE_TURN_MS) {
        finalizeDone(s)
      }
    }
    const anyTurn = [...sessions.values()].some((s) => s.turn && !s.turn.finalized)
    for (const [id, s] of sessions) {
      if ((!s.turn || s.turn.finalized) && Date.now() - s.lastEventAt > 3600000) sessions.delete(id)
    }
    if (!anyTurn && Date.now() - lastEventAt > IDLE_EXIT_MS) shutdown()
    if (Date.now() - lastHbAt > HB_MS) {
      lastHbAt = Date.now()
      writeStatus()
    }
  } catch {
    // Spec console policy: config reminders only. A malformed event or a
    // transient fs error must never kill the daemon — the desk device depends
    // on it for the un-stick Done messages.
  }
}

const timer = setInterval(tick, TICK_MS)
tick() // drain the spawning hook's event immediately without waiting 250ms

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
