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
import { EDIT_CARD_EXCERPT_CHARS } from '../../shared/edit-card-metrics.mjs'

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
export function summarizeChange(patch, { excerptChars = EDIT_CARD_EXCERPT_CHARS } = {}) {
  const hunks = hunksFromPatch(patch)
  if (hunks.length === 0) return null

  // How much actually DIFFERS, per hunk, rather than how big the hunk is.
  //
  // A line re-emitted with one space added counts 44 words removed and 44
  // added at line level, and one changed token at word level. Scoring by hunk
  // size therefore ranked a whitespace fix above a deleted theorem statement
  // in the same commit -- the card excerpted the space and the headline
  // aggregated both, so a reader saw "rewrote ~44 words" over two lines
  // identical to the eye. Found on a paper of his; the fourth distinct way
  // that has happened.
  //
  // Above the cap the word diff is not worth its cost -- LCS is quadratic and
  // a whole-file insertion would be gigabytes -- and it is not needed there
  // either, since a hunk that large is never competing with a one-space fix.
  const DIFF_WORD_CAP = 1500
  const changedWords = (before, after) => {
    const b = words(before)
    const a = words(after)
    if (!before) return { displaced: 0, added: a }
    if (!after) return { displaced: b, added: 0 }
    if (b > DIFF_WORD_CAP || a > DIFF_WORD_CAP) return { displaced: b, added: a }
    const { beforeParts, afterParts } = markWordDiff(before, after)
    const count = parts => parts.filter(part => part.changed).reduce((n, part) => n + words(part.text), 0)
    return { displaced: count(beforeParts), added: count(afterParts) }
  }

  // Displacement first, size second.
  //
  // His record is explicit about the ordering: "a large pure addition is
  // usually fine; replacing prose he already wrote is where the subtlety
  // dies." So ANY hunk that took words of his away outranks any hunk that
  // only added, however big the addition -- and among hunks that displaced,
  // the one that displaced most wins. That is one comparison and it encodes
  // the priority rather than approximating it with a single number.
  const outranks = (a, b) => (a.displaced !== b.displaced ? a.displaced > b.displaced : a.added > b.added)

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
    // Counts are of words that actually DIFFER, so the headline and the
    // excerpt describe the same event. Counting whole lines said "rewrote ~44
    // words" of a line re-emitted with one space added, over an excerpt
    // showing that space -- a number that disagrees with what is on screen
    // reads as the highlighting being broken.
    const weight = changedWords(before, after)
    addedWords += weight.added
    removedWords += weight.displaced
    // EVERY hunk competes, including pure deletions and pure additions. The
    // previous rule required both sides to be non-empty, so a deletion could
    // never be the excerpt however large -- which is how a removed theorem
    // statement lost to a space.
    if ((before || after) && (!best || outranks(weight, best.weight))) {
      best = { weight, file: hunk.file, before, after }
    }
  }

  const kind = removedWords === 0 ? 'addition'
    : addedWords === 0 ? 'deletion'
      : 'replacement'

  // Clip AROUND the change, not from the start.
  //
  // Clipping the first N characters and marking afterwards shows a person the
  // opening of a passage whose difference is at character 500 -- two identical
  // windows and no marks, which is the same failure as not marking at all.
  // Measured on a paper of his: a three-line correction where the excerpt was
  // byte-identical on both sides because the edit was past the cut.
  // A side with nothing marked still says when it was cut: an excerpt that
  // ends mid-sentence with no ellipsis reads as the whole passage.
  const head = (whole, parts) => whole.length > excerptChars
    ? { text: `${whole.slice(0, excerptChars).trimEnd()}…`, parts: [] }
    : { text: whole, parts }
  const clipParts = (parts, whole) => {
    if (!parts.length) return head(whole, [])
    const firstChanged = parts.findIndex(part => part.changed)
    if (firstChanged === -1) return head(whole, parts)
    // Keep about a third of the budget as lead-in, so the marked span sits in
    // its sentence rather than at the very start.
    const lead = Math.floor(excerptChars / 3)
    let start = 0
    for (let i = 0; i < firstChanged; i += 1) start += parts[i].text.length
    const from = Math.max(0, start - lead)
    const to = from + excerptChars
    const out = []
    let cursor = 0
    for (const part of parts) {
      const partStart = cursor
      const partEnd = cursor + part.text.length
      cursor = partEnd
      if (partEnd <= from || partStart >= to) continue
      out.push({ text: part.text.slice(Math.max(0, from - partStart), Math.min(part.text.length, to - partStart)), changed: part.changed })
    }
    const text = (from > 0 ? '…' : '') + out.map(part => part.text).join('') + (to < whole.length ? '…' : '')
    if (from > 0) out.unshift({ text: '…', changed: false })
    if (to < whole.length) out.push({ text: '…', changed: false })
    return { text, parts: out }
  }

  return {
    kind,
    addedWords,
    removedWords,
    // Only meaningful for a replacement, and the reason the distinction exists.
    rewordedWords: kind === 'replacement' ? Math.min(addedWords, removedWords) : 0,
    excerpt: best ? (() => {
      // Marked on the WHOLE passage first, then clipped around the first mark:
      // the window has to be chosen by where the change is, and that is not
      // known until the diff has run.
      const { beforeParts, afterParts } = markWordDiff(best.before, best.after)
      const before = clipParts(beforeParts, best.before)
      const after = clipParts(afterParts, best.after)
      return {
        file: best.file,
        before: before.text,
        after: after.text,
        beforeParts: before.parts,
        afterParts: after.parts,
      }
    })() : null,
    hunkCount: hunks.length,
  }
}
