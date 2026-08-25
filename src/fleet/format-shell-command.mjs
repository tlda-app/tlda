/**
 * A shell one-liner, laid out so it can be read.
 *
 * Skip, 2026-08-25, looking at a Bash card in chat: "we gotta do a bash
 * formatter dude ... all scrolled offscreen."
 *
 * An agent writes a command as one line however long it is, and the card puts
 * that line in a `<pre>`, so everything past the panel's width is off the side
 * where nobody will scroll to it. The command is not complicated — it is a
 * handful of steps joined by `&&` and `;` — and written one step to a line it
 * reads at a glance.
 *
 * This only breaks at the joins between commands, and only at the top level:
 * inside quotes, `$( )`, backticks, parens and braces the text is left exactly
 * as written, because those are one command's own arguments and breaking them
 * would change what you are looking at.
 *
 * **A command that already contains a newline is returned untouched.** It was
 * written multi-line deliberately, and it is also where heredocs live — whose
 * bodies are literal text that must not be reflowed. That rule is what keeps
 * this from needing to understand heredocs at all.
 */

/** Joins between commands, longest first so `&&` is never read as two `&`. */
const OPERATORS = ['&&', '||', ';;', ';', '|']

export function formatShellCommand(command) {
  const text = typeof command === 'string' ? command : ''
  if (!text || text.includes('\n')) return text

  const parts = splitTopLevel(text)
  if (parts.length < 2) return text

  return parts
    .map((part, index) => (index === 0 ? part.text : `  ${part.text}`))
    .map((line, index) => {
      const operator = parts[index].operator
      return operator ? `${line} ${operator}` : line
    })
    .join('\n')
}

/**
 * The command split at its top-level joins. Each part carries the operator that
 * FOLLOWED it, so the operator stays at the end of its own line the way it is
 * written by hand.
 */
function splitTopLevel(text) {
  const parts = []
  let current = ''
  let single = false
  let double = false
  let depth = 0
  let backtick = false

  for (let i = 0; i < text.length; i++) {
    const char = text[i]

    if (char === '\\' && !single) {
      current += char + (text[i + 1] ?? '')
      i++
      continue
    }
    if (char === "'" && !double && !backtick) { single = !single; current += char; continue }
    if (char === '"' && !single && !backtick) { double = !double; current += char; continue }
    if (single || double) { current += char; continue }
    if (char === '`') { backtick = !backtick; current += char; continue }
    if (backtick) { current += char; continue }

    if (char === '$' && text[i + 1] === '(') { depth++; current += '$('; i++; continue }
    if (char === '(' || char === '{') { depth++; current += char; continue }
    if (char === ')' || char === '}') { depth = Math.max(0, depth - 1); current += char; continue }
    if (depth > 0) { current += char; continue }

    // `2>&1` and friends: a single `&` is a redirection or a background marker,
    // never a join, so only the doubled form splits.
    const operator = OPERATORS.find(candidate => text.startsWith(candidate, i))
    if (operator) {
      parts.push({ text: current.trim(), operator })
      current = ''
      i += operator.length - 1
      continue
    }
    current += char
  }

  const tail = current.trim()
  if (tail) parts.push({ text: tail, operator: '' })
  // A trailing operator with nothing after it (`foo &&`) leaves the last part
  // holding an operator; that is what was written, so keep it.
  return parts.filter(part => part.text || part.operator)
}
