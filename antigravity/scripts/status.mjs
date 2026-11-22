// Rubato status inspector for the Antigravity plugin.
// Prints a JSON summary: MQTT config (secrets masked) and daemon liveness with
// publish counters. User-side plugins keep no local archive (spec §5) and
// register no model tools (spec §6); this is a standalone CLI helper.
// Usage: node scripts/status.mjs [workspaceCwd]
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { loadConfig, configured, runtimeDir, pluginRoot, CONFIG_NAME } from '../lib/config.mjs'

// Fallback lookup for Antigravity's persistent plugin_data dir when invoked
// from a regular shell outside hook processes (where PLUGIN_DATA is unset).
function defaultPluginDataDir() {
  return join(homedir(), '.gemini', 'antigravity', 'plugin_data', 'rubato')
}

const workspaceCwd = process.argv[2] || null
const prevPluginData = process.env.PLUGIN_DATA
if (!process.env.RUBATO_DATA_DIR && !prevPluginData && existsSync(defaultPluginDataDir())) {
  process.env.PLUGIN_DATA = defaultPluginDataDir()
}
const cfg = loadConfig(workspaceCwd)
if (prevPluginData === undefined) delete process.env.PLUGIN_DATA
const rtDir = runtimeDir()

let daemon = null
try { daemon = JSON.parse(readFileSync(join(rtDir, 'daemon.json'), 'utf8')) } catch { daemon = null }

const isConfigured = Boolean(configured(cfg) || (daemon && daemon.configured))
const mask = (s) => (s ? String(s).slice(0, 3) + '***' : '')

console.log(JSON.stringify({
  configPath: cfg._path || join(defaultPluginDataDir(), CONFIG_NAME) + ' (or ' + join(pluginRoot(), CONFIG_NAME) + ')',
  configured: isConfigured,
  ...(isConfigured ? {} : {
    setupHint: 'Put username (deviceId from the device sticker, RUBATO-xxxxxx) and password (its token) into ' + CONFIG_NAME + ' in the configPath above; the plugin auto-enables once both are filled.',
  }),
  enabled: cfg.enabled,
  host: cfg.host,
  clientId: cfg.clientId || null,
  topic: cfg.topic || null,
  qos: cfg.qos,
  usernameMasked: mask(cfg.username),
  daemon: daemon || { running: false, hint: 'no daemon yet - it spawns on your next model invocation' },
  runtimeDir: rtDir,
}, null, 2))
