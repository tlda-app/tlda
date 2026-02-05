#!/usr/bin/env node
/**
 * Test synctex anchoring end-to-end with Puppeteer
 */

import puppeteer from 'puppeteer'
import { execSync } from 'child_process'

const DOC_URL = 'http://localhost:5173/claude-tldraw/?doc=bregman'
const TEX_FILE = '/Users/skip/work/bregman-lower-bound/bregman-lower-bound.tex'

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

async function main() {
  console.log('=== SyncTeX Anchoring Test ===\n')

  // Launch browser
  console.log('1. Launching browser...')
  const browser = await puppeteer.launch({ headless: false })
  const page = await browser.newPage()

  // Collect console logs
  const logs = []
  page.on('console', msg => {
    const text = msg.text()
    if (text.includes('[SyncTeX]') || text.includes('[Yjs]')) {
      logs.push(text)
      console.log('   ', text)
    }
  })

  // Load the app
  console.log('2. Loading app...')
  await page.goto(DOC_URL)
  await page.waitForFunction(() => window.__tldraw_editor__, { timeout: 30000 })
  await sleep(3000) // Wait for SVGs and Yjs sync

  // Check room ID in URL
  const url = page.url()
  console.log('   URL:', url)
  if (!url.includes('room=doc-bregman')) {
    console.log('   WARNING: Room ID not set to doc-bregman!')
  }

  // Get editor and find page 9
  console.log('3. Navigating to page 9...')
  const pageInfo = await page.evaluate(() => {
    const editor = window.__tldraw_editor__
    const shapes = editor.getCurrentPageShapes()
    const pageShapes = shapes.filter(s => s.id.includes('-page-'))
      .sort((a, b) => a.y - b.y)

    // Page 9 (0-indexed: 8)
    const page9 = pageShapes[8]
    if (page9) {
      // Scroll to page 9 - use zoomToBounds for reliable positioning
      const targetY = page9.y + 400
      editor.setCamera({ x: -200, y: -targetY + 300, z: 1 })
      return { x: page9.x, y: page9.y, width: page9.props?.w, height: page9.props?.h }
    }
    return null
  })
  console.log('   Page 9:', pageInfo)
  await sleep(500)

  // Check for existing notes and delete ones without content fingerprint
  console.log('4. Checking for existing anchored notes...')
  const existingNotes = await page.evaluate(() => {
    const editor = window.__tldraw_editor__
    const shapes = editor.getCurrentPageShapes()
    const anchored = shapes
      .filter(s => s.type === 'math-note' && s.meta?.sourceAnchor)
      .map(s => ({
        id: s.id,
        x: s.x,
        y: s.y,
        anchor: s.meta.sourceAnchor,
        hasContent: !!s.meta.sourceAnchor.content
      }))

    // Delete notes without content fingerprint (old format)
    const toDelete = anchored.filter(n => !n.hasContent).map(n => n.id)
    if (toDelete.length > 0) {
      editor.deleteShapes(toDelete)
      console.log(`Deleted ${toDelete.length} notes without content fingerprint`)
    }

    return anchored.filter(n => n.hasContent)
  })

  if (existingNotes.length > 0) {
    console.log(`   Found ${existingNotes.length} existing anchored note(s) with content:`)
    existingNotes.forEach(n => {
      console.log(`     - ${n.id} at (${n.x.toFixed(0)}, ${n.y.toFixed(0)}) anchored to ${n.anchor.file}:${n.anchor.line}`)
      console.log(`       content: "${n.anchor.content?.slice(0, 40)}..."`)
    })
  } else {
    console.log('   No existing anchored notes found.')

    // Create a note
    console.log('5. Creating a note near "Formal Results"...')
    await page.evaluate(() => {
      const editor = window.__tldraw_editor__
      editor.setCurrentTool('math-note')
    })

    // Click in the center of the viewport where page 9 content should be
    // We've already scrolled to show page 9, so click in the middle of the screen
    const viewport = await page.viewport()
    const clickScreenX = viewport.width / 2
    const clickScreenY = viewport.height / 2

    console.log(`   Clicking at screen center (${clickScreenX}, ${clickScreenY})...`)

    // First verify where we are in canvas coordinates
    const canvasPos = await page.evaluate(({sx, sy}) => {
      const editor = window.__tldraw_editor__
      const camera = editor.getCamera()
      const container = document.querySelector('.tl-container')
      const rect = container?.getBoundingClientRect() || { left: 0, top: 0 }

      // Convert screen to canvas
      const canvasX = (sx - rect.left - camera.x) / camera.z
      const canvasY = (sy - rect.top - camera.y) / camera.z
      return { x: canvasX, y: canvasY, camera }
    }, { sx: clickScreenX, sy: clickScreenY })

    console.log(`   Canvas position at click: (${canvasPos.x.toFixed(0)}, ${canvasPos.y.toFixed(0)})`)
    console.log(`   Camera: x=${canvasPos.camera.x.toFixed(0)}, y=${canvasPos.camera.y.toFixed(0)}, z=${canvasPos.camera.z.toFixed(2)}`)

    await page.mouse.click(clickScreenX, clickScreenY)
    await sleep(2000)

    // Press Escape to deselect/finish editing
    await page.keyboard.press('Escape')
    await sleep(500)

    // Check if note was created with anchor
    const newNotes = await page.evaluate(() => {
      const editor = window.__tldraw_editor__
      const shapes = editor.getCurrentPageShapes()
      return shapes
        .filter(s => s.type === 'math-note')
        .map(s => ({
          id: s.id,
          x: s.x,
          y: s.y,
          anchor: s.meta?.sourceAnchor || null
        }))
    })

    console.log(`   Created notes:`, newNotes)
  }

  // Wait for Yjs to sync
  console.log('6. Waiting for Yjs sync...')
  await sleep(2000)

  // Get note position before modification
  const beforePos = await page.evaluate(() => {
    const editor = window.__tldraw_editor__
    const shapes = editor.getCurrentPageShapes()
    const note = shapes.find(s => s.type === 'math-note' && s.meta?.sourceAnchor)
    return note ? { x: note.x, y: note.y, anchor: note.meta.sourceAnchor } : null
  })
  console.log('   Note position before modification:', beforePos)

  // Now test the remapping
  console.log('\n7. Testing remapping...')

  // Find the anchor line from the note
  const anchorLine = beforePos?.anchor?.line || 433
  console.log(`   Note anchored to line ${anchorLine}`)
  console.log('   Adding vspace BEFORE that line...')

  // Add vspace a few lines before the anchor to shift it down
  const insertLine = Math.max(1, anchorLine - 5)
  execSync(`sed -i '' '${insertLine}i\\
\\\\vspace{2cm} % TEST SYNCTEX
' "${TEX_FILE}"`)

  // Rebuild
  console.log('   Rebuilding SVGs...')
  execSync('./scripts/build-doc-dvisvgm.sh /Users/skip/work/bregman-lower-bound/bregman-lower-bound.tex public/docs/bregman', { stdio: 'pipe' })

  // Note: beforePos was captured earlier, now we just log it after rebuild
  console.log('   Note position (captured before rebuild):', beforePos)

  // Reload the page
  console.log('8. Reloading page...')
  logs.length = 0  // Clear logs
  await page.reload()
  await page.waitForFunction(() => window.__tldraw_editor__, { timeout: 30000 })
  await sleep(5000)  // Wait for Yjs sync and remapping

  // Get note position after reload
  const afterPos = await page.evaluate(() => {
    const editor = window.__tldraw_editor__
    const shapes = editor.getCurrentPageShapes()
    const note = shapes.find(s => s.type === 'math-note' && s.meta?.sourceAnchor)
    return note ? { x: note.x, y: note.y, anchor: note.meta.sourceAnchor } : null
  })
  console.log('   Note position after reload:', afterPos)

  // Check if note moved
  if (beforePos && afterPos) {
    const dx = afterPos.x - beforePos.x
    const dy = afterPos.y - beforePos.y
    console.log(`   Movement: dx=${dx.toFixed(1)}, dy=${dy.toFixed(1)}`)
    if (Math.abs(dy) > 10) {
      console.log('   ✓ Note moved! Synctex anchoring is working.')
    } else {
      console.log('   ✗ Note did not move significantly.')
    }
  } else {
    console.log('   Could not compare positions (note missing before or after)')
  }

  // Revert tex file
  console.log('\n9. Reverting tex file...')
  execSync(`sed -i '' '/^\\\\vspace{2cm} % TEST SYNCTEX$/d' "${TEX_FILE}"`)
  execSync('./scripts/build-doc-dvisvgm.sh /Users/skip/work/bregman-lower-bound/bregman-lower-bound.tex public/docs/bregman', { stdio: 'pipe' })

  console.log('\n=== Test Complete ===')
  console.log('Browser left open for inspection. Close manually when done.')

  // Don't close browser so user can inspect
  // await browser.close()
}

main().catch(e => {
  console.error('Test failed:', e)
  process.exit(1)
})
