// Rubato config for the Codex plugin — identity + MQTT endpoint, same shape as
// the dsh/ and opencode/ plugins (authoritative: dsh/lib/index.js).
//
// Generic config name shared by every Rubato plugin (spec §4): looked up in the
// host process cwd first — one shared config for every harness on this machine
// — then in the plugin directory (the template lands here on first run; config
// travels with the install). The pre-rename name `dsh-mqtt-config.json` is
// migrated in place on first lookup in a directory (skipped when the new name
// already exists there; if the rename fails the legacy path keeps working).
// First existing file wins; the plugin hot-reloads the config on every publish.
//
// Identity is USER-ENTERED: username = the deviceId printed on the device
// sticker — `RUBATO-<mac6>` (uppercase brand, per the provisioning ledger) —
// and password = the token paired with it. The sticker value is used verbatim;
// nothing is derived from the host machine. clientId/topic/enabled are
// identity-derived: clientId = 'Codex-' + username = Codex-RUBATO-<mac6>
// (spec §2.2 registration for the Codex harness).
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)))

export const CONFIG_NAME = 'rubato-mqtt-config.json'
export const LEGACY_CONFIG_NAME = 'dsh-mqtt-config.json'

// clientId prefix for this harness — registered in PLUGIN_SPEC §2.2.
export const CLIENT_ID_PREFIX = 'Codex-'

export const DEFAULTS = {
  // enabled is NOT a user setting: it is derived on every load — credentials
  // filled = publishing on. An explicit enabled:false in the file remains the
  // manual off switch for people who want the plugin silent but installed.
  host: 'ubaa35f0.ala.cn-shenzhen.emqxsl.cn', // EMQX Cloud Serverless, TLS-only
  port: 8883,
  tls: true,
  clientId: '', // derived: Codex-<username> (= Codex-RUBATO-<mac6>)
  username: '',
  password: '',
  topic: '', // derived: rubato/<username>/state
  qos: 1,
}

// Spec §4: the legacy config file is migrated (renamed) on first lookup in a
// directory — skipped when the new name already exists there; if the rename
// fails (locked etc.) the legacy path keeps working below.
function migrateLegacyConfig(dir) {
  const newPath = join(dir, CONFIG_NAME)
  const oldPath = join(dir, LEGACY_CONFIG_NAME)
  try {
    if (existsSync(oldPath) && !existsSync(newPath)) renameSync(oldPath, newPath)
  } catch { /* rename failed: the legacy path keeps working below */ }
}

// Candidates in lookup order: per directory (cwd first, then plugin root),
// the new name first and the legacy name as fallback (covers a failed rename).
function configCandidates() {
  const dirs = [process.cwd(), PLUGIN_DIR]
  const out = []
  for (const dir of dirs) {
    migrateLegacyConfig(dir)
    out.push(join(dir, CONFIG_NAME), join(dir, LEGACY_CONFIG_NAME))
  }
  return out
}

// Fill the identity-derived fields the user never has to configure, and derive
// enablement: credentials present = on; explicit enabled:false = off.
function deriveIdentity(cfg) {
  if (cfg.username) {
    if (!cfg.clientId) cfg.clientId = CLIENT_ID_PREFIX + cfg.username
    if (!cfg.topic) cfg.topic = 'rubato/' + cfg.username + '/state'
  }
  if (cfg.enabled === undefined) cfg.enabled = Boolean(cfg.username && cfg.password)
  return cfg
}

function parseConfigFile(p, overrides) {
  try {
    // Tolerate // comment lines: the auto-generated template documents
    // itself with them; plain JSON.parse would reject them. (The config file
    // itself must be BOM-free — spec §9.4.)
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
  return null
}

export function loadConfig(overrides) {
  // Explicit path (tests / exotic setups): read directly, no migration.
  if (overrides && overrides.configPath) {
    const direct = parseConfigFile(overrides.configPath, overrides)
    if (direct) return direct
  }
  for (const p of configCandidates()) {
    const cfg = parseConfigFile(p, overrides)
    if (cfg) return cfg
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

// First run on a fresh install: drop a self-documenting template next to the
// plugin. The user fills username (RUBATO-xxxxxx from the sticker) + token.
export function createConfigTemplate() {
  const p = join(PLUGIN_DIR, CONFIG_NAME)
  if (!existsSync(p)) {
    try { writeFileSync(p, TEMPLATE_TEXT, 'utf8') } catch { /* best effort */ }
  }
  return p
}
