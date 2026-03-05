/**
 * Markdown build pipeline for tlda.
 *
 * Reads a .md file from sourceDir, renders with markdown-it + KaTeX,
 * wraps in a full HTML page with the tlda bridge script, and writes
 * output/index.html + page-info.json.
 *
 * The output format is identical to the 'html' format — the viewer
 * uses loadHtmlDocument and html-page shapes, same as for Quarto HTML.
 */

import MarkdownIt from 'markdown-it'
import markdownItAnchor from 'markdown-it-anchor'
import katex from 'katex'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, basename } from 'path'
import { injectBridge } from './html-injector.mjs'
import { updateProject, readProject, listProjects, aggregateBookToc, sourceDir as getSourceDir, outputDir as getOutputDir } from './project-store.mjs'
import { broadcastSignal } from './sync-rooms.mjs'

// ---- KaTeX math plugin for markdown-it ----

function escapedDollar(state, silent) {
  if (state.src[state.pos] !== '\\') return false
  if (state.src[state.pos + 1] !== '$') return false
  if (!silent) {
    const token = state.push('html_inline', '', 0)
    token.content = '$'
  }
  state.pos += 2
  return true
}

function mathPlugin(md) {
  // Display math: $$...$$
  md.block.ruler.before('fence', 'math_block', (state, startLine, endLine, silent) => {
    let pos = state.bMarks[startLine] + state.tShift[startLine]
    let max = state.eMarks[startLine]
    const src = state.src

    if (src.charCodeAt(pos) !== 0x24 || src.charCodeAt(pos + 1) !== 0x24) return false

    pos += 2
    let firstLine = src.slice(pos, max)

    if (silent) return true

    // Find closing $$
    let nextLine = startLine
    let found = false
    let lastContent = firstLine

    if (firstLine.trimEnd().endsWith('$$')) {
      found = true
      lastContent = firstLine.slice(0, firstLine.lastIndexOf('$$'))
    } else {
      nextLine++
      while (nextLine < endLine) {
        pos = state.bMarks[nextLine] + state.tShift[nextLine]
        max = state.eMarks[nextLine]
        const line = src.slice(pos, max)
        if (line.trimEnd().endsWith('$$')) {
          lastContent = line.slice(0, line.lastIndexOf('$$'))
          found = true
          break
        }
        nextLine++
      }
    }

    if (!found) return false

    // Collect math content
    let mathContent
    if (nextLine === startLine) {
      mathContent = lastContent.trim()
    } else {
      const lines = []
      for (let i = startLine; i <= nextLine; i++) {
        const lp = state.bMarks[i] + state.tShift[i]
        const lm = state.eMarks[i]
        let line = src.slice(lp, lm)
        if (i === startLine) line = line.slice(2)
        if (i === nextLine) line = lastContent
        lines.push(line)
      }
      mathContent = lines.join('\n').trim()
    }

    state.line = nextLine + 1

    const token = state.push('math_block', 'math', 0)
    token.block = true
    token.content = mathContent
    token.map = [startLine, state.line]
    token.markup = '$$'
    return true
  }, { alt: ['paragraph', 'reference', 'blockquote', 'list'] })

  // Inline math: $...$
  md.inline.ruler.after('escape', 'math_inline', (state, silent) => {
    const src = state.src
    const pos = state.pos
    if (src[pos] !== '$') return false
    if (src[pos + 1] === '$') return false  // not display math start

    // Find closing $
    let end = pos + 1
    while (end < src.length) {
      if (src[end] === '\\') { end += 2; continue }
      if (src[end] === '$') break
      end++
    }
    if (end >= src.length) return false

    const content = src.slice(pos + 1, end)
    if (!content.trim()) return false
    if (!silent) {
      const token = state.push('math_inline', '', 0)
      token.markup = '$'
      token.content = content
    }
    state.pos = end + 1
    return true
  })

  // Render tokens
  md.renderer.rules.math_inline = (tokens, idx) => {
    try {
      return katex.renderToString(tokens[idx].content, { throwOnError: false, displayMode: false })
    } catch (e) {
      return `<span class="math-error">${tokens[idx].content}</span>`
    }
  }

  md.renderer.rules.math_block = (tokens, idx) => {
    try {
      return '<p>' + katex.renderToString(tokens[idx].content, { throwOnError: false, displayMode: true }) + '</p>\n'
    } catch (e) {
      return `<p class="math-error">${tokens[idx].content}</p>\n`
    }
  }
}

// ---- Extract title from markdown source ----

function extractTitle(source) {
  const m = source.match(/^#\s+(.+)$/m)
  return m ? m[1].trim() : 'Document'
}

// ---- Main build function ----

export async function buildMarkdownDocument(name, addLog = console.log) {
  const srcDir = getSourceDir(name)
  const outDir = getOutputDir(name)

  // Find the main markdown file
  const project = readProject(name)
  const mainFile = project.mainFile || 'index.md'
  const srcFile = join(srcDir, mainFile)

  addLog(`[markdown] Reading ${srcFile}`)

  let source
  try {
    source = readFileSync(srcFile, 'utf8')
  } catch (e) {
    addLog(`[markdown] Error reading source: ${e.message}`)
    updateProject(name, { buildStatus: 'error' })
    return
  }

  const slugify = s => s.toLowerCase().replace(/[^\w]+/g, '-').replace(/^-|-$/g, '')

  // Extract TOC from original source (before stripping {#id} tags)
  // Pandoc-style {#explicit-id} in headings: strip from title, use as anchor
  const LEVEL_MAP = { 1: 'section', 2: 'subsection', 3: 'subsubsection', 4: 'subsubsection' }
  const toc = []
  const mdToc = new MarkdownIt()
  const tocTokens = mdToc.parse(source, {})
  for (let i = 0; i < tocTokens.length; i++) {
    if (tocTokens[i].type === 'heading_open') {
      const level = parseInt(tocTokens[i].tag.slice(1))
      const inlineToken = tocTokens[i + 1]
      let headingTitle = inlineToken?.children?.map(t => t.content).join('') || ''
      const explicitId = headingTitle.match(/\{#([\w-]+)\}/)
      if (explicitId) headingTitle = headingTitle.replace(/\s*\{#[\w-]+\}/, '').trim()
      const anchor = slugify(headingTitle)
      if (level <= 4 && headingTitle && anchor) {
        toc.push({ title: headingTitle, level: LEVEL_MAP[level] || 'subsubsection', page: 1, anchor })
      }
    }
  }

  // Strip {#id} tags from headings so they don't appear in rendered HTML
  const processedSource = source.replace(/(^#{1,6}[^\n]*?)\s*\{#[\w-]+\}/gm, '$1')

  const md = new MarkdownIt({ html: true, linkify: true, typographer: true })
    .use(mathPlugin)
    .use(markdownItAnchor, { slugify })

  // Render and collect tokens
  const env = {}
  const tokens = md.parse(processedSource, env)
  const content = md.renderer.render(tokens, md.options, env)
  const title = extractTitle(source)

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.22/dist/katex.min.css">
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      font-size: 0.875rem;
      font-weight: 400;
      line-height: 1.5;
      color: #212529;
      max-width: 680px;
      margin: 0 auto;
      padding: 48px 0 80px;
    }
    h1, h2, h3, h4 {
      font-weight: 500;
      line-height: 1.25;
      margin-top: 1.8em;
      margin-bottom: 0.5em;
    }
    h1 { font-size: 1.8em; margin-top: 0; }
    h2 { font-size: 1.35em; }
    h3 { font-size: 1.1em; }
    p { margin: 0 0 1em; }
    pre {
      background: #f5f5f5;
      padding: 1em;
      border-radius: 4px;
      overflow-x: auto;
      font-size: 0.88em;
    }
    code {
      font-family: 'SF Mono', 'Fira Mono', monospace;
      font-size: 0.9em;
      background: rgba(0,0,0,0.06);
      padding: 0.1em 0.35em;
      border-radius: 3px;
    }
    pre code { background: none; padding: 0; }
    blockquote {
      margin: 1em 0;
      padding: 0 0 0 1em;
      border-left: 3px solid #ccc;
      color: #555;
    }
    table { border-collapse: collapse; width: 100%; margin: 1em 0; }
    th, td { border: 1px solid #ddd; padding: 0.5em 0.75em; text-align: left; }
    th { background: #f5f5f5; font-weight: 500; }
    img { max-width: 100%; height: auto; }
    a { color: #2563eb; }
    .katex-display { overflow-x: auto; overflow-y: hidden; }
    .math-error { color: red; font-family: monospace; }
  </style>
</head>
<body>
${content}
</body>
</html>`

  const injected = injectBridge(html, '', '', true, {})

  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'index.html'), injected)

  const pageInfo = [{ file: 'index.html', width: 800, height: 1200, title }]
  writeFileSync(join(outDir, 'page-info.json'), JSON.stringify(pageInfo, null, 2))
  writeFileSync(join(outDir, 'toc.json'), JSON.stringify(toc, null, 2))

  updateProject(name, { buildStatus: 'success', pages: 1, lastBuild: new Date().toISOString() })
  broadcastSignal(`doc-${name}`, 'signal:reload', { pages: 1, timestamp: Date.now() })

  // Re-aggregate any book that contains this doc as a member
  for (const proj of listProjects()) {
    if (proj.format === 'book' && (proj.members || []).includes(name)) {
      aggregateBookToc(proj.name, proj.members)
    }
  }

  addLog(`[markdown] ${name}: rendered "${title}"`)
}
