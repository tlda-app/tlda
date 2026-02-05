#!/usr/bin/env node
/**
 * CLI tool to add annotations to a tldraw document via Yjs
 *
 * Usage:
 *   node add-annotation.mjs --doc bregman --line 433 --text "Note about this"
 *   node add-annotation.mjs --doc bregman --page 9 --text "Note on page 9"
 *   node add-annotation.mjs --doc bregman --x 500 --y 8800 --text "Positioned note"
 *   node add-annotation.mjs --server wss://tldraw-sync-skip.fly.dev --doc bregman --list
 *
 * Options:
 *   --server URL    WebSocket server (default: ws://localhost:5176)
 *   --doc NAME      Document name (required)
 *   --line N        Source line number - uses lookup.json for precise positioning
 *   --page N        Page number (1-indexed), positions at top-right of page
 *   --x N           Canvas X position (alternative to --line or --page)
 *   --y N           Canvas Y position
 *   --text TEXT     Note content (supports $math$)
 *   --color COLOR   Note color (yellow, red, green, blue, violet, orange, grey)
 *   --width N       Note width (default: 200)
 *   --height N      Note height (default: 150)
 *   --list          List existing annotations instead of adding
 *   --delete ID     Delete annotation by shape ID
 */

import WebSocket from 'ws'
import * as Y from 'yjs'
import { readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Parse args
const args = process.argv.slice(2)
function getArg(name, defaultValue = null) {
  const idx = args.indexOf(`--${name}`)
  if (idx === -1) return defaultValue
  return args[idx + 1]
}
function hasFlag(name) {
  return args.includes(`--${name}`)
}

const SERVER = getArg('server', 'ws://localhost:5176')
const DOC_NAME = getArg('doc')
const PAGE_NUM = getArg('page') ? parseInt(getArg('page')) : null
const LINE_NUM = getArg('line') ? parseInt(getArg('line')) : null
const X_POS = getArg('x') ? parseFloat(getArg('x')) : null
const Y_POS = getArg('y') ? parseFloat(getArg('y')) : null
const TEXT = getArg('text', '')
const COLOR = getArg('color', 'yellow')
const WIDTH = parseInt(getArg('width', '200'))
const HEIGHT = parseInt(getArg('height', '150'))
const LIST_MODE = hasFlag('list')
const DELETE_ID = getArg('delete')

if (!DOC_NAME) {
  console.error('Error: --doc is required')
  process.exit(1)
}

if (!LIST_MODE && !DELETE_ID && !TEXT) {
  console.error('Error: --text is required (or use --list to view annotations)')
  process.exit(1)
}

const ROOM_ID = `doc-${DOC_NAME}`

// Standard page dimensions (matching SvgDocument.tsx)
const PAGE_WIDTH = 800
const PAGE_HEIGHT = 1035.294  // 792 * (800/612)
const PAGE_GAP = 20

// PDF dimensions and viewBox offset (matching synctexAnchor.ts)
const PDF_WIDTH = 612
const PDF_HEIGHT = 792
const VIEWBOX_OFFSET = -72

function pageToCanvas(pageNum) {
  // Pages are stacked vertically with gap
  const y = (pageNum - 1) * (PAGE_HEIGHT + PAGE_GAP)
  return { x: 0, y, width: PAGE_WIDTH, height: PAGE_HEIGHT }
}

// Convert PDF coordinates to canvas coordinates
function pdfToCanvas(page, pdfX, pdfY) {
  const pageBounds = pageToCanvas(page)
  const scaleX = PAGE_WIDTH / PDF_WIDTH
  const scaleY = PAGE_HEIGHT / PDF_HEIGHT

  const canvasX = pageBounds.x + (pdfX - VIEWBOX_OFFSET) * scaleX
  const canvasY = pageBounds.y + (pdfY - VIEWBOX_OFFSET) * scaleY

  return { x: canvasX, y: canvasY }
}

// Load lookup.json for a document
function loadLookup(docName) {
  const lookupPath = join(__dirname, '..', 'public', 'docs', docName, 'lookup.json')
  if (!existsSync(lookupPath)) {
    console.warn(`Warning: lookup.json not found at ${lookupPath}`)
    return null
  }
  try {
    return JSON.parse(readFileSync(lookupPath, 'utf8'))
  } catch (e) {
    console.warn(`Warning: Could not parse lookup.json: ${e.message}`)
    return null
  }
}

// Get position for a source line from lookup
function getLinePosition(lookup, lineNum) {
  if (!lookup || !lookup.lines) return null
  const entry = lookup.lines[lineNum.toString()]
  if (!entry) return null
  return {
    page: entry.page,
    pdfX: entry.x,
    pdfY: entry.y,
    content: entry.content
  }
}

function generateId() {
  return Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 12)
}

async function main() {
  console.log(`Connecting to ${SERVER}/${ROOM_ID}...`)

  const doc = new Y.Doc()
  const yRecords = doc.getMap('tldraw')

  const ws = new WebSocket(`${SERVER}/${ROOM_ID}`)

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message)
    process.exit(1)
  })

  ws.on('open', () => {
    console.log('Connected')
  })

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString())
      if (msg.type === 'sync') {
        // Apply server state
        const update = new Uint8Array(msg.data)
        Y.applyUpdate(doc, update)
        console.log(`Synced ${yRecords.size} records from server`)

        if (LIST_MODE) {
          listAnnotations()
          ws.close()
          return
        }

        if (DELETE_ID) {
          deleteAnnotation()
          return
        }

        // Add the annotation
        addAnnotation()
      }
    } catch (e) {
      console.error('Message error:', e)
    }
  })

  function listAnnotations() {
    console.log('\nAnnotations:')
    let count = 0
    yRecords.forEach((record, id) => {
      if (record.type === 'math-note') {
        count++
        const anchor = record.meta?.sourceAnchor
        const anchorStr = anchor ? `${anchor.file}:${anchor.line}` : 'no anchor'
        console.log(`  ${id}`)
        console.log(`    pos: (${record.x.toFixed(0)}, ${record.y.toFixed(0)})`)
        console.log(`    anchor: ${anchorStr}`)
        console.log(`    text: "${record.props.text.slice(0, 50)}${record.props.text.length > 50 ? '...' : ''}"`)
        console.log()
      }
    })
    console.log(`Total: ${count} annotation(s)`)
  }

  function deleteAnnotation() {
    const fullId = DELETE_ID.startsWith('shape:') ? DELETE_ID : `shape:${DELETE_ID}`
    if (!yRecords.has(fullId)) {
      console.error(`Annotation not found: ${fullId}`)
      ws.close()
      process.exit(1)
    }

    doc.transact(() => {
      yRecords.delete(fullId)
    })

    // Send update
    const update = Y.encodeStateAsUpdate(doc)
    ws.send(JSON.stringify({ type: 'update', data: Array.from(update) }))
    console.log(`Deleted: ${fullId}`)

    setTimeout(() => ws.close(), 500)
  }

  function addAnnotation() {
    // Load lookup for precise positioning
    const lookup = loadLookup(DOC_NAME)

    // Calculate position
    let x, y
    let sourceAnchor = null

    if (X_POS !== null && Y_POS !== null) {
      // Direct canvas position
      x = X_POS
      y = Y_POS
    } else if (LINE_NUM !== null) {
      // Position by source line using lookup.json
      const linePos = getLinePosition(lookup, LINE_NUM)
      if (linePos) {
        const canvasPos = pdfToCanvas(linePos.page, linePos.pdfX, linePos.pdfY)
        // Offset to the right of the content
        x = Math.min(canvasPos.x + 100, PAGE_WIDTH - WIDTH - 20)
        y = canvasPos.y - HEIGHT / 2  // Center vertically on the line

        sourceAnchor = {
          file: `./${lookup?.meta?.texFile || DOC_NAME + '.tex'}`,
          line: LINE_NUM,
          column: -1,
          content: linePos.content
        }
        console.log(`Line ${LINE_NUM} → page ${linePos.page}, canvas (${x.toFixed(0)}, ${y.toFixed(0)})`)
      } else {
        console.error(`Error: Line ${LINE_NUM} not found in lookup.json`)
        console.error('Available lines:', Object.keys(lookup?.lines || {}).slice(0, 10).join(', '), '...')
        ws.close()
        process.exit(1)
      }
    } else if (PAGE_NUM !== null) {
      // Page-relative position (top-right of page)
      const pageBounds = pageToCanvas(PAGE_NUM)
      x = pageBounds.x + PAGE_WIDTH - WIDTH - 50
      y = pageBounds.y + 100
    } else {
      console.error('Error: specify --line, --page, or --x/--y for position')
      ws.close()
      process.exit(1)
    }

    const shapeId = `shape:${generateId()}`
    const shape = {
      id: shapeId,
      type: 'math-note',
      typeName: 'shape',
      x: x,
      y: y,
      rotation: 0,
      isLocked: false,
      opacity: 1,
      props: {
        w: WIDTH,
        h: HEIGHT,
        text: TEXT,
        color: COLOR,
      },
      meta: sourceAnchor ? { sourceAnchor } : {},
      parentId: 'page:page',
      index: 'a1',
    }

    doc.transact(() => {
      yRecords.set(shapeId, shape)
    })

    // Send update
    const update = Y.encodeStateAsUpdate(doc)
    ws.send(JSON.stringify({ type: 'update', data: Array.from(update) }))
    console.log(`Created: ${shapeId}`)
    console.log(`  pos: (${x.toFixed(0)}, ${y.toFixed(0)})`)
    console.log(`  text: "${TEXT.slice(0, 50)}${TEXT.length > 50 ? '...' : ''}"`)

    setTimeout(() => ws.close(), 500)
  }
}

main().catch(e => {
  console.error('Error:', e)
  process.exit(1)
})
