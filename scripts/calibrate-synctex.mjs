#!/usr/bin/env node
/**
 * Calibrate synctex coordinate mapping using Puppeteer
 *
 * Finds known text in the SVG, gets its canvas position,
 * compares to synctex coordinates, and calculates the transform.
 */

import puppeteer from 'puppeteer'
import { execSync } from 'child_process'

const DOC_URL = 'http://localhost:5178/claude-tldraw/?doc=bregman'
const SYNCTEX_SERVER = 'http://localhost:5177'
const DOC_NAME = 'Bregman Lower Bound'
const TEX_FILE = 'bregman-lower-bound.tex'

// Test points: distinctive text and their approximate source lines
const TEST_POINTS = [
  { text: 'Formal Results', line: 453 },
  { text: 'Sobolev models', line: 485 },
  { text: 'Rate of Convergence', line: 457 },
]

async function getSynctexPosition(line) {
  const url = `${SYNCTEX_SERVER}/view?doc=${encodeURIComponent(DOC_NAME)}&file=${TEX_FILE}&line=${line}`
  const resp = await fetch(url)
  const data = await resp.json()
  if (data.error) {
    console.error(`Synctex error for line ${line}:`, data.error)
    return null
  }
  return { page: data.page, x: data.x, y: data.y }
}

async function findTextInCanvas(page, searchText) {
  // Find text elements in the SVG containing the search text
  const result = await page.evaluate((text) => {
    const editor = window.__tldraw_editor__
    if (!editor) return { error: 'No editor found' }

    // Get all SVG elements (including nested ones from page images)
    const allSvgs = document.querySelectorAll('svg')
    let found = []

    for (const svg of allSvgs) {
      // Search text elements, tspans, and also check innerHTML
      const textElements = svg.querySelectorAll('text, tspan')
      for (const el of textElements) {
        const content = el.textContent || ''
        if (content.includes(text)) {
          found.push({ el, content, type: 'textElement' })
        }
      }

      // Also try searching by innerHTML for embedded text
      const allElements = svg.querySelectorAll('*')
      for (const el of allElements) {
        if (el.innerHTML && el.innerHTML.includes(text) && el.children.length === 0) {
          found.push({ el, content: el.innerHTML.slice(0, 100), type: 'innerHTML' })
        }
      }
    }

    if (found.length === 0) {
      // Debug: show what text we can find
      const samples = []
      for (const svg of allSvgs) {
        const texts = svg.querySelectorAll('text')
        for (const t of texts) {
          if (t.textContent && t.textContent.length > 3) {
            samples.push(t.textContent.slice(0, 30))
          }
          if (samples.length >= 5) break
        }
        if (samples.length >= 5) break
      }
      return { found: false, samples }
    }

    const { el } = found[0]
    const rect = el.getBoundingClientRect()

    // Get the camera transform to convert screen to canvas coords
    const camera = editor.getCamera()
    const containerRect = document.querySelector('.tl-container')?.getBoundingClientRect() || { left: 0, top: 0 }
    const screenX = rect.left - containerRect.left + rect.width / 2
    const screenY = rect.top - containerRect.top + rect.height / 2

    // Convert screen coords to canvas coords
    const canvasX = (screenX - camera.x) / camera.z
    const canvasY = (screenY - camera.y) / camera.z

    return {
      found: true,
      screenX, screenY,
      canvasX, canvasY,
      text: found[0].content.slice(0, 50),
      type: found[0].type
    }
  }, searchText)

  return result
}

async function main() {
  console.log('Launching browser...')
  const browser = await puppeteer.launch({ headless: false })
  const page = await browser.newPage()

  console.log(`Loading ${DOC_URL}...`)
  await page.goto(DOC_URL)

  // Wait for TLDraw to initialize
  await page.waitForFunction(() => window.__tldraw_editor__, { timeout: 30000 })
  console.log('Editor ready')

  // Wait a bit for SVGs to render
  await new Promise(r => setTimeout(r, 3000))

  // Get page layout info from TLDraw
  const pageInfo = await page.evaluate(() => {
    const editor = window.__tldraw_editor__
    if (!editor) return null

    // Get all shapes to find page images
    const shapes = editor.getCurrentPageShapes()
    const pageShapes = shapes.filter(s => s.id.includes('-page-'))
      .sort((a, b) => a.y - b.y)

    return pageShapes.map((s, i) => ({
      index: i,
      id: s.id,
      x: s.x,
      y: s.y,
      width: s.props?.w,
      height: s.props?.h,
    }))
  })

  console.log('\n=== Page Layout ===')
  if (pageInfo && pageInfo.length > 0) {
    console.log(`Found ${pageInfo.length} pages`)
    // Show first few pages
    for (const p of pageInfo.slice(0, 3)) {
      console.log(`  Page ${p.index + 1}: x=${p.x}, y=${p.y}, w=${p.width}, h=${p.height}`)
    }

    // Calculate what synctex coords should map to
    const page1 = pageInfo[0]
    console.log('\n=== Coordinate Analysis ===')
    console.log(`Page 1 bounds: (${page1.x}, ${page1.y}) to (${page1.x + page1.width}, ${page1.y + page1.height})`)

    // Get synctex for something on page 1 (line 100 should be on page 1)
    const synctex = await getSynctexPosition(100)
    if (synctex) {
      console.log(`\nSynctex for line 100: page ${synctex.page}, x=${synctex.x.toFixed(1)}, y=${synctex.y.toFixed(1)}`)

      // The SVG dimensions (from pdf2svg) should match page dimensions in PDF points
      // Typical PDF page is 612 x 792 points (US Letter)
      // Check what the canvas page dimensions are
      const svgWidth = page1.width
      const svgHeight = page1.height

      console.log(`Canvas page size: ${svgWidth} x ${svgHeight}`)
      console.log(`PDF points (typical letter): 612 x 792`)

      // Scale factors
      const scaleX = svgWidth / 612
      const scaleY = svgHeight / 792
      console.log(`\nScale factors: X=${scaleX.toFixed(4)}, Y=${scaleY.toFixed(4)}`)

      // Calculate expected canvas position
      // Synctex Y is from bottom, canvas Y is from top
      const canvasX = page1.x + synctex.x * scaleX
      const canvasYNoFlip = page1.y + synctex.y * scaleY
      const canvasYFlipped = page1.y + (792 - synctex.y) * scaleY

      console.log(`\nPredicted canvas position for line 100:`)
      console.log(`  X: ${canvasX.toFixed(1)}`)
      console.log(`  Y (no flip): ${canvasYNoFlip.toFixed(1)}`)
      console.log(`  Y (flipped): ${canvasYFlipped.toFixed(1)}`)
    }
  } else {
    console.log('No page shapes found!')
  }

  await browser.close()
}

main().catch(console.error)
