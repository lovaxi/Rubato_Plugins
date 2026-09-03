// Rubato for Codex — user-text helpers for the rollout interpreter.
// Injected harness layers are not typed by the user and must never drive
// user-message features or lastUser tracking (spec §3.1's real-text rule,
// applied to the Codex hook layer).

export function extractUserText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((p) => {
      if (!p || typeof p !== 'object') return ''
      if (typeof p.text === 'string') return p.text
      if (p.type === 'input_text' && typeof p.text === 'string') return p.text
      return ''
    })
    .join(' ')
}

// Codex injects context as user-role messages starting with '<' (<user_instructions>,
// <environment_context>, <system-reminder>, ...). Treat any leading-'<' user text
// as injected; real prompts never start with a bare XML-ish tag.
export function isInjectedUserText(text) {
  if (!text) return true
  return text.trimStart().startsWith('<')
}
