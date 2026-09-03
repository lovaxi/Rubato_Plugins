// Rubato config for the Cursor extension — identity + MQTT endpoint, same
// shape as the dsh/ and openclaw/ plugins (authoritative: dsh/lib/index.js).
//
// Generic config name shared by every Rubato host plugin (spec §4): looked up
// in the extension host process cwd first — one shared config for every
// harness on this machine — then in the plugin directory (the template lands
// here on first run; config travels with the install). The pre-rename name
// `dsh-mqtt-config.json` is migrated in place on first lookup in a directory
// (skipped when the new name already exists there; if the rename fails the
// legacy path keeps working). First existing file wins; the extension
// hot-reloads the config on every publish.
//
// Identity is USER-ENTERED: username = the deviceId printed on the device
// sticker — Cursor-fleet devices are provisioned as `Cursor-RUBATO-<mac6>`
// (the `Cursor-` prefix capitalized exactly like that) — and password = the
// token paired with it. The sticker value is used verbatim; nothing is
// derived from the host machine. clientId/topic/enabled are identity-derived.
'use strict'

const fs = require('fs')
const path = require('path')

const CONFIG_NAME = 'rubato-mqtt-config.json'
const LEGACY_CONFIG_NAME = 'dsh-mqtt-config.json'

// clientId prefix for this harness — registered in PLUGIN_SPEC §2.2.
const CLIENT_ID_PREFIX = 'CUR-'

const DEFAULTS = {
  // enabled is NOT a user setting: it is derived on every load — credentials
  // filled = publishing on. An explicit enabled:false in the file remains the
  // manual off switch for people who want the plugin silent but installed.
  host: 'ubaa35f0.ala.cn-shenzhen.emqxsl.cn', // EMQX Cloud Serverless, TLS-only
  port: 8883,
  tls: true,
  clientId: '', // derived: CUR-<username> (= CUR-Cursor-RUBATO-<mac6>)
  username: '',
  password: '',
  topic: '', // derived: rubato/<username>/state
  qos: 1,
}

// Spec §4: the legacy config file is migrated (renamed) on first lookup in a
// directory — skipped when the new name already exists there; if the rename
// fails (locked etc.) the legacy path keeps working below.
function migrateLegacyConfig(dir) {
  const newPath = path.join(dir, CONFIG_NAME)
  const oldPath = path.join(dir, LEGACY_CONFIG_NAME)
  try {
    if (fs.existsSync(oldPath) && !fs.existsSync(newPath)) fs.renameSync(oldPath, newPath)
  } catch { /* rename failed: the legacy path keeps working below */ }
}

// Candidates in lookup order: per directory (cwd first, then plugin root),
// the new name first and the legacy name as fallback (covers a failed rename).
function configCandidates() {
  const dirs = [process.cwd(), path.join(__dirname, '..')]
  const out = []
  for (const dir of dirs) {
    migrateLegacyConfig(dir)
    out.push(path.join(dir, CONFIG_NAME), path.join(dir, LEGACY_CONFIG_NAME))
  }
  return out
}

// Fill the identity-derived fields the user never has to configure, and
// derive enablement: credentials present = on; explicit enabled:false = off.
function deriveIdentity(cfg) {
  if (cfg.username) {
    if (!cfg.clientId) cfg.clientId = CLIENT_ID_PREFIX + cfg.username
    if (!cfg.topic) cfg.topic = 'rubato/' + cfg.username + '/state'
  }
  if (cfg.enabled === undefined) cfg.enabled = Boolean(cfg.username && cfg.password)
  return cfg
}

function loadConfig() {
  for (const p of configCandidates()) {
    try {
      // Tolerate // comment lines: the auto-generated template documents
      // itself with them; plain JSON.parse would reject them.
      const text = fs.readFileSync(p, 'utf8')
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
  const p = path.join(__dirname, '..', CONFIG_NAME)
  if (!fs.existsSync(p)) {
    try { fs.writeFileSync(p, TEMPLATE_TEXT, 'utf8') } catch { /* best effort */ }
  }
  return p
}

module.exports = { CONFIG_NAME, LEGACY_CONFIG_NAME, CLIENT_ID_PREFIX, DEFAULTS, configCandidates, deriveIdentity, loadConfig, createConfigTemplate }
