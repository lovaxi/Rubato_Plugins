// Rubato — durable model-state monitor for OpenClaw (龙虾).
// Port of the DSH rubato plugin (Rubato_Plugin_DSH is the reference);
// the device contract is identical:
//   Estimate  { model, state:'Estimate', ts, estSec }   kNN duration prediction
//   Thinking  { model, state:'Thinking', ts }           provider call started
//   Done      { model, state:'Done', ts, tokens? }      turn end (token usage)
//   Error     { model, state:'Error', ts, error }       provider call failed
// Every record is published as one MQTT message (lib/mqtt.js, persistent
// connection) and archived as a JSON line next to the config file.
//
// Broker: EMQX Cloud Serverless (TLS-only). Auth mirrors the device firmware
// (rubato.ino): username = deviceId (RUBATO-<mac6>), password = the per-unit
// token; clientId/topic/enabled are identity-derived, so the config only needs
// username + password.
//
// OpenClaw hook mapping (typed plugin hooks, api.on):
//   llm_input          -> extract zero-token features (context size etc.)
//   model_call_started -> Estimate + Thinking
//   model_call_ended   -> Error+Done on failure; success arms a debounced Done
//                         that is cancelled by the next model_call_started (so
//                         mid-turn tool-loop steps never flash Done, like DSH)
//   llm_output         -> token usage for the run's terminal Done + backfill
//   agent_end          -> terminal Done for the run
//   gateway_stop       -> cancel timers
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
  clientId: '', // derived: Claw-Rubato-<mac6> (mac6 = hex part of RUBATO-<mac6>)
  username: '',
  password: '',
  topic: '', // derived: rubato/<username>/state
  qos: 1,
}

// Config file lookup order: the gateway process cwd (shares the DSH plugin's
// config when both harnesses run on this machine), then the plugin root
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
    if (!cfg.clientId) {
      // mac6 = the hex part of the deviceId (RUBATO-<mac6>; legacy units
      // TT-<mac6>). A username following neither convention is used verbatim.
      const u = cfg.username
      const mac6 = u.startsWith('RUBATO-') ? u.slice(7) : u.startsWith('TT-') ? u.slice(3) : u
      cfg.clientId = 'Claw-Rubato-' + mac6
    }
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

function textOf(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join(' ')
  return ''
}

// Features from an llm_input event. Event shape is runner-dependent, so every
// field is read defensively: system (string), prompt (string) and
// messages/history (role/content lists, content string or text-part array).
function extractFeatures(event) {
  if (!event || typeof event !== 'object') return null
  const msgs = []
  if (typeof event.system === 'string') msgs.push({ role: 'system', content: event.system })
  if (Array.isArray(event.messages)) msgs.push(...event.messages)
  else if (Array.isArray(event.history)) msgs.push(...event.history)
  if (msgs.length === 0 && typeof event.prompt === 'string' && event.prompt) {
    msgs.push({ role: 'user', content: event.prompt })
  }
  if (msgs.length === 0) return null
  let ctxChars = 0
  let last = ''
  for (const m of msgs) {
    if (!m) continue
    const text = textOf(m.content)
    ctxChars += text.length
    if (m.role === 'user') last = text
  }
  return {
    c: ctxChars,
    l: last.length,
    f: Math.min(4, Math.floor((last.match(/```/g) || []).length / 2)),
    v: /(实现|重构|调试|修复|排查|迁移|搭建|优化|写一|implement|refactor|debug|fix\b|build|migrate|optimize)/i.test(last) ? 1 : 0,
    fl: /(@[\w./\\-]+|\.(ts|js|mjs|cjs|json|py|md|yml|yaml)\b|[A-Z]:\\)/.test(last) ? 1 : 0,
    n: msgs.length,
    e: '',
  }
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

function registerPlugin(api) {
  const state = { published: 0, failed: 0, last: null, recent: [] }
  const pushRecent = (rec) => {
    state.recent.push(rec)
    if (state.recent.length > 10) state.recent.shift()
  }

  const pluginOverrides = {} // reserved: plugins.entries.rubato.config overrides
  let cfg = loadConfig(pluginOverrides)
  if (!cfg._path) {
    // First run on a fresh install: drop a self-documenting template next to
    // the plugin, then load it (enabled:false) so the archive path exists.
    createConfigTemplate()
    cfg = loadConfig(pluginOverrides)
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
    console.error('  2. "username":  the deviceId printed on the device sticker (RUBATO-xxxxxx)')
    console.error('  3. "password":  the token paired with that deviceId')
    console.error('  save the file and you are done - the plugin auto-enables once both')
    console.error('  fields are filled (next message, no restart).')
    console.error('============================================================')
  }

  const archive = (record) => {
    if (!cfg._path) return
    // Data files keep the legacy thinktime-* names on purpose (calibration
    // data continuity across the rename — spec §11).
    try { appendFileSync(join(dirname(cfg._path), 'thinktime-records.jsonl'), JSON.stringify(record) + '\n') } catch { /* best effort */ }
  }

  // publish(record, wire = record): the archive always receives the FULL
  // record, MQTT receives the (possibly leaner) wire object. Done is the one
  // message that currently needs the split (spec §2.4.7).
  const publish = async (record, wire = record) => {
    cfg = loadConfig(pluginOverrides) // hot reload per record
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

  // ---- Per-run tracking (subagent runs have their own runId) --------------
  const runs = new Map() // rid -> { model, feat, est, tStart, usage, doneTimer, lastCall }
  const ridOf = (event, hookCtx) => {
    const rid = (hookCtx && hookCtx.runId) || (event && event.runId) || '_'
    if (!runs.has(rid) && runs.size >= RUN_MAP_CAP) {
      const oldest = runs.keys().next().value
      const r = runs.get(oldest)
      if (r) clearTimeout(r.doneTimer)
      runs.delete(oldest)
    }
    return rid
  }

  let pendingFeat = null // features seen on llm_input before the call starts

  // llm_input: stash zero-token features for the upcoming model call(s).
  api.on('llm_input', (event, hookCtx) => {
    try {
      const feat = extractFeatures(event)
      if (!feat) return
      const rid = ridOf(event, hookCtx)
      const r = runs.get(rid) || {}
      r.feat = feat
      runs.set(rid, r)
      pendingFeat = feat
    } catch { /* observation only */ }
  })

  // llm_output: capture usage for the run's terminal Done (tokens go to the
  // archive and the status tool — never onto the wire, spec §2.4.5).
  api.on('llm_output', (event, hookCtx) => {
    try {
      const usage = event && (event.usage || event.tokenUsage || (event.output && event.output.usage))
      if (!usage) return
      const rid = ridOf(event, hookCtx)
      const r = runs.get(rid) || {}
      r.usage = usage
      runs.set(rid, r)
    } catch { /* observation only */ }
  })

  // model_call_started: Estimate + Thinking.
  api.on('model_call_started', (event, hookCtx) => {
    try {
      const rid = ridOf(event, hookCtx)
      const r = runs.get(rid) || {}
      clearTimeout(r.doneTimer) // a follow-up call cancels the pending Done
      const model = (event && (event.model || event.modelId)) || 'unknown'
      cfg = loadConfig(pluginOverrides)
      const feat = r.feat || pendingFeat || { c: 0, l: 0, f: 0, v: 0, fl: 0, n: 0, e: '' }
      pendingFeat = null
      const estMsVal = Math.round(predictMs(loadStats()[model] && loadStats()[model].samples, feat))
      r.model = model
      r.feat = feat
      r.est = estMsVal
      r.tStart = Date.now()
      runs.set(rid, r)
      publish({
        model,
        state: 'Estimate',
        ts: r.tStart,
        estSec: Math.round(estMsVal / 100) / 10,
      })
      // Thinking fires at call start (not on the first reasoning delta): the
      // harness UI shows thinking immediately, and prefill on large contexts
      // can delay the first delta by seconds - the device must not trail it.
      publish({ model, state: 'Thinking', ts: r.tStart })
    } catch (e) {
      console.error('[Rubato] model_call_started handler failed: ' + ((e && e.message) || e))
    }
  })

  // model_call_ended: failure publishes Error + Done (un-stick, like DSH);
  // success only records the finished call's calibration inputs and arms a
  // debounced Done in case agent_end never fires on this runner. NO backfill
  // here: mid-turn tool-loop steps and failed calls never enter the samples
  // (spec §2.4.3/§10 — the run's final call is backfilled at terminal Done).
  api.on('model_call_ended', (event, hookCtx) => {
    try {
      const rid = ridOf(event, hookCtx)
      const r = runs.get(rid) || {}
      const model = r.model || (event && (event.model || event.modelId)) || 'unknown'
      const ev = event || {}
      const outcome = ev.outcome || ev.status || 'ok'
      const ok = outcome === 'ok' || outcome === 'success'
      const durationMs = typeof ev.durationMs === 'number'
        ? ev.durationMs
        : (r.tStart ? Date.now() - r.tStart : 0)

      clearTimeout(r.doneTimer)
      if (!ok) {
        // Un-stick the device: it only exits the breathing state on done.
        // The failed call is not calibration material — drop it. DSH parity:
        // the error-path Done is the plain lean record (no tokens anywhere).
        r.lastCall = null
        runs.set(rid, r)
        publish({ model, state: 'Error', ts: Date.now(), error: String((ev.error && (ev.error.message || ev.error)) || outcome) })
        publish({ model, state: 'Done', ts: Date.now() })
        return
      }
      r.lastCall = { feat: r.feat, est: r.est || 0, ms: durationMs, t: Date.now() }
      r.doneTimer = setTimeout(() => {
        const rr = runs.get(rid)
        if (!rr) return
        rr.doneTimer = null
        publishDone(rid)
      }, DONE_DEBOUNCE_MS)
      runs.set(rid, r)
    } catch (e) {
      console.error('[Rubato] model_call_ended handler failed: ' + ((e && e.message) || e))
    }
  })

  // agent_end: terminal Done for the run (clears any pending debounce timer).
  api.on('agent_end', (event, hookCtx) => {
    try {
      const rid = ridOf(event, hookCtx)
      const r = runs.get(rid)
      if (r) clearTimeout(r.doneTimer)
      publishDone(rid)
    } catch { /* observation only */ }
  })

  // gateway_stop: cancel timers (mqtt connection dies with the process).
  api.on('gateway_stop', () => {
    try {
      for (const [, r] of runs) clearTimeout(r.doneTimer)
      runs.clear()
    } catch { /* best effort */ }
  })

  // Token summary matching the receiver contract: { out, cache, cost? }.
  // cost is derived from cfg.pricing ({ input, output, cacheRead } USD per 1M
  // tokens) and omitted when pricing is not configured.
  function tokensFor(usage) {
    if (!usage || typeof usage !== 'object') return undefined
    const num = (...v) => { for (const x of v) { if (typeof x === 'number') return x } return undefined }
    const t = {}
    const out = num(usage.outputTokens, usage.output, usage.completionTokens)
    const cache = num(usage.cacheReadTokens, usage.cacheRead, usage.cachedTokens)
    if (typeof out === 'number') t.out = out
    if (typeof cache === 'number') t.cache = cache
    const p = cfg.pricing
    if (p && typeof p === 'object') {
      const inTok = num(usage.inputTokens, usage.input, usage.promptTokens) || 0
      const outTok = typeof out === 'number' ? out : 0
      const cacheTok = typeof cache === 'number' ? cache : 0
      const cost = ((p.input || 0) * inTok + (p.output || 0) * outTok + (p.cacheRead || 0) * cacheTok) / 1e6
      if (cost > 0) t.cost = Math.round(cost * 1e6) / 1e6
    }
    return Object.keys(t).length > 0 ? t : undefined
  }

  function publishDone(rid) {
    const r = runs.get(rid) || {}
    const model = r.model || 'unknown'
    cfg = loadConfig(pluginOverrides)
    const ts = Date.now()
    const tokens = tokensFor(r.usage)
    // Done wire contract is lean: { model, state, ts }. Token usage is kept
    // for the local archive/status only — the device ignores it (spec §2.4.5).
    publish(
      { model, state: 'Done', ts, ...(tokens ? { tokens } : {}) },
      { model, state: 'Done', ts },
    )
    // Terminal backfill (DSH parity): exactly one sample per turn — the FINAL
    // call's features/estimate vs its real duration, with output tokens.
    // Fields per spec §3.3: { c,l,f,v,fl,n,e, ms, est, o, t } (o defaults 0).
    const lc = r.lastCall
    if (lc && lc.feat) {
      const stats = loadStats()
      const b = stats[model] || (stats[model] = { samples: [] })
      if (!Array.isArray(b.samples)) b.samples = []
      b.samples.push({
        c: lc.feat.c, l: lc.feat.l, f: lc.feat.f, v: lc.feat.v, fl: lc.feat.fl,
        n: lc.feat.n, e: lc.feat.e,
        ms: lc.ms || 0,
        est: lc.est,
        o: tokens && typeof tokens.out === 'number' ? tokens.out : 0,
        t: lc.t,
      })
      if (b.samples.length > MAX_SAMPLES) b.samples.splice(0, b.samples.length - MAX_SAMPLES)
      saveStats(stats)
      r.lastCall = null
    }
  }

  // Calibration store accessors (file lives next to the config; legacy
  // S/M/L-shaped entries are detected and reset — features不可回填).
  let statsCache = null
  function loadStats() {
    if (statsCache) return statsCache
    const p = cfg._path ? join(dirname(cfg._path), 'thinktime-stats.json') : null
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
    const p = cfg._path ? join(dirname(cfg._path), 'thinktime-stats.json') : null
    if (!p) return
    try { writeFileSync(p, JSON.stringify(stats), 'utf8') } catch { /* best effort */ }
  }

  // Model-visible status tool (optional service; failure must not kill the plugin).
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
    api.registerTool({
      name: 'mqmon_status',
      description: 'Report the Rubato plugin status: MQTT config summary, recent captured model-call records (Estimate/Thinking/Done/Error with token usage), and the last MQTT publish outcome.',
      parameters: { type: 'object', properties: {} },
      execute: async () => ({
        configured: Boolean(cfg.username && cfg.password),
        // Lossless-JSON discipline (spec §6): no field may be assigned
        // undefined — conditional fields are spread-omitted instead.
        ...(cfg.username && cfg.password ? {} : {
          setupHint: 'MQTT credentials missing: put username (RUBATO-xxxxxx from the device sticker) and password (token) into dsh-mqtt-config.json and save - the plugin auto-enables once both are filled (next message, no restart needed)',
        }),
        enabled: cfg.enabled,
        host: cfg.host,
        topic: cfg.topic,
        qos: cfg.qos,
        configPath: cfg._path,
        published: state.published,
        failed: state.failed,
        lastPublish: state.last,
        recentRecords: state.recent.slice(),
      }),
    })
    boot.toolRegistered = true
  } catch (e) {
    boot.toolRegistered = false
    boot.toolError = String((e && e.message) || e)
  }

  if (cfg._path) archive(boot)
}

// OpenClaw plugin entry.
import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry'

export default definePluginEntry({
  id: 'rubato',
  name: 'Rubato',
  description: 'Publishes every model call state (Estimate/Thinking/Done/Error + token usage) to the desk device over MQTT.',
  register(api) {
    registerPlugin(api)
  },
})
