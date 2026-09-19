/**
 * Drop a handout's student-side filter from a document that did not bring it.
 *
 * A generated handout carries `<stem>.qmd.support/`, and its front matter names
 * a filter inside it. That filter is an aid for the student's own render in
 * Positron: every branch of it returns nil and all it does is write warnings to
 * stderr about an answer typed outside its box. Nothing in tlda reads it.
 *
 * When the student hands in a document without that directory, pandoc refuses
 * the render outright — `cannot open …answer-placement-warning.lua` — after the
 * whole document has knitted. The work is complete and present; the render dies
 * on a file that could not have changed a byte of the output. Measured on a real
 * submission: 33 of 33 chunks executed, then nothing, and zero pages served.
 *
 * So the dependency is removed rather than checked for. The repo rule is to
 * prefer deleting an unnecessary path to adding validation around it, and there
 * is nothing useful to say to a student about a warning filter they never knew
 * they had.
 *
 * SCOPED DELIBERATELY TO `.qmd.support/`. A document's other filters are not
 * cosmetic — `solution-callout.lua` beside this one is what folds the solutions,
 * and dropping a missing filter in general would silently change what a page
 * says. Only the handout generator's own support directory is treated this way,
 * and only when it is absent: when it is there, it runs as before.
 */

const FRONT_MATTER = /^(---\r?\n)([\s\S]*?)(\r?\n---\s*(?:\r?\n|$))/

/** A `filters:` list item naming a file under some `<stem>.qmd.support/`. */
const SUPPORT_FILTER_ITEM = /^(\s*)-\s*(['"]?)([^'"\n]*\.qmd\.support\/[^'"\n]+)\2\s*$/

/**
 * `text` with absent support-directory filters removed from its front matter.
 *
 * `hasFile(relativePath)` answers whether a path written relative to the
 * document exists. Returns the text unchanged when there is nothing to drop, so
 * a caller can compare by identity to decide whether to write.
 *
 * Returns `{ text, dropped }` — `dropped` names what was removed, because a
 * build that quietly alters a document is the failure this file exists to
 * report, not to commit.
 */
export function withoutAbsentSupportFilters(text, hasFile) {
  const source = String(text ?? '')
  const match = source.match(FRONT_MATTER)
  if (!match) return { text: source, dropped: [] }

  const [, open, body, close] = match
  const dropped = []
  let inFilters = false

  const kept = body.split('\n').filter(line => {
    if (/^filters\s*:/.test(line)) { inFilters = true; return true }
    // Any other top-level key ends the block. A list item is indented, so this
    // only fires on a sibling key rather than on the items themselves.
    if (inFilters && /^\S/.test(line)) inFilters = false
    if (!inFilters) return true

    const item = line.match(SUPPORT_FILTER_ITEM)
    if (!item) return true
    const target = item[3]
    if (hasFile(target)) return true
    dropped.push(target)
    return false
  })

  if (dropped.length === 0) return { text: source, dropped }

  // A `filters:` key left with no items is not an empty list to Quarto, it is a
  // null value, and it is rejected. Drop the key too when it has been emptied.
  const withoutEmptyKey = kept.filter((line, index) => {
    if (!/^filters\s*:\s*$/.test(line)) return true
    const next = kept[index + 1]
    return next !== undefined && /^\s+-/.test(next)
  })

  return {
    text: source.replace(FRONT_MATTER, `${open}${withoutEmptyKey.join('\n')}${close}`),
    dropped,
  }
}
