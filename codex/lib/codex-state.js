// Rubato for Codex — rollout JSONL line interpreter: the plugin's hook mapping
// layer (the only part allowed to differ per spec §7). Codex CLI appends one
// JSON object per line to
//   $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
// with the modern (>= ~0.44) envelope { timestamp, type, payload } where type is
// session_meta | turn_context | event_msg | response_item | compacted.
//
// Codex event -> Rubato wire mapping (semantics of spec §2.4, adapted):
//   task_started/turn_started        -> open a turn    -> Estimate + Thinking
//   first agent_message/tool call    -> Generating
//   task_complete/turn_complete      -> lean Done ({model,state,ts}; spec §2.4.5)
//   turn_aborted / shutdown_complete -> user stop / early teardown: lean Done
//                                       only, NO Error record (spec §2.4.8 —
//                                       an aborted turn is not a failure; the
//                                       device only exits breathing on Done)
//   task_complete carrying .error, or event 'error'
//                                    -> Error + lean Done (un-stick, §2.4.6)
// Codex has no per-model-call events inside a turn (the tool loop is invisible
// in the rollout), so Estimate/Thinking fire per turn rather than per call.
// Token usage is intentionally not tracked: the lean Done wire has no tokens
// field (§2.3) and user-side plugins keep no archive (§5). token_count is read
// only for its `info.model` fallback (older rollouts lack turn_context).
import { extractUserText, isInjectedUserText } from './user-text.js'

export function createSessionState() {
  return {
    meta: null, // session_meta payload (id, cwd, cli_version, ...)
    model: '',
    effort: '',
    turn: null, // { id, tStart, generating }
    turnsSeen: 0,
  }
}

function tsOf(line, fallback) {
  const t = line && line.timestamp ? Date.parse(line.timestamp) : NaN
  return Number.isFinite(t) ? t : fallback
}

function closeTurn(sess) {
  sess.turn = null
}

// Apply one parsed rollout line. Returns an ordered list of actions for the
// watcher; during fast-forward the watcher ignores 'emit'/'open-turn'/'end'
// events but the session state still advances.
// Actions: {kind:'open-turn'} | {kind:'emit', state:'Generating'}
//        | {kind:'end', how:'complete'|'interrupted'|'error', detail?}
export function applyLine(sess, line, now) {
  const actions = []
  if (!line || typeof line !== 'object') return actions
  const type = line.type
  const p = line.payload
  if (!p || typeof p !== 'object') return actions

  if (type === 'session_meta') {
    sess.meta = p
    return actions
  }

  if (type === 'turn_context') {
    if (typeof p.model === 'string' && p.model) sess.model = p.model
    const e = p.effort || p.model_reasoning_effort || (p.reasoning && p.reasoning.effort)
    if (e) sess.effort = String(e)
    return actions
  }

  if (type === 'compacted') return actions

  if (type === 'response_item') {
    const it = p
    if (it.type === 'message') {
      const text = extractUserText(it.content)
      if (it.role === 'user' && !isInjectedUserText(text)) sess.lastUser = text
    } else if (it.type === 'function_call' || it.type === 'custom_tool_call' || it.type === 'local_shell_call' || it.type === 'web_search_call' || it.type === 'tool_call') {
      noteGenerating(sess, actions)
    }
    return actions
  }

  if (type === 'event_msg') {
    const ev = p.type
    switch (ev) {
      case 'user_message': {
        // Duplicates the response_item message; only used as a lastUser
        // fallback when the response_item has not been seen (robustness for
        // exotic writers — never drives anything else).
        const text = typeof p.message === 'string' ? p.message : extractUserText(p.content)
        if (text && !isInjectedUserText(text) && !sess.lastUser) sess.lastUser = text
        break
      }
      case 'task_started':
      case 'turn_started': {
        if (sess.turn) closeTurn(sess) // unbalanced previous turn; swallow it
        sess.turn = {
          id: p.turn_id || ('turn-' + tsOf(line, now)),
          tStart: tsOf(line, now),
          generating: false,
        }
        sess.turnsSeen += 1
        actions.push({ kind: 'open-turn' })
        break
      }
      case 'agent_message':
      case 'agent_message_delta':
      case 'agent_message_content_delta':
        noteGenerating(sess, actions)
        break
      // agent_reasoning* needs no action: the turn already opened as Thinking.
      case 'token_count': {
        // Lean wire keeps no token usage; only the model fallback is read.
        const info = p.info
        if (info && typeof info === 'object' && typeof info.model === 'string' && info.model) {
          sess.model = info.model
        }
        break
      }
      case 'task_complete':
      case 'turn_complete': {
        if (!sess.turn) break
        if (p.error && (p.error.message || typeof p.error === 'string')) {
          actions.push({ kind: 'end', how: 'error', detail: p.error.message || String(p.error) })
        } else {
          actions.push({ kind: 'end', how: 'complete' })
        }
        closeTurn(sess)
        break
      }
      case 'turn_aborted':
        if (sess.turn) {
          // User pressed Esc / stop — an early teardown is NOT a failure
          // (spec §2.4.8): lean Done only, no Error record.
          actions.push({ kind: 'end', how: 'interrupted' })
          closeTurn(sess)
        }
        break
      case 'error':
        if (sess.turn) {
          actions.push({ kind: 'end', how: 'error', detail: p.message ? String(p.message) : 'error' })
          closeTurn(sess)
        }
        break
      case 'shutdown_complete':
        if (sess.turn) {
          actions.push({ kind: 'end', how: 'interrupted' })
          closeTurn(sess)
        }
        break
      default:
        break
    }
  }
  return actions
}

function noteGenerating(sess, actions) {
  if (sess.turn && !sess.turn.generating) {
    sess.turn.generating = true
    actions.push({ kind: 'emit', state: 'Generating' })
  }
}
