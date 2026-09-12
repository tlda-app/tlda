/**
 * What an edit did to the writing.
 *
 * The bridge's card named the file and not the change, and Skip's verdict on
 * that was "ZERO EDITS ARE VISIBLE IN THE BRIDGE". The feature is named for
 * *what*; it was answering *when* and *which file*. This is the missing half.
 *
 * The agent-edit record states the cost it has to remove, in its first line:
 * "the expensive part is detection and localization". Detection is whether
 * something went wrong here. Localization is in which words. A filename is
 * neither, and a lines-changed count is only the first.
 *
 * Two decisions this encodes, neither of them invented here:
 *
 * ADDED IS NOT REPLACED. From the same record: "a large pure addition is
 * usually fine; replacing prose he already wrote is where the subtlety dies."
 * So an edit that only adds is cheap to skim past and an edit that reworded him
 * is the one to stop on, and the card must tell them apart at a glance. That is
 * recorded as a proposal he never ruled on, so it governs what the card
 * emphasises -- not what it claims.
 *
 * THE PROSE, NOT THE SOURCE, AT REST. His test is recognising a bad rewrite of
 * his own writing, and he reads the document rather than the source. The exact
 * source hunk has its own home in spec §8, at high zoom, and it is carried
 * through untouched for whatever wants it there.
 */

/** Markup that is noise when the question is "what words changed". */
function proseOf(line) {
  return line
    .replace(/^[+-]/, '')
    // LaTeX commands keep their argument, which is usually the prose.
    .replace(/\\(?:emph|textbf|textit|section|subsection|subsubsection|chapter|title|caption|label|ref|eqref|cite)\*?\{([^}]*)\}/g, '$1')
    .replace(/\\[a-zA-Z]+\*?/g, ' ')
    .replace(/[{}$]/g, '')
    // Markdown emphasis, headings and list bullets.
    .replace(/^\s{0,3}#{1,6}\s+/, '')
    .replace(/^\s*[-*+]\s+/, '')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function words(text) {
  const trimmed = text.trim()
  return trimmed ? trimmed.split(/\s+/).length : 0
}

/**
 * Split a unified diff into per-file hunks of added and removed lines.
 *
 * Deliberately not a full patch parser. It reads what `git log -p` emits for
 * our own shadow repo, where every file is text we wrote and there are no
 * renames to track, so the cases a general parser exists for cannot arise.
 */
export function hunksFromPatch(patch) {
  const hunks = []
  let file = null
  let current = null
  const flush = () => {
    if (current && (current.removed.length || current.added.length)) hunks.push(current)
    current = null
  }
  // A context line closes the run of changed lines and OPENS THE NEXT ONE in
  // the same hunk. It must not leave the parser holding nothing: `-U1` puts a
  // context line immediately before the first change of every hunk, so a
  // parser that drops to null there discards the change it was called to read.
  // Measured by the test below before this ever saw a real patch -- every
  // build would have summarised to nothing, which is the defect this module
  // exists to fix, arriving through the reader instead of the card.
  const open = () => { current = { file, removed: [], added: [] } }
  for (const line of String(patch || '').split('\n')) {
    if (line.startsWith('diff --git')) {
      flush()
      const match = line.match(/ b\/(.+)$/)
      file = match ? match[1] : null
      continue
    }
    if (line.startsWith('@@')) { flush(); open(); continue }
    if (!current) continue
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('-')) current.removed.push(line)
    else if (line.startsWith('+')) current.added.push(line)
    else { flush(); open() }
  }
  flush()
  return hunks
}

/**
 * What this edit did, as a person would say it.
 *
 * `kind` is the thing to read first:
 *   addition    -- only new text; nothing of his was displaced
 *   deletion    -- text removed and nothing put back
 *   replacement -- his words rewritten, which is the expensive case
 *
 * `excerpt` is the largest single rewrite, before and after, so a card can show
 * the change itself rather than a count. Counts alone are the failure this
 * replaces: "3 files, +40 -12" tells you an edit was big, never whether it was
 * wrong.
 */
export function summarizeChange(patch, { excerptChars = 240 } = {}) {
  const hunks = hunksFromPatch(patch)
  if (hunks.length === 0) return null

  let addedWords = 0
  let removedWords = 0
  let best = null
  for (const hunk of hunks) {
    const before = hunk.removed.map(proseOf).filter(Boolean).join(' ')
    const after = hunk.added.map(proseOf).filter(Boolean).join(' ')
    addedWords += words(after)
    removedWords += words(before)
    // The biggest rewrite, not the biggest hunk: a hunk that only adds is not
    // the one a person needs to see first, whatever its size.
    const weight = Math.min(words(before), words(after))
    if (before && after && (!best || weight > best.weight)) {
      best = { weight, file: hunk.file, before, after }
    }
  }

  // Nothing was rewritten, so show the largest thing that did happen.
  if (!best) {
    const widest = hunks
      .map(hunk => ({
        file: hunk.file,
        before: hunk.removed.map(proseOf).filter(Boolean).join(' '),
        after: hunk.added.map(proseOf).filter(Boolean).join(' '),
      }))
      .sort((a, b) => words(b.before) + words(b.after) - words(a.before) - words(a.after))[0]
    best = widest ? { ...widest, weight: 0 } : null
  }

  const kind = removedWords === 0 ? 'addition'
    : addedWords === 0 ? 'deletion'
      : 'replacement'

  const clip = text => (text.length > excerptChars ? `${text.slice(0, excerptChars).trimEnd()}…` : text)

  return {
    kind,
    addedWords,
    removedWords,
    // Only meaningful for a replacement, and the reason the distinction exists.
    rewordedWords: kind === 'replacement' ? Math.min(addedWords, removedWords) : 0,
    excerpt: best ? { file: best.file, before: clip(best.before), after: clip(best.after) } : null,
    hunkCount: hunks.length,
  }
}
