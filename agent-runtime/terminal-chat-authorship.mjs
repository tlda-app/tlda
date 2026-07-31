// Who authored a `user` record in a harness transcript.
//
// A tailed transcript's `user` records are mirrored into fleet chat as the
// human speaking, because normally that is exactly what they are: the person
// typing into that agent's terminal. But the harness also records its own
// output as `user` turns — slash-command echoes, compaction summaries,
// interruption notices, injected channel messages — and none of those are
// something the human said.
//
// Both tail implementations (the daemon's in-process tail and the forked
// ingester child) ask this module, so the two cannot drift apart.

// Harness markup that the transcript stores as a `user` turn. These records
// carry no distinguishing field, so the literal tag is the only signal
// available. Matched as a prefix.
export const HARNESS_MARKUP_PREFIXES = [
  '<command-name>', '<command-message>', '<command-args>',
  '<local-command-stdout>', '<local-command-caveat>',
  '<bash-input>', '<bash-stdout>', '<bash-stderr>',
]

// Injection tags and notices that are addressed *to* the agent rather than
// typed by the human.
export const INJECTED_TEXT_PREFIXES = [
  '<task-notification', '<system-reminder', '<channel', '📬',
]

export const HARNESS_EXACT_TEXTS = [
  '[Request interrupted by user]',
  '[Request interrupted by user for tool use]',
]

const LOGIN_PROMPT = /^Call (?:login|register)\([^)]*\) with the (?:tlda|fleet) MCP server\b/

// Structural test, using only fields the harness sets on the record itself.
//
// Deliberately fail-open: an unrecognised record is treated as human. The
// tighter rule — require a positive "a human typed this" marker — is wrong
// here, because every such marker is optional in the transcript. Real typed
// messages exist carrying `promptSource: 'typed'` and no `origin` at all, so a
// positive test starts dropping real messages the moment a harness version
// stops emitting the field it depends on. A stray `/clear` reaching the log is
// a much cheaper failure than a lost message from the human.
export function isHarnessAuthoredRecord(parsed) {
  if (!parsed || parsed.type !== 'user') return false
  if (parsed.isMeta) return true
  if (parsed.interruptedMessageId) return true
  if (parsed.isCompactSummary) return true
  const promptSource = parsed.promptSource
  if (promptSource === 'system' || promptSource === 'sdk') return true
  // `origin` names what produced the turn. Absent means unknown, which stays
  // open; a named non-human origin (channel, task-notification, peer,
  // coordinator) is an injection.
  const origin = parsed.origin?.kind
  if (origin && origin !== 'human') return true
  return false
}

// Text-level test, for harness output that is structurally indistinguishable
// from typed input. Prefix matching only — never match a bare leading `/`,
// because a pasted absolute path is a real message that starts that way.
export function isHarnessAuthoredText(text) {
  if (!text) return false
  if (HARNESS_EXACT_TEXTS.includes(text)) return true
  if (INJECTED_TEXT_PREFIXES.some(prefix => text.startsWith(prefix))) return true
  if (HARNESS_MARKUP_PREFIXES.some(prefix => text.startsWith(prefix))) return true
  return LOGIN_PROMPT.test(text)
}
