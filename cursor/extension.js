// Rubato (musical term: stolen time) — model-state monitor for Cursor.
// User-side port of the DSH plugin (dsh/ in the Rubato_Plugins repository).
// Device contract (spec §2.3 — user-side records are lean):
//   Estimate   { model, state, ts }   burst opens (NO estSec — the zero-token
//                                     estimator is a dsh-only facility, §3)
//   Thinking   { model, state, ts }   burst opens
//   Generating { model, state, ts }   edits keep streaming in
//   Done       { model, state, ts }   burst settled
// Every record is published as one MQTT message (lib/mqtt.js, persistent
// connection). Zero local persistence beyond the config file (spec §1/§5):
// no archive, no stats, no model tools.
//
// Cursor hook mapping (spec §7 — the only layer allowed to differ):
//   workspace.onDidChangeTextDocument -> the only observable AI signal is what
//       the AI writes: rapid, non-keystroke document edits form an "edit
//       burst" (lib/tracker.js). Burst open -> Estimate + Thinking; continued
//       edits -> Generating; a quiet window settles the burst with a debounced
//       Done that the next edit cancels — mid-burst continuation never flashes
//       Done, like dsh's tool-calls handling and opencode's debounce.
//   Error + Done (spec §2.4-6/§2.4-8): Cursor exposes no failure signal for
//       its AI calls — nothing observable to map. The Done backstops are the
//       quiet-window timer and the deactivate flush: every burst closes with
//       Done, which un-sticks the device.
//   mqmon_status: not registered — model tools are dsh-only (spec §6), and
//       the host has no model-visible tool registry anyway.
//
// Broker: EMQX Cloud Serverless (TLS-only). Auth mirrors the device firmware
// (rubato.ino): username = deviceId — Cursor-fleet devices are provisioned as
// Cursor-RUBATO-<mac6> (prefix capitalized exactly like that) — password =
// the per-unit token; clientId/topic/enabled are identity-derived, so the
// config only needs username + password. This port derives clientId as
// 'CUR-' + username, i.e. CUR-Cursor-RUBATO-<mac6> — distinct from the
// device's own clientId (= deviceId) and from the other harnesses' clientIds
// (DSH-/OC-/Claw-), so concurrent publishing processes never kick each other
// off the broker.
//
// First-run UX: when no config file exists anywhere, a self-documenting
// template is dropped next to the plugin and a setup guide is printed at boot.
//
// Console policy (spec §4): configuration reminders ONLY. Per-edit activity
// and publish outcomes live in the Rubato: Show Status command — never on
// the console.
'use strict'

const fs = require('fs')
const path = require('path')
const vscode = require('vscode')

const { loadConfig, createConfigTemplate } = require('./lib/config')
const { publishRecord } = require('./lib/mqtt')
const { createTracker } = require('./lib/tracker')

// Kept at module scope so deactivate() can close an in-flight burst.
let finishBurstRef = null

function activate(context) {
  const channel = vscode.window.createOutputChannel('Rubato')
  context.subscriptions.push(channel)
  // OutputChannel is user-facing diagnostics only (the status command dumps
  // and the setup reminder mirror) — NOT an automatic runtime chatter surface.
  const log = (msg) => { try { channel.appendLine(msg) } catch { /* ignore */ } }

  const state = { published: 0, failed: 0, last: null }
  const settings = () => vscode.workspace.getConfiguration('rubato')

  // ---- status bar: the phase at a glance -----------------------------------
  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50)
  statusItem.name = 'Rubato'
  statusItem.command = 'rubato.status'
  statusItem.text = '$(circle-outline) Rubato'
  statusItem.tooltip = 'Rubato device link — click for status'
  statusItem.show()
  context.subscriptions.push(statusItem)

  let phaseReset = null
  const setPhase = (phase) => {
    if (phaseReset) { clearTimeout(phaseReset); phaseReset = null }
    if (!phase) {
      statusItem.text = '$(circle-outline) Rubato'
      return
    }
    statusItem.text = phase === 'Done' ? '$(check) Rubato: Done' : '$(sync~spin) Rubato: ' + phase
    if (phase === 'Done') phaseReset = setTimeout(() => setPhase(null), 4000)
  }

  // Phase mirrors the record stream (observation only; never blocks publish).
  const observe = (record) => {
    if (record.state === 'Estimate' || record.state === 'Thinking') setPhase('Thinking')
    else if (record.state === 'Generating') setPhase('Generating')
    else if (record.state === 'Done') setPhase('Done')
  }

  // ---- config (hot-reloaded per publish; zero other local writes) ----------
  let cfg = loadConfig()
  if (!cfg._path) {
    // First run on a fresh install: drop a self-documenting template next to
    // the plugin, then load it (enabled:false).
    createConfigTemplate()
    cfg = loadConfig()
  }

  const publish = async (record) => {
    observe(record)
    cfg = loadConfig()
    if (!cfg.enabled || !cfg.username || !cfg.password) return
    try {
      await publishRecord(cfg, record)
      state.published += 1
      state.last = { ok: true, at: Date.now(), state: record.state }
    } catch (e) {
      state.failed += 1
      state.last = { ok: false, at: Date.now(), state: record.state, detail: String((e && e.message) || e) }
    }
  }

  // ---- burst tracker (hook mapping; see lib/tracker.js) --------------------
  const tracker = createTracker({
    publish,
    settings: () => ({
      modelLabel: settings().get('modelLabel') || 'cursor-agent',
      settleMs: settings().get('settleMs', 6000),
      minBurstChars: settings().get('minBurstChars', 12),
      maxBurstMs: settings().get('maxBurstMs', 600000),
    }),
  })
  finishBurstRef = (reason) => tracker.finish(reason)

  // Schemes whose text changes can count as workspace edits. Anything else
  // (output channels, debug consoles) is harness chatter, not AI work.
  const EDITABLE_SCHEMES = new Set(['file', 'untitled', 'vscode-notebook-cell', 'vscode-notebook-cell-metadata'])
  const onDocChange = (e) => {
    try {
      if (!e || !e.document || !EDITABLE_SCHEMES.has(e.document.uri.scheme)) return
      let ch = 0
      for (const c of e.contentChanges || []) ch += (c.text ? c.text.length : 0) + (c.rangeLength || 0)
      if (ch <= 0) return
      // Keystroke-scale change in the focused editor reads as human typing;
      // anything larger — or any edit outside the focused editor — is AI work.
      const focused = vscode.window.activeTextEditor
        && vscode.window.activeTextEditor.document === e.document
      if (ch < settings().get('minBurstChars', 12) && focused) return
      tracker.onEdit({ docId: e.document.uri.toString(), chars: ch, focused: !!focused })
    } catch { /* observation only — never disturb the host */ }
  }
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(onDocChange))

  // ---- commands ------------------------------------------------------------
  const openConfig = async () => {
    const p = loadConfig()._path || createConfigTemplate()
    if (!p) {
      vscode.window.showErrorMessage('[Rubato] could not locate or create the config file')
      return
    }
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(p))
    await vscode.window.showTextDocument(doc)
  }

  context.subscriptions.push(vscode.commands.registerCommand('rubato.openConfig', () => openConfig()))

  context.subscriptions.push(vscode.commands.registerCommand('rubato.ping', async () => {
    // User-invoked device-link check: one full contract-shaped cycle over the
    // plugin's OWN persistent connection (never a second clientId/process).
    const model = 'cursor-test'
    await publish({ model, state: 'Estimate', ts: Date.now() })
    await publish({ model, state: 'Thinking', ts: Date.now() })
    await publish({ model, state: 'Generating', ts: Date.now() })
    await new Promise((resolve) => setTimeout(resolve, 1500))
    await publish({ model, state: 'Done', ts: Date.now() })
    const c = loadConfig()
    if (c.username && c.password) {
      vscode.window.showInformationMessage(
        '[Rubato] test cycle sent (published ' + state.published + ', failed ' + state.failed
        + ') — the device should have run one breathing cycle.')
    } else {
      vscode.window.showWarningMessage(
        '[Rubato] credentials missing — nothing was sent. Fill "username" (Cursor-RUBATO-<mac6> from the device sticker) and "password" in rubato-mqtt-config.json.')
      await openConfig()
    }
  }))

  context.subscriptions.push(vscode.commands.registerCommand('rubato.status', async () => {
    const c = loadConfig()
    const lines = [
      'configured: ' + Boolean(c.username && c.password),
      'deviceId:   ' + (c.username || '(not set — Cursor-RUBATO-<mac6> from the device sticker)'),
      'clientId:   ' + (c.clientId || '-'),
      'topic:      ' + (c.topic || '-'),
      'host:       ' + c.host + ':' + c.port + (c.tls === false ? ' (tcp)' : ' (tls)'),
      'enabled:    ' + c.enabled,
      'published:  ' + state.published + '   failed: ' + state.failed,
      'last:       ' + (state.last ? JSON.stringify(state.last) : '-'),
      'config:     ' + (c._path || '<none yet>'),
      'burst:      ' + (tracker.burstInfo() ? JSON.stringify(tracker.burstInfo()) : 'idle'),
    ]
    log('status:\n  ' + lines.join('\n  '))
    channel.show(true)
    const pick = await vscode.window.showQuickPick([
      { label: '$(json) Open config file', action: 'config' },
      { label: '$(radio-tower) Send test cycle', action: 'ping' },
    ], { placeHolder: '[Rubato] ' + lines[0] + ', ' + lines[6] })
    if (!pick) return
    if (pick.action === 'config') await openConfig()
    if (pick.action === 'ping') await vscode.commands.executeCommand('rubato.ping')
  }))

  // ---- first-run setup guidance on console (spec §4: config reminders only)
  const unconfigured = !cfg.username || !cfg.password
  if (cfg.enabled && (!cfg.host || !cfg.topic)) {
    console.error('[Rubato] enabled but host/topic missing; fix rubato-mqtt-config.json')
  }
  if (unconfigured) {
    console.error('============================================================')
    console.error('[Rubato] SETUP REQUIRED - MQTT credentials not configured')
    console.error('  1. open:        ' + (cfg._path || '<plugin root>/rubato-mqtt-config.json'))
    console.error('  2. "username":  the deviceId printed on the device sticker')
    console.error('                  (Cursor-RUBATO-xxxxxx)')
    console.error('  3. "password":  the token paired with that deviceId')
    console.error('  save the file and you are done - the plugin auto-enables once both')
    console.error('  fields are filled (next edit burst, no restart).')
    console.error('============================================================')
    log('SETUP REQUIRED — MQTT credentials not configured. Open: ' + (cfg._path || '<plugin root>/rubato-mqtt-config.json'))
    void vscode.window.showInformationMessage(
      '[Rubato] the device link is not configured yet. Put username (Cursor-RUBATO-<mac6> from the device sticker) and its token into rubato-mqtt-config.json.',
      'Open config',
      'Later',
    ).then((pick) => { if (pick === 'Open config') void openConfig() })
  }
}

function deactivate() {
  // Close an in-flight burst on shutdown — the §2.4-8 backstop: a burst always
  // closes with Done, so the device never stays stuck breathing.
  try { if (finishBurstRef) finishBurstRef('deactivate') } catch { /* best effort */ }
}

module.exports = { activate, deactivate }
