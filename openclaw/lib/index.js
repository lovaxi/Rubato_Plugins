// Rubato — durable model-state monitor for OpenClaw (龙虾).
// User-side port of the DSH rubato plugin (Rubato_Plugins/dsh is the
// authoritative implementation); the device contract is identical:
//   Estimate  { model, state:'Estimate', ts }      call started (NO estSec —
//                                                  the zero-token estimator is
//                                                  dsh-only until validated,
//                                                  spec §2.3/§3/§7)
//   Thinking  { model, state:'Thinking', ts }      provider call started
//   Done      { model, state:'Done', ts }          turn end (wire is lean)
//   Error     { model, state:'Error', ts, error }  provider call failed
// Every record is published as one MQTT message (lib/mqtt.js, persistent
// connection). User-side discipline (spec §5/§6/§7): zero local writes beyond
// the config file and zero model tools — the local archive, the kNN estimator
// and the mqmon_status tool are dsh-only development facilities. Diagnostics
// rely on the device itself and the broker console.
//
// Broker: EMQX Cloud Serverless (TLS-only). Auth mirrors the device firmware
// (rubato.ino): username = deviceId (RUBATO-<mac6>), password = the per-unit
// token; clientId/topic/enabled are identity-derived, so the config only needs
// username + password.
//
// OpenClaw hook mapping (typed plugin hooks, api.on):
//   model_call_started -> Estimate + Thinking
//   model_call_ended   -> Error+Done on failure; success arms a debounced Done
//                         that is cancelled by the next model_call_started (so
//                         mid-turn tool-loop steps never flash Done). The
//                         debounce doubles as the user-stop safety net (spec
//                         §2.4.8): even if agent_end never fires, the device
//                         un-sticks 1.5s after the last call ends.
//   agent_end          -> terminal Done for the run
//   gateway_stop       -> cancel timers
// First-run UX: when no config file exists anywhere, a self-documenting
// template is dropped next to the plugin and a setup guide is printed at boot.
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs'
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
  clientId: '', // derived: Claw-<username> (= Claw-RUBATO-<mac6>)
  username: '',
  password: '',
  topic: '', // derived: rubato/<username>/state
  qos: 1,
}

// Generic config name shared by every Rubato host plugin (spec §4). The
// pre-rename name is migrated in place on first lookup in a directory.
const CONFIG_NAME = 'rubato-mqtt-config.json'
const LEGACY_CONFIG_NAME = 'dsh-mqtt-config.json'

// Config lookup: the gateway process cwd first (one shared config for every
// Rubato host on this machine), then the plugin root. First existing file
// wins; edits take effect on the next record (hot reload).
function migrateLegacyConfig(dir) {
  const newPath = join(dir, CONFIG_NAME)
  const oldPath = join(dir, LEGACY_CONFIG_NAME)
  try {
    if (existsSync(oldPath) && !existsSync(newPath)) renameSync(oldPath, newPath)
  } catch {
    // rename failed (locked etc.): the legacy path keeps working below
  }
}

function configCandidates(overrides) {
  if (overrides && overrides.configPath) return [overrides.configPath]
  return [process.cwd(), PLUGIN_DIR].flatMap((dir) => {
    migrateLegacyConfig(dir)
    return [join(dir, CONFIG_NAME), join(dir, LEGACY_CONFIG_NAME)]
  })
}

// Fill the identity-derived fields the user never has to configure, and
// derive enablement: credentials present = on; explicit enabled:false = off.
function deriveIdentity(cfg) {
  if (cfg.username) {
    // Standard formula (spec §2.2): <prefix>-<username> — 'Claw-' + the
    // deviceId-as-username (RUBATO-<mac6>) = Claw-RUBATO-<mac6>. It differs
    // from the device's own clientId (= deviceId) and every other agent's.
    if (!cfg.clientId) cfg.clientId = 'Claw-' + cfg.username
    if (!cfg.topic) cfg.topic = 'rubato/' + cfg.username + '/state'
  }
  if (cfg.enabled === undefined) cfg.enabled = Boolean(cfg.username && cfg.password)
  return cfg
}

function loadConfig(overrides) {
  for (const p of configCandidates(overrides)) {
    try {
      // Tolerate // comment lines: users may annotate their config; plain
      // JSON.parse would reject them.
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
  const p = join(PLUGIN_DIR, CONFIG_NAME)
  if (!existsSync(p)) {
    try { writeFileSync(p, TEMPLATE_TEXT, 'utf8') } catch { /* best effort */ }
  }
  return p
}

// ---- Plugin runtime --------------------------------------------------------

const DONE_DEBOUNCE_MS = 1500
const RUN_MAP_CAP = 64

function registerPlugin(api) {
  const pluginOverrides = {} // reserved: plugins.entries.rubato.config overrides
  let cfg = loadConfig(pluginOverrides)
  if (!cfg._path) {
    // First run on a fresh install: drop a self-documenting template next to
    // the plugin, then load it (enabled:false) so setup starts from a file.
    createConfigTemplate()
    cfg = loadConfig(pluginOverrides)
  }
  const unconfigured = !cfg.username || !cfg.password
  // Console policy: configuration reminders ONLY. No per-message or publish
  // chatter — user-side diagnostics live on the device and broker console.
  if (cfg.enabled && (!cfg.host || !cfg.topic)) {
    console.error('[Rubato] enabled but host/topic missing; fix ' + CONFIG_NAME)
  }
  if (unconfigured) {
    console.error('============================================================')
    console.error('[Rubato] SETUP REQUIRED - MQTT credentials not configured')
    console.error('  1. open:        ' + (cfg._path || '<plugin root>/' + CONFIG_NAME))
    console.error('  2. "username":  the deviceId printed on the device sticker (RUBATO-xxxxxx)')
    console.error('  3. "password":  the token paired with that deviceId')
    console.error('  save the file and you are done - the plugin auto-enables once both')
    console.error('  fields are filled (next message, no restart).')
    console.error('============================================================')
  }

  // User-side discipline (spec §5): publish or stay silent — nothing is
  // written locally, publish outcomes are not reported anywhere.
  const publish = async (record) => {
    cfg = loadConfig(pluginOverrides) // hot reload per record
    if (!cfg.enabled || !cfg.username || !cfg.password) return
    try {
      await publishRecord(cfg, record)
    } catch {
      // silent by design: no console chatter, no local diagnostics (spec §5)
    }
  }

  // ---- Per-run tracking (subagent runs have their own runId) --------------
  const runs = new Map() // rid -> { model, doneTimer }
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

  // model_call_started: Estimate + Thinking.
  api.on('model_call_started', (event, hookCtx) => {
    try {
      const rid = ridOf(event, hookCtx)
      const r = runs.get(rid) || {}
      clearTimeout(r.doneTimer) // a follow-up call cancels the pending Done
      const model = (event && (event.model || event.modelId)) || 'unknown'
      r.model = model
      runs.set(rid, r)
      // Estimate lands before any chunk. User-side wire contract: NO estSec —
      // the zero-token estimator is dsh-only until validated (spec §2.3/§7).
      publish({ model, state: 'Estimate', ts: Date.now() })
      // Thinking fires at call start (not on the first reasoning delta): the
      // harness UI shows thinking immediately, and prefill on large contexts
      // can delay the first delta by seconds - the device must not trail it.
      publish({ model, state: 'Thinking', ts: Date.now() })
    } catch (e) {
      console.error('[Rubato] model_call_started handler failed: ' + ((e && e.message) || e))
    }
  })

  // model_call_ended: failure publishes Error + Done (un-stick, like DSH);
  // success only arms a debounced Done in case agent_end never fires on this
  // runner. No calibration backfill: the estimator is dsh-only (spec §3).
  api.on('model_call_ended', (event, hookCtx) => {
    try {
      const rid = ridOf(event, hookCtx)
      const r = runs.get(rid) || {}
      const model = r.model || (event && (event.model || event.modelId)) || 'unknown'
      const ev = event || {}
      const outcome = ev.outcome || ev.status || 'ok'
      const ok = outcome === 'ok' || outcome === 'success'
      clearTimeout(r.doneTimer)
      // User stop / early teardown (spec §2.4.8): NOT an error — un-stick the
      // device with a lean Done and no Error record. Genuine failures (any
      // other non-ok outcome) get the Error + Done pair (spec §2.4.6).
      const stopped = ev.aborted === true || /^(abort|cancel|interrupt|stop)/i.test(String(outcome))
      if (stopped) {
        publish({ model, state: 'Done', ts: Date.now() })
        return
      }
      if (!ok) {
        // Un-stick the device: it only exits the breathing state on done.
        publish({ model, state: 'Error', ts: Date.now(), error: String((ev.error && (ev.error.message || ev.error)) || outcome) })
        publish({ model, state: 'Done', ts: Date.now() })
        return
      }
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

  // Done wire contract is lean: { model, state, ts } (spec §2.4.5).
  function publishDone(rid) {
    const r = runs.get(rid) || {}
    publish({ model: r.model || 'unknown', state: 'Done', ts: Date.now() })
  }
}

// OpenClaw plugin entry.
import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry'

export default definePluginEntry({
  id: 'rubato',
  name: 'Rubato',
  description: 'Publishes every model call state (Estimate/Thinking/Done/Error) to the desk device over MQTT.',
  register(api) {
    registerPlugin(api)
  },
})
