// Rubato (musical term: stolen time) — durable model-state monitor for opencode.
// Port of the DSH plugin (dsh/ in the Rubato_Plugins repository); the
// device contract is identical:
//   Estimate  { model, state:'Estimate', ts, estSec }   kNN duration prediction
//   Thinking  { model, state:'Thinking', ts }           provider call started
//   Generating{ model, state:'Generating', ts }         first output text/tool part
//   Done      { model, state:'Done', ts }               turn end (lean wire; token
//                                                       usage kept in the local archive)
//   Error     { model, state:'Error', ts, error }       call failed
// Every record is published as one MQTT message (lib/mqtt.js, persistent
// connection) and archived as a JSON line next to the config file.
//
// Broker: EMQX Cloud Serverless (TLS-only). Auth mirrors the device firmware
// (rubato.ino): username = deviceId (TT-<mac6>), password = the per-unit
// token; clientId/topic/enabled are identity-derived, so the config only needs
// username + password. This port derives clientId as 'OC-' + username, i.e.
// OC-TT-<mac6> — distinct from the device (TT-<mac6>) and from the other
// harnesses' clientIds (DSH-TT-<mac6>, Claw-TT-<mac6>), so concurrent
// publishing processes never kick each other off the broker.
//
// opencode hook mapping (verified against sst/opencode dev, Hooks interface):
//   experimental.chat.messages.transform -> full message list for the request:
//       stash zero-token features (context size etc.). Fires per step, before
//       the request; ordering vs chat.params is handled both ways (consume-
//       and-clear stash; fallback features from the user message otherwise).
//   chat.params      -> Estimate + Thinking (fires before each LLM request)
//   event:
//     message.part.updated -> Generating on first text delta / tool part of a
//                             step (synthetic parts excluded); step-finish
//                             carries per-call tokens+cost: calibration
//                             backfill, then a debounced Done — cancelled by
//                             the next chat.params, so mid-turn tool-loop
//                             steps ('tool-calls' reason) never flash Done,
//                             like DSH.
//     message.updated      -> latest assistant message id (part filtering)
//                             + info.error -> Error + Done (un-stick)
//     session.error        -> Error + Done (dedup with the above)
//     session.idle         -> terminal Done for the turn (clears the debounce)
//   tool mqmon_status    -> model-visible status tool
//   dispose              -> cancel timers
// First-run UX: when no config file exists anywhere, a self-documenting
// template is dropped next to the plugin and a setup guide is printed at boot;
// the mqmon_status tool reports configured:false until username+password land.
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { publishRecord } from './mqtt.js'

// Plugin root (lib/..): template + default config home; travels with installs.
const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)))

const DEFAULTS = {
  // enabled is NOT a user setting: it is derived on every load — credentials
  // filled = publishing on. An explicit enabled:false in the file remains the
  // manual off switch for people who want the plugin silent but installed.
  host: 'ubaa35f0.ala.cn-shenzhen.emqxsl.cn', // EMQX Cloud Serverless, TLS-only
  port: 8883,
  tls: true,
  clientId: '', // derived: OC-<username> (= OC-TT-<mac6>)
  username: '',
  password: '',
  topic: '', // derived: rubato/<username>/state
  qos: 1,
}

// Config file lookup order: the opencode process cwd (shares the DSH/OpenClaw
// plugins' config when several harnesses run on this machine), then the plugin
// root (config travels with the install). First existing file wins; edits take
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

// ---- Duration estimator (zero-token, feature-based kNN) --------------------
// Identical to the DSH plugin: features are compared against the model's real
// historical samples and duration is predicted as a similarity-weighted
// average of the nearest ones. Context size is the dominant feature.

// Flatten one part to text (defensive: part shapes vary across opencode
// versions). Tool outputs count toward context size like DSH's request payload.
function partText(part) {
  if (!part || typeof part !== 'object') return ''
  if ((part.type === 'text' || part.type === 'reasoning') && typeof part.text === 'string') return part.text
  if (part.type === 'tool' && part.state && typeof part.state === 'object') {
    if (typeof part.state.output === 'string') return part.state.output
    if (typeof part.state.error === 'string') return part.state.error
  }
  if (typeof part.text === 'string') return part.text
  return ''
}

// Features from an experimental.chat.messages.transform payload
// ({ info, parts }[]): the same zero-token features the DSH plugin extracts
// from GenerateOptions.messages at stream start.
function featuresFromMessages(msgs) {
  let ctxChars = 0
  let last = ''
  let n = 0
  for (const m of msgs) {
    if (!m || typeof m !== 'object') continue
    n += 1
    let text = ''
    if (Array.isArray(m.parts)) text = m.parts.map(partText).join(' ')
    if (typeof m.info?.text === 'string') text += (text ? ' ' : '') + m.info.text
    ctxChars += text.length
    if (m.info && m.info.role === 'user') last = text
  }
  return {
    c: ctxChars,
    l: last.length,
    f: Math.min(4, Math.floor((last.match(/```/g) || []).length / 2)),
    v: /(实现|重构|调试|修复|排查|迁移|搭建|优化|写一|implement|refactor|debug|fix\b|build|migrate|optimize)/i.test(last) ? 1 : 0,
    fl: /(@[\w./\\-]+|\.(ts|js|mjs|cjs|json|py|md|yml|yaml)\b|[A-Z]:\\)/.test(last) ? 1 : 0,
    n,
    e: '',
  }
}

// Fallback features when the transform hook has not stashed anything for this
// session (hook absent on older opencode, or chat.params fired first): the
// triggering user message is the only context available for free.
function featuresFromUserMessage(userMessage) {
  const um = userMessage && typeof userMessage === 'object' ? userMessage : {}
  let text = ''
  if (Array.isArray(um.parts)) text = um.parts.map(partText).join(' ')
  if (typeof um.text === 'string') text += (text ? ' ' : '') + um.text
  return {
    c: text.length,
    l: text.length,
    f: Math.min(4, Math.floor((text.match(/```/g) || []).length / 2)),
    v: /(实现|重构|调试|修复|排查|迁移|搭建|优化|写一|implement|refactor|debug|fix\b|build|migrate|optimize)/i.test(text) ? 1 : 0,
    fl: /(@[\w./\\-]+|\.(ts|js|mjs|cjs|json|py|md|yml|yaml)\b|[A-Z]:\\)/.test(text) ? 1 : 0,
    n: 1,
    e: '',
  }
}

// Best-effort effort/reasoning dial from the provider options block of
// chat.params (DSH read options.reasoningEffort the same way).
function effortOf(options) {
  try {
    for (const [k, v] of Object.entries(options || {})) {
      if (/effort|reasoning|thinking/i.test(k)) {
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v).slice(0, 24)
        if (v && typeof v === 'object') {
          for (const [k2, v2] of Object.entries(v)) {
            if (/effort|budget/i.test(k2) && (typeof v2 === 'string' || typeof v2 === 'number')) return String(v2).slice(0, 24)
          }
        }
      }
    }
  } catch { /* ignore */ }
  return ''
}

// Prior (ms) used only while a model has zero samples: small constant plus a
// linear term on context size, roughly matching observed real durations.
function priorMs(feat) {
  return 4000 + feat.c * 0.018
}

// Predict duration (ms): k-nearest historical samples by log-scale feature
// distance, weighted by 1/(1+distance). Effort mismatch is a first-class
// difficulty signal (weight 0.4); message count captures turn depth.
function predictMs(samples, feat) {
  if (!Array.isArray(samples) || samples.length === 0) return priorMs(feat)
  const lc = Math.log(feat.c + 1)
  const ll = Math.log(feat.l + 1)
  const ln = Math.log(feat.n + 1)
  const scored = samples.map((s) => ({
    ms: s.ms,
    d: Math.abs(lc - Math.log((s.c || 0) + 1))
      + Math.abs(ll - Math.log((s.l || 0) + 1)) * 0.3
      + Math.abs(ln - Math.log((s.n || 0) + 1)) * 0.3
      + ((feat.e || '') !== (s.e || '') ? 0.4 : 0)
      + Math.abs((feat.f || 0) - (s.f || 0)) * 0.2
      + ((feat.v || 0) !== (s.v || 0) ? 0.1 : 0)
      + ((feat.fl || 0) !== (s.fl || 0) ? 0.1 : 0),
  }))
  scored.sort((a, b) => a.d - b.d)
  const k = Math.min(5, scored.length)
  let wsum = 0
  let msum = 0
  for (let i = 0; i < k; i += 1) {
    const w = 1 / (1 + scored[i].d)
    wsum += w
    msum += w * scored[i].ms
  }
  return wsum > 0 ? msum / wsum : priorMs(feat)
}

// ---- Plugin runtime --------------------------------------------------------

// Calibration store: { [model]: { samples: [ { c,l,f,v,fl,n,e, ms, est, o, t } ] } },
// persisted next to the config file so estimates improve across restarts.
const MAX_SAMPLES = 200
const DONE_DEBOUNCE_MS = 1500
const RUN_MAP_CAP = 64

// Extract a readable message from opencode's typed error shapes.
function errText(err) {
  if (!err) return 'unknown'
  if (typeof err === 'string') return err
  const data = err.data && typeof err.data === 'object' ? err.data : null
  return String((data && data.message) || err.message || err.name || 'unknown').slice(0, 200)
}

function registerPlugin() {
  const state = { published: 0, failed: 0, last: null, recent: [] }
  const pushRecent = (rec) => {
    state.recent.push(rec)
    if (state.recent.length > 10) state.recent.shift()
  }

  let cfg = loadConfig()
  if (!cfg._path) {
    // First run on a fresh install: drop a self-documenting template next to
    // the plugin, then load it (enabled:false) so the archive path exists.
    createConfigTemplate()
    cfg = loadConfig()
  }
  const unconfigured = !cfg.username || !cfg.password
  // Console policy: configuration reminders ONLY. No per-message or publish
  // chatter — runtime status lives in mqmon_status and the JSONL archive.
  if (cfg.enabled && (!cfg.host || !cfg.topic)) {
    console.error('[Rubato] enabled but host/topic missing; fix dsh-mqtt-config.json')
  }
  if (unconfigured) {
    console.error('============================================================')
    console.error('[Rubato] SETUP REQUIRED - MQTT credentials not configured')
    console.error('  1. open:        ' + (cfg._path || '<plugin root>/dsh-mqtt-config.json'))
    console.error('  2. "username":  the deviceId printed on the device sticker (TT-xxxxxx)')
    console.error('  3. "password":  the token paired with that deviceId')
    console.error('  save the file and you are done - the plugin auto-enables once both')
    console.error('  fields are filled (next message, no restart).')
    console.error('============================================================')
  }

  const archive = (record) => {
    if (!cfg._path) return
    try { appendFileSync(join(dirname(cfg._path), 'rubato-records.jsonl'), JSON.stringify(record) + '\n') } catch { /* best effort */ }
  }

  const publish = async (record, wire = record) => {
    cfg = loadConfig() // hot reload per record
    // Local archive: every record lands as one JSON line next to the config
    // file (always, regardless of MQTT enablement) for direct inspection.
    archive(record)
    // Program-judged readiness: publish only when enabled AND credentials
    // are present; otherwise archive locally and keep waiting for setup.
    if (!cfg.enabled || !cfg.username || !cfg.password) { pushRecent(record); return }
    try {
      await publishRecord(cfg, wire)
      state.published += 1
      state.last = { ok: true, at: Date.now(), state: record.state }
    } catch (e) {
      state.failed += 1
      state.last = { ok: false, at: Date.now(), state: record.state, detail: String((e && e.message) || e) }
    }
  }

  // ---- Per-session run tracking (subagent sessions have their own id) -----
  // One run per opencode session; every model call within the turn resets the
  // per-step fields. Keyed by sessionID, so concurrent subagents are separate.
  const runs = new Map() // sid -> { model, feat, est, tStart, messageID, stepActive, generatingSent, doneSent, errorSent, doneTimer, lastTokens, lastCost }
  const stash = new Map() // sid -> features stashed by messages.transform
  const evictOldest = (map) => {
    const k = map.keys().next().value
    if (k === undefined) return
    const r = map.get(k)
    if (r && r.doneTimer) clearTimeout(r.doneTimer)
    map.delete(k)
  }

  // Calibration store accessors (file lives next to the config).
  let statsCache = null
  function loadStats() {
    if (statsCache) return statsCache
    const p = cfg._path ? join(dirname(cfg._path), 'rubato-stats.json') : null
    try { statsCache = JSON.parse(readFileSync(p, 'utf8')) } catch { statsCache = {} }
    for (const key of Object.keys(statsCache)) {
      const entry = statsCache[key]
      if (!entry || typeof entry !== 'object' || !Array.isArray(entry.samples)) {
        statsCache[key] = { samples: [] }
      }
    }
    return statsCache
  }
  function saveStats(stats) {
    statsCache = stats
    const p = cfg._path ? join(dirname(cfg._path), 'rubato-stats.json') : null
    if (!p) return
    try { writeFileSync(p, JSON.stringify(stats), 'utf8') } catch { /* best effort */ }
  }

  // Token summary for the archive/status only: { out, cache, cost? }. The
  // Done wire record is lean (device reads state/model/estSec only); usage is
  // kept in the JSONL archive for humans and mqmon_status. cost: opencode
  // reports the real per-call cost on step-finish — used when present;
  // otherwise derived from cfg.pricing ({ input, output, cacheRead } USD per
  // 1M tokens), like the DSH plugin. Omitted when zero/unavailable.
  function tokensFor(tokens, cost) {
    if (!tokens || typeof tokens !== 'object') return undefined
    const t = {}
    if (typeof tokens.output === 'number') t.out = tokens.output
    if (tokens.cache && typeof tokens.cache.read === 'number') t.cache = tokens.cache.read
    let c = typeof cost === 'number' && cost > 0 ? cost : null
    if (c === null) {
      const p = cfg.pricing
      if (p && typeof p === 'object') {
        const inTok = typeof tokens.input === 'number' ? tokens.input : 0
        const outTok = typeof tokens.output === 'number' ? tokens.output : 0
        const cacheTok = tokens.cache && typeof tokens.cache.read === 'number' ? tokens.cache.read : 0
        const derived = ((p.input || 0) * inTok + (p.output || 0) * outTok + (p.cacheRead || 0) * cacheTok) / 1e6
        if (derived > 0) c = derived
      }
    }
    if (c !== null) t.cost = Math.round(c * 1e6) / 1e6
    return Object.keys(t).length > 0 ? t : undefined
  }

  function publishDone(sid) {
    const r = runs.get(sid) || {}
    r.doneSent = true
    r.stepActive = false
    runs.set(sid, r)
    cfg = loadConfig()
    // Done wire contract is lean: { model, state, ts }. Token usage (and the
    // opencode-native cost) is kept for the local archive/status only — the
    // device ignores it.
    const tokens = tokensFor(r.lastTokens, r.lastCost)
    const doneRecord = { model: r.model || 'unknown', state: 'Done', ts: Date.now(), ...(tokens ? { tokens } : {}) }
    publish(doneRecord, { model: doneRecord.model, state: 'Done', ts: doneRecord.ts })
  }

  function markError(sid, detail) {
    const r = runs.get(sid)
    if (!r || r.errorSent) return false
    r.errorSent = true
    r.stepActive = false
    runs.set(sid, r)
    publish({ model: r.model || 'unknown', state: 'Error', ts: Date.now(), error: detail })
    publishDone(sid) // un-stick the device: it only exits the breathing state on done
    return true
  }

  const hooks = {}

  // chat.params: fires before EACH LLM request — the opencode equivalent of
  // the DSH llm/stream start. Estimate + Thinking go out here.
  hooks['chat.params'] = async (input, output) => {
    try {
      const sid = (input && input.sessionID) || '_'
      if (!runs.has(sid) && runs.size >= RUN_MAP_CAP) evictOldest(runs)
      let r = runs.get(sid) || {}
      clearTimeout(r.doneTimer) // a follow-up step cancels the pending Done
      const m = input && input.model
      const model = (m && (m.modelID || m.id)) || 'unknown'
      cfg = loadConfig()
      const feat = stash.get(sid) || featuresFromUserMessage(input && input.message)
      stash.delete(sid) // consumed; if transform fires later it stashes for the NEXT call
      feat.e = effortOf(output && output.options)
      const estMsVal = Math.round(predictMs(loadStats()[model] && loadStats()[model].samples, feat))
      r.model = model
      r.feat = feat
      r.est = estMsVal
      r.tStart = Date.now()
      r.messageID = null
      r.stepActive = true
      r.generatingSent = false
      r.doneSent = false
      r.errorSent = false
      r.lastTokens = null
      r.lastCost = null
      r.doneTimer = null
      runs.set(sid, r)
      publish({
        model,
        state: 'Estimate',
        ts: r.tStart,
        estSec: Math.round(estMsVal / 100) / 10,
      })
      // Thinking fires at request build (not on the first reasoning delta):
      // prefill on large contexts can delay the first delta by seconds — the
      // device must not trail it.
      publish({ model, state: 'Thinking', ts: r.tStart })
    } catch (e) {
      console.error('[Rubato] chat.params handler failed: ' + ((e && e.message) || e))
    }
  }

  // experimental.chat.messages.transform: the full message list for the
  // upcoming request — stash features for the chat.params that follows.
  hooks['experimental.chat.messages.transform'] = async (input, output) => {
    try {
      const msgs = output && Array.isArray(output.messages) ? output.messages : []
      if (msgs.length === 0) return
      const sid = (msgs[0] && msgs[0].info && msgs[0].info.sessionID) || '_'
      if (!stash.has(sid) && stash.size >= RUN_MAP_CAP) evictOldest(stash)
      stash.set(sid, featuresFromMessages(msgs))
    } catch { /* observation only */ }
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
      if (part.tokens && typeof part.tokens === 'object') r.lastTokens = part.tokens
      if (typeof part.cost === 'number') r.lastCost = part.cost
      // Calibration backfill (features + estimate vs. real duration).
      const durationMs = r.tStart ? Date.now() - r.tStart : 0
      const stats = loadStats()
      const b = stats[r.model] || (stats[r.model] = { samples: [] })
      if (!Array.isArray(b.samples)) b.samples = []
      const f = r.feat || { c: 0, l: 0, f: 0, v: 0, fl: 0, n: 0, e: '' }
      const sample = {
        c: f.c, l: f.l, f: f.f, v: f.v, fl: f.fl, n: f.n, e: f.e,
        ms: durationMs,
        est: r.est || 0,
        t: Date.now(),
      }
      if (part.tokens && typeof part.tokens.output === 'number') sample.o = part.tokens.output
      b.samples.push(sample)
      if (b.samples.length > MAX_SAMPLES) b.samples.splice(0, b.samples.length - MAX_SAMPLES)
      saveStats(stats)

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
    if (info.error) markError(sid, errText(info.error))
  }

  function onSessionError(props) {
    const sid = props && props.sessionID
    if (!sid) return
    const r = runs.get(sid)
    if (!r) return
    if (r.doneSent && !r.stepActive) return // turn already closed cleanly
    markError(sid, errText(props && props.error))
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
      stash.clear()
    } catch { /* best effort */ }
  }

  // Model-visible status tool (plain ToolDefinition — opencode's tool() helper
  // is the identity function, so no runtime dependency on @opencode-ai/plugin).
  // Registration outcome is recorded into the archive's _boot line for diagnosis.
  const boot = {
    state: '_boot',
    ts: Date.now(),
    config: cfg._path || null,
    enabled: cfg.enabled,
    host: cfg.host,
    topic: cfg.topic,
    toolRegistered: null,
    toolError: null,
  }
  try {
    hooks.tool = {
      mqmon_status: {
        description: 'Report the Rubato plugin status: MQTT config summary, recent captured model-call records (Estimate/Thinking/Generating/Done/Error with token usage), and the last MQTT publish outcome.',
        args: {},
        execute: async () => JSON.stringify({
          configured: Boolean(cfg.username && cfg.password),
          setupHint: cfg.username && cfg.password ? undefined
            : 'MQTT credentials missing: put username (TT-xxxxxx from the device sticker) and password (token) into dsh-mqtt-config.json and save - the plugin auto-enables once both are filled (next message, no restart needed)',
          enabled: cfg.enabled,
          host: cfg.host,
          topic: cfg.topic,
          qos: cfg.qos,
          configPath: cfg._path,
          published: state.published,
          failed: state.failed,
          lastPublish: state.last,
          recentRecords: state.recent.slice(),
        }, null, 2),
      },
    }
    boot.toolRegistered = true
  } catch (e) {
    boot.toolRegistered = false
    boot.toolError = String((e && e.message) || e)
  }

  if (cfg._path) archive(boot)
  return hooks
}

// opencode plugin entry. Every function export is registered exactly once
// (the loader dedupes same-reference exports); named + default cover both the
// plugin-directory loader and npm installs.
export const Rubato = async () => registerPlugin()

export default Rubato
