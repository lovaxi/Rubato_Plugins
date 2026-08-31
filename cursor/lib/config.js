// Rubato config for the Cursor extension — identity + MQTT endpoint, same
// shape as the dsh/ and opencode/ plugins (authoritative: dsh/lib/index.js).
//
// Lookup order: the extension host process cwd's dsh-mqtt-config.json first —
// the SAME file the other Rubato host plugins read, so one machine with one
// device shares one config across harnesses — then the plugin directory (the
// template lands here on first run; config travels with the install). First
// existing file wins; the extension hot-reloads it on every publish.
//
// Identity is USER-ENTERED, exactly like every other Rubato plugin: username =
// the deviceId printed on the device sticker (RUBATO-<mac6>), password = its
// token. Nothing is derived from the host machine and the sticker value is
// used verbatim. clientId/topic/enabled are identity-derived.
'use strict'

const fs = require('fs')
const path = require('path')

const CONFIG_NAME = 'dsh-mqtt-config.json'

// clientId prefix for this harness — registered in PLUGIN_SPEC §2.2.
const CLIENT_ID_PREFIX = 'CUR-'

const DEFAULTS = {
  // enabled is NOT a user setting: it is derived on every load — credentials
  // filled = publishing on. An explicit enabled:false in the file remains the
  // manual off switch for people who want the plugin silent but installed.
  host: 'ubaa35f0.ala.cn-shenzhen.emqxsl.cn', // EMQX Cloud Serverless, TLS-only
  port: 8883,
  tls: true,
  clientId: '', // derived: CUR-<username> (= CUR-RUBATO-<mac6>)
  username: '',
  password: '',
  topic: '', // derived: rubato/<username>/state
  qos: 1,
}

function configCandidates() {
  return [
    path.join(process.cwd(), CONFIG_NAME),
    path.join(__dirname, '..', CONFIG_NAME),
  ]
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

module.exports = { CONFIG_NAME, CLIENT_ID_PREFIX, DEFAULTS, configCandidates, deriveIdentity, loadConfig, createConfigTemplate }
