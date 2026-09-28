/**
 * Pre-send chat linters: configurable binary gates on outbound chat.
 *
 * Each linter passes (delivery proceeds) or fails with an error that names the
 * linter, the defect, and the fix. Pure functions, no I/O: the server imports
 * this module and runs `lintChatOutbound` at chat ingress, so the executables
 * ship with the deploy and only the declarative config is server-held
 * (`server.yaml` `chatLinters:` — absent means every linter is off).
 *
 * See docs/chat-linters.md for the daemon/server placement boundary.
 */

export const CHAT_LINTER_IDS = Object.freeze(['file-backed-composition', 'outline-depth'])

export const DEFAULT_FILE_BACKED_MIN_CHARS = 500
export const DEFAULT_OUTLINE_MIN_SIGNAL_LINES = 5
export const DEFAULT_OUTLINE_MAX_PROSE_LINES = 2

const PASS = Object.freeze({ pass: true, linter: null, error: null })

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function positiveInt(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback
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
    fileBackedComposition: { enabled: false, minChars: DEFAULT_FILE_BACKED_MIN_CHARS },
    outlineDepth: {
      enabled: false,
      minSignalLines: DEFAULT_OUTLINE_MIN_SIGNAL_LINES,
      maxProseLines: DEFAULT_OUTLINE_MAX_PROSE_LINES,
    },
  }
  if (!isRecord(raw)) return off
  const fileRaw = isRecord(raw.fileBackedComposition) ? raw.fileBackedComposition : null
  const outlineRaw = isRecord(raw.outlineDepth) ? raw.outlineDepth : null
  return {
    fileBackedComposition: {
      enabled: fileRaw?.enabled === true,
      minChars: positiveInt(fileRaw?.minChars, DEFAULT_FILE_BACKED_MIN_CHARS),
    },
    outlineDepth: {
      enabled: outlineRaw?.enabled === true,
      minSignalLines: positiveInt(outlineRaw?.minSignalLines, DEFAULT_OUTLINE_MIN_SIGNAL_LINES),
      maxProseLines: nonNegativeInt(outlineRaw?.maxProseLines, DEFAULT_OUTLINE_MAX_PROSE_LINES),
    },
  }
}

function hasFileSource(source) {
  return typeof source?.file === 'string' && source.file.trim().length > 0
}

/**
 * file-backed-composition: a substantive message (at or over minChars) sent
 * inline, with no source file, fails. Short chat and file+selector sends pass.
 */
export function lintFileBackedComposition(text, source, options = {}) {
  const enabled = options.enabled === true
  if (!enabled) return PASS
  if (hasFileSource(source)) return PASS
  const minChars = positiveInt(options.minChars, DEFAULT_FILE_BACKED_MIN_CHARS)
  const length = String(text ?? '').length
  if (length < minChars) return PASS
  return {
    pass: false,
    linter: 'file-backed-composition',
    error: `file-backed-composition: this message is ${length} chars with no source file. `
      + 'Write it in a file first and send it with `file`+`selector` so it can be read and corrected in place.',
  }
}

// Outline-presentation signals. A bare bullet or numbered list is honestly a
// list and passes; the linter fires only when the message presents itself as
// structure — an outline/beats heading, or a run of bold-label beats — while
// carrying a single structural depth.
const HEADING_RE = /^\s*(#{1,6})\s+\S/
const OUTLINE_KEYWORD_RE = /outline|beats|structure/i
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
  let outlineHeading = false
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
      if (OUTLINE_KEYWORD_RE.test(line)) outlineHeading = true
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
  return { beats, lists, headingLevels, outlineHeading, proseLines }
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
 * outline-depth: a purported outline with a single structural depth fails as a
 * list. A bare list (no outline presentation), prose, and genuinely nested
 * outlines pass. Conservative by instruction: a false block on legitimate chat
 * is worse than a missed list, so ambiguous shapes pass.
 */
export function lintOutlineDepth(text, options = {}) {
  const enabled = options.enabled === true
  if (!enabled) return PASS
  const minSignalLines = positiveInt(options.minSignalLines, DEFAULT_OUTLINE_MIN_SIGNAL_LINES)
  const maxProseLines = nonNegativeInt(options.maxProseLines, DEFAULT_OUTLINE_MAX_PROSE_LINES)
  const classified = classifyOutlineLines(text)
  const { beats, lists, outlineHeading, proseLines } = classified
  const structuralLines = beats.length + lists.length
  // An outline/beats heading is an explicit presentation-as-structure, so it
  // needs only a short flat body to trip. Without one, only an unambiguous run
  // of bold-label beats qualifies — a couple of bold leads in ordinary chat
  // must never block a send.
  const presented = outlineHeading
    ? structuralLines >= 2
    : beats.length >= minSignalLines
  if (!presented) return PASS
  if (outlineHasDepth(classified)) return PASS
  if (proseLines > maxProseLines) return PASS
  return {
    pass: false,
    linter: 'outline-depth',
    error: 'outline-depth: this reads as an outline with a single structural depth — '
      + 'a labeled list, not an outline. Add nesting (sections with sub-points), or send it as prose.',
  }
}

/**
 * Run the configured linters in order. File-backed composition runs first so a
 * long inline outline is told to move into a file before it is told to nest.
 */
export function lintChatOutbound({ text = '', source = null, config = null } = {}) {
  const normalized = normalizeChatLintersConfig(config)
  const fileBacked = lintFileBackedComposition(text, source, normalized.fileBackedComposition)
  if (!fileBacked.pass) return fileBacked
  return lintOutlineDepth(text, normalized.outlineDepth)
}
