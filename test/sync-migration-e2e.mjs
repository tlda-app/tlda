/**
 * E2E test for @tldraw/sync migration.
 * Tests: viewer load with synced annotations, REST->viewer sync,
 *        two-tab CRDT sync, shape deletion sync, console error check.
 *
 * Assumes server running on localhost:5176 with spinoff4 project.
 *
 * Usage: node test/sync-migration-e2e.mjs
 */

import puppeteer from 'puppeteer-core'

const BASE = 'http://localhost:5176'
const READ_TOKEN = 'uY6r_smer80SyjMxbexOBut9U82jE_bY'
const WRITE_TOKEN = 'TQq6xhqzxiJKN_pF7vxX2py-UEVHPXUK'
const DOC = 'spinoff4'
const VIEWER_URL = `${BASE}/?doc=${DOC}&token=${READ_TOKEN}`
const TEST_SHAPE_ID = 'shape:e2e-sync-test'
const TWO_TAB_SHAPE_ID = 'shape:e2e-two-tab-test'

// -- Helpers --

const results = []

function report(name, pass, detail = '') {
  results.push({ name, pass, detail })
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${name}${detail ? ': ' + detail : ''}`)
}

async function apiPost(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${WRITE_TOKEN}` },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

async function apiDelete(path) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${WRITE_TOKEN}` },
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

/** Wait for editor + svg-page shapes to be ready. */
async function waitForEditor(page, timeout = 30000) {
  await page.waitForFunction(
    () => {
      const e = window.__tldraw_editor__
      return e?.store && e.getCurrentPageShapes().some(s => s.type === 'svg-page')
    },
    { timeout },
  )
}

/** Poll for a shape to appear or disappear in the TLDraw store. */
async function waitForShape(page, shapeId, shouldExist = true, timeout = 10000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const exists = await page.evaluate((id) => {
      const e = window.__tldraw_editor__
      if (!e?.store) return false
      try { return !!e.store.get(id) } catch { return false }
    }, shapeId)
    if (exists === shouldExist) return true
    await new Promise(r => setTimeout(r, 250))
  }
  return false
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// -- Main --

let browser
let page1, page2

async function main() {
  browser = await puppeteer.launch({
    headless: 'shell', executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })

  const consoleErrors = { tab1: [], tab2: [] }

  console.log('\n=== @tldraw/sync Migration E2E Tests ===\n')

  // -- Test 1: Viewer loads with synced annotations --
  try {
    console.log('Test 1: Viewer loads with synced annotations')
    page1 = await browser.newPage()
    page1.on('console', msg => {
      if (msg.type() === 'error') consoleErrors.tab1.push(msg.text())
    })

    await page1.goto(VIEWER_URL, { waitUntil: 'domcontentloaded', timeout: 20000 })
    await waitForEditor(page1)
    await sleep(2000)

    const mathNoteCount = await page1.evaluate(() => {
      const e = window.__tldraw_editor__
      return e.getCurrentPageShapes().filter(s => s.type === 'math-note').length
    })

    report('Viewer loads with synced annotations', mathNoteCount === 7,
      `expected 7 math-notes, got ${mathNoteCount}`)
  } catch (err) {
    report('Viewer loads with synced annotations', false, err.message)
  }

  // -- Test 2: REST API -> viewer sync --
  try {
    console.log('Test 2: REST API -> viewer sync')

    // Clean up in case a previous run left this shape
    await apiDelete(`/api/projects/${DOC}/shapes/${TEST_SHAPE_ID}`)
    await sleep(500)

    const createRes = await apiPost(`/api/projects/${DOC}/shapes`, {
      id: TEST_SHAPE_ID,
      type: 'math-note',
      typeName: 'shape',
      x: 50,
      y: 200,
      rotation: 0,
      index: 'aZ',
      parentId: 'page:page',
      isLocked: false,
      opacity: 1,
      props: { w: 200, h: 100, text: 'Created via REST', color: 'blue' },
      meta: {},
    })

    if (createRes.status !== 200) {
      report('REST API -> viewer sync', false,
        `POST returned ${createRes.status}: ${JSON.stringify(createRes.body)}`)
    } else {
      const found = await waitForShape(page1, TEST_SHAPE_ID, true, 5000)
      if (found) {
        const text = await page1.evaluate((id) => {
          return window.__tldraw_editor__.store.get(id)?.props?.text
        }, TEST_SHAPE_ID)
        report('REST API -> viewer sync', text === 'Created via REST',
          `shape text: "${text}"`)
      } else {
        report('REST API -> viewer sync', false, 'shape did not appear in viewer within 5s')
      }
    }
  } catch (err) {
    report('REST API -> viewer sync', false, err.message)
  }

  // -- Test 3: Two-tab sync --
  try {
    console.log('Test 3: Two-tab sync')
    page2 = await browser.newPage()
    page2.on('console', msg => {
      if (msg.type() === 'error') consoleErrors.tab2.push(msg.text())
    })

    await page2.goto(VIEWER_URL, { waitUntil: 'domcontentloaded', timeout: 20000 })
    await waitForEditor(page2)
    await sleep(2000)

    // Create a shape in tab1 via editor.createShape
    await page1.evaluate((id) => {
      window.__tldraw_editor__.createShape({
        id,
        type: 'math-note',
        x: 100,
        y: 300,
        props: { w: 180, h: 80, text: 'Two-tab test', color: 'green' },
      })
    }, TWO_TAB_SHAPE_ID)

    // Wait for it to appear in tab2
    const synced = await waitForShape(page2, TWO_TAB_SHAPE_ID, true, 5000)
    if (synced) {
      const text = await page2.evaluate((id) => {
        return window.__tldraw_editor__.store.get(id)?.props?.text
      }, TWO_TAB_SHAPE_ID)
      report('Two-tab sync', text === 'Two-tab test',
        `tab2 received shape with text: "${text}"`)
    } else {
      report('Two-tab sync', false, 'shape did not appear in tab2 within 5s')
    }
  } catch (err) {
    report('Two-tab sync', false, err.message)
  }

  // -- Test 4: Shape deletion sync --
  try {
    console.log('Test 4: Shape deletion sync')

    const delRes = await apiDelete(`/api/projects/${DOC}/shapes/${TEST_SHAPE_ID}`)
    if (delRes.status !== 200) {
      report('Shape deletion sync', false, `DELETE returned ${delRes.status}`)
    } else {
      const goneTab1 = await waitForShape(page1, TEST_SHAPE_ID, false, 5000)
      const goneTab2 = await waitForShape(page2, TEST_SHAPE_ID, false, 5000)
      report('Shape deletion sync', goneTab1 && goneTab2,
        `tab1=${goneTab1 ? 'gone' : 'still present'}, tab2=${goneTab2 ? 'gone' : 'still present'}`)
    }
  } catch (err) {
    report('Shape deletion sync', false, err.message)
  }

  // -- Test 5: Console errors --
  try {
    console.log('Test 5: Console errors')
    const filterNoise = (errors) => errors.filter(e =>
      !e.includes('favicon.ico') &&
      !e.includes('ResizeObserver') &&
      !e.includes('net::ERR_')
    )
    const tab1Errors = filterNoise(consoleErrors.tab1)
    const tab2Errors = filterNoise(consoleErrors.tab2)
    const totalErrors = tab1Errors.length + tab2Errors.length

    if (totalErrors === 0) {
      report('Console errors', true, 'no JS errors in either tab')
    } else {
      const detail = []
      if (tab1Errors.length) detail.push(`tab1: ${tab1Errors.join('; ')}`)
      if (tab2Errors.length) detail.push(`tab2: ${tab2Errors.join('; ')}`)
      report('Console errors', false, detail.join(' | '))
    }
  } catch (err) {
    report('Console errors', false, err.message)
  }

  // -- Cleanup --
  console.log('\nCleaning up test shapes...')
  await apiDelete(`/api/projects/${DOC}/shapes/${TEST_SHAPE_ID}`).catch(() => {})
  await apiDelete(`/api/projects/${DOC}/shapes/${TWO_TAB_SHAPE_ID}`).catch(() => {})

  if (page1) {
    await page1.evaluate((ids) => {
      const e = window.__tldraw_editor__
      if (!e) return
      ids.forEach(id => { try { e.deleteShape(id) } catch {} })
    }, [TEST_SHAPE_ID, TWO_TAB_SHAPE_ID]).catch(() => {})
  }

  await browser.close()

  // -- Summary --
  console.log('\n+------------------------------------------------+--------+')
  console.log('| Test                                           | Result |')
  console.log('+------------------------------------------------+--------+')
  for (const r of results) {
    const name = r.name.padEnd(46)
    const status = r.pass ? ' PASS ' : ' FAIL '
    console.log(`| ${name} | ${status} |`)
  }
  console.log('+------------------------------------------------+--------+')

  const failed = results.filter(r => !r.pass).length
  console.log(`\n${results.length} tests, ${results.length - failed} passed, ${failed} failed\n`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch(err => {
  console.error('Fatal error:', err)
  if (browser) browser.close().catch(() => {})
  process.exit(2)
})
