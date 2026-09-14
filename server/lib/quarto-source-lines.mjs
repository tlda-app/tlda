/**
 * quarto-source-lines.mjs — put source-line markers on rendered Quarto blocks.
 *
 * tlda's own markdown renderer marks every block it emits with `id="line-N"`
 * (build-markdown.mjs, installLineAnchorPlugin), and the client anchors
 * annotations, source-cursor tracking and highlight selections to those
 * markers. Quarto renders its own HTML through pandoc and emits nothing of the
 * kind, so every one of those three was dark on a Quarto chapter: measured on a
 * real 164KB render, zero `line-`, zero `data-source-line`, zero `data-line`.
 *
 * There is no source map to read. Quarto knits the .qmd to an intermediate .md
 * before pandoc sees it, so even pandoc's own source positions would name lines
 * in a file that does not survive the build. What does survive is the text: a
 * prose block is rendered from one source line, mostly verbatim. So the mapping
 * is recovered by walking both in document order.
 *
 * The cursor only ever moves forward. That is what makes a text match safe
 * rather than a guess — a phrase that recurs later in the chapter cannot drag an
 * anchor backwards across the file, and the worst a coincidence can do is claim
 * a line slightly early in a region the walk was already passing through.
 *
 * A block that does not match gets NO marker. Tables (rendered as concatenated
 * cells against pipe rows in source), display math (one block spanning several
 * source lines), and text produced by lua filters or `{{< include >}}` are the
 * structural misses; the last of those has no line in this file to name, so
 * marking it would be a lie. The client falls back to the nearest preceding
 * marker, which is what it already does for an unmarked region of markdown.
 */

import { JSDOM } from 'jsdom'

/**
 * Quarto's content container. Its absence is meaningful, not an error: a reveal
 * deck and the book's redirect stub both lack it, and neither takes the
 * line-anchored path.
 */
const CONTENT_ROOT = 'main#quarto-document-content'

const BLOCK_SELECTOR = 'h1,h2,h3,h4,h5,h6,p,li,blockquote,dd,dt'

/**
 * Output of an executed chunk is rendered from data, not from a source line
 * anyone can annotate against, and `.tlda-output-source` is injected by
 * quarto-output-provenance.mjs and already carries its own coordinate.
 */
const EXCLUDED_ANCESTORS = '.cell-output, .tlda-output-source, figure'

const MIN_PREFIX_MATCH = 12
const PREFIX_WINDOW = 40

/** Fold what Quarto renders differently from how it is typed. */
function fold(value) {
  return String(value)
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/ /g, ' ')
    .replace(/\\[()[\]]/g, '')
    .replace(/\$\$?/g, '')
    .replace(/--+/g, '-')
}

function normalize(value) {
  return fold(value).replace(/\s+/g, ' ').trim().toLowerCase()
}

/** The same text, as it reads in the .qmd, with the markup that renders away removed. */
function normalizeSourceLine(line) {
  return String(line)
    .replace(/^#{1,6}\s+/, '')
    .replace(/\{#[^}]*\}/g, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]/g, '')
    .replace(/^>\s*/, '')
    .replace(/^\s*[-*+]\s+/, '')
    .replace(/^\s*\d+[.)]\s+/, '')
}

const HEADING = /^#{1,6}\s/
const LIST_ITEM = /^\s*([-*+]|\d+[.)])\s/

/**
 * Fences whose CONTENT still renders into a markable block.
 *
 * A `:::` callout wraps ordinary prose in paragraphs, and display math between
 * `$$` arrives as a single rendered block. Both are separators only: the fence
 * line contributes no text, the lines inside it stay matchable.
 */
const DIVISION = /^\s*(:::|\$\$)/

/**
 * Fences whose content renders into `pre`/`code`, which `markableBlocks` never
 * matches — so the source side must not offer it either.
 *
 * Offering it is a false-anchor generator rather than a missed match. The two
 * walks are a matched pair, and a region that only one of them can see makes
 * their cursors diverge. Counterexample, found by review rather than by the
 * measurements, which were all green:
 *
 *     ```                                        <- 1
 *     A repeated sentence that belongs to code.   <- 2
 *     ```                                        <- 3
 *                                                 <- 4
 *     A repeated sentence that belongs to code.   <- 5
 *
 * Quarto renders the first into `pre > code` and the second into `p`. Only the
 * `p` is markable, the cursor was still sitting at the line-2 block, the texts
 * are identical, so the paragraph anchored to **line 2** — a line inside a code
 * block, which is not where that sentence is.
 *
 * Forward-only matching does not save this. Monotonicity bounds how far an
 * anchor can be dragged; it does not make an approximate match correct.
 */
const CODE_FENCE = /^\s*(`{3,}|~{3,})/

/**
 * A table row renders into `table`, also outside the markable set, for the same
 * reason and with the same failure mode.
 */
const TABLE_ROW = /^\s*\|/

/**
 * The .qmd as the blocks a reader would recognize, each keyed to the line it
 * starts on.
 *
 * A markdown paragraph is soft-wrapped across as many source lines as the author
 * felt like using, and Quarto renders it as one element; display math spans the
 * lines between its `$$` fences the same way. Comparing a rendered block against
 * a single source line therefore missed most prose — measured on a real chapter,
 * it found 47 of 159 blocks, against 99 for this grouping.
 *
 * A heading, a list item, and a division fence each begin a block of their own,
 * so a run of list items does not collapse into one anchor.
 */
function sourceBlocks(source) {
  const blocks = []
  let current = null
  const flush = () => {
    if (current && current.parts.join(' ').trim()) {
      blocks.push({ line: current.line, text: normalize(current.parts.join(' ')) })
    }
    current = null
  }
  const lines = String(source).split(/\r?\n/)
  let openFence = null
  let inFrontmatter = false
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index]

    // YAML frontmatter is configuration, not prose. Its `title:` reaches the
    // page as the document title, never as the text of the line that declared
    // it, so leaving it matchable only offers a block nothing can consume.
    if (index === 0 && /^---\s*$/.test(raw)) { inFrontmatter = true; continue }
    if (inFrontmatter) { if (/^(---|\.\.\.)\s*$/.test(raw)) inFrontmatter = false; continue }

    // Inside a code fence nothing is matchable, including the closing fence.
    const fence = CODE_FENCE.exec(raw)
    if (openFence) {
      if (fence && fence[1][0] === openFence[0] && fence[1].length >= openFence.length) openFence = null
      continue
    }
    if (fence) { flush(); openFence = fence[1]; continue }

    if (!raw.trim()) { flush(); continue }
    if (TABLE_ROW.test(raw)) { flush(); continue }
    // A fence is markup, not content. It ends the block above it and
    // contributes no text of its own, so the content inside a callout is keyed
    // to the line the author wrote it on rather than to the `:::` above it.
    if (DIVISION.test(raw)) { flush(); continue }
    if (HEADING.test(raw) || LIST_ITEM.test(raw)) flush()
    if (!current) current = { line: index + 1, parts: [] }
    current.parts.push(normalizeSourceLine(raw))
    if (HEADING.test(raw)) flush()
  }
  flush()
  return blocks
}

/**
 * Whether a rendered block and a source block are the same text.
 *
 * Containment, not just equality, because Quarto's callouts and the project's
 * lua filters prepend generated text to a block they did not write — an exercise
 * paragraph reaches the page as "Exercise 1 " followed by the author's sentence.
 */
function matches(sourceText, blockText) {
  if (sourceText === blockText) return true
  if (blockText.length <= MIN_PREFIX_MATCH || sourceText.length <= MIN_PREFIX_MATCH) return false
  const head = sourceText.slice(0, PREFIX_WINDOW)
  return sourceText.startsWith(blockText.slice(0, PREFIX_WINDOW))
    || blockText.startsWith(head)
    || blockText.includes(head)
}

/**
 * Blocks to mark, in document order: those that hold text of their own rather
 * than wrapping other blocks, so a list item and the paragraph inside it do not
 * both consume the cursor.
 */
function markableBlocks(root) {
  return [...root.querySelectorAll(BLOCK_SELECTOR)].filter(element => {
    if (element.closest(EXCLUDED_ANCESTORS)) return false
    if (element.querySelector(BLOCK_SELECTOR)) return false
    if (element.hasAttribute('data-source-line')) return false
    return !!normalize(element.textContent)
  })
}

/**
 * Mark each rendered block that can be traced to a line of `source`.
 *
 * Returns the HTML unchanged when there is nothing to mark, so a deck, a
 * redirect stub, or a chapter whose every block is generated costs one parse and
 * no rewrite.
 */
export function markQuartoSourceLines(html, source) {
  const dom = new JSDOM(html)
  const root = dom.window.document.querySelector(CONTENT_ROOT)
  if (!root) return html

  const blocks = sourceBlocks(source)

  let cursor = 0
  let marked = 0
  for (const element of markableBlocks(root)) {
    const text = normalize(element.textContent)
    let found = -1
    for (let index = cursor; index < blocks.length; index++) {
      if (matches(blocks[index].text, text)) {
        found = index
        break
      }
    }
    if (found < 0) continue
    element.setAttribute('data-source-line', String(blocks[found].line))
    cursor = found + 1
    marked++
  }

  return marked > 0 ? dom.serialize() : html
}
