#!/usr/bin/env node
/**
 * Smoke test for the claude-tldraw viewer.
 *
 * Usage:
 *   node scripts/smoke-test.mjs [doc-name]
 *   npm run smoke [-- doc-name]
 *
 * Checks services, manifest consistency, SVG rendering, and WebSocket connectivity.
 * Exits 0 if all pass, 1 if any fail.
 */

import { execSync } from 'child_process'
import { readdirSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import puppeteer from 'puppeteer-core'
import { readManifest, listDocs } from './manifest.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const VITE_BASE = '/claude-tldraw/'

function pass(msg) { return { ok: true, msg } }
function fail(msg, detail) { return { ok: false, msg, detail } }

function printSection(name, checks) {
  console.log(`\n--- ${name} ---`)
  for (const c of checks) {
    if (c.ok) {
      console.log(`  \x1b[32mPASS\x1b[0m  ${c.msg}`)
    } else {
      console.log(`  \x1b[31mFAIL\x1b[0m  ${c.msg}`)
      if (c.detail) console.log(`        ${c.detail}`)
    }
  }
}

// --- Phase 1: Service health ---

async function checkServices() {
  const checks = []

  // Vite dev server at correct base path
  try {
    const resp = await fetch(`http://localhost:5173${VITE_BASE}`)
    const html = await resp.text()
    if (resp.ok && html.includes('id="root"')) {
      checks.push(pass(`Vite responding at ${VITE_BASE}`))
    } else {
      checks.push(fail(`Vite returned unexpected response at ${VITE_BASE}`, `status=${resp.status}`))
    }
  } catch (e) {
    checks.push(fail('Vite not responding on port 5173', e.message))
  }

  // Sync server health
  try {
    const resp = await fetch('http://localhost:5176/health')
    const body = await resp.text()
    if (resp.ok && body.trim() === 'ok') {
      checks.push(pass('Sync server healthy on port 5176'))
    } else {
      checks.push(fail('Sync server unhealthy', `status=${resp.status}, body=${body}`))
    }
  } catch (e) {
    checks.push(fail('Sync server not responding on port 5176', e.message))
  }

  // Port conflict: exactly one process on 5176
  try {
    const pids = execSync('lsof -i :5176 -sTCP:LISTEN -t 2>/dev/null', { encoding: 'utf8' })
      .trim().split('\n').filter(Boolean)
    if (pids.length === 1) {
      checks.push(pass(`Single process on port 5176 (pid ${pids[0]})`))
    } else if (pids.length > 1) {
      checks.push(fail('Multiple processes on port 5176', `pids: ${pids.join(', ')}`))
    }
  } catch {
    // lsof returns non-zero if nothing found — already caught above
  }

  return checks
}

// --- Phase 2: Manifest vs. disk ---

function checkManifest() {
  const checks = []
  const docs = readManifest()

  for (const [name, config] of Object.entries(docs)) {
    if (config.format === 'html' || config.format === 'diff') continue
    const dir = resolve(ROOT, 'public', 'docs', name)
    try {
      const svgFiles = readdirSync(dir).filter(f => /^page-\d+\.svg$/.test(f))
      if (svgFiles.length === config.pages) {
        checks.push(pass(`${name}: ${config.pages} SVGs match manifest`))
      } else {
        checks.push(fail(`${name}: manifest says ${config.pages} pages, found ${svgFiles.length}`, dir))
      }
    } catch {
      checks.push(fail(`${name}: directory not found`, dir))
    }
  }
  return checks
}

// --- Phase 3 & 4: Rendering + WebSocket (puppeteer) ---

async function checkBrowser(docName, expectedPages) {
  const checks = []
  const roomId = `smoke-test-${Date.now()}`
  const url = `http://localhost:5173${VITE_BASE}?doc=${docName}&room=${roomId}`

  const browser = await puppeteer.launch({
    headless: 'shell',
    executablePath: CHROME,
  })

  try {
    const page = await browser.newPage()
    const consoleErrors = []
    page.on('console', msg => {
      if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 200))
    })
    page.on('pageerror', err => consoleErrors.push(err.message.slice(0, 200)))

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 })

    // Wait for TLDraw editor + svg-page shapes
    await page.waitForFunction(() => {
      const ed = window.__tldraw_editor__
      return ed && ed.getCurrentPageShapes().some(s => s.type === 'svg-page')
    }, { timeout: 15000 })

    // Let SVG injection settle
    await new Promise(r => setTimeout(r, 2000))

    // --- Rendering checks ---
    const result = await page.evaluate((expected) => {
      const editor = window.__tldraw_editor__
      const shapes = editor.getCurrentPageShapes()
      const svgPages = shapes.filter(s => s.type === 'svg-page')

      // Check DOM for actual SVG content (not empty white divs)
      const els = document.querySelectorAll('[data-shape-type="svg-page"]')
      let rendered = 0, empty = 0
      for (const el of els) {
        if (el.querySelector('svg')) rendered++
        else empty++
      }

      // svgViewBoxStore proves svgTextStore wasn't wiped
      const viewBoxCount = window.__changeStore__?.svgViewBoxStore?.size ?? -1

      return { svgPages: svgPages.length, expected, rendered, empty, viewBoxCount }
    }, expectedPages)

    if (result.svgPages >= result.expected) {
      checks.push(pass(`${result.svgPages} svg-page shapes created`))
    } else {
      checks.push(fail(`Only ${result.svgPages} svg-page shapes (expected ${result.expected})`))
    }

    if (result.empty === 0 && result.rendered > 0) {
      checks.push(pass(`SVG content rendered in DOM (${result.rendered} visible, 0 empty)`))
    } else {
      checks.push(fail(`${result.empty} empty white divs`, `rendered: ${result.rendered}, empty: ${result.empty}`))
    }

    if (result.viewBoxCount >= result.expected) {
      checks.push(pass(`svgViewBoxStore has ${result.viewBoxCount} entries`))
    } else {
      checks.push(fail(`svgViewBoxStore has ${result.viewBoxCount} entries (expected ${result.expected})`,
        'svgTextStore may have been cleared by race condition'))
    }

    // Filter out the Yjs reconnect noise
    const realErrors = consoleErrors.filter(e => !e.includes('[Yjs] WebSocket error'))
    if (realErrors.length === 0) {
      checks.push(pass('No console errors'))
    } else {
      checks.push(fail(`${realErrors.length} console error(s)`, realErrors.slice(0, 3).join('\n')))
    }

    // --- WebSocket check ---
    const wsOk = await page.evaluate((room) => {
      return new Promise((resolve) => {
        const ws = new WebSocket(`ws://${location.hostname}:5176/${room}`)
        ws.binaryType = 'arraybuffer'
        const timeout = setTimeout(() => { ws.close(); resolve(false) }, 5000)
        ws.onopen = () => {
          ws.onmessage = () => {
            clearTimeout(timeout)
            ws.close()
            resolve(true)
          }
        }
        ws.onerror = () => { clearTimeout(timeout); resolve(false) }
      })
    }, roomId)

    if (wsOk) {
      checks.push(pass('WebSocket connected, received sync data'))
    } else {
      checks.push(fail('WebSocket connection failed or no data received'))
    }
  } finally {
    await browser.close()
  }

  return checks
}

// --- Main ---

async function main() {
  const start = Date.now()
  const args = process.argv.slice(2)
  const requestedDoc = args.find(a => !a.startsWith('--'))

  const docs = listDocs()

  // Pick doc
  let docName, docConfig
  if (requestedDoc && docs[requestedDoc]) {
    docName = requestedDoc
    docConfig = docs[requestedDoc]
  } else {
    const entry = Object.entries(docs).find(([, c]) => !c.format || c.format === 'svg')
    if (!entry) {
      console.error('No SVG documents in manifest')
      process.exit(1)
    }
    ;[docName, docConfig] = entry
  }

  console.log(`Smoke test: claude-tldraw viewer`)
  console.log(`Using document: ${docName} (${docConfig.pages} pages)`)

  // Phase 1: Services
  const serviceChecks = await checkServices()
  printSection('Services', serviceChecks)
  if (serviceChecks.some(c => !c.ok)) {
    console.log('\nServices not healthy — skipping browser tests.')
    console.log('Start services with: npm run collab')
    process.exit(1)
  }

  // Phase 2: Manifest
  const manifestChecks = checkManifest()
  printSection('Manifest', manifestChecks)

  // Phase 3 & 4: Rendering + WebSocket
  const browserChecks = await checkBrowser(docName, docConfig.pages)
  printSection('Rendering', browserChecks.slice(0, 4))
  printSection('WebSocket', browserChecks.slice(4))

  // Summary
  const all = [...serviceChecks, ...manifestChecks, ...browserChecks]
  const passed = all.filter(c => c.ok).length
  const failed = all.filter(c => !c.ok).length
  const elapsed = ((Date.now() - start) / 1000).toFixed(1)

  console.log(`\n${passed} passed, ${failed} failed (${elapsed}s)`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch(e => {
  console.error('Smoke test crashed:', e.message)
  process.exit(1)
})
