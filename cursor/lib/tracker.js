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
// User-side wire (spec §2.3/§2.4-7): every record is lean and there is NO
// local archive — Estimate carries no estSec (the zero-token estimator is a
// dsh development facility, spec §3), Done is exactly { model, state, ts },
// and publish() takes a single record. The quiet-window timer plus the
// deactivate flush are the Done backstops required by §2.4-8: a burst always
// closes, so the device never stays stuck breathing.
//
// All side effects are injected, so tools/cursor-smoke-test.mjs can drive the
// machine offline (no vscode, no broker).
'use strict'

function createTracker(deps) {
  // deps: {
  //   publish:  async (record) -> void     (MQTT only; no local writes)
  //   settings: () -> { modelLabel, settleMs, minBurstChars, maxBurstMs }
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
    // Done wire contract: { model, state, ts } — lean, no extra fields
    // (user-side plugins have no archive to carry a fuller record).
    deps.publish({ model: b.model, state: 'Done', ts: now() })
    return { reason }
  }

  // edit: { docId, chars, focused } — one document change event, already
  // char-counted and scheme-filtered by the vscode layer. Small edits in the
  // focused editor read as human typing and are ignored here.
  function onEdit(edit) {
    const s = deps.settings()
    if (!burst) {
      const model = s.modelLabel
      const t0 = now()
      burst = {
        model,
        startedAt: t0,
        chars: edit.chars,
        edits: 1,
        docs: new Set([edit.docId]),
        generated: false,
      }
      deps.publish({ model, state: 'Estimate', ts: t0 })
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
