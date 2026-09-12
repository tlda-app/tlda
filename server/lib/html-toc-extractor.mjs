/**
 * Extract TOC from Quarto HTML chapter files.
 * Reads page-info.json, scans each HTML file for headings, outputs toc.json.
 *
 * Usage: node server/lib/html-toc-extractor.mjs <project-name>
 */

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECTS_DIR = join(__dirname, '..', 'projects')

function stripHtmlTags(html) {
  return html.replace(/<[^>]+>/g, '').trim()
}

/**
 * A chapter is named after what it is about, never after where it sits.
 *
 * Skip, 2026-09-01 06:11 EDT: "labs are not a thing." A lab is a chapter, and
 * `Lab 1` / `Lecture 2` is a position rather than a name — positions shift the
 * moment anything is inserted before them, so the TOC must not carry one.
 *
 * This used to live inline in the `inPart` branch below and only ran there, so
 * the strip fired for a chapter inside a part and never for a book member,
 * which is the case that reaches a reader: a member's own extractor runs with
 * no part, keeps `entry.title` verbatim, and `aggregateBookToc` then lifts that
 * string straight out as the chapter title. The separator was also required to
 * be `:` or `.`, so a plain `Lab 1 Sampling` went through untouched.
 */
export function stripPositionPrefix(title) {
  return String(title || '').replace(/^(?:Lab|Lecture)\s+\d+\s*[:.–—-]?\s*/i, '').trim()
}

/** The first `<h1>` text in a rendered document, or '' when it has none. */
function firstHeadingText(html) {
  const match = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html || '')
  return match ? stripHtmlTags(match[1]).replace(/\s+/g, ' ').trim() : ''
}

function extractHeadings(html, pageNum, chapterTitle, tocLevel) {
  const entries = []

  // Add chapter/part title from page-info.json
  if (chapterTitle) {
    entries.push({ title: chapterTitle, level: tocLevel || 'chapter', page: pageNum })
  }

  // Normalize a title for dedup comparison
  const normalize = (s) => s.replace(/[^a-z0-9]/gi, '').toLowerCase()
  const chapterNorm = chapterTitle ? normalize(chapterTitle) : ''

  // Find all headings with id attributes
  // Quarto generates: <h1 data-number="5"><span class="header-section-number">5</span> Title</h1>
  // or: <section id="anchor" class="level2"><h2>...</h2></section>
  const headingRegex = /<(h[1-3])\b[^>]*(?:id="([^"]*)")?[^>]*>([\s\S]*?)<\/\1>/gi
  let match
  while ((match = headingRegex.exec(html)) !== null) {
    const tag = match[1].toLowerCase()
    const idFromTag = match[2]
    const innerHtml = match[3]

    // Extract text, including section numbers from <span class="header-section-number">
    let text = stripHtmlTags(innerHtml).replace(/\s+/g, ' ').trim()
    if (!text) continue

    // Find the enclosing <section id="..."> if the heading itself doesn't have an id
    let anchor = idFromTag
    if (!anchor) {
      // Look backwards for <section id="..."> that contains this heading
      const before = html.slice(Math.max(0, match.index - 200), match.index)
      const sectionMatch = before.match(/<section[^>]*id="([^"]*)"[^>]*>\s*$/)
      if (sectionMatch) anchor = sectionMatch[1]
    }

    // Skip headings without anchors (can't navigate to them)
    if (!anchor) continue

    // Skip h1 headings that duplicate the chapter title
    // Strip prefixes like "2 ", "Lab 1:", "Lecture 2:", "Chapter 1:" before comparing
    if (chapterTitle && tag === 'h1') {
      const textNoNum = text.replace(/^\d+[\s.]+/, '')
      const titleNoNum = stripPositionPrefix(chapterTitle.replace(/^Chapter\s+\d+[:.]\s*/i, ''))
      if (normalize(textNoNum) === normalize(titleNoNum)) {
        continue
      }
    }

    const level = tag === 'h1' ? 'section' : tag === 'h2' ? 'subsection' : 'subsubsection'
    entries.push({ title: text, level, page: pageNum, anchor })
  }

  return entries
}

export function extractHtmlToc(outputDir, providedPageInfo = null) {
  const pageInfoPath = join(outputDir, 'page-info.json')

  if (!existsSync(pageInfoPath)) {
    throw new Error(`No page-info.json found in ${outputDir}`)
  }

  const pageInfo = providedPageInfo || JSON.parse(readFileSync(pageInfoPath, 'utf8'))
  const toc = []

  // Compute "Chapter N" display titles (same logic as unified-server)
  let inPart = false
  let chapterNum = 0
  for (let i = 0; i < pageInfo.length; i++) {
    const entry = pageInfo[i]
    if (entry.group && entry.groupIndex > 0) {
      toc.push({ title: entry.title || `Slide ${entry.groupIndex + 1}`, level: 'section', page: i + 1 })
      continue
    }
    if (entry.tocLevel === 'part') {
      chapterNum = 0
      inPart = true
    } else if (!entry.tocLevel && inPart) {
      chapterNum++
    }

    // A structural entry declares no file at all — a part heading that is a
    // title and not a page — so there is nothing it could have produced and
    // nothing missing. Before this guard existed such an entry fell through
    // the `tocLevel === 'part'` branch above, which unlike the `entry.group`
    // branch does not `continue`, and died on `join(outputDir, undefined)`.
    if (!entry.file) continue

    // A declared page whose HTML is absent is a failed build, not a page to
    // skip. Same rule as `Fail incomplete alternate renders` (815ee96d3):
    // something declared did not get produced.
    //
    // Which path this actually guards, because it is not the obvious one:
    // `buildQmdDocument` (`build-qmd.mjs`) reaches here with a `pageInfo` it
    // derived from files it observed on disk, and it throws earlier still via
    // `qmdMissingDeclaredOutputFiles`. So the qmd build cannot trip this. What
    // can is the CLI entry below, run against a `page-info.json` this build
    // did not generate. The exemption is keyed on whether an entry names a
    // file rather than on `tocLevel`, because a part that names one has
    // declared a page.
    const htmlPath = join(outputDir, entry.file)
    if (!existsSync(htmlPath)) {
      throw new Error(`[toc] ${pageInfoPath} declares ${entry.file}, but ${htmlPath} was not produced`)
    }

    const html = readFileSync(htmlPath, 'utf8')

    // Build display title for the TOC entry. The position prefix comes off
    // every entry, in or out of a part — see `stripPositionPrefix`. A title
    // that was ONLY a position leaves nothing behind, so the document's own
    // first heading names it; the app cannot invent a name beyond that, and a
    // document with neither keeps whatever string it had.
    let displayTitle = stripPositionPrefix(entry.title) || firstHeadingText(html) || entry.title
    if (!entry.tocLevel && inPart && chapterNum > 0) {
      displayTitle = displayTitle ? `Chapter ${chapterNum}: ${displayTitle}` : `Chapter ${chapterNum}`
    }

    const headings = extractHeadings(html, i + 1, displayTitle, entry.tocLevel) // 1-indexed
    console.log(`  ${entry.file}: ${headings.length} headings`)
    toc.push(...headings)
  }

  return toc
}

function extractToc(projectName) {
  const outputDir = join(PROJECTS_DIR, projectName, 'output')
  const toc = extractHtmlToc(outputDir)

  const tocPath = join(outputDir, 'toc.json')
  writeFileSync(tocPath, JSON.stringify(toc, null, 2))
  console.log(`Wrote ${toc.length} entries to ${tocPath}`)
}

function buildSearchIndex(projectName) {
  const outputDir = join(PROJECTS_DIR, projectName, 'output')
  const searchJsonPath = join(outputDir, 'search.json')
  const pageInfoPath = join(outputDir, 'page-info.json')

  if (!existsSync(searchJsonPath)) {
    console.warn(`No search.json found for project ${projectName} — skipping search index`)
    return
  }
  if (!existsSync(pageInfoPath)) {
    console.warn(`No page-info.json found — skipping search index`)
    return
  }

  const quartoSearch = JSON.parse(readFileSync(searchJsonPath, 'utf8'))
  const pageInfo = JSON.parse(readFileSync(pageInfoPath, 'utf8'))

  // Build filename → 1-indexed page number map
  const fileToPage = {}
  pageInfo.forEach((entry, i) => {
    fileToPage[entry.file] = i + 1
  })

  const index = []
  for (const entry of quartoSearch) {
    const href = entry.href || entry.objectID || ''
    const parts = href.split('#')
    const file = parts[0]
    const anchor = parts[1] || undefined
    // search.json may use paths like "lectures/Lab1-prose.html" — strip dir prefix
    const basename = file.split('/').pop()
    const page = fileToPage[file] || fileToPage[basename]
    if (!page) continue
    const text = entry.text || ''
    if (!text.trim()) continue
    const label = entry.section || entry.title || undefined
    index.push({ page, text, label, anchor })
  }

  const outPath = join(outputDir, 'search-index.json')
  writeFileSync(outPath, JSON.stringify(index))
  console.log(`Wrote ${index.length} search entries to ${outPath}`)
}

// CLI
if (fileURLToPath(import.meta.url) === process.argv[1]) {
  const projectName = process.argv[2]
  if (!projectName) {
    console.error('Usage: node server/lib/html-toc-extractor.mjs <project-name>')
    process.exit(1)
  }
  extractToc(projectName)
  buildSearchIndex(projectName)
}
