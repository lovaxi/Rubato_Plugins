// ThinkTime — durable model-state monitor for DeepSeek Harness.
// Captures every streaming model call in this process (thinking / generating /
// done) and publishes each state plus the final token usage as MQTT messages
// to EMQX Cloud (thinktime/<username>/state). Auth mirrors the device firmware
// (Thinktime.ino): username = deviceId (TT-<mac6>), password = the per-unit
// token. Loaded as a host plugin from the web profile's cordis.patch.yml, so
// it auto-starts with dsh.
//
// First-run UX: when no config file exists anywhere, a self-documenting
// template is dropped next to the plugin and a setup guide is printed at boot;
// the mqmon_status tool reports configured:false until username+password land.
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { publishRecord } from './mqtt.js'

// Plugin root (lib/..): template + default config home; travels with installs.
const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

const DEFAULTS = {
  // enabled is NOT a user setting: it is derived on every load — credentials
  // filled = publishing on. An explicit enabled:false in the file remains the
  // manual off switch for people who want the plugin silent but installed.
  host: 'ubaa35f0.ala.cn-shenzhen.emqxsl.cn', // EMQX Cloud Serverless, TLS-only
  port: 8883,
  tls: true,
  clientId: '', // derived: DSH-<username>
  username: '',
  password: '',
  topic: '', // derived: thinktime/<username>/state
  qos: 1,
}

// Config file lookup order: the host process cwd, then the plugin root
// (config travels with the install). First existing file wins; edits take
// effect on the next record (hot reload).
const CONFIG_CANDIDATES = [
  join(process.cwd(), 'dsh-mqtt-config.json'),
  join(PLUGIN_ROOT, 'dsh-mqtt-config.json'),
]

// Fill the identity-derived fields the user never has to configure, and
// derive enablement: credentials present = on; explicit enabled:false = off.
function deriveIdentity(cfg) {
  if (cfg.username) {
    if (!cfg.clientId) cfg.clientId = 'DSH-' + cfg.username
    if (!cfg.topic) cfg.topic = 'thinktime/' + cfg.username + '/state'
  }
  if (cfg.enabled === undefined) cfg.enabled = Boolean(cfg.username && cfg.password)
  return cfg
}

function loadConfig() {
  for (const p of CONFIG_CANDIDATES) {
    try {
      // Tolerate // comment lines: the auto-generated template documents
      // itself with them; plain JSON.parse would reject them.
      const text = readFileSync(p, 'utf8')
        .split(/\r?\n/)
        .filter((line) => !line.trim().startsWith('//'))
        .join('\n')
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed === 'object') {
        return deriveIdentity({ ...DEFAULTS, ...parsed, _path: p })
      }
    } catch {
      // try next candidate
    }
  }
  return deriveIdentity({ ...DEFAULTS, _path: null })
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
  const p = join(PLUGIN_ROOT, 'dsh-mqtt-config.json')
  if (!existsSync(p)) {
    try { writeFileSync(p, TEMPLATE_TEXT, 'utf8') } catch { /* best effort */ }
  }
  return p
}

// ---- Duration estimator (zero-token, feature-based kNN) --------------------
// No discrete S/M/L types: every stream's features are compared against the
// model's real historical samples, and duration is predicted as a similarity-
// weighted average of the nearest ones. Context size is the dominant feature.

// Extract estimation features from GenerateOptions at stream start.
//   c  = total chars across all messages (proxy for input/context size)
//   l  = last user message length
//   f  = code-fence pairs in the last user message (capped)
//   v/fl = task-verb / file-reference flags on the last user message
//   n  = message count (turn depth)
//   e  = reasoningEffort requested for this call (harness's own difficulty dial)
function extractFeatures(options) {
  const msgs = options && Array.isArray(options.messages) ? options.messages : []
  let ctxChars = 0
  let last = ''
  for (const m of msgs) {
    if (!m) continue
    let text = ''
    if (typeof m.content === 'string') text = m.content
    else if (Array.isArray(m.content)) text = m.content.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join(' ')
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
    e: options && options.reasoningEffort ? String(options.reasoningEffort) : '',
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

export default {
  name: 'Thinktime',
  // Hard dependency: the tools service mounts after plain plugins apply, so
  // declare it and let Cordis re-apply once it appears — otherwise both model
  // tools (mqmon_status / mqmon_setup) never register.
  inject: ['tools'],
  apply(ctx) {
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
      console.error('[Thinktime] enabled but host/topic missing; fix dsh-mqtt-config.json')
    }
    if (unconfigured) {
      console.error('============================================================')
      console.error('[Thinktime] SETUP REQUIRED - MQTT credentials not configured')
      console.error('  1. open:        ' + (cfg._path || '<plugin root>/dsh-mqtt-config.json'))
      console.error('  2. "username":  the deviceId printed on the device sticker (TT-xxxxxx)')
      console.error('  3. "password":  the token paired with that deviceId')
      console.error('  save the file and you are done - the plugin auto-enables once both')
      console.error('  fields are filled (next message, no restart).')
      console.error('============================================================')
    }

    const publish = async (record) => {
      cfg = loadConfig() // hot reload per record
      // Local archive: every record lands as one JSON line next to the config
      // file (always, regardless of MQTT enablement) for direct inspection.
      if (cfg._path) {
        try { appendFileSync(join(dirname(cfg._path), 'thinktime-records.jsonl'), JSON.stringify(record) + '\n') } catch { /* best effort */ }
      }
      // Program-judged readiness: publish only when enabled AND credentials
      // are present; otherwise archive locally and keep waiting for setup.
      if (!cfg.enabled || !cfg.username || !cfg.password) { pushRecent(record); return }
      try {
        await publishRecord(cfg, record)
        state.published += 1
        state.last = { ok: true, at: Date.now(), state: record.state }
      } catch (e) {
        state.failed += 1
        state.last = { ok: false, at: Date.now(), state: record.state, detail: String(e && e.message || e) }
      }
    }

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

    // Model-visible status tool (optional service; failure must not kill the plugin).
    // Registration outcome is recorded into the archive's _boot line for diagnosis.
    try {
      const tools = ctx.get('tools')
      if (tools) {
        ctx.effect(() => tools.register({
          name: 'mqmon_status',
          description: 'Report the Thinktime plugin status: MQTT config summary, recent captured model-call records (thinking/generating/done with token usage), and the last MQTT publish outcome.',
          parameters: { type: 'object', properties: {} },
          output: {
            schema: {},
            render: (args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
          },
          execute: async () => ({
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
          }),
        }))
        boot.toolRegistered = true
      } else {
        boot.toolRegistered = false
        boot.toolError = 'tools service absent'
      }
    } catch (e) {
      boot.toolRegistered = false
      boot.toolError = String(e && e.message || e)
    }

    if (cfg._path) {
      try { appendFileSync(join(dirname(cfg._path), 'thinktime-records.jsonl'), JSON.stringify(boot) + '\n') } catch { /* best effort */ }
    }

    // Token summary matching the receiver contract: { out, cache, cost? }.
    // cost is derived from cfg.pricing ({ input, output, cacheRead } USD per 1M
    // tokens) and omitted when pricing is not configured.
    const tokensFor = (usage) => {
      if (!usage || typeof usage !== 'object') return undefined
      const t = {}
      if (typeof usage.outputTokens === 'number') t.out = usage.outputTokens
      if (typeof usage.cacheReadTokens === 'number') t.cache = usage.cacheReadTokens
      const p = cfg.pricing
      if (p && typeof p === 'object') {
        const inTok = typeof usage.inputTokens === 'number' ? usage.inputTokens : 0
        const outTok = typeof usage.outputTokens === 'number' ? usage.outputTokens : 0
        const cacheTok = typeof usage.cacheReadTokens === 'number' ? usage.cacheReadTokens : 0
        const cost = ((p.input || 0) * inTok + (p.output || 0) * outTok + (p.cacheRead || 0) * cacheTok) / 1e6
        if (cost > 0) t.cost = Math.round(cost * 1e6) / 1e6
      }
      return Object.keys(t).length > 0 ? t : undefined
    }

    // Calibration store: { [model]: { samples: [ { c,l,f,v,fl, ms, o, t } ] } },
    // persisted next to the config file so estimates improve across restarts.
    // Legacy S/M/L bucket files are detected and reset (features不可回填).
    const MAX_SAMPLES = 200
    const statsPath = () => (cfg._path ? join(dirname(cfg._path), 'thinktime-stats.json') : null)
    let stats = null
    const loadStats = () => {
      if (stats) return stats
      try { stats = JSON.parse(readFileSync(statsPath(), 'utf8')) } catch { stats = {} }
      for (const key of Object.keys(stats)) {
        const entry = stats[key]
        if (!entry || typeof entry !== 'object' || !Array.isArray(entry.samples)) {
          stats[key] = { samples: [] } // legacy S/M/L shape (or junk): start fresh
        }
      }
      return stats
    }
    const saveStats = () => {
      const p = statsPath()
      if (!p || !stats) return
      try { writeFileSync(p, JSON.stringify(stats), 'utf8') } catch { /* best effort */ }
    }

    // Observe every streaming model call in this process.
    ctx.on('llm/stream', (options, next) => {
      const stream = next()
      // Contract key field: the exact model id in use for this call.
      const model = options.model || 'unknown'
      const tStart = Date.now()
      // Pre-thinking estimate: extract features locally (zero tokens) and
      // predict duration from this model's real historical samples via kNN,
      // falling back to a context-size prior while no samples exist. Emitted
      // before the first chunk, so it lands before Thinking. Wire format
      // carries ONLY the estimated duration (seconds).
      const feat = extractFeatures(options)
      loadStats()
      const estMsVal = Math.round(predictMs(stats[model] && stats[model].samples, feat))
      publish({
        model,
        state: 'Estimate',
        ts: tStart,
        estSec: Math.round(estMsVal / 100) / 10,
      })
      // Thinking fires at stream start (not on the first reasoning delta): the
      // harness UI shows thinking immediately, and prefill on large contexts
      // can delay the first delta by seconds - the device must not trail it.
      publish({ model, state: 'Thinking', ts: tStart })
      let generatingAt = null
      let usage = null
      let finishReason = null
      return (async function* () {
        try {
          for await (const chunk of stream) {
            if ((chunk.type === 'text-delta' || chunk.type === 'tool-call-delta') && generatingAt === null) {
              generatingAt = Date.now()
              publish({ model, state: 'Generating', ts: generatingAt })
            }
            if (chunk.type === 'usage') usage = chunk.usage
            if (chunk.type === 'finish') finishReason = chunk.reason && chunk.reason.kind ? chunk.reason.kind : null
            yield chunk
          }
          // A 'tool-calls' finish means the loop will execute tools and call the
          // model again — this stream is NOT the end of the turn, so no 'Done'
          // (only Thinking/Generating are emitted for such intermediate steps).
          if (finishReason === 'tool-calls') return
          const tokens = tokensFor(usage)
          publish({
            model,
            state: 'Done',
            ts: Date.now(),
            ...(tokens ? { tokens } : {}),
          })
          // Backfill calibration: store this call's features, real duration
          // (ms) and the estimate made at stream start (est) — so the stats
          // file itself documents predicted-vs-actual per sample. Capped list.
          const b = stats[model] || (stats[model] = { samples: [] })
          if (!Array.isArray(b.samples)) b.samples = []
          b.samples.push({
            c: feat.c, l: feat.l, f: feat.f, v: feat.v, fl: feat.fl,
            n: feat.n, e: feat.e,
            ms: Date.now() - tStart,
            est: estMsVal,
            o: usage && typeof usage.outputTokens === 'number' ? usage.outputTokens : 0,
            t: Date.now(),
          })
          if (b.samples.length > MAX_SAMPLES) b.samples.splice(0, b.samples.length - MAX_SAMPLES)
          saveStats()
        } catch (err) {
          publish({ model, state: 'Error', ts: Date.now(), error: String(err && err.message || err) })
          // Un-stick the device: it only exits the breathing state on done.
          publish({ model, state: 'Done', ts: Date.now() })
          throw err
        }
      })()
    })
  },
}
