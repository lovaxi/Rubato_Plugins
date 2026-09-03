// Rubato (musical term: stolen time) — configuration for the Claude Code plugin.
// User-side port of the DSH plugin (Rubato_Plugins/dsh, the authoritative
// implementation). Per PLUGIN_SPEC.md §1/§3/§5/§6, user-side plugins are
// MINIMAL: no estimator/calibration (Estimate carries no estSec), no local
// archive/stats (zero persistent local files except the config), no model
// tools. The only user-facing fields are username (= the deviceId printed on
// the device sticker, RUBATO-<mac6>) and password; clientId/topic/enabled are
// identity-derived.
//
// Config lookup (spec §4, cwd first so several harnesses share one file):
//   1. $RUBATO_DATA_DIR/rubato-mqtt-config.json   explicit override (tests)
//   2. <daemon cwd>/rubato-mqtt-config.json       host process cwd (spec order)
//   3. $CLAUDE_PLUGIN_DATA/rubato-mqtt-config.json  Claude Code's persistent
//      plugin-data dir — the CC-specific analog of the plugin root: it is the
//      only location that survives marketplace plugin updates
//   4. <plugin root>/rubato-mqtt-config.json      travels with the install
// Legacy names (dsh-mqtt-config.json, cc-mqtt-config.json) are renamed in
// place to the generic name on first touch (spec §4), credentials preserved.
import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

export const CONFIG_NAME = 'rubato-mqtt-config.json'
const CONFIG_LEGACIES = ['dsh-mqtt-config.json', 'cc-mqtt-config.json']
export const SETUP_MARKER = '.setup-shown'
export const TEMPLATE_TEXT = `{
  "username": "",
  "password": ""
}
`

export function pluginRoot() {
  return dirname(dirname(fileURLToPath(import.meta.url)))
}

function configDirs() {
  const dirs = []
  if (process.env.RUBATO_DATA_DIR) dirs.push(process.env.RUBATO_DATA_DIR)
  dirs.push(process.cwd()) // spec §4: host cwd first (shared across harnesses)
  if (process.env.CLAUDE_PLUGIN_DATA) dirs.push(process.env.CLAUDE_PLUGIN_DATA)
  dirs.push(pluginRoot())
  return dirs
}

// Hook->daemon IPC runtime (queue spool, singleton lock, liveness status).
// Ephemeral OS temp, not user data: user-side plugins keep zero persistent
// local files except the config (spec §5); the spool is the transport of the
// CC hook-mapping layer, not a diagnostic archive.
export function runtimeDir() {
  const dir = process.env.RUBATO_DATA_DIR || join(tmpdir(), 'rubato-cc')
  try { mkdirSync(dir, { recursive: true }) } catch { /* exists */ }
  return dir
}

export const DEFAULTS = {
  // enabled is NOT a user setting: it is derived on every load — credentials
  // filled = publishing on. An explicit enabled:false in the file remains the
  // manual off switch for people who want the plugin silent but installed.
  host: 'ubaa35f0.ala.cn-shenzhen.emqxsl.cn', // EMQX Cloud Serverless, TLS-only
  port: 8883,
  tls: true,
  clientId: '', // derived: CC-RUBATO-<mac6>
  username: '', // deviceId from the device sticker (RUBATO-xxxxxx)
  password: '', // the token paired with that deviceId
  topic: '', // derived: rubato/<username>/state
  qos: 1,
}

// Fill the identity-derived fields the user never has to configure, and
// derive enablement: credentials present = on; explicit enabled:false = off.
// clientId uses the registered CC prefix (spec §2.2): CC-RUBATO-<mac6> — the
// device id RUBATO-<mac6> without its RUBATO- prefix. A username that is
// already a dedicated CC- identity is used as-is; an explicit clientId in the
// config always wins.
export function deriveIdentity(cfg) {
  if (cfg.username) {
    if (!cfg.clientId) {
      if (/^CC-/i.test(cfg.username)) cfg.clientId = cfg.username
      else cfg.clientId = 'CC-RUBATO-' + cfg.username.replace(/^RUBATO-/i, '')
    }
    if (!cfg.topic) cfg.topic = 'rubato/' + cfg.username + '/state'
  }
  if (cfg.enabled === undefined) cfg.enabled = Boolean(cfg.username && cfg.password)
  return cfg
}

// One-time per-directory config migration to the generic name (spec §4): the
// fresh name wins; a legacy file is renamed in place so credentials survive.
// If the rename is blocked (locked file, permissions), the legacy path works.
function resolveConfigPath(dir) {
  const fresh = join(dir, CONFIG_NAME)
  if (existsSync(fresh)) return fresh
  for (const legacy of CONFIG_LEGACIES) {
    const p = join(dir, legacy)
    if (!existsSync(p)) continue
    try { renameSync(p, fresh); return fresh } catch { return p }
  }
  return null
}

function envOverrides() {
  // userConfig options declared in plugin.json: prompted by /plugin at enable
  // time and exported to hook processes (and thus the daemon) as
  // CLAUDE_PLUGIN_OPTION_* env vars. They win over the config file, so
  // rotating the token via /plugin config takes effect on the next daemon
  // start; the file remains the manual fallback.
  const o = {}
  const u = process.env.CLAUDE_PLUGIN_OPTION_USERNAME
  const p = process.env.CLAUDE_PLUGIN_OPTION_PASSWORD
  if (u && u.trim()) o.username = u.trim()
  if (p && p.trim()) o.password = p.trim()
  return o
}

// Load config, hot-reloaded per record (spec §4). The leading BOM strip is
// input tolerance beyond dsh (whose loader would throw on a BOM): it changes
// nothing for spec-clean files and rescues configs saved by BOM-happy editors.
export function loadConfig() {
  for (const dir of configDirs()) {
    const p = resolveConfigPath(dir)
    if (!p) continue
    try {
      // Tolerate // comment lines: the auto-generated template documents
      // itself with them; plain JSON.parse would reject them.
      const text = readFileSync(p, 'utf8')
        .replace(/^\uFEFF/, '')
        .split(/\r?\n/)
        .filter((line) => !line.trim().startsWith('//'))
        .join('\n')
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed === 'object') {
        return deriveIdentity({ ...DEFAULTS, ...parsed, ...envOverrides(), _path: p })
      }
    } catch {
      // try next candidate
    }
  }
  return deriveIdentity({ ...DEFAULTS, ...envOverrides(), _path: null })
}

export function configured(cfg) {
  return Boolean(cfg.username && cfg.password)
}

// First-run UX (spec §4): drop the pure-JSON template — no comments in it —
// in the most persistent candidate dir, then a SETUP guide points at it.
export function createConfigTemplate() {
  const dir = process.env.RUBATO_DATA_DIR || process.env.CLAUDE_PLUGIN_DATA || pluginRoot()
  try { mkdirSync(dir, { recursive: true }) } catch { /* exists */ }
  const p = join(dir, CONFIG_NAME)
  if (!existsSync(p)) {
    try { writeFileSync(p, TEMPLATE_TEXT, 'utf8') } catch { /* best effort */ }
  }
  return p
}

export function setupNotice(cfg) {
  return [
    '[Rubato] SETUP REQUIRED - MQTT credentials not configured',
    '  1. open:        ' + (cfg._path || createConfigTemplate()),
    '  2. "username":  the deviceId printed on the device sticker (RUBATO-xxxxxx)',
    '  3. "password":  the token paired with that deviceId',
    '  save the file and you are done - the plugin auto-enables once both',
    '  fields are filled (next prompt, no restart).',
  ].join('\n')
}
