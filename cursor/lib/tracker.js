// Rubato burst tracker for the Cursor plugin — the hook-mapping state machine
// (spec §7: the only layer allowed to differ from dsh).
//
// Cursor exposes no public API for its AI chat, so the observable AI signal is
// what the AI writes to the workspace: rapid, non-keystroke document edits
// (Tab completions, Cmd+K inline edits, chat Apply, multi-file agent diffs).
// A burst of such edits maps onto the device contract:
//
//   burst opens  -> Estimate + Thinking   (Estimate first, spec §2.4-1/-2)
//   edits continue -> Generating          (first continuation edit)
//   quiet window -> Done                  (debounced; cancelled by the next
//                                          edit — mid-burst continuation never
//                                          flashes Done, like dsh's tool-calls
//                                          handling and opencode's debounce)
//
// Semantics kept identical to dsh: Estimate precedes everything, Thinking
// fires at burst open (not on some later delta), Done is the only lean-wire
// message (publish(record, wire) separation), calibration backfills on the
// features captured at burst START. Error+Done has no Cursor equivalent — the
// host exposes no failure signal (see extension.js header).
//
// All side effects are injected, so tools/cursor-smoke-test.mjs can drive the
// machine offline (no vscode, no broker).
'use strict'

function createTracker(deps) {
  // deps: {
  //   publish:    async (record, wire?) -> void     (archive + MQTT in extension.js)
  //   estimateMs: (model, feat) -> number           (zero-token kNN prediction)
  //   backfill:   (model, feat, ms, estMs) -> void  (calibration sample store)
  //   settings:   () -> { modelLabel, settleMs, minBurstChars, maxBurstMs }
  //   now, setTimeout, clearTimeout: injectable clock/timers (optional)
  // }
  const now = deps.now || (() => Date.now())
  const schedule = deps.setTimeout || ((fn, ms) => setTimeout(fn, ms))
  const cancel = deps.clearTimeout || ((t) => clearTimeout(t))

  let burst = null
  let settleTimer = null

  const clearSettle = () => { if (settleTimer) { cancel(settleTimer); settleTimer = null } }

  function finish(reason) {
    clearSettle()
    const b = burst
    burst = null
    if (!b) return
    const ms = now() - b.startedAt
    const ts = now()
    // Done wire contract is lean: { model, state, ts }. The burst stats ride
    // in the archive record only — publish(record, wire) separation (dsh keeps
    // tokens there; Cursor's observable extras are the burst metrics).
    deps.publish(
      { model: b.model, state: 'Done', ts, dur: ms, files: b.docs.size, chars: b.chars, edits: b.edits },
      { model: b.model, state: 'Done', ts },
    )
    // Backfill calibration on the features captured at burst START, so
    // predict and train always see the same signal.
    deps.backfill(b.model, b.feat, ms, b.estMs)
    return { reason, ms }
  }

  // edit: { docId, chars, focused } — one document change event, already
  // char-counted and scheme-filtered by the vscode layer. Small edits in the
  // focused editor read as human typing and are ignored here.
  function onEdit(edit) {
    const s = deps.settings()
    if (!burst) {
      const feat = {
        c: Math.max(0, Math.round(edit.chars)),
        l: 0, f: 0, v: 0, fl: 0, n: 1, e: '',
      }
      const model = s.modelLabel
      const estMs = Math.round(deps.estimateMs(model, feat))
      const t0 = now()
      burst = {
        model,
        feat,
        estMs,
        startedAt: t0,
        chars: edit.chars,
        edits: 1,
        docs: new Set([edit.docId]),
        generated: false,
      }
      deps.publish({ model, state: 'Estimate', ts: t0, estSec: Math.round(estMs / 100) / 10 })
      // Thinking at burst open — not on some later "first delta": the device
      // must not trail the real rhythm (same reasoning as dsh §2.4-2).
      deps.publish({ model, state: 'Thinking', ts: t0 })
    } else {
      burst.chars += edit.chars
      burst.edits += 1
      burst.docs.add(edit.docId)
      if (!burst.generated) {
        burst.generated = true
        deps.publish({ model: burst.model, state: 'Generating', ts: now() })
      }
    }
    // The quiet window re-arms on every edit: a pending Done is cancelled by
    // the next edit (spec §7 debounce discipline).
    clearSettle()
    settleTimer = schedule(() => finish('settle'), s.settleMs)
    if (burst && now() - burst.startedAt > s.maxBurstMs) finish('max-duration')
  }

  function busy() { return !!burst }

  function burstInfo() {
    return burst
      ? { model: burst.model, chars: burst.chars, edits: burst.edits, files: burst.docs.size }
      : null
  }

  function dispose() {
    clearSettle()
    burst = null
  }

  return { onEdit, finish, busy, burstInfo, dispose }
}

module.exports = { createTracker }
