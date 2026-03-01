#!/usr/bin/env node
/**
 * End-to-end tests for the tlda viewer.
 *
 * Uses node:test + puppeteer to verify rendering, viewport loading,
 * signal dispatch, binary WebSocket protocol, and absence of regressions.
 *
 * Usage:
 *   node scripts/e2e-test.mjs [doc-name]
 *
 * Requires: unified server running (`tlda server start`).
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import puppeteer from 'puppeteer-core'
import WebSocket from 'ws'
import * as Y from 'yjs'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const SERVER = 'http://localhost:5176'
const WS_SERVER = 'ws://localhost:5176'

// --- Helpers ---

async function waitForEditor(page, timeout = 15000) {
  await page.waitForFunction(() => {
    const ed = window.__tldraw_editor__
    return ed && ed.getCurrentPageShapes().some(s => s.type === 'svg-page')
  }, { timeout })
}

async function waitForSvg(page, timeout = 10000) {
  await page.waitForFunction(() => {
    return document.querySelectorAll('[data-shape-type="svg-page"] svg').length > 0
  }, { timeout })
}

/** Count SVGs actually in the DOM (viewport-loaded pages). */
async function countRenderedSvgs(page) {
  return page.evaluate(() =>
    document.querySelectorAll('[data-shape-type="svg-page"] svg').length
  )
}

/** Count all svg-page shapes in TLDraw. */
async function countShapes(page) {
  return page.evaluate(() => {
    const ed = window.__tldraw_editor__
    return ed.getCurrentPageShapes().filter(s => s.type === 'svg-page').length
  })
}

/** Connect a raw WebSocket to a Yjs room, return { ws, doc, yRecords }. */
function connectYjs(room) {
  return new Promise((resolve, reject) => {
    const doc = new Y.Doc()
    const yRecords = doc.getMap('tldraw')
    const ws = new WebSocket(`${WS_SERVER}/${room}`)

    const timeout = setTimeout(() => {
      ws.close()
      reject(new Error('Yjs WS connect timeout'))
    }, 5000)

    ws.on('message', (data) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
      // Binary: [type byte][payload]
      if (buf.length > 0 && (buf[0] === 0x01 || buf[0] === 0x02)) {
        Y.applyUpdate(doc, buf.subarray(1))
        if (buf[0] === 0x01) {
          clearTimeout(timeout)
          resolve({ ws, doc, yRecords })
        }
      }
    })

    ws.on('error', (e) => {
      clearTimeout(timeout)
      reject(e)
    })
  })
}

/** Send a binary update to a Yjs WS. */
function sendBinaryUpdate(ws, update) {
  const msg = Buffer.alloc(1 + update.length)
  msg[0] = 0x02
  Buffer.from(update).copy(msg, 1)
  ws.send(msg)
}

/** Write a Yjs signal via a separate WS connection. */
async function writeSignalViaWs(room, key, value) {
  const { ws, doc, yRecords } = await connectYjs(room)
  doc.transact(() => {
    yRecords.set(key, { ...value, timestamp: Date.now() })
  })
  // Send the update
  const update = Y.encodeStateAsUpdate(doc)
  sendBinaryUpdate(ws, update)
  // Wait for relay
  await new Promise(r => setTimeout(r, 300))
  ws.close()
  doc.destroy()
}

// --- Resolve doc ---

async function getDocInfo(name) {
  const resp = await fetch(`${SERVER}/docs/manifest.json`)
  const { documents } = await resp.json()
  if (name && documents[name]) {
    return { name, pages: documents[name].pages }
  }
  // Pick first SVG doc
  for (const [n, c] of Object.entries(documents)) {
    if (!c.format || c.format === 'svg') {
      return { name: n, pages: c.pages }
    }
  }
  throw new Error('No SVG documents in manifest')
}

// --- Tests ---

const requestedDoc = process.argv.find((a, i) => i >= 2 && !a.startsWith('--'))

describe('e2e: viewer', async () => {
  let browser, page, doc, consoleErrors

  before(async () => {
    // Verify server is up
    try {
      const resp = await fetch(`${SERVER}/health`)
      const health = await resp.json()
      assert.ok(health.ok, 'Server not healthy')
    } catch {
      throw new Error('Server not running — start with `tlda server start`')
    }

    doc = await getDocInfo(requestedDoc)
    console.log(`Testing with: ${doc.name} (${doc.pages} pages)`)

    browser = await puppeteer.launch({
      headless: 'shell',
      executablePath: CHROME,
    })
  })

  after(async () => {
    if (browser) await browser.close()
  })

  async function openFreshPage() {
    // Viewer always uses room = `doc-${docName}`, ignoring query params
    const room = `doc-${doc.name}`
    const p = await browser.newPage()
    consoleErrors = []
    p.on('console', msg => {
      if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 300))
    })
    p.on('pageerror', err => consoleErrors.push(err.message.slice(0, 300)))

    await p.goto(`${SERVER}/?doc=${doc.name}`, {
      waitUntil: 'networkidle2',
      timeout: 20000,
    })
    await waitForEditor(p)
    return { page: p, room }
  }

  // --- 1. Rendering ---

  describe('rendering', () => {
    let ctx

    before(async () => {
      ctx = await openFreshPage()
      // Let SVGs inject
      await waitForSvg(ctx.page, 10000)
      await new Promise(r => setTimeout(r, 2000))
    })

    after(async () => {
      if (ctx?.page) await ctx.page.close()
    })

    it('creates all svg-page shapes', async () => {
      const count = await countShapes(ctx.page)
      assert.ok(count >= doc.pages, `Expected ${doc.pages} shapes, got ${count}`)
    })

    it('renders SVGs in viewport (not empty divs)', async () => {
      const rendered = await countRenderedSvgs(ctx.page)
      assert.ok(rendered > 0, `No SVGs rendered in DOM`)

      // Check there are no empty svg-page divs in viewport
      const emptyInViewport = await ctx.page.evaluate(() => {
        const editor = window.__tldraw_editor__
        const vp = editor.getViewportPageBounds()
        let empty = 0
        for (const el of document.querySelectorAll('[data-shape-type="svg-page"]')) {
          const rect = el.getBoundingClientRect()
          // rough check: if element is on screen
          if (rect.bottom > 0 && rect.top < window.innerHeight) {
            if (!el.querySelector('svg')) empty++
          }
        }
        return empty
      })
      assert.equal(emptyInViewport, 0, `${emptyInViewport} empty svg-page divs in viewport`)
    })

    it('populates svgViewBoxStore', async () => {
      const count = await ctx.page.evaluate(() =>
        window.__changeStore__?.svgViewBoxStore?.size ?? 0
      )
      assert.ok(count > 0, `svgViewBoxStore is empty`)
    })

    it('no version prop on shapes', async () => {
      const hasVersion = await ctx.page.evaluate(() => {
        const ed = window.__tldraw_editor__
        return ed.getCurrentPageShapes().some(s => 'version' in s.props)
      })
      assert.equal(hasVersion, false, 'Found shapes with version prop')
    })
  })

  // --- 2. Viewport loading ---

  describe('viewport loading', () => {
    let ctx

    before(async () => {
      ctx = await openFreshPage()
      await waitForSvg(ctx.page, 10000)
      await new Promise(r => setTimeout(r, 2000))
    })

    after(async () => {
      if (ctx?.page) await ctx.page.close()
    })

    it('loads SVGs for pages scrolled into view', async () => {
      if (doc.pages < 15) {
        // Small doc — skip, all pages likely in viewport
        return
      }

      // Scroll to a far page
      const targetPage = Math.min(30, doc.pages)
      await ctx.page.evaluate((pg) => {
        const ed = window.__tldraw_editor__
        const shapes = ed.getCurrentPageShapes().filter(s => s.type === 'svg-page')
        // shapes are sorted by y — page N is roughly index N-1
        const target = shapes[pg - 1]
        if (target) {
          ed.centerOnPoint({ x: target.x + 300, y: target.y + 400 })
        }
      }, targetPage)

      // Wait for SVGs to load in new viewport
      await new Promise(r => setTimeout(r, 3000))

      const rendered = await countRenderedSvgs(ctx.page)
      assert.ok(rendered > 0, `No SVGs after scrolling to page ${targetPage}`)
    })

    it('clears off-screen pages to save memory', async () => {
      if (doc.pages < 15) return

      // After scrolling far, original pages should be cleared
      const total = await ctx.page.evaluate(() =>
        document.querySelectorAll('[data-shape-type="svg-page"] svg').length
      )
      // Should NOT have all pages loaded — viewport culling should limit it
      assert.ok(total < doc.pages,
        `All ${doc.pages} pages loaded — viewport culling not working (${total} SVGs in DOM)`)
    })
  })

  // --- 3. Signal dispatch ---

  describe('signals', () => {
    let ctx

    before(async () => {
      ctx = await openFreshPage()
      await waitForSvg(ctx.page, 10000)
      await new Promise(r => setTimeout(r, 2000))
    })

    after(async () => {
      if (ctx?.page) await ctx.page.close()
    })

    it('forward-scroll signal moves camera', async () => {
      // First reset camera to top of document
      await ctx.page.evaluate(() => {
        const ed = window.__tldraw_editor__
        ed.setCamera({ x: 0, y: 0, z: 1 })
      })
      await new Promise(r => setTimeout(r, 300))

      const before = await ctx.page.evaluate(() => {
        const ed = window.__tldraw_editor__
        const cam = ed.getCamera()
        return { x: cam.x, y: cam.y }
      })

      // Get position of a far page (page 20+)
      const scrollTarget = await ctx.page.evaluate(() => {
        const ed = window.__tldraw_editor__
        const shapes = ed.getCurrentPageShapes().filter(s => s.type === 'svg-page')
        const idx = Math.min(20, shapes.length - 1)
        const target = shapes[idx]
        return { x: target.x + 100, y: target.y + 100 }
      })

      // Write forward-scroll signal via external WS
      await writeSignalViaWs(ctx.room, 'signal:forward-scroll', {
        x: scrollTarget.x,
        y: scrollTarget.y,
      })

      // Wait for camera to move (animation is 300ms + relay time)
      await new Promise(r => setTimeout(r, 2000))

      const after_ = await ctx.page.evaluate(() => {
        const ed = window.__tldraw_editor__
        const cam = ed.getCamera()
        return { x: cam.x, y: cam.y }
      })

      // Camera should have moved significantly (scrolling from top to page 20+)
      const moved = Math.abs(after_.y - before.y) > 100
      assert.ok(moved, `Camera didn't move: before=${JSON.stringify(before)} after=${JSON.stringify(after_)}, target=${JSON.stringify(scrollTarget)}`)
    })

    it('reload signal triggers page refresh', async () => {
      // Inject a full reload signal
      await writeSignalViaWs(ctx.room, 'signal:reload', { type: 'full' })

      // After reload, SVGs should still render (they get re-fetched)
      await new Promise(r => setTimeout(r, 3000))

      const rendered = await countRenderedSvgs(ctx.page)
      assert.ok(rendered > 0, `No SVGs after reload signal`)
    })

    it('stale signals (old timestamp) are ignored', async () => {
      // Reset camera to a known position
      await ctx.page.evaluate(() => {
        window.__tldraw_editor__.setCamera({ x: 0, y: 0, z: 1 })
      })
      await new Promise(r => setTimeout(r, 300))

      // Send a signal with a timestamp OLDER than the last-seen one
      // (the previous forward-scroll test already set a timestamp)
      const { ws: staleWs, doc: staleDoc, yRecords: staleRecords } = await connectYjs(ctx.room)
      staleDoc.transact(() => {
        staleRecords.set('signal:forward-scroll', {
          x: 400, y: 99999, timestamp: 1, // very old timestamp
        })
      })
      sendBinaryUpdate(staleWs, Y.encodeStateAsUpdate(staleDoc))
      await new Promise(r => setTimeout(r, 1000))
      staleWs.close()
      staleDoc.destroy()

      const cam = await ctx.page.evaluate(() => {
        const c = window.__tldraw_editor__.getCamera()
        return { x: c.x, y: c.y }
      })

      // Camera should NOT have moved to y=99999
      assert.ok(Math.abs(cam.y) < 1000, `Camera y=${cam.y} — stale signal was applied`)
    })
  })

  // --- 4. Binary WebSocket protocol ---

  describe('binary WebSocket', () => {
    it('server sends binary sync message', async () => {
      const room = `e2e-binary-${Date.now()}`
      const ws = new WebSocket(`${WS_SERVER}/${room}`)

      const firstMessage = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { ws.close(); reject(new Error('No message')) }, 5000)
        ws.on('message', (data) => {
          clearTimeout(timeout)
          resolve(data)
        })
        ws.on('error', reject)
      })

      // Should be a Buffer starting with 0x01 (sync)
      const buf = Buffer.isBuffer(firstMessage) ? firstMessage : Buffer.from(firstMessage)
      assert.equal(buf[0], 0x01, `Expected sync byte 0x01, got 0x${buf[0].toString(16)}`)
      assert.ok(buf.length > 1, 'Sync message has no payload')

      ws.close()
    })

    it('binary update roundtrip works', async () => {
      const room = `e2e-binrt-${Date.now()}`

      // Connect two clients
      const client1 = await connectYjs(room)
      const client2 = await connectYjs(room)

      // Client 1 writes a value
      const testKey = 'test-binary-roundtrip'
      const testValue = { hello: 'world', n: 42, timestamp: Date.now() }

      client1.doc.transact(() => {
        client1.yRecords.set(testKey, testValue)
      })
      sendBinaryUpdate(client1.ws, Y.encodeStateAsUpdate(client1.doc))

      // Wait for client 2 to receive
      await new Promise(r => setTimeout(r, 500))

      const received = client2.yRecords.get(testKey)
      assert.ok(received, 'Client 2 did not receive the update')
      assert.equal(received.hello, 'world')
      assert.equal(received.n, 42)

      client1.ws.close()
      client2.ws.close()
      client1.doc.destroy()
      client2.doc.destroy()
    })

    it('JSON fallback still works', async () => {
      const room = `e2e-json-${Date.now()}`

      // Connect normally to get initial state
      const { ws: normalWs, doc: normalDoc, yRecords: normalRecords } = await connectYjs(room)

      // Connect a "legacy" client that sends JSON
      const legacyWs = new WebSocket(`${WS_SERVER}/${room}`)
      await new Promise((resolve) => {
        legacyWs.on('open', resolve)
      })
      // Skip initial sync message
      await new Promise(r => setTimeout(r, 500))

      // Send a JSON-encoded update (legacy format)
      const tmpDoc = new Y.Doc()
      const tmpMap = tmpDoc.getMap('tldraw')
      tmpDoc.transact(() => {
        tmpMap.set('json-test', { legacy: true, timestamp: Date.now() })
      })
      const update = Y.encodeStateAsUpdate(tmpDoc)
      legacyWs.send(JSON.stringify({
        type: 'update',
        data: Array.from(update),
      }))

      // Wait for normal client to receive
      await new Promise(r => setTimeout(r, 500))

      const received = normalRecords.get('json-test')
      assert.ok(received, 'JSON fallback update not received')
      assert.equal(received.legacy, true)

      normalWs.close()
      legacyWs.close()
      normalDoc.destroy()
      tmpDoc.destroy()
    })
  })

  // --- 5. No regressions ---

  describe('no regressions', () => {
    let ctx

    before(async () => {
      ctx = await openFreshPage()
      await waitForSvg(ctx.page, 10000)
      await new Promise(r => setTimeout(r, 3000))
    })

    after(async () => {
      if (ctx?.page) await ctx.page.close()
    })

    it('no console errors (excluding Yjs reconnect noise)', () => {
      const real = consoleErrors.filter(e =>
        !e.includes('[Yjs] WebSocket error') &&
        !e.includes('ERR_CONNECTION_REFUSED')
      )
      assert.equal(real.length, 0, `Console errors:\n${real.join('\n')}`)
    })

    it('signalBus registered all expected signals', async () => {
      // Verify all 6 signal keys are handled by checking they don't warn
      const signalKeys = [
        'signal:reload',
        'signal:forward-scroll',
        'signal:forward-highlight',
        'signal:screenshot-request',
        'signal:camera-link',
        'signal:ref-viewer',
      ]
      // Write each signal and verify no console error
      for (const key of signalKeys) {
        await writeSignalViaWs(ctx.room, key, {
          type: 'full', x: 0, y: 0, page: 1,
          viewerId: 'test', refs: null,
        })
      }
      await new Promise(r => setTimeout(r, 500))

      // No new errors from signal dispatch
      const newErrors = consoleErrors.filter(e =>
        e.includes('signal') && !e.includes('WebSocket')
      )
      assert.equal(newErrors.length, 0, `Signal errors:\n${newErrors.join('\n')}`)
    })
  })
})
