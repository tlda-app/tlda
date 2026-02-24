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
      const titleNoNum = chapterTitle.replace(/^(Chapter|Lab|Lecture)\s+\d+[:.]\s*/i, '')
      if (normalize(textNoNum) === normalize(titleNoNum)) {
        continue
      }
    }

    const level = tag === 'h1' ? 'section' : tag === 'h2' ? 'subsection' : 'subsubsection'
    entries.push({ title: text, level, page: pageNum, anchor })
  }

  return entries
}

function extractToc(projectName) {
  const outputDir = join(PROJECTS_DIR, projectName, 'output')
  const pageInfoPath = join(outputDir, 'page-info.json')

  if (!existsSync(pageInfoPath)) {
    console.error(`No page-info.json found for project ${projectName}`)
    process.exit(1)
  }

  const pageInfo = JSON.parse(readFileSync(pageInfoPath, 'utf8'))
  const toc = []

  // Compute "Chapter N" display titles (same logic as unified-server)
  let inPart = false
  let chapterNum = 0
  for (let i = 0; i < pageInfo.length; i++) {
    const entry = pageInfo[i]
    if (entry.tocLevel === 'part') {
      chapterNum = 0
      inPart = true
    } else if (!entry.tocLevel && inPart) {
      chapterNum++
    }

    // Build display title for the TOC entry
    let displayTitle = entry.title
    if (!entry.tocLevel && inPart && chapterNum > 0) {
      const stripped = entry.title.replace(/^(Lab|Lecture)\s+\d+[:.]\s*/i, '').replace(/^Lecture\s+\d+$/i, '')
      displayTitle = stripped ? `Chapter ${chapterNum}: ${stripped}` : `Chapter ${chapterNum}`
    }

    const htmlPath = join(outputDir, entry.file)
    if (!existsSync(htmlPath)) {
      console.warn(`  Skipping ${entry.file} (not found)`)
      continue
    }

    const html = readFileSync(htmlPath, 'utf8')
    const headings = extractHeadings(html, i + 1, displayTitle, entry.tocLevel) // 1-indexed
    console.log(`  ${entry.file}: ${headings.length} headings`)
    toc.push(...headings)
  }

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
const projectName = process.argv[2]
if (!projectName) {
  console.error('Usage: node server/lib/html-toc-extractor.mjs <project-name>')
  process.exit(1)
}
extractToc(projectName)
buildSearchIndex(projectName)
