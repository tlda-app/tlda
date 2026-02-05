#!/usr/bin/env node
// Migrate annotations after document rebuild
// Uses synctex anchors to reposition annotations to their new locations
//
// Usage: node scripts/migrate-annotations.js <room-id> <doc-name>

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import * as Y from 'yjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SYNCTEX_SERVER = process.env.SYNCTEX_SERVER || 'http://localhost:5177'

const roomId = process.argv[2]
const docName = process.argv[3]

if (!roomId || !docName) {
  console.log('Usage: node scripts/migrate-annotations.js <room-id> <doc-name>')
  console.log('')
  console.log('Example:')
  console.log('  node scripts/migrate-annotations.js review-session bregman')
  console.log('')
  console.log('Make sure the synctex server is running:')
  console.log('  node server/synctex-server.js bregman:/path/to/bregman.tex')
  process.exit(1)
}

// Load Yjs document
const dataFile = join(__dirname, '..', 'server', 'data', `${roomId}.yjs`)
if (!existsSync(dataFile)) {
  console.error(`Room data not found: ${dataFile}`)
  process.exit(1)
}

const doc = new Y.Doc()
const data = readFileSync(dataFile)
Y.applyUpdate(doc, new Uint8Array(data))

const yRecords = doc.getMap('tldraw')
console.log(`Loaded ${yRecords.size} records from ${roomId}`)

// Load manifest to get page info
const manifestFile = join(__dirname, '..', 'public', 'docs', 'manifest.json')
const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
const docConfig = manifest.documents[docName]

if (!docConfig) {
  console.error(`Document not found in manifest: ${docName}`)
  process.exit(1)
}

// Load page info (we need this for coordinate conversion)
// For now, assume standard dimensions - in practice you'd parse the SVGs
const PAGE_WIDTH = 612   // PDF points (letter size)
const PAGE_HEIGHT = 792
const CANVAS_WIDTH = 800 // Display width
const PAGE_SPACING = 32

function buildPageInfo(pageCount) {
  const pages = []
  let top = 0
  for (let i = 0; i < pageCount; i++) {
    const scale = CANVAS_WIDTH / PAGE_WIDTH
    const height = PAGE_HEIGHT * scale
    pages.push({
      bounds: { x: 0, y: top, width: CANVAS_WIDTH, height },
      width: PAGE_WIDTH,
      height: PAGE_HEIGHT
    })
    top += height + PAGE_SPACING
  }
  return pages
}

const pages = buildPageInfo(docConfig.pages)

// Convert canvas to PDF coordinates
function canvasToPdf(x, y) {
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i]
    if (y >= page.bounds.y && y < page.bounds.y + page.bounds.height) {
      const scale = page.width / CANVAS_WIDTH
      return {
        page: i + 1,
        x: (x - page.bounds.x) * scale,
        y: (y - page.bounds.y) * scale
      }
    }
  }
  return null
}

// Convert PDF to canvas coordinates
function pdfToCanvas(pdfPage, pdfX, pdfY) {
  const pageIndex = pdfPage - 1
  if (pageIndex < 0 || pageIndex >= pages.length) return null

  const page = pages[pageIndex]
  const scale = CANVAS_WIDTH / page.width
  return {
    x: page.bounds.x + pdfX * scale,
    y: page.bounds.y + pdfY * scale
  }
}

// Resolve source anchor to new position
async function resolveAnchor(anchor) {
  try {
    const url = `${SYNCTEX_SERVER}/view?doc=${docName}&file=${anchor.file}&line=${anchor.line}&column=${anchor.column || 0}`
    const resp = await fetch(url)
    const data = await resp.json()
    if (data.error) {
      console.warn(`  Warning: Could not resolve ${anchor.file}:${anchor.line}`)
      return null
    }
    return { page: data.page, x: data.x, y: data.y }
  } catch (e) {
    console.warn(`  Warning: Synctex server error:`, e.message)
    return null
  }
}

async function migrate() {
  let migrated = 0
  let skipped = 0
  let failed = 0

  // Find all shapes with source anchors
  for (const [id, record] of yRecords) {
    if (record.typeName !== 'shape') continue
    if (!record.meta?.sourceAnchor) continue

    const anchor = record.meta.sourceAnchor
    console.log(`\nShape ${id}: anchored to ${anchor.file}:${anchor.line}`)

    // Resolve anchor to new PDF position
    const newPdfPos = await resolveAnchor(anchor)
    if (!newPdfPos) {
      failed++
      continue
    }

    console.log(`  New PDF position: page ${newPdfPos.page}, (${newPdfPos.x.toFixed(1)}, ${newPdfPos.y.toFixed(1)})`)

    // Convert to canvas coordinates
    const newCanvasPos = pdfToCanvas(newPdfPos.page, newPdfPos.x, newPdfPos.y)
    if (!newCanvasPos) {
      console.warn(`  Warning: Could not convert to canvas coords`)
      failed++
      continue
    }

    // Calculate offset (annotations are positioned at top-left, but anchored at center)
    const offsetX = (record.props?.w || 200) / 2
    const offsetY = (record.props?.h || 200) / 2

    const oldX = record.x
    const oldY = record.y
    const newX = newCanvasPos.x - offsetX
    const newY = newCanvasPos.y - offsetY

    const distance = Math.sqrt((newX - oldX) ** 2 + (newY - oldY) ** 2)

    if (distance < 5) {
      console.log(`  No significant movement (${distance.toFixed(1)}px)`)
      skipped++
      continue
    }

    console.log(`  Moving: (${oldX.toFixed(0)}, ${oldY.toFixed(0)}) → (${newX.toFixed(0)}, ${newY.toFixed(0)}) [${distance.toFixed(0)}px]`)

    // Update the record
    yRecords.set(id, { ...record, x: newX, y: newY })
    migrated++
  }

  // Save updated document
  if (migrated > 0) {
    const state = Y.encodeStateAsUpdate(doc)
    writeFileSync(dataFile, Buffer.from(state))
    console.log(`\nSaved ${migrated} migrated annotations`)
  }

  console.log(`\n=== Summary ===`)
  console.log(`Migrated: ${migrated}`)
  console.log(`Skipped (no movement): ${skipped}`)
  console.log(`Failed: ${failed}`)
}

migrate().catch(e => {
  console.error('Migration failed:', e)
  process.exit(1)
})
