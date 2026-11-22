// Rubato (musical term: stolen time) — configuration for the Antigravity plugin.
// User-side port of the DSH plugin (Rubato_Plugins/dsh, the authoritative
// implementation). Per PLUGIN_SPEC.md §1/§3/§5/§6, user-side plugins are
// MINIMAL: no estimator/calibration (Estimate carries no estSec), no local
// archive/stats (zero persistent local files except the config), no model
// tools. The only user-facing fields are username (= the deviceId printed on
// the device sticker, RUBATO-<mac6>) and password; clientId/topic/enabled are
// identity-derived.
//
// Config lookup (spec §4, workspace/host cwd first so several harnesses share
// one file):
//   1. $RUBATO_DATA_DIR/rubato-mqtt-config.json  explicit override (tests)
//   2. <workspace cwd>/rubato-mqtt-config.json   session cwd from hook payload
//   3. <process cwd>/rubato-mqtt-config.json     daemon/CLI cwd fallback
//   4. $PLUGIN_DATA/rubato-mqtt-config.json      Antigravity persistent plugin data dir
//   5. <plugin root>/rubato-mqtt-config.json     travels with the install
// Legacy names (dsh-mqtt-config.json, agy-mqtt-config.json) are renamed in
// place to the generic name on first touch (spec §4), credentials preserved.
import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

export const CONFIG_NAME = 'rubato-mqtt-config.json'
const CONFIG_LEGACIES = ['dsh-mqtt-config.json', 'agy-mqtt-config.json']
export const SETUP_MARKER = '.setup-shown'
export const TEMPLATE_TEXT = `{
  "username": "",
  "password": ""
}
`

export function pluginRoot() {
  return dirname(dirname(fileURLToPath(import.meta.url)))
}

function configDirs(workspaceCwd) {
  const candidates = [
    process.env.RUBATO_DATA_DIR,
    workspaceCwd,
    process.cwd(),
    process.env.PLUGIN_DATA,
    process.env.PLUGIN_ROOT,
    pluginRoot(),
  ]
  const seen = new Set()
  const dirs = []
  for (const raw of candidates) {
    if (!raw || typeof raw !== 'string') continue
    const norm = resolve(raw)
    const key = process.platform === 'win32' ? norm.toLowerCase() : norm
    if (seen.has(key)) continue
    seen.add(key)
    dirs.push(norm)
  }
  return dirs
}

// Hook->daemon IPC runtime (queue spool, singleton lock, liveness status).
// Ephemeral OS temp, not user data: user-side plugins keep zero persistent
// local files except the config (spec §5); the spool is the transport of the
// Antigravity hook-mapping layer, not a diagnostic archive.
export function runtimeDir() {
  const dir = process.env.RUBATO_DATA_DIR || join(tmpdir(), 'rubato-agy')
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
  clientId: '', // derived: AGY-<username> (e.g. AGY-RUBATO-<mac6>)
  username: '', // deviceId from the device sticker (RUBATO-xxxxxx)
  password: '', // the token paired with that deviceId
  topic: '', // derived: rubato/<username>/state
  qos: 1,
}

// Fill the identity-derived fields the user never has to configure, and
// derive enablement: credentials present = on; explicit enabled:false = off.
// clientId follows spec §2.2 (<prefix>-<username>): AGY-<username>.
export function deriveIdentity(cfg) {
  if (cfg.username) {
    if (!cfg.clientId) cfg.clientId = 'AGY-' + cfg.username
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

// Load config, hot-reloaded per record (spec §4). Leading BOM is stripped as
// input tolerance (rescuing configs edited in BOM-adding editors) while the
// generated template itself stays clean UTF-8 without BOM.
export function loadConfig(workspaceCwd) {
  for (const dir of configDirs(workspaceCwd)) {
    const p = resolveConfigPath(dir)
    if (!p) continue
    try {
      const text = readFileSync(p, 'utf8')
        .replace(/^\uFEFF/, '')
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

export function configured(cfg) {
  return Boolean(cfg.username && cfg.password)
}

// First-run UX (spec §4): drop the pure-JSON template — no comments, no BOM —
// in the most persistent candidate dir, then a SETUP guide points at it.
export function createConfigTemplate() {
  const dir = process.env.RUBATO_DATA_DIR || process.env.PLUGIN_DATA || process.env.PLUGIN_ROOT || pluginRoot()
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
    '  fields are filled (next invocation, no restart).',
  ].join('\n')
}

export function setupMarkdown(cfg) {
  const target = cfg._path || createConfigTemplate()
  return [
    '**[Rubato] SETUP REQUIRED** — MQTT credentials not configured',
    '',
    `1. Open \`${target}\``,
    '2. Set `"username"` to the deviceId on the device sticker (`RUBATO-xxxxxx`)',
    '3. Set `"password"` to the token paired with that deviceId',
    '',
    'Save the file and you are done — Rubato auto-enables on the next model call (no restart needed).',
  ].join('\n')
}
