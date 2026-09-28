/**
 * Pre-send chat linters: configurable binary gates on outbound chat.
 *
 * One claimed type triggers both validations: a message the sender marks as an
 * outline must (1) be file-backed, because outlines get edited, and (2)
 * actually be an outline — a single structural depth fails as a flat list.
 * The marker is explicit (`outline: true` through the chat input); ordinary
 * unmarked chat is never scanned for length or shape.
 *
 * Pure functions, no I/O: the server imports this module and runs
 * `lintChatOutbound` at chat ingress, so the executables ship with the deploy
 * and only the declarative config is server-held (`server.yaml` `chatLinters:`
 * — absent means every linter is off).
 *
 * See docs/chat-linters.md for the daemon/server placement boundary.
 */

export const CHAT_LINTER_IDS = Object.freeze(['outline-file-backed', 'outline-depth'])

export const DEFAULT_OUTLINE_DEPTH_MAX_PROSE_LINES = 2

const PASS = Object.freeze({ pass: true, linter: null, error: null })

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function nonNegativeInt(value, fallback) {
  return Number.isInteger(value) && value >= 0 ? value : fallback
}

/**
 * Normalize the server-held `chatLinters` config. Absent or misshapen config
 * disables linters rather than breaking chat: this runs on the send path, so a
 * config fault must fail open (and loud, at the call site's log), never refuse
 * a send for a reason the sender cannot fix.
 */
export function normalizeChatLintersConfig(raw) {
  const off = {
    outlineFileBacked: { enabled: false },
    outlineDepth: { enabled: false, maxProseLines: DEFAULT_OUTLINE_DEPTH_MAX_PROSE_LINES },
  }
  if (!isRecord(raw)) return off
  const fileRaw = isRecord(raw.outlineFileBacked) ? raw.outlineFileBacked : null
  const depthRaw = isRecord(raw.outlineDepth) ? raw.outlineDepth : null
  return {
    outlineFileBacked: { enabled: fileRaw?.enabled === true },
    outlineDepth: {
      enabled: depthRaw?.enabled === true,
      maxProseLines: nonNegativeInt(depthRaw?.maxProseLines, DEFAULT_OUTLINE_DEPTH_MAX_PROSE_LINES),
    },
  }
}

function hasFileSource(source) {
  return typeof source?.file === 'string' && source.file.trim().length > 0
}

/**
 * outline-file-backed: a marked outline fails unless it carries a source file.
 * Unmarked messages pass untouched.
 *
 * Errors carry no trailing period: the durable-transport refusal template
 * appends one (`...refused it: <reason>.`), so a period here renders doubled.
 */
export function lintOutlineFileBacked({ source = null, outline = false } = {}, options = {}) {
  if (options.enabled !== true) return PASS
  if (outline !== true) return PASS
  if (hasFileSource(source)) return PASS
  return {
    pass: false,
    linter: 'outline-file-backed',
    error: 'outline-file-backed: this message is marked as an outline but has no source file. '
      + 'Write it in a file first and send it with `file`+`selector` so it can be read and edited in place',
  }
}

// Structural line shapes. The marker declares the message an outline, so the
// depth check does not need presentation triggers — only a depth measurement.
const HEADING_RE = /^\s*(#{1,6})\s+\S/
const BEAT_RE = /^\s*\*\*[^*\n]{1,80}?\*\*/
const LIST_RE = /^(\s*)(?:[-*+]|\d+(?:\.\d+)*[.)])\s+\S/
const SUB_NUMBERED_RE = /^\s*\d+\.\d+/
const HR_RE = /^\s*(---+|\*\*\*+|___+)\s*$/
const QUOTE_RE = /^\s*>/
const FENCE_RE = /^\s*(```|~~~)/

function classifyOutlineLines(text) {
  const beats = []
  const lists = []
  const headingLevels = new Set()
  let proseLines = 0
  let inFence = false
  for (const line of String(text ?? '').split('\n')) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    if (!line.trim() || HR_RE.test(line)) continue
    const heading = line.match(HEADING_RE)
    if (heading) {
      headingLevels.add(heading[1].length)
      continue
    }
    if (QUOTE_RE.test(line)) {
      // Quoted material is someone else's content, not this message's
      // structure. Counting it as prose keeps the linter conservative.
      proseLines += 1
      continue
    }
    if (BEAT_RE.test(line)) {
      beats.push(line)
      continue
    }
    const list = line.match(LIST_RE)
    if (list) {
      lists.push({ indent: list[1].replace(/\t/g, '    ').length, subNumbered: SUB_NUMBERED_RE.test(line) })
      continue
    }
    proseLines += 1
  }
  return { beats, lists, headingLevels, proseLines }
}

function outlineHasDepth({ beats, lists, headingLevels }) {
  if (headingLevels.size >= 2) return true
  if (lists.some(item => item.subNumbered)) return true
  if (new Set(lists.map(item => item.indent)).size >= 2) return true
  // Bold-label beats each carrying bullet sub-points are two levels, even
  // when the bullets sit at the same indent as the beats.
  if (beats.length > 0 && lists.length > 0) return true
  return false
}

/**
 * outline-depth: a marked outline with a single structural depth fails as a
 * flat list. Runs only on explicitly marked messages — unmarked chat is never
 * shape-scanned. Genuinely nested outlines pass, as do marked messages that
 * are mostly prose rather than list-shaped.
 */
export function lintOutlineDepth(text, options = {}) {
  const enabled = options.enabled === true
  if (!enabled) return PASS
  const marked = options.marked === true
  if (!marked) return PASS
  const maxProseLines = nonNegativeInt(options.maxProseLines, DEFAULT_OUTLINE_DEPTH_MAX_PROSE_LINES)
  const classified = classifyOutlineLines(text)
  const { beats, lists, proseLines } = classified
  // A single structural line is not a list failing to be an outline — it is a
  // note. Two or more list-shaped lines at one depth is the flat shape.
  if (beats.length + lists.length < 2) return PASS
  if (outlineHasDepth(classified)) return PASS
  if (proseLines > maxProseLines) return PASS
  return {
    pass: false,
    linter: 'outline-depth',
    error: 'outline-depth: this marked outline has a single structural depth — '
      + 'a list, not an outline. Add nesting (sections with sub-points), or send it unmarked as a plain list',
  }
}

/**
 * Run the configured linters in order: file backing first, so a marked inline
 * outline is told to move into a file before it is told to nest.
 */
export function lintChatOutbound({ text = '', source = null, outline = false, config = null } = {}) {
  const normalized = normalizeChatLintersConfig(config)
  const fileBacked = lintOutlineFileBacked({ source, outline }, normalized.outlineFileBacked)
  if (!fileBacked.pass) return fileBacked
  return lintOutlineDepth(text, { ...normalized.outlineDepth, marked: outline })
}
