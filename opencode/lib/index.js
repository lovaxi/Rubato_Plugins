// Rubato (musical term: stolen time) — durable model-state monitor for opencode.
// User-side port of the DSH plugin (dsh/ in the Rubato_Plugins repository).
// Per PLUGIN_SPEC.md §1/§3/§5/§6, user-side plugins are MINIMAL:
//   - no local estimator/calibration (§3 is dsh-first): Estimate carries no estSec
//   - no local archive/stats (§5 is dsh-only): zero local writes except the config
//   - no model-visible tools (§6): mqmon_status is dsh-only
// It observes the model-call lifecycle and publishes the lean message set
//   Estimate   { model, state:'Estimate', ts }       call starting, before any chunk
//   Thinking   { model, state:'Thinking', ts }       stream started
//   Generating { model, state:'Generating', ts }     first text/tool delta
//   Done       { model, state:'Done', ts }           turn really finished (lean wire)
//   Error      { model, state:'Error', ts, error }   call failed -> immediately Done
// to EMQX Cloud (rubato/<username>/state). Auth mirrors the device firmware
// (rubato.ino): username = deviceId (RUBATO-<mac6>), password = the per-unit
// token; clientId/topic/enabled are identity-derived, so the config only needs
// username + password. This port derives clientId as 'OC-' + username, i.e.
// OC-RUBATO-<mac6> — distinct from the device (RUBATO-<mac6>) and from the
// other harnesses' clientIds (e.g. DSH-RUBATO-<mac6>), so concurrent
// publishing processes never kick each other off the broker.
//
// opencode hook mapping (verified against sst/opencode dev, Hooks interface):
//   chat.params                -> Estimate + Thinking (every request, incl. tool steps)
//   event message.part.updated -> Generating on first non-synthetic text/tool delta
//   event step-finish          -> debounced Done ('tool-calls' = intermediate, no Done)
//   event message.updated      -> info.error: user stop (MessageAbortedError, spec
//                                 §2.4.8) -> lean Done only; any other error -> Error
//                                 + lean Done
//   event session.error        -> dedup guard
//   event session.idle         -> terminal lean Done (the finally-equivalent)
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { publishRecord } from './mqtt.js'

const PLUGIN_DIR = dirname(new URL(import.meta.url).pathname
  .replace(/^\/([A-Za-z]:)/, '$1')) // windows drive letter fix

const DEFAULTS = {
  // The only user-facing fields are username (= the deviceId printed on the
  // device sticker) and password (the per-unit token). Everything below is
  // identity-derived; `enabled` is a manual off switch for people who want the
  // plugin silent but installed.
  host: 'ubaa35f0.ala.cn-shenzhen.emqxsl.cn', // EMQX Cloud Serverless, TLS-only
  port: 8883,
  tls: true,
  clientId: '', // derived: OC-<username> (= OC-RUBATO-<mac6>)
  username: '',
  password: '',
  topic: '', // derived: rubato/<username>/state
  qos: 1,
}

// Config file lookup order: the opencode process cwd (shares the other
// harnesses' config when several run on this machine), then the plugin root
// (config travels with the install). First existing file wins; edits take
// effect on the next record (hot reload).
const CONFIG_CANDIDATES = [
  join(process.cwd(), 'dsh-mqtt-config.json'),
  join(PLUGIN_DIR, 'dsh-mqtt-config.json'),
]

// Fill the identity-derived fields the user never has to configure, and
// derive enablement: credentials present = on; explicit enabled:false = off.
function deriveIdentity(cfg) {
  if (cfg.username) {
    if (!cfg.clientId) cfg.clientId = 'OC-' + cfg.username
    if (!cfg.topic) cfg.topic = 'rubato/' + cfg.username + '/state'
  }
  if (cfg.enabled === undefined) cfg.enabled = Boolean(cfg.username && cfg.password)
  return cfg
}

function loadConfig(overrides) {
  const candidates = overrides && overrides.configPath
    ? [overrides.configPath, ...CONFIG_CANDIDATES]
    : CONFIG_CANDIDATES
  for (const p of candidates) {
    try {
      // Tolerate // comment lines: the auto-generated template documents
      // itself with them; plain JSON.parse would reject them.
      const text = readFileSync(p, 'utf8')
        .split(/\r?\n/)
        .filter((line) => !line.trim().startsWith('//'))
        .join('\n')
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed === 'object') {
        return deriveIdentity({ ...DEFAULTS, ...parsed, ...(overrides || {}), _path: p })
      }
    } catch {
      // try next candidate
    }
  }
  return deriveIdentity({ ...DEFAULTS, ...(overrides || {}), _path: null })
}

// The template is pure JSON — comments are not part of the JSON standard and
// strict editors/parsers flag them. The guidance lives in the console SETUP
// reminder instead. (loadConfig still tolerates // lines in case users add
// their own notes.)
const TEMPLATE_TEXT = `{
  "username": "",
  "password": ""
}
`

function createConfigTemplate() {
  const p = join(PLUGIN_DIR, 'dsh-mqtt-config.json')
  if (!existsSync(p)) {
    try { writeFileSync(p, TEMPLATE_TEXT, 'utf8') } catch { /* best effort */ }
  }
  return p
}

// ---- Plugin runtime ---------------------------------------------------------

const DONE_DEBOUNCE_MS = 1500
const RUN_MAP_CAP = 64

// Extract a readable message from opencode's typed error shapes.
function errText(err) {
  if (!err) return 'unknown'
  if (typeof err === 'string') return err
  const data = err.data && typeof err.data === 'object' ? err.data : null
  return String((data && data.message) || err.message || err.name || 'unknown').slice(0, 200)
}

// opencode surfaces a user stop (ESC / stop button) as MessageAbortedError on
// the assistant message. Per spec §2.4.8 an early teardown is NOT a failure:
// it must un-stick the device with a lean Done and no Error record (dsh's
// finally guard does the same). Every other error is a real failure.
function isAbortError(err) {
  if (!err || typeof err !== 'object') return false
  const n = err.name || (err.data && err.data.name) || ''
  return n === 'MessageAbortedError'
}

function registerPlugin() {
  let cfg = loadConfig()
  if (!cfg._path) {
    // First run on a fresh install: drop a self-documenting template next to
    // the plugin, then load it (enabled:false) so the SETUP banner can point
    // at a real file path.
    createConfigTemplate()
    cfg = loadConfig()
  }
  const unconfigured = !cfg.username || !cfg.password
  // Console policy: configuration reminders ONLY. No per-message or publish
  // chatter (spec §4) — user-side plugins have no archive or status tool, so
  // there is nothing else to print.
  if (cfg.enabled && (!cfg.host || !cfg.topic)) {
    console.error('[Rubato] enabled but host/topic missing; fix dsh-mqtt-config.json')
  }
  if (unconfigured) {
    console.error('============================================================')
    console.error('[Rubato] SETUP REQUIRED - MQTT credentials not configured')
    console.error('  1. open:        ' + (cfg._path || '<plugin root>/dsh-mqtt-config.json'))
    console.error('  2. "username":  the deviceId printed on the device sticker (RUBATO-xxxxxx)')
    console.error('  3. "password":  the token paired with that deviceId')
    console.error('  save the file and you are done - the plugin auto-enables once both')
    console.error('  fields are filled (next message, no restart).')
    console.error('============================================================')
  }

  const publish = async (record) => {
    cfg = loadConfig() // hot reload per record
    // User-side plugins keep zero local files (spec §5): the record goes
    // straight to the broker when configured, and is dropped otherwise.
    if (!cfg.enabled || !cfg.username || !cfg.password) return
    try {
      await publishRecord(cfg, record)
    } catch { /* observation only — console policy: config reminders only */ }
  }

  // ---- Per-session run tracking (subagent sessions have their own id) -----
  // One run per opencode session; every model call within the turn resets the
  // per-step fields. Keyed by sessionID, so concurrent subagents are separate.
  const runs = new Map() // sid -> { model, tStart, messageID, stepActive, generatingSent, doneSent, errorSent, doneTimer }
  const evictOldest = (map) => {
    const k = map.keys().next().value
    if (k === undefined) return
    const r = map.get(k)
    if (r && r.doneTimer) clearTimeout(r.doneTimer)
    map.delete(k)
  }

  // Done wire contract is lean: { model, state, ts } (spec §2.4.5). User-side
  // plugins have no archive, so nothing beyond the wire exists at all.
  function publishDone(sid) {
    const r = runs.get(sid) || {}
    r.doneSent = true
    r.stepActive = false
    runs.set(sid, r)
    publish({ model: r.model || 'unknown', state: 'Done', ts: Date.now() })
  }

  function markError(sid, err) {
    const r = runs.get(sid)
    if (!r || r.errorSent) return
    r.errorSent = true
    r.stepActive = false
    runs.set(sid, r)
    if (!isAbortError(err)) {
      publish({ model: r.model || 'unknown', state: 'Error', ts: Date.now(), error: errText(err) })
    }
    publishDone(sid) // un-stick the device: it only exits the breathing state on done
  }

  const hooks = {}

  // chat.params: fires before EACH LLM request — the opencode equivalent of
  // the DSH llm/stream start. Estimate + Thinking go out here.
  hooks['chat.params'] = async (input, output) => {
    try {
      const sid = (input && input.sessionID) || '_'
      if (!runs.has(sid) && runs.size >= RUN_MAP_CAP) evictOldest(runs)
      const r = runs.get(sid) || {}
      clearTimeout(r.doneTimer) // a follow-up step cancels the pending Done
      const m = input && input.model
      const model = (m && (m.modelID || m.id)) || 'unknown'
      r.model = model
      r.tStart = Date.now()
      r.messageID = null
      r.stepActive = true
      r.generatingSent = false
      r.doneSent = false
      r.errorSent = false
      r.doneTimer = null
      runs.set(sid, r)
      // Estimate first (spec §2.4.1). User-side plugins publish it WITHOUT
      // estSec (§2.3: only dsh estimates; the device treats Estimate as pure
      // metadata either way — it never drives the state machine).
      publish({ model, state: 'Estimate', ts: r.tStart })
      // Thinking fires at request build (not on the first reasoning delta):
      // prefill on large contexts can delay the first delta by seconds — the
      // device must not trail it.
      publish({ model, state: 'Thinking', ts: r.tStart })
    } catch { /* observation only — console policy: config reminders only */ }
  }

  // message.part.updated for the tracked assistant message of a session.
  function onPartUpdated(props) {
    const part = props && props.part
    if (!part || typeof part !== 'object') return
    const sid = part.sessionID || '_'
    const r = runs.get(sid)
    if (!r) return
    // Only the current step's assistant message is tracked; user-message part
    // updates and background calls on the same session are filtered by id.
    if (part.type === 'step-start') {
      if (!r.messageID) r.messageID = part.messageID || r.messageID
      return
    }
    if (r.messageID && part.messageID && part.messageID !== r.messageID) return
    if (part.type === 'text') {
      if (part.synthetic) return
      const delta = typeof props.delta === 'string' ? props.delta : ''
      if (!r.generatingSent && (delta.length > 0 || (typeof part.text === 'string' && part.text.length > 0))) {
        r.generatingSent = true
        publish({ model: r.model, state: 'Generating', ts: Date.now() })
      }
      return
    }
    if (part.type === 'tool') {
      // A streamed tool call counts as output, like DSH's tool-call-delta.
      if (!r.generatingSent) {
        r.generatingSent = true
        publish({ model: r.model, state: 'Generating', ts: Date.now() })
      }
      return
    }
    if (part.type === 'step-finish') {
      r.stepActive = false
      const reason = String(part.reason || '')
      if (reason === 'tool-calls') return // the loop will run tools and call again — NOT the end of the turn
      if (reason === 'error') { markError(sid, 'step-finish: error'); return }
      // Success terminal for this step: arm a debounced Done in case
      // session.idle never fires; a follow-up step's chat.params cancels it
      // first, so mid-turn continuation steps never flash Done.
      clearTimeout(r.doneTimer)
      r.doneTimer = setTimeout(() => {
        const rr = runs.get(sid)
        if (!rr) return
        rr.doneTimer = null
        publishDone(sid)
      }, DONE_DEBOUNCE_MS)
    }
  }

  function onMessageUpdated(props) {
    const info = props && props.info
    if (!info || typeof info !== 'object' || info.role !== 'assistant') return
    const sid = info.sessionID || '_'
    const r = runs.get(sid)
    if (!r) return
    // Latest assistant message of the session = the step currently streaming.
    r.messageID = info.id
    if (info.error) markError(sid, info.error)
  }

  function onSessionError(props) {
    const sid = props && props.sessionID
    if (!sid) return
    const r = runs.get(sid)
    if (!r) return
    if (r.doneSent && !r.stepActive) return // turn already closed cleanly
    markError(sid, props && props.error)
  }

  function onSessionIdle(props) {
    const sid = props && props.sessionID
    if (!sid) return
    const r = runs.get(sid)
    if (!r) return
    if (r.doneTimer) { clearTimeout(r.doneTimer); r.doneTimer = null }
    if (r.doneSent || r.errorSent) return
    if (!r.tStart) return // nothing observed for this session — nothing to close
    publishDone(sid)
  }

  // event: the opencode bus. Everything the hooks above cannot see arrives here.
  hooks.event = async ({ event }) => {
    try {
      const ev = event || {}
      const props = ev.properties || {}
      if (ev.type === 'message.part.updated') onPartUpdated(props)
      else if (ev.type === 'message.updated') onMessageUpdated(props)
      else if (ev.type === 'session.error') onSessionError(props)
      else if (ev.type === 'session.idle') onSessionIdle(props)
    } catch { /* observation only */ }
  }

  // dispose: cancel timers (the MQTT connection dies with the process).
  hooks.dispose = async () => {
    try {
      for (const [, r] of runs) if (r.doneTimer) clearTimeout(r.doneTimer)
      runs.clear()
    } catch { /* best effort */ }
  }

  return hooks
}

// opencode plugin entry. Every function export is registered exactly once
// (the loader dedupes same-reference exports); named + default cover both the
// plugin-directory loader and npm installs.
export const Rubato = async () => registerPlugin()

export default Rubato
