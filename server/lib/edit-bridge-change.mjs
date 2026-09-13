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

/**
 * The words that differ between two passages, marked.
 *
 * Whole-passage before/after answers "a paragraph changed" and fails on the
 * case that is most of his real traffic: a correction inside a long passage.
 * Measured on his course, `lectures/Lecture3.qmd`, commit "fixed typo in L3" --
 * 13 words on each side, one character different, and the card rendered two
 * lines that looked identical. A reader learned less than the commit subject
 * already told them.
 *
 * So the card marks the span that differs rather than showing two passages that
 * contain it. Plain LCS over words: the excerpts are clipped to a couple of
 * hundred characters, so the quadratic cost is nothing and a smarter algorithm
 * would only be harder to read.
 */
export function markWordDiff(before, after) {
  const a = before ? before.split(/(\s+)/).filter(t => t !== '') : []
  const b = after ? after.split(/(\s+)/).filter(t => t !== '') : []
  // lcs[i][j] = longest common run of a.slice(i) and b.slice(j)
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1))
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }
  const beforeParts = []
  const afterParts = []
  const push = (parts, text, changed) => {
    const last = parts[parts.length - 1]
    if (last && last.changed === changed) last.text += text
    else parts.push({ text, changed })
  }
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { push(beforeParts, a[i], false); push(afterParts, b[j], false); i += 1; j += 1 }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { push(beforeParts, a[i], true); i += 1 }
    else { push(afterParts, b[j], true); j += 1 }
  }
  while (i < a.length) { push(beforeParts, a[i], true); i += 1 }
  while (j < b.length) { push(afterParts, b[j], true); j += 1 }
  return { beforeParts, afterParts }
}

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

/** The line as written, with only the diff marker removed. */
function rawOf(line) {
  return line.replace(/^[+-]/, '').replace(/\s+/g, ' ').trim()
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
    let before = hunk.removed.map(proseOf).filter(Boolean).join(' ')
    let after = hunk.added.map(proseOf).filter(Boolean).join(' ')
    // Stripping must never erase the change itself.
    //
    // His course is LaTeX-heavy and a common real edit is a command fix:
    // `\ldot` -> `\ldots`, measured on `lectures/Lecture3.qmd`, commit
    // "fixed typo in L3". `proseOf` turns BOTH into a space, so the two sides
    // came out identical and the card showed a person two matching lines and
    // called it a rewrite. When that happens the markup IS the change, so the
    // lines are shown as written -- he reads LaTeX, and raw beats a passage
    // whose only difference has been deleted.
    if (before && before === after) {
      const rawBefore = hunk.removed.map(rawOf).filter(Boolean).join(' ')
      const rawAfter = hunk.added.map(rawOf).filter(Boolean).join(' ')
      if (rawBefore !== rawAfter) { before = rawBefore; after = rawAfter }
    }
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
    excerpt: best ? (() => {
      const before = clip(best.before)
      const after = clip(best.after)
      // Marked AFTER clipping, so the marks line up with the text the card
      // actually shows rather than with a passage it truncated.
      return { file: best.file, before, after, ...markWordDiff(before, after) }
    })() : null,
    hunkCount: hunks.length,
  }
}
