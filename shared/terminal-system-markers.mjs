// Marks the lines tlda writes into an agent's terminal.
//
// An agent's terminal carries two kinds of text: what Skip typed, and what the
// app put there. Reading a transcript back has to tell them apart, and until now
// that was done by remembering phrasings — a prefix list plus a regex per notice
// — which fails the moment a notice is reworded or a new one is added. It failed
// exactly that way: 4,791 lines of machine text are stored in his history as
// things he said.
//
// Skip's rule, 8/1: a system message or a notification is ONE line and starts
// with 💻 or 📬, and he never starts a line with either. Everything else is chat.
//
//   💻  a system message — the app speaking about the session
//   📬  a notification — something is waiting in the inbox
//
// Both are single code points, so they hold a predictable width in a terminal;
// 🖥️ carries a variation selector and does not.

export const SYSTEM_MARKER = '💻'
export const NOTIFICATION_MARKER = '📬'

const MARKERS = [SYSTEM_MARKER, NOTIFICATION_MARKER]

// Leading whitespace and C0 control characters. A line injected into a terminal
// can arrive with the prompt-clear (Ctrl-U, U+0015) or a carriage return still on
// the front, and a marker test anchored at position zero then reads the app's own
// line as something the human typed. Nothing printable is skipped, so this cannot
// pull a real message into a marker.
export const LEADING_CONTROL = /^[\s\u0000-\u001f\u007f]+/

export function isMarkedLine(line) {
  const start = String(line).replace(LEADING_CONTROL, '')
  return MARKERS.some(marker => start.startsWith(marker))
}

// One system message per line. A notice with several sentences to deliver sends
// several system messages rather than one message containing line breaks, which
// is what keeps every line independently strippable.
export function systemMessage(text) {
  return String(text ?? '')
    .split('\n')
    .filter(line => line.trim())
    .map(line => (isMarkedLine(line) ? line : `${SYSTEM_MARKER} ${line}`))
    .join('\n')
}

// True when every line the text carries is marked — i.e. the app wrote all of
// it. Blank lines are ignored so a notice and a notification can be separated
// for readability without either becoming unclassifiable.
export function isFullyMarked(text) {
  if (!text) return false
  const lines = String(text).split('\n').filter(line => line.trim())
  return lines.length > 0 && lines.every(isMarkedLine)
}
