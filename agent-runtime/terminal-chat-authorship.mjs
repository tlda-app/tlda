// What was typed into an agent's terminal.
//
// A tailed transcript's `user` records are mirrored into fleet chat as the
// human speaking. The terminal record is a record of things that were typed
// into the terminal — and nothing else. Slash commands and `!` bash-mode lines
// are typed, so they belong in it. The harness also stores its own output as
// `user` turns: command output, compaction summaries, interruption notices,
// injected channel messages. Nobody types those, so they are not the human's
// words and are not mirrored.
//
// Both tail implementations (the daemon's in-process tail and the forked
// ingester child) ask this module, so the two cannot drift apart.

import { isFullyMarked, LEADING_CONTROL } from '../shared/terminal-system-markers.mjs'

// Machine output and harness notices. These wrap what the terminal printed
// back, or what the harness said about the session — never what was typed.
const MACHINE_OUTPUT_PREFIXES = [
  '<local-command-stdout>', '<local-command-caveat>',
  '<bash-stdout>', '<bash-stderr>',
]

// Messages addressed *to* the agent rather than typed by the human. The harness
// writes these wrappers itself, so tlda cannot mark them and they stay a list.
const INJECTED_TEXT_PREFIXES = [
  '<task-notification', '<system-reminder', '<channel',
]

// Notices the harness writes about the human, not words from them.
const HARNESS_NOTICES = [
  '[Request interrupted by user]',
  '[Request interrupted by user for tool use]',
]

// Shapes tlda emitted before it marked its own lines. Everything tlda writes now
// carries 💻 or 📬 and is caught by isFullyMarked, so this list is closed: it
// describes text already in the wild, and no new notice belongs in it. Adding an
// entry here means an emitter skipped its marker — fix the emitter instead.
//
// RETURN_NOTICE needed a pattern rather than a prefix because the notice is
// prepended ahead of the 📬 line. It also required the trailing newline, so a
// bare notice with nothing after it never matched and landed in Skip's chat as
// him — 769 rows of it.
const RETURN_NOTICE = /^You were away as \S+ for [^\n]*(\n|$)/
const NOTIFICATION_PREFIX = '📬'

const LOGIN_PROMPT = /^Call (?:login|register)\([^)]*\) with the (?:tlda|fleet) MCP server\b/

// The harness stores a typed command wrapped in markup. The markup is not what
// was typed, so it is unwrapped back to the line as entered.
const COMMAND_NAME = /^<command-name>([^<]*)<\/command-name>/
const COMMAND_ARGS = /<command-args>([^<]*)<\/command-args>/
const BASH_INPUT = /^<bash-input>([\s\S]*?)<\/bash-input>\s*$/

// Structural test, using only fields the harness sets on the record itself.
//
// Deliberately fail-open: an unrecognised record is treated as typed. The
// tighter rule — require a positive "a human typed this" marker — is wrong
// here, because every such marker is optional in the transcript. Real typed
// messages exist carrying `promptSource: 'typed'` and no `origin` at all, so a
// positive test starts dropping real messages the moment a harness version
// stops emitting the field it depends on. A stray command reaching the log is a
// much cheaper failure than a lost message from the human.
export function isHarnessAuthoredRecord(parsed) {
  if (!parsed || parsed.type !== 'user') return false
  // A sidechain record belongs to a native subagent, which has no terminal and
  // nobody at one: its `user` records are the parent's Task brief and the tool
  // results feeding it back. The tail is already gated on the file being
  // classified as a subagent, but that classification reads the file's first
  // record, and a fork subagent's first record is a `fork-context-ref` — so the
  // file reads as an ordinary session and its brief mirrors as the human. The
  // record states the fact itself, so it is tested here, where authorship is
  // decided, rather than left to depend on the file having been recognised.
  if (parsed.isSidechain === true) return true
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

// Text-level test, for machine output that is structurally indistinguishable
// from typed input. Prefix matching only — never match a bare leading `/`,
// because a pasted absolute path is a real message that starts that way.
export function isMachineAuthoredText(text) {
  if (!text) return false
  // Every prefix below is anchored at the start, and injected text can arrive
  // with the prompt-clear (Ctrl-U) or a carriage return still on the front. That
  // is not a different kind of text, it is the same text with a control byte in
  // front of it, so the byte comes off before the shape is read — 31 rows of
  // machine output reached Skip's history through that gap.
  const start = String(text).replace(LEADING_CONTROL, '')
  if (!start) return false
  // The rule: every line tlda writes into a terminal is one line and starts with
  // 💻 or 📬, and Skip starts no line with either. Text whose lines are all
  // marked is the app talking, whatever it says.
  if (isFullyMarked(start)) return true
  if (HARNESS_NOTICES.includes(start)) return true
  if (INJECTED_TEXT_PREFIXES.some(prefix => start.startsWith(prefix))) return true
  if (MACHINE_OUTPUT_PREFIXES.some(prefix => start.startsWith(prefix))) return true
  if (start.startsWith(NOTIFICATION_PREFIX)) return true
  if (RETURN_NOTICE.test(start)) return true
  return LOGIN_PROMPT.test(start)
}

// Recover the line as typed. Returns the text unchanged when it carries no
// harness wrapper, so ordinary messages pass through untouched.
export function typedTextFrom(text) {
  if (!text) return text
  const command = text.match(COMMAND_NAME)
  if (command) {
    const name = command[1].trim()
    const args = (text.match(COMMAND_ARGS)?.[1] || '').trim()
    return args ? `${name} ${args}` : name
  }
  const bash = text.match(BASH_INPUT)
  if (bash) return `! ${bash[1].trim()}`
  return text
}
