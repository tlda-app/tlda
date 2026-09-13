// Link the crossrefs in ONE already-rendered book page.
//
// This is the loop body of Quarto's `bookCrossrefsPostRender` for a single
// output file. Quarto runs that pass over the whole book after every chapter
// has been compiled, and does not expose it, so it is ported here. Source of
// the port: `src/project/types/book/book-crossrefs.ts` — resolveCrossrefs,
// isChapterRef, formatCrossref, refType, numberOption, sectionNumber,
// numberStyle, formatChapterIndex, refWithChapter, convertToRoman.
//
// Read against the installed 1.9.38 bundle and re-checked against the v1.10.18
// sources, which is the version we pin; the mechanism is identical in both.
// No line numbers are cited on purpose — they move, and the shipped bundle's
// differ from the repository's.
//
// WHAT THIS IS FOR. Compiling a chapter is expensive; linking it is not.
// Quarto couples them: numbering is baked per document at compile time from
// the chapter's position in the book config, but references BETWEEN chapters
// are left as `.quarto-unresolved-ref` placeholders and only resolved by a
// whole-book pass at the end. This module does that last step for one page, so
// a chapter can be compiled alone and linked when someone looks at it.
//
// PUBLISHING DOES NOT USE THIS. Published output is produced by stock
// `quarto render`. This runs only in the development loop.
//
// ---------------------------------------------------------------------------
// THE ONE DELIBERATE DIVERGENCE: a missing target leaves the reference intact
// ---------------------------------------------------------------------------
//
// What Quarto does when a ref's target is not in the merged index: warn,
// replace the ref with `<span class="quarto-unresolved-ref">?ID</span>`, and
// DELETE the enclosing `<a>`.
//
// What this does: warn, count it, and change nothing in the document. The
// anchor and the original id text are left exactly as they were, still
// carrying the `quarto-unresolved-ref` class.
//
// Why. Quarto's behaviour is correct FOR QUARTO. It links after the whole book
// is compiled, so a missing target means a genuinely broken reference and
// showing `?ID` is the right report. We link one page at a time, before the
// rest of the book exists, which makes "missing" the normal transient state.
// Their behaviour would turn a temporary gap into permanent damage the first
// time a reader opened the page: the anchor is gone, and the text is now `?ID`,
// which no later pass can match. We did not improve their tool — we broke the
// precondition their behaviour assumes, so we need a different property.
//
// THIS NEVER REACHES A PUBLISHED PAGE. Publishing uses stock `quarto render`
// over a complete book, where nothing is uncompiled, so on any complete book
// this module and Quarto's produce the same bytes. The divergence is only
// observable in the development loop, on a book that is partly built.
//
// Two tests hold it in place, named so the argument reads off the test list:
//   - "WHY WE DIVERGE: quarto destroys the anchor, so a later pass can never
//     link it" — reproduces their behaviour, then links again with a COMPLETE
//     index and shows it still resolves nothing.
//   - "THE MIRROR: ours leaves it intact, and a later pass DOES resolve it".
// Verified by counterfactual rather than assertion: restoring Quarto's
// destructive branch makes THE MIRROR fail, and only that test.
//
// Copied as-is, and not a divergence: `refType` returns `match ? match[1] :
// 'fig'`, so it never returns falsy and Quarto's own `if (!type) continue` is
// dead code. Preserved for fidelity. An id with no `type-` prefix is therefore
// treated as a figure ref rather than skipped.

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, posix } from 'node:path'
import { JSDOM } from 'jsdom'

const kCrossrefLabels = 'labels'
const kCrossrefChapters = 'chapters'
const kCrossrefChaptersAlpha = 'chapters-alpha'
const kCrossrefChaptersAppendix = 'chapters-appendix'
const kCrossrefChapterId = 'chapter-id'
const kCrossrefChPrefix = 'crossref-ch-prefix'
const kCrossrefApxPrefix = 'crossref-apx-prefix'
const kCrossrefSecPrefix = 'crossref-sec-prefix'

// --- number formatting, ported from Quarto --------------------------------

export function refType(id) {
  const match = id.match(/^(\w+)-/)
  return (match ? match[1] : 'fig').toLowerCase()
}

function formatChapterIndex(options, index) {
  return index
    ? (options[kCrossrefChaptersAlpha] ? String.fromCharCode(64 + index) : index.toString())
    : ''
}

function refWithChapter(options, ref, section) {
  if (options[kCrossrefChapters] !== false) {
    const chapter = section ? section[0] : undefined
    return (chapter ? formatChapterIndex(options, chapter) + '.' : '') + ref
  }
  return ref
}

function sectionNumber(options, section) {
  let lastIndex = 0
  for (let i = section.length - 1; i >= 0; i--) {
    if (section[i] > 0) { lastIndex = i; break }
  }
  const num = []
  for (let i = 0; i <= lastIndex; i++) {
    if (i === 0) {
      const chapIndex = formatChapterIndex(options, section[i])
      if (chapIndex) num.push(chapIndex)
    } else {
      num.push(section[i].toString())
    }
  }
  return num.join('.')
}

function numberStyle(options, type, defaultFormat = 'arabic') {
  return options[`${type}-labels`] || options[kCrossrefLabels] || defaultFormat
}

function convertToRoman(num, lower) {
  const roman = { M: 1000, CM: 900, D: 500, CD: 400, C: 100, XC: 90, L: 50, XL: 40, X: 10, IX: 9, V: 5, IV: 4, I: 1 }
  let str = ''
  for (const key of Object.keys(roman)) {
    const q = Math.floor(num / roman[key])
    num -= q * roman[key]
    str += (lower ? key.toLowerCase() : key).repeat(q)
  }
  return str
}

function numberOption(order, options, type, defaultFormat) {
  if (type === 'sec' && order.section) return sectionNumber(options, order.section)
  const style = numberStyle(options, type, defaultFormat)
  if (Array.isArray(style)) {
    return refWithChapter(options, style[(order.number - 1) % style.length], order.section)
  }
  if (style.match(/^alpha /)) {
    let startIndexChar = style[style.length - 1]
    if (startIndexChar === ' ') startIndexChar = 'a'
    return refWithChapter(
      options, String.fromCharCode(startIndexChar.charCodeAt(0) + order.number - 1), order.section)
  }
  if (style.match(/^roman/)) {
    return refWithChapter(options, convertToRoman(order.number, style.endsWith('i')), order.section)
  }
  return refWithChapter(options, order.number.toString(), order.section)
}

export function isChapterRef(entry) {
  if (refType(entry.key) === 'sec' && entry.order.section) {
    return !entry.order.section.slice(1).some(i => i > 0)
  }
  return false
}

function formatCrossref(type, options, entry, noPrefix, format, parent) {
  const { language } = format
  if (parent) {
    return [
      numberOption(parent.order, options, refType(parent.key)),
      ' (',
      numberOption(entry.order, options, 'subref', 'alpha a'),
      ')',
    ].join('')
  }
  if (format.pandoc['number-sections'] === false && type === 'sec') {
    return entry.caption || entry.key
  }
  const refNumber = numberOption(entry.order, options, type)
  if (type === 'sec' && !noPrefix) {
    const prefix = options[kCrossrefChapters] && isChapterRef(entry)
      ? (options[kCrossrefChaptersAppendix] ? language[kCrossrefApxPrefix] : language[kCrossrefChPrefix])
      : language[kCrossrefSecPrefix]
    return `${prefix} ${refNumber}`
  }
  return refNumber
}

// --- the linker -----------------------------------------------------------

// `file` is the page's path relative to the project output dir, which is what
// the index keys entries by. Mutates `doc`; returns counts so a caller can
// assert on them rather than re-parsing the result.
export function resolveCrossrefsInDoc(file, format, doc, index, { warn = console.warn } = {}) {
  let resolved = 0
  let unresolved = 0
  let relinked = 0

  const relativePathTo = target => posix.relative(posix.dirname(file), target)

  const refs = doc.querySelectorAll('.quarto-unresolved-ref')
  for (let i = 0; i < refs.length; i++) {
    const ref = refs[i]
    const id = ref.textContent
    const noPrefix = ref.classList.contains('ref-noprefix')
    const type = refType(id)
    if (!type) continue
    const entry = index.entries[id]
    let parentLink
    if (ref.parentElement?.tagName === 'A' &&
        ref.parentElement?.getAttribute('href') === `#${id}`) {
      parentLink = ref.parentElement
    }
    if (entry) {
      if (parentLink && file !== entry.file) {
        const hash = isChapterRef(entry) ? '' : `#${id}`
        parentLink.setAttribute('href', `${relativePathTo(entry.file)}${hash}`)
      }
      ref.innerHTML = formatCrossref(
        type, index.files[entry.file], entry, noPrefix, format,
        entry.parent ? index.entries[entry.parent] : undefined)
      ref.removeAttribute('class')
      resolved++
    } else {
      // The divergence. See the header. Deliberately does not touch the DOM.
      warn(`${file}: crossref @${id} not yet resolvable; left for a later pass`)
      unresolved++
    }
  }

  const links = doc.querySelectorAll('a')
  for (let i = 0; i < links.length; i++) {
    const link = links[i]
    const href = link.getAttribute('href')
    if (!href || !href.startsWith('#')) continue
    const id = href.slice(1)
    const heading = index.headings[id]
    if (heading && !heading.files.includes(file)) {
      const linkToFile = heading.files[0]
      const hash = index.files[linkToFile]?.[kCrossrefChapterId] === id ? '' : `#${id}`
      link.setAttribute('href', `${relativePathTo(linkToFile)}${hash}`)
      relinked++
    }
  }

  return { resolved, unresolved, relinked }
}

export function linkPage({ projectOutputDir, file, index, format, warn }) {
  const absolute = join(projectOutputDir, file)
  const dom = new JSDOM(readFileSync(absolute, 'utf8'))
  const counts = resolveCrossrefsInDoc(file, format, dom.window.document, index, { warn })
  writeFileSync(absolute, dom.serialize())
  return counts
}

// Build the merged index the way Quarto's `bookCrossrefIndexes` does, but from
// the on-disk INDEX rather than by walking the book config — the config walk
// needs the whole project loaded, which is the thing we are avoiding.
//
// A per-document index file that does not exist is SKIPPED, not an error. That
// is Quarto's behaviour too, and it is what makes a partially compiled book
// linkable at all.
export function loadMergedIndex(projectDir, { only } = {}) {
  const xrefDir = join(projectDir, '.quarto', 'xref')
  const mainIndexFile = join(xrefDir, 'INDEX')
  const index = { files: {}, entries: {}, headings: {} }
  if (!existsSync(mainIndexFile)) return index
  const mainIndex = JSON.parse(readFileSync(mainIndexFile, 'utf8'))

  for (const input of Object.keys(mainIndex)) {
    for (const outputBaseFile of Object.keys(mainIndex[input])) {
      const outputFile = posix.join(posix.dirname(input), outputBaseFile)
      if (only && !only.includes(outputFile)) continue
      const indexFile = join(xrefDir, mainIndex[input][outputBaseFile])
      if (!existsSync(indexFile)) continue
      const json = JSON.parse(readFileSync(indexFile, 'utf8'))
      index.files[outputFile] = json.options || {}
      for (const entry of json.entries || []) {
        index.entries[entry.key] = { ...entry, file: outputFile }
      }
      for (const heading of json.headings || []) {
        if (!index.headings[heading]) index.headings[heading] = { id: heading, files: [] }
        index.headings[heading].files.push(outputFile)
      }
    }
  }
  return index
}
