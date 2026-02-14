#!/usr/bin/env node
/**
 * Build an annotatable TLDraw document from a Quarto/HTML page.
 *
 * Accepts either a rendered .html file or a .qmd source file.
 * For .qmd files, finds the project's _quarto.yml, inherits its
 * execute settings (echo, warning, message, etc.), and renders
 * to HTML before processing.
 *
 * Splits the HTML at <h2> boundaries into separate page files,
 * measures each page's rendered height via Puppeteer, and writes
 * everything to public/docs/.
 *
 * Usage:
 *   node scripts/build-html-doc.mjs <html-or-qmd-path> <doc-name> [title]
 *
 * Examples:
 *   node scripts/build-html-doc.mjs \
 *     /path/to/_book/lectures/Lecture2-prose.html \
 *     lecture2-prose \
 *     "Point and Interval Estimates"
 *
 *   node scripts/build-html-doc.mjs \
 *     /path/to/lectures/Lecture2-prose.qmd \
 *     lecture2-prose
 */

import puppeteer from 'puppeteer-core'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { execSync } from 'child_process'
import { JSDOM } from 'jsdom'
import YAML from 'yaml'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(__dirname, '..')

const PAGE_WIDTH = 800  // CSS pixels — matches SVG target width
const MIN_PAGE_HEIGHT = 400  // Minimum height to avoid tiny pages

// Find Chrome
function findChrome() {
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  throw new Error('Could not find Chrome. Install Google Chrome or set CHROME_PATH.')
}

// Walk up from a directory to find _quarto.yml
function findQuartoConfig(startDir) {
  let dir = startDir
  while (true) {
    for (const name of ['_quarto.yml', '_quarto.yaml']) {
      const candidate = path.join(dir, name)
      if (fs.existsSync(candidate)) return candidate
    }
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

// Render a .qmd file to HTML, inheriting project execute settings
async function renderQmd(qmdPath) {
  const qmdDir = path.dirname(qmdPath)
  const qmdName = path.basename(qmdPath)

  // Find project _quarto.yml
  const configPath = findQuartoConfig(qmdDir)
  let executeSettings = {}
  let quartoTitle = null
  if (configPath) {
    console.log(`Found project config: ${configPath}`)
    const config = YAML.parse(fs.readFileSync(configPath, 'utf8'))
    if (config?.execute) {
      executeSettings = config.execute
      console.log(`  Inheriting execute settings: ${JSON.stringify(executeSettings)}`)
    }
  }

  // Parse the .qmd front matter
  const qmdContent = fs.readFileSync(qmdPath, 'utf8')
  const fmMatch = qmdContent.match(/^---\n([\s\S]*?)\n---/)
  let frontMatter = {}
  let bodyContent = qmdContent
  if (fmMatch) {
    frontMatter = YAML.parse(fmMatch[1]) || {}
    bodyContent = qmdContent.slice(fmMatch[0].length)
  }
  quartoTitle = frontMatter.title || null

  // Merge execute settings: project defaults, then file overrides
  const mergedExecute = { ...executeSettings, ...(frontMatter.execute || {}) }

  // Render in an isolated temp dir so Quarto doesn't find the project
  // config (which may define a book build). Symlink source dir contents
  // so includes and data files resolve.
  const tmpRenderDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tldraw-qmd-'))
  const htmlName = qmdName.replace(/\.qmd$/, '.html')

  // Symlink everything in the source directory
  for (const entry of fs.readdirSync(qmdDir)) {
    // Skip _quarto config files to avoid triggering project builds
    if (entry.startsWith('_quarto')) continue
    const src = path.join(qmdDir, entry)
    const dest = path.join(tmpRenderDir, entry)
    try { fs.symlinkSync(src, dest) } catch {}
  }

  // Write the patched .qmd (overrides the symlink)
  const tmpQmd = path.join(tmpRenderDir, qmdName)
  try { fs.unlinkSync(tmpQmd) } catch {}  // remove symlink first
  const newFrontMatter = { ...frontMatter, execute: mergedExecute }
  const newContent = `---\n${YAML.stringify(newFrontMatter)}---${bodyContent}`
  fs.writeFileSync(tmpQmd, newContent)

  // Render with Quarto
  console.log(`Rendering ${qmdName} with Quarto...`)
  try {
    execSync(`quarto render "${tmpQmd}" --to html`, {
      cwd: tmpRenderDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 120000,
    })
  } catch (e) {
    console.error('Quarto render failed:')
    console.error(e.stderr?.toString() || e.message)
    try { fs.rmSync(tmpRenderDir, { recursive: true }) } catch {}
    process.exit(1)
  }

  const tmpHtmlPath = path.join(tmpRenderDir, htmlName)
  if (!fs.existsSync(tmpHtmlPath)) {
    console.error(`Expected rendered HTML at ${tmpHtmlPath} but not found`)
    try { fs.rmSync(tmpRenderDir, { recursive: true }) } catch {}
    process.exit(1)
  }

  console.log(`Rendered to ${tmpHtmlPath}`)
  return { htmlPath: tmpHtmlPath, title: quartoTitle, tmpFiles: [tmpRenderDir] }
}

async function main() {
  const [inputPath, docName, title] = process.argv.slice(2)

  if (!inputPath || !docName) {
    console.error('Usage: node scripts/build-html-doc.mjs <html-or-qmd-path> <doc-name> [title]')
    process.exit(1)
  }

  const absInputPath = path.resolve(inputPath)
  if (!fs.existsSync(absInputPath)) {
    console.error(`File not found: ${absInputPath}`)
    process.exit(1)
  }

  // If .qmd, render to HTML first
  let absHtmlPath = absInputPath
  let renderTmpFiles = null
  let quartoTitle = null
  if (absInputPath.endsWith('.qmd')) {
    const result = await renderQmd(absInputPath)
    absHtmlPath = result.htmlPath
    quartoTitle = result.title
    renderTmpFiles = result.tmpFiles
  }

  const docTitle = title || quartoTitle || docName
  const outDir = path.join(PROJECT_ROOT, 'public', 'docs', docName)
  fs.mkdirSync(outDir, { recursive: true })

  console.log(`Building "${docTitle}" from ${absHtmlPath}`)

  // --- Step 1: Parse HTML and split at <h2> boundaries ---
  const rawHtml = fs.readFileSync(absHtmlPath, 'utf8')
  const dom = new JSDOM(rawHtml)
  const doc = dom.window.document

  // Extract <head> content for shared styles/scripts
  const headHtml = doc.head.innerHTML

  // Find the main content area (Quarto-specific, with fallbacks)
  const contentEl = doc.querySelector('#quarto-document-content')
    || doc.querySelector('main')
    || doc.querySelector('.content')
    || doc.body

  // Expand collapsed callouts — content should be fully visible for annotation
  for (const el of doc.querySelectorAll('.callout-collapse.collapse')) {
    el.classList.remove('collapse')
    el.classList.add('show')
  }

  // Split at section boundaries.
  // Strategy: find the best split points in the DOM tree.
  // 1. Quarto sections: <section class="level1"> or <section class="level2">
  // 2. Direct heading children: <h1> or <h2>
  // 3. If only one big section, split its children at headings
  const chunks = []

  function splitChildrenAtHeadings(parent) {
    const result = []
    let current = []
    for (const child of parent.children) {
      const isHeading = child.tagName.match(/^H[12]$/)
      const isSection = child.tagName === 'SECTION' && (child.classList.contains('level1') || child.classList.contains('level2'))
      if ((isHeading || isSection) && current.length > 0) {
        result.push(current)
        current = []
      }
      current.push(child.outerHTML)
    }
    if (current.length > 0) result.push(current)
    return result
  }

  // Try Quarto section wrappers first
  const level2Sections = contentEl.querySelectorAll(':scope > section.level2')
  const level1Sections = contentEl.querySelectorAll(':scope > section.level1')

  if (level2Sections.length > 1) {
    // Multiple level2 sections — split at those
    let preamble = []
    for (const child of contentEl.children) {
      if (child.tagName === 'SECTION' && child.classList.contains('level2')) break
      preamble.push(child.outerHTML)
    }
    if (preamble.length > 0) chunks.push(preamble)
    for (const s of level2Sections) chunks.push([s.outerHTML])
  } else if (level1Sections.length > 1) {
    // Multiple level1 sections — split each into its level2 children
    let preamble = []
    for (const child of contentEl.children) {
      if (child.tagName === 'SECTION' && child.classList.contains('level1')) break
      preamble.push(child.outerHTML)
    }
    if (preamble.length > 0) chunks.push(preamble)
    for (const s of level1Sections) {
      const subSections = s.querySelectorAll(':scope > section.level2')
      if (subSections.length > 1) {
        // Split this level1 into its level2 children
        let sectionPreamble = []
        for (const child of s.children) {
          if (child.tagName === 'SECTION' && child.classList.contains('level2')) break
          sectionPreamble.push(child.outerHTML)
        }
        if (sectionPreamble.length > 0) chunks.push(sectionPreamble)
        for (const sub of subSections) chunks.push([sub.outerHTML])
      } else {
        // No level2 sub-sections — keep as one chunk
        chunks.push([s.outerHTML])
      }
    }
  } else if (level1Sections.length === 1) {
    // Single level1 section — look inside it for sub-sections or headings
    const section = level1Sections[0]
    const subSections = section.querySelectorAll(':scope > section.level2')
    if (subSections.length > 1) {
      // Split at level2 sub-sections
      let preamble = []
      for (const child of section.children) {
        if (child.tagName === 'SECTION' && child.classList.contains('level2')) break
        preamble.push(child.outerHTML)
      }
      // Include preamble (title/header) from outside the section
      let outerPreamble = []
      for (const child of contentEl.children) {
        if (child === section) break
        outerPreamble.push(child.outerHTML)
      }
      if (outerPreamble.length > 0 || preamble.length > 0) {
        chunks.push([...outerPreamble, ...preamble])
      }
      for (const s of subSections) chunks.push([s.outerHTML])
    } else {
      // No sub-sections — split the section's children at headings
      const outerPreamble = []
      for (const child of contentEl.children) {
        if (child === section) break
        outerPreamble.push(child.outerHTML)
      }
      const inner = splitChildrenAtHeadings(section)
      if (outerPreamble.length > 0 && inner.length > 0) {
        inner[0] = [...outerPreamble, ...inner[0]]
      }
      chunks.push(...inner)
    }
  } else {
    // No section wrappers — split at heading tags directly
    chunks.push(...splitChildrenAtHeadings(contentEl))
  }

  // Append any trailing content (e.g. quarto-appendix)
  // that wasn't captured by section splitting

  console.log(`Split into ${chunks.length} section chunks`)

  // --- Step 1b: Post-process chunks to split tabsets into side-by-side pages ---
  // Each entry: { html: string[], group?, groupIndex?, tabLabel? }
  let processedChunks = []
  let tabsetCounter = 0

  for (const chunk of chunks) {
    const chunkHtml = chunk.join('\n')
    // Quick check before parsing
    if (!chunkHtml.includes('panel-tabset')) {
      processedChunks.push({ html: chunk })
      continue
    }

    // Parse chunk and split at tabset boundaries
    const chunkDom = new JSDOM(`<body>${chunkHtml}</body>`)
    const body = chunkDom.window.document.body
    let beforeBuffer = []
    let foundTabset = false

    for (const child of [...body.children]) {
      const tabset = child.classList?.contains('panel-tabset')
        ? child
        : child.querySelector?.('.panel-tabset')

      if (!tabset) {
        beforeBuffer.push(child.outerHTML)
        continue
      }

      foundTabset = true
      // Flush content before the tabset
      // If the tabset is nested inside a wrapper (e.g. section), split the wrapper
      if (child.classList?.contains('panel-tabset')) {
        // Direct child is the tabset
        if (beforeBuffer.length > 0) {
          processedChunks.push({ html: [...beforeBuffer] })
          beforeBuffer = []
        }
      } else {
        // Tabset is inside a wrapper — extract content before/after it within the wrapper
        // Collect siblings before the tabset
        const wrapperBefore = []
        const wrapperAfter = []
        let seenTabset = false
        for (const sibling of [...child.children]) {
          if (sibling === tabset || sibling.querySelector?.('.panel-tabset') === tabset) {
            seenTabset = true
            continue
          }
          if (!seenTabset) wrapperBefore.push(sibling.outerHTML)
          else wrapperAfter.push(sibling.outerHTML)
        }
        if (beforeBuffer.length > 0 || wrapperBefore.length > 0) {
          processedChunks.push({ html: [...beforeBuffer, ...wrapperBefore] })
          beforeBuffer = []
        }
        // After processing the tabset below, push wrapperAfter into beforeBuffer
        // so it gets flushed with the next non-tabset content
        if (wrapperAfter.length > 0) {
          beforeBuffer = [...wrapperAfter]
        }
      }

      // Extract tab labels and panes
      const navLinks = tabset.querySelectorAll(':scope > ul .nav-link, :scope > nav .nav-link')
      const tabPanes = tabset.querySelectorAll(':scope > .tab-content > .tab-pane')
      const groupId = `tabset-${tabsetCounter++}`

      const labels = [...navLinks].map(a => a.textContent.trim())

      for (let t = 0; t < tabPanes.length; t++) {
        const label = labels[t] || `Tab ${t + 1}`
        const paneHtml = tabPanes[t].innerHTML
        const labelHeader = `<div style="background:#f0f0f0;padding:8px 16px;margin:-48px -56px 16px -56px;font-size:14px;font-weight:600;color:#555;border-bottom:2px solid #ddd">${label}</div>`
        processedChunks.push({
          html: [labelHeader, paneHtml],
          group: groupId,
          groupIndex: t,
          tabLabel: label,
        })
      }

      console.log(`  Tabset "${groupId}": ${tabPanes.length} tabs [${labels.join(', ')}]`)
    }

    // Flush any remaining content after the last tabset
    if (beforeBuffer.length > 0) {
      processedChunks.push({ html: [...beforeBuffer] })
    }

    if (!foundTabset) {
      // Shouldn't happen, but fallback
      processedChunks.push({ html: chunk })
    }
  }

  console.log(`After tabset splitting: ${processedChunks.length} pages`)

  // --- Step 1c: Post-process to split image-toggle scrollytelling ---
  // .image-toggle elements are a custom Quarto filter for stepped image reveals.
  // Each step (image + companion text) becomes a grouped page, laid out side-by-side.
  function emitToggleSteps(chunks, toggleData) {
    const { labels, stepDivs, figcaption, groupId, stepTexts } = toggleData
    const numSteps = Math.max(stepDivs.length, labels.length, stepTexts.length)

    for (let s = 0; s < numSteps; s++) {
      const label = labels[s] || `Step ${s + 1}`
      const visual = stepDivs[s] ? stepDivs[s].innerHTML : ''
      const companion = stepTexts[s] || ''
      const labelHeader = `<div style="background:#f0f0f0;padding:8px 16px;margin:-48px -56px 16px -56px;font-size:14px;font-weight:600;color:#555;border-bottom:2px solid #ddd">${label}</div>`

      chunks.push({
        html: [labelHeader, visual, figcaption, companion],
        group: groupId,
        groupIndex: s,
        tabLabel: label,
      })
    }

    console.log(`  Toggle "${groupId}": ${numSteps} steps [${labels.join(', ')}]`)
  }

  {
    let toggleCounter = 0
    const finalChunks = []

    for (const chunk of processedChunks) {
      // Skip already-grouped chunks (from tabset splitting)
      if (chunk.group) {
        finalChunks.push(chunk)
        continue
      }

      const chunkHtml = chunk.html.join('\n')
      if (!chunkHtml.includes('image-toggle')) {
        finalChunks.push(chunk)
        continue
      }

      // Parse and find image-toggles
      const chunkDom = new JSDOM(`<body>${chunkHtml}</body>`)
      const body = chunkDom.window.document.body

      // Determine content parent: body, or single section wrapper
      let contentParent = body
      if (body.children.length === 1 && body.children[0].tagName === 'SECTION') {
        contentParent = body.children[0]
      }

      // Find direct-child image-toggles
      const toggleEls = contentParent.querySelectorAll(':scope > .image-toggle')
      if (toggleEls.length === 0) {
        // Toggle might be nested deeper — fall back to non-split
        finalChunks.push(chunk)
        continue
      }

      const toggleSet = new Set(toggleEls)
      const toggleDataMap = new Map()
      for (const toggle of toggleEls) {
        const stepSel = toggle.getAttribute('data-steps')
        const labels = (toggle.getAttribute('data-labels') || '').split(',').map(s => s.trim())
        const ariaDiv = toggle.querySelector('figure > div[aria-describedby]')
        const stepDivs = ariaDiv ? [...ariaDiv.children] : []
        const figcaption = toggle.querySelector('figcaption')

        toggleDataMap.set(toggle, {
          labels,
          stepDivs,
          figcaption: figcaption ? figcaption.outerHTML : '',
          stepSelector: stepSel,
          groupId: `toggle-${toggleCounter++}`,
          stepTexts: [],
        })
      }

      // Walk content parent's children
      let beforeBuffer = []
      let currentToggle = null

      for (const child of [...contentParent.children]) {
        if (toggleSet.has(child)) {
          // Flush previous toggle if any
          if (currentToggle) {
            emitToggleSteps(finalChunks, currentToggle)
            currentToggle = null
          }
          // Flush before-buffer
          if (beforeBuffer.length > 0) {
            finalChunks.push({ html: [...beforeBuffer] })
            beforeBuffer = []
          }
          currentToggle = toggleDataMap.get(child)
        } else if (currentToggle?.stepSelector && child.matches?.(currentToggle.stepSelector)) {
          // Companion text for current toggle
          currentToggle.stepTexts.push(child.outerHTML)
        } else {
          // Regular content — flush toggle if active
          if (currentToggle) {
            emitToggleSteps(finalChunks, currentToggle)
            currentToggle = null
          }
          beforeBuffer.push(child.outerHTML)
        }
      }

      // Flush remaining
      if (currentToggle) {
        emitToggleSteps(finalChunks, currentToggle)
      }
      if (beforeBuffer.length > 0) {
        finalChunks.push({ html: [...beforeBuffer] })
      }
    }

    processedChunks = finalChunks
    console.log(`After image-toggle splitting: ${processedChunks.length} pages`)
  }

  // CSS overrides to strip Quarto chrome and set page width
  const pageCSS = `
    * { box-sizing: border-box; }
    body {
      margin: 0; padding: 48px 56px;
      width: ${PAGE_WIDTH}px;
      background: white;
      overflow: hidden;
    }
    /* Hide Quarto navigation chrome */
    #quarto-sidebar, .sidebar, nav, footer, .nav-footer,
    #quarto-margin-sidebar, .quarto-search, #quarto-header,
    .toc-actions, nav[role="doc-toc"],
    header.quarto-title-block .quarto-title-breadcrumbs { display: none !important; }
    #quarto-content { margin-left: 0 !important; padding-left: 0 !important; }
    .page-columns .content { grid-column: 1 / -1 !important; }
  `

  // Use <base> tag so relative paths (CSS, JS, images) resolve from the original HTML's directory
  const sourceDir = path.dirname(absHtmlPath)
  // For Quarto books, the base is the _book root (one level up from lectures/)
  // Detect by checking for a _book parent
  const bookRoot = sourceDir.includes('_book')
    ? sourceDir.slice(0, sourceDir.indexOf('_book') + '_book'.length)
    : sourceDir

  // --- Step 2: Write each chunk as a self-contained HTML file ---
  // Also write chunks to source dir for accurate Puppeteer measurement (relative paths work)
  const pageFiles = []
  const tmpDir = path.join(sourceDir, '.tldraw-build-tmp')
  fs.mkdirSync(tmpDir, { recursive: true })

  for (let i = 0; i < processedChunks.length; i++) {
    const pageNum = String(i + 1).padStart(2, '0')
    const filename = `page-${pageNum}.html`
    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
${headHtml}
<style>${pageCSS}</style>
</head>
<body>
${processedChunks[i].html.join('\n')}
</body>
</html>`
    // Write to source dir for measurement (relative paths work)
    fs.writeFileSync(path.join(tmpDir, filename), html)
    // Write to output dir for serving
    fs.writeFileSync(path.join(outDir, filename), html)
    pageFiles.push(filename)
  }

  console.log(`Wrote ${pageFiles.length} HTML page files`)

  // --- Step 3: Measure rendered height of each page ---
  // Serve from the source directory so relative CSS/JS/image paths resolve
  const http = await import('http')
  const serveRoot = bookRoot
  const mimeTypes = {
    '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript',
    '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.woff': 'font/woff', '.woff2': 'font/woff2',
    '.ttf': 'font/ttf', '.eot': 'application/vnd.ms-fontobject',
  }
  const server = http.default.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0])
    const filePath = path.join(serveRoot, url)
    if (!fs.existsSync(filePath)) { res.writeHead(404); res.end(); return }
    const ext = path.extname(filePath)
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' })
    fs.createReadStream(filePath).pipe(res)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const serverPort = server.address().port
  // Relative path from book root to the tmp dir
  const relTmpDir = path.relative(serveRoot, tmpDir)

  console.log(`Measuring page heights with Puppeteer (serving from ${serveRoot} on :${serverPort})...`)

  const chromePath = process.env.CHROME_PATH || findChrome()
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: chromePath,
  })

  const page = await browser.newPage()
  await page.setViewport({ width: PAGE_WIDTH, height: 800 })

  const pageHeights = []
  for (let i = 0; i < pageFiles.length; i++) {
    const pageUrl = `http://127.0.0.1:${serverPort}/${relTmpDir}/${pageFiles[i]}`
    await page.goto(pageUrl, { waitUntil: 'networkidle2', timeout: 30000 })

    // Wait for MathJax if present
    try {
      await page.waitForFunction(
        () => !window.MathJax?.startup?.promise || window.MathJax.startup.promise.then(() => true),
        { timeout: 10000 }
      )
      await page.evaluate(async () => {
        if (window.MathJax?.typesetPromise) await window.MathJax.typesetPromise()
      })
    } catch { /* no MathJax, fine */ }

    await new Promise(r => setTimeout(r, 500))

    const rawHeight = await page.evaluate(() => document.body.scrollHeight)
    const height = Math.max(rawHeight, MIN_PAGE_HEIGHT)
    pageHeights.push(height)
    console.log(`  Page ${i + 1}: ${rawHeight}px${rawHeight < MIN_PAGE_HEIGHT ? ` → ${height}px (min)` : ''}`)
  }

  await browser.close()
  server.close()

  // Clean up measurement temp files (but NOT render temp — need it for resource copy)
  for (const f of pageFiles) {
    try { fs.unlinkSync(path.join(tmpDir, f)) } catch {}
  }
  try { fs.rmdirSync(tmpDir) } catch {}

  // --- Step 3b: Copy referenced local resources (site_libs, _files, etc.) ---
  // Scan head for relative paths and copy their directories
  const referencedDirs = new Set()
  const pathRe = /(?:src|href)="([^"]+)"/g
  let match
  while ((match = pathRe.exec(headHtml)) !== null) {
    const ref = match[1]
    if (ref.startsWith('http') || ref.startsWith('//') || ref.startsWith('#')) continue
    const topDir = ref.split('/')[0]
    if (topDir && !topDir.includes('.')) referencedDirs.add(topDir)
  }

  // Also check for figure/image directories referenced in the body
  for (const chunk of processedChunks) {
    const bodyHtml = chunk.html.join('')
    let bodyMatch
    const bodyRe = /(?:src|href)="([^"]+)"/g
    while ((bodyMatch = bodyRe.exec(bodyHtml)) !== null) {
      const ref = bodyMatch[1]
      if (ref.startsWith('http') || ref.startsWith('//') || ref.startsWith('#')) continue
      const topDir = ref.split('/')[0]
      if (topDir && !topDir.includes('.')) referencedDirs.add(topDir)
    }
  }

  for (const dir of referencedDirs) {
    const srcDir = path.join(sourceDir, dir)
    const destDir = path.join(outDir, dir)
    if (fs.existsSync(srcDir) && fs.statSync(srcDir).isDirectory()) {
      console.log(`Copying resource directory: ${dir}/`)
      // Remove existing destination to avoid symlink/copy conflicts
      if (fs.existsSync(destDir)) {
        fs.rmSync(destDir, { recursive: true })
      }
      fs.cpSync(srcDir, destDir, { recursive: true })
    }
  }

  // Clean up render temp files now that resources are copied
  if (renderTmpFiles) {
    for (const f of renderTmpFiles) {
      try { fs.rmSync(f, { recursive: true }) } catch {}
    }
  }

  // --- Step 4: Write page-info.json (dimensions per page) ---
  const pageInfo = pageFiles.map((file, i) => {
    const entry = {
      file,
      width: PAGE_WIDTH,
      height: pageHeights[i],
    }
    const chunk = processedChunks[i]
    if (chunk.group) {
      entry.group = chunk.group
      entry.groupIndex = chunk.groupIndex
      entry.tabLabel = chunk.tabLabel
    }
    return entry
  })

  fs.writeFileSync(
    path.join(outDir, 'page-info.json'),
    JSON.stringify(pageInfo, null, 2)
  )

  // --- Step 4b: Generate TOC from headings ---
  const tocEntries = []
  for (let i = 0; i < processedChunks.length; i++) {
    const chunkHtml = processedChunks[i].html.join('\n')
    const chunkDom = new JSDOM(`<body>${chunkHtml}</body>`)
    const body = chunkDom.window.document.body
    for (const h of body.querySelectorAll('h1, h2, h3, h4')) {
      const tag = h.tagName.toLowerCase()
      const level = tag === 'h1' ? 'section'
        : tag === 'h2' ? 'subsection'
        : 'subsubsection'
      const title = h.textContent.trim()
      if (title) {
        tocEntries.push({ title, level, page: i + 1 })
      }
    }
  }
  if (tocEntries.length > 0) {
    fs.writeFileSync(
      path.join(outDir, 'toc.json'),
      JSON.stringify(tocEntries, null, 2)
    )
    console.log(`Generated TOC with ${tocEntries.length} entries`)
  }

  // --- Step 4c: Generate search index ---
  const searchIndex = []
  for (let i = 0; i < processedChunks.length; i++) {
    const chunkHtml = processedChunks[i].html.join('\n')
    const chunkDom = new JSDOM(`<body>${chunkHtml}</body>`)
    const body = chunkDom.window.document.body
    const text = body.textContent.replace(/\s+/g, ' ').trim()
    if (text) {
      const entry = { page: i + 1, text }
      if (processedChunks[i].tabLabel) {
        entry.label = processedChunks[i].tabLabel
      }
      searchIndex.push(entry)
    }
  }
  fs.writeFileSync(
    path.join(outDir, 'search-index.json'),
    JSON.stringify(searchIndex)
  )
  console.log(`Generated search index for ${searchIndex.length} pages`)

  // --- Step 4d: Generate source lookup for .qmd inputs ---
  // Maps .qmd source lines → pages + approximate y positions.
  // Matching strategy: find section headings in source, match to rendered page headings,
  // then assign all lines between headings to the corresponding page with interpolated y.
  if (absInputPath.endsWith('.qmd')) {
    const qmdContent = fs.readFileSync(absInputPath, 'utf8')
    const qmdLines = qmdContent.split('\n')

    // Parse source headings (skip YAML front matter and code chunks)
    const sourceHeadings = []
    let inYaml = false, inCode = false
    for (let i = 0; i < qmdLines.length; i++) {
      const line = qmdLines[i]
      if (i === 0 && line.trim() === '---') { inYaml = true; continue }
      if (inYaml && line.trim() === '---') { inYaml = false; continue }
      if (inYaml) continue
      if (line.startsWith('```')) { inCode = !inCode; continue }
      if (inCode) continue
      const m = line.match(/^(#{1,6})\s+(.+)/)
      if (m) {
        sourceHeadings.push({ line: i + 1, level: m[1].length, text: m[2].trim() })
      }
    }

    // Extract first heading from each rendered page
    const pageHeadingList = []
    for (let i = 0; i < processedChunks.length; i++) {
      const chunkDom = new JSDOM(`<body>${processedChunks[i].html.join('\n')}</body>`)
      const heading = chunkDom.window.document.body.querySelector('h1, h2, h3, h4')
      if (heading) {
        pageHeadingList.push({ page: i + 1, text: heading.textContent.trim() })
      }
    }

    // Match source headings to page headings by normalized text
    function normalizeForMatch(s) {
      return s.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim()
    }
    const lineToPage = []
    const usedPages = new Set()
    for (const sh of sourceHeadings) {
      const shNorm = normalizeForMatch(sh.text)
      let bestMatch = null, bestScore = 0
      for (const ph of pageHeadingList) {
        if (usedPages.has(ph.page)) continue
        const phNorm = normalizeForMatch(ph.text)
        if (shNorm === phNorm) { bestMatch = ph; break }
        if (shNorm.includes(phNorm) || phNorm.includes(shNorm)) {
          const score = Math.min(shNorm.length, phNorm.length)
          if (score > bestScore) { bestMatch = ph; bestScore = score }
        }
      }
      if (bestMatch) {
        lineToPage.push({ sourceLine: sh.line, page: bestMatch.page })
        usedPages.add(bestMatch.page)
      }
    }
    lineToPage.sort((a, b) => a.sourceLine - b.sourceLine)

    // Also try text-fingerprint matching for pages without heading matches.
    // For each unmatched page, extract a distinctive phrase and search the source.
    for (let p = 0; p < processedChunks.length; p++) {
      const pageNum = p + 1
      if (usedPages.has(pageNum)) continue
      const chunk = processedChunks[p]
      if (chunk.group) continue // skip tab/toggle fragments

      const chunkDom = new JSDOM(`<body>${chunk.html.join('\n')}</body>`)
      const text = chunkDom.window.document.body.textContent.replace(/\s+/g, ' ').trim()
      // Extract first 5+ word phrase for fingerprinting
      const words = text.split(/\s+/).slice(0, 8)
      if (words.length < 3) continue
      const phrase = words.join(' ').toLowerCase()

      for (let i = 0; i < qmdLines.length; i++) {
        if (qmdLines[i].toLowerCase().includes(phrase.slice(0, 40))) {
          lineToPage.push({ sourceLine: i + 1, page: pageNum })
          usedPages.add(pageNum)
          break
        }
      }
    }
    lineToPage.sort((a, b) => a.sourceLine - b.sourceLine)

    // Build lookup entries: assign each source line to a page
    const lookupLines = {}
    for (let line = 1; line <= qmdLines.length; line++) {
      // Find section this line belongs to
      let page = lineToPage.length > 0 ? lineToPage[0].page : 1
      for (let h = lineToPage.length - 1; h >= 0; h--) {
        if (line >= lineToPage[h].sourceLine) {
          page = lineToPage[h].page
          break
        }
      }

      // Find the source line range for this page's section
      let rangeStart = 1, rangeEnd = qmdLines.length
      for (let h = 0; h < lineToPage.length; h++) {
        if (line >= lineToPage[h].sourceLine) {
          rangeStart = lineToPage[h].sourceLine
          rangeEnd = h + 1 < lineToPage.length ? lineToPage[h + 1].sourceLine - 1 : qmdLines.length
        }
      }

      // Interpolate y position within the page (48px padding top/bottom)
      const pageHeight = pageHeights[page - 1] || 400
      const lineCount = rangeEnd - rangeStart + 1
      const fraction = lineCount > 1 ? (line - rangeStart) / (lineCount - 1) : 0
      const y = 48 + fraction * Math.max(0, pageHeight - 96)

      lookupLines[line.toString()] = {
        page,
        x: 56, // left padding
        y: Math.round(y),
        content: qmdLines[line - 1],
      }
    }

    fs.writeFileSync(
      path.join(outDir, 'lookup.json'),
      JSON.stringify({
        meta: {
          texFile: path.basename(absInputPath),
          generated: new Date().toISOString(),
          totalLines: qmdLines.length,
          format: 'html',
        },
        lines: lookupLines,
      })
    )
    console.log(`Generated source lookup: ${qmdLines.length} lines, ${lineToPage.length} section anchors`)
  }

  // --- Step 5: Update manifest ---
  const { updateDoc } = await import('./manifest.mjs')
  updateDoc(docName, { name: docTitle, pages: pageFiles.length, format: 'html' })

  console.log('')
  console.log(`Done! ${pageFiles.length} pages written to ${outDir}`)
  console.log(`Access at: ?doc=${docName}`)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
