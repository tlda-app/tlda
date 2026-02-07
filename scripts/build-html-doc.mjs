#!/usr/bin/env node
/**
 * Build an annotatable TLDraw document from a Quarto HTML page.
 *
 * Opens the pre-rendered HTML in Puppeteer, paginates into PNG screenshots,
 * extracts text positions from the DOM, and writes everything to public/docs/.
 *
 * Usage:
 *   node scripts/build-html-doc.mjs <html-path> <doc-name> [title]
 *
 * Example:
 *   node scripts/build-html-doc.mjs \
 *     /path/to/_book/lectures/Lecture2-prose.html \
 *     lecture2-prose \
 *     "Point and Interval Estimates"
 */

import puppeteer from 'puppeteer'
import http from 'http'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(__dirname, '..')

const VIEWPORT_WIDTH = 900
const DEVICE_SCALE = 2
const PAGE_HEIGHT_CSS = 1200  // CSS pixels per page chunk

async function main() {
  const [htmlPath, docName, title] = process.argv.slice(2)

  if (!htmlPath || !docName) {
    console.error('Usage: node scripts/build-html-doc.mjs <html-path> <doc-name> [title]')
    process.exit(1)
  }

  const absHtmlPath = path.resolve(htmlPath)
  if (!fs.existsSync(absHtmlPath)) {
    console.error(`File not found: ${absHtmlPath}`)
    process.exit(1)
  }

  const docTitle = title || docName
  const outDir = path.join(PROJECT_ROOT, 'public', 'docs', docName)
  fs.mkdirSync(outDir, { recursive: true })

  console.log(`Building "${docTitle}" from ${absHtmlPath}`)
  console.log(`Output: ${outDir}`)

  // Serve the _book directory over HTTP so relative paths and ES modules work
  const serveRoot = path.resolve(path.dirname(absHtmlPath), '..')
  const relPath = '/' + path.relative(serveRoot, absHtmlPath)

  const server = http.createServer((req, res) => {
    const mimeTypes = {
      '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript',
      '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
      '.png': 'image/png', '.jpg': 'image/jpeg', '.woff': 'font/woff', '.woff2': 'font/woff2',
      '.ttf': 'font/ttf', '.eot': 'application/vnd.ms-fontobject',
    }
    const url = decodeURIComponent(req.url.split('?')[0])
    const filePath = path.join(serveRoot, url)
    if (!fs.existsSync(filePath)) { res.writeHead(404); res.end(); return }
    const ext = path.extname(filePath)
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' })
    fs.createReadStream(filePath).pipe(res)
  })

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const serverPort = server.address().port
  const pageUrl = `http://127.0.0.1:${serverPort}${relPath}`

  const browser = await puppeteer.launch({
    headless: true,
    args: [`--window-size=${VIEWPORT_WIDTH},800`],
  })

  const page = await browser.newPage()
  await page.setViewport({
    width: VIEWPORT_WIDTH,
    height: 800,
    deviceScaleFactor: DEVICE_SCALE,
  })

  console.log(`Loading ${pageUrl}`)
  await page.goto(pageUrl, { waitUntil: 'networkidle2', timeout: 60000 })

  // Wait for MathJax to load and finish rendering
  console.log('Waiting for MathJax...')
  try {
    await page.waitForFunction(
      () => window.MathJax?.startup?.promise != null,
      { timeout: 30000 }
    )
    await page.evaluate(async () => {
      await window.MathJax.startup.promise
      if (window.MathJax.typesetPromise) {
        await window.MathJax.typesetPromise()
      }
    })
  } catch {
    console.log('MathJax not detected or timed out, continuing without it')
  }

  // Let any final rendering settle
  await new Promise(r => setTimeout(r, 2000))

  // Inject CSS to isolate the content area
  await page.addStyleTag({
    content: `
      /* Hide sidebar, nav, header, footer — keep only main content */
      #quarto-sidebar, .sidebar, nav.quarto-secondary-nav,
      nav.quarto-page-breadcrumbs, .quarto-page-breadcrumbs,
      header.quarto-title-block .quarto-title-breadcrumbs,
      footer, .nav-footer, #quarto-margin-sidebar,
      .quarto-search, #quarto-header,
      nav[role="doc-toc"], .toc-actions {
        display: none !important;
      }
      /* Remove sidebar grid layout offsets */
      #quarto-content {
        margin-left: 0 !important;
        padding-left: 0 !important;
      }
      .page-columns .content {
        grid-column: 1 / -1 !important;
      }
      body {
        margin: 0 !important;
        padding: 0 !important;
        overflow: visible !important;
      }
      #quarto-document-content, .content {
        max-width: ${VIEWPORT_WIDTH - 80}px !important;
        margin: 0 auto !important;
        padding: 40px 40px !important;
      }
    `
  })

  // Wait for style to apply
  await new Promise(r => setTimeout(r, 500))

  // Measure content height
  const contentHeight = await page.evaluate(() => {
    const el = document.querySelector('#quarto-document-content') || document.querySelector('.content') || document.body
    return el.scrollHeight
  })

  console.log(`Content height: ${contentHeight}px`)

  // Calculate number of pages
  const numPages = Math.ceil(contentHeight / PAGE_HEIGHT_CSS)
  console.log(`Paginating into ${numPages} pages (${PAGE_HEIGHT_CSS}px each)`)

  // Set viewport to full page width for consistent screenshots
  await page.setViewport({
    width: VIEWPORT_WIDTH,
    height: PAGE_HEIGHT_CSS,
    deviceScaleFactor: DEVICE_SCALE,
  })

  // Extract text and take screenshots for each page
  const allTextData = []

  for (let i = 0; i < numPages; i++) {
    const yOffset = i * PAGE_HEIGHT_CSS
    const pageNum = String(i + 1).padStart(2, '0')
    const pngPath = path.join(outDir, `page-${pageNum}.png`)

    console.log(`  Page ${i + 1}/${numPages} (y=${yOffset})`)

    // Screenshot this page region
    await page.screenshot({
      path: pngPath,
      clip: {
        x: 0,
        y: yOffset,
        width: VIEWPORT_WIDTH,
        height: Math.min(PAGE_HEIGHT_CSS, contentHeight - yOffset),
      },
    })

    // Extract text positions from this page region
    const pageText = await page.evaluate((opts) => {
      const { yOffset, pageHeight, viewportWidth } = opts
      const yEnd = yOffset + pageHeight
      const lines = []

      // Walk all text nodes in the content area
      const root = document.querySelector('#quarto-document-content') || document.querySelector('.content') || document.body
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null)

      // Group fragments by approximate y position
      const fragmentsByY = new Map()

      let node
      while ((node = walker.nextNode())) {
        const text = node.textContent?.trim()
        if (!text) continue

        const range = document.createRange()
        range.selectNodeContents(node)
        const rects = range.getClientRects()

        for (const rect of rects) {
          // Use absolute page coordinates (account for scroll = 0, position is absolute)
          const absY = rect.top + window.scrollY
          const centerY = absY + rect.height / 2

          // Only include if center is within this page
          if (centerY < yOffset || centerY >= yEnd) continue

          // Check if this is inside a MathJax container
          let el = node.parentElement
          let isMath = false
          while (el && el !== root) {
            if (el.tagName === 'MJX-CONTAINER' || el.classList?.contains('MathJax')) {
              isMath = true
              break
            }
            el = el.parentElement
          }

          // For MathJax, use the container's textContent instead
          if (isMath) continue  // We'll handle MathJax containers separately

          const relY = absY - yOffset
          const yKey = Math.round(relY)

          if (!fragmentsByY.has(yKey)) {
            fragmentsByY.set(yKey, [])
          }
          fragmentsByY.get(yKey).push({
            text: node.textContent || '',
            x: rect.left,
            y: relY,
            width: rect.width,
            height: rect.height,
          })
        }
      }

      // Handle MathJax containers as single text blocks
      const mathContainers = root.querySelectorAll('mjx-container')
      for (const mjx of mathContainers) {
        const rect = mjx.getBoundingClientRect()
        const absY = rect.top + window.scrollY
        const centerY = absY + rect.height / 2

        if (centerY < yOffset || centerY >= yEnd) continue

        const text = mjx.textContent?.trim()
        if (!text) continue

        const relY = absY - yOffset
        const yKey = Math.round(relY)

        if (!fragmentsByY.has(yKey)) {
          fragmentsByY.set(yKey, [])
        }
        fragmentsByY.get(yKey).push({
          text,
          x: rect.left,
          y: relY,
          width: rect.width,
          height: rect.height,
        })
      }

      // Merge fragments into lines (group by y proximity)
      const sortedYKeys = [...fragmentsByY.keys()].sort((a, b) => a - b)
      const mergedLines = []
      let currentGroup = null

      for (const yKey of sortedYKeys) {
        const frags = fragmentsByY.get(yKey)
        if (!currentGroup || Math.abs(yKey - currentGroup.y) > 3) {
          if (currentGroup) mergedLines.push(currentGroup)
          currentGroup = { y: yKey, fragments: [...frags] }
        } else {
          currentGroup.fragments.push(...frags)
        }
      }
      if (currentGroup) mergedLines.push(currentGroup)

      // Convert to line format
      for (const group of mergedLines) {
        group.fragments.sort((a, b) => a.x - b.x)
        const text = group.fragments.map(f => f.text).join(' ')
          .replace(/\s+/g, ' ').trim()
        if (!text) continue

        const firstFrag = group.fragments[0]
        const lastFrag = group.fragments[group.fragments.length - 1]
        const fontSize = firstFrag.height * 0.8  // approximate
        const lineWidth = (lastFrag.x + lastFrag.width) - firstFrag.x

        lines.push({
          text,
          x: firstFrag.x,
          y: firstFrag.y,
          fontSize,
          fontFamily: 'sans-serif',
          width: lineWidth,
        })
      }

      return {
        lines,
        viewBox: {
          minX: 0,
          minY: 0,
          width: viewportWidth,
          height: Math.min(pageHeight, document.querySelector('#quarto-document-content')?.scrollHeight - yOffset || pageHeight),
        },
      }
    }, { yOffset, pageHeight: PAGE_HEIGHT_CSS, viewportWidth: VIEWPORT_WIDTH })

    allTextData.push(pageText)
  }

  // Write text data
  const textDataPath = path.join(outDir, 'text-data.json')
  fs.writeFileSync(textDataPath, JSON.stringify(allTextData, null, 2))
  console.log(`Wrote text data: ${textDataPath}`)

  // Update manifest
  const manifestPath = path.join(PROJECT_ROOT, 'public', 'docs', 'manifest.json')
  let manifest = { documents: {} }
  if (fs.existsSync(manifestPath)) {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  }
  manifest.documents[docName] = {
    name: docTitle,
    pages: numPages,
    basePath: `/docs/${docName}/`,
    format: 'png',
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  console.log('Manifest updated')

  await browser.close()
  server.close()

  console.log('')
  console.log(`Done! ${numPages} pages written to ${outDir}`)
  console.log(`Access at: ?doc=${docName}`)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
