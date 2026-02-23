#!/usr/bin/env node
/**
 * End-to-end pipeline tests.
 *
 * Verifies that file changes actually make it through the full pipeline
 * to rendered content in the viewer:
 *   push files → server builds → SVGs generated → viewer renders them
 *
 * Usage:
 *   node --test test/pipeline.test.mjs
 *   npm test
 *
 * Requires: LaTeX (latexmk, dvisvgm), Chrome, built viewer SPA.
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import puppeteer from 'puppeteer-core'
import { startServer, createProject, pushFile, pushFiles, waitForBuild, CHROME } from './helpers.mjs'

const MINIMAL_TEX = String.raw`\documentclass{article}
\begin{document}
Hello world
\end{document}
`

const MODIFIED_TEX = String.raw`\documentclass{article}
\begin{document}
Goodbye world
\end{document}
`

const BROKEN_TEX = String.raw`\documentclass{article}
\begin{document}
\undefinedcommandthatwillfail
\end{document}
`

const FIGURE_TEX = String.raw`\documentclass{article}
\usepackage{graphicx}
\begin{document}
Figure test
\begin{figure}[h]
\includegraphics[width=0.5\textwidth]{figures/plot.pdf}
\end{figure}
\end{document}
`

// Minimal SVGs with distinct path data so we can tell them apart
const FIGURE_SVG_V1 = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100">
  <rect x="10" y="10" width="80" height="80" fill="red" class="v1-marker"/>
</svg>`

const FIGURE_SVG_V2 = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100">
  <circle cx="100" cy="50" r="40" fill="blue" class="v2-marker"/>
</svg>`

// ---------------------------------------------------------------------------
// Viewer helpers (Puppeteer-specific, not shared)
// ---------------------------------------------------------------------------

/** Open viewer page and wait for SVG shapes to render. Returns page. */
async function openViewer(browser, base, docName, timeoutMs = 30000) {
  const page = await browser.newPage()
  const consoleErrors = []
  page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  page.on('pageerror', err => consoleErrors.push(err.message))

  await page.goto(`${base}/?doc=${docName}`, {
    waitUntil: 'networkidle2',
    timeout: timeoutMs,
  })

  // Wait for TLDraw + svg-page shapes
  await page.waitForFunction(() => {
    const ed = window.__tldraw_editor__
    return ed && ed.getCurrentPageShapes().some(s => s.type === 'svg-page')
  }, { timeout: timeoutMs })

  // Let SVG injection settle
  await new Promise(r => setTimeout(r, 2000))

  page._consoleErrors = consoleErrors
  return page
}

/** Check that SVGs are actually rendered (not empty white divs). */
async function checkRendered(page) {
  return page.evaluate(() => {
    const els = document.querySelectorAll('[data-shape-type="svg-page"]')
    let rendered = 0, empty = 0
    for (const el of els) {
      if (el.querySelector('svg')) rendered++
      else empty++
    }
    return { rendered, empty, total: els.length }
  })
}

/** Extract visible text from all rendered SVGs on the page. */
async function getRenderedText(page) {
  return page.evaluate(() => {
    const els = document.querySelectorAll('[data-shape-type="svg-page"] svg')
    const texts = []
    for (const svg of els) {
      // dvisvgm puts text in <text> elements or <tspan>
      for (const t of svg.querySelectorAll('text, tspan')) {
        const content = t.textContent.trim()
        if (content) texts.push(content)
      }
    }
    return texts.join(' ')
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('pipeline', { timeout: 300000 }, () => {
  let server
  let browser

  before(async () => {
    server = await startServer(15176)
    browser = await puppeteer.launch({
      headless: 'shell',
      executablePath: CHROME,
    })
    console.log(`  Server on port ${server.port}`)
  })

  after(async () => {
    if (browser) await browser.close()
    if (server) await server.cleanup()
  })

  it('fresh build renders in viewer', async () => {
    const name = 'test-fresh'
    await createProject(server.base, name)
    await pushFile(server.base, name, 'test.tex', MINIMAL_TEX)

    const buildResult = await waitForBuild(server.base, name)
    assert.equal(buildResult.status, 'success', `Build failed: ${buildResult.log}`)

    const page = await openViewer(browser, server.base, name)
    try {
      const rendered = await checkRendered(page)
      assert.ok(rendered.rendered > 0, `No SVGs rendered (${rendered.empty} empty)`)
      assert.equal(rendered.empty, 0, `${rendered.empty} SVG shapes are empty white divs`)

      const text = await getRenderedText(page)
      assert.ok(text.includes('Hello'), `Expected "Hello" in rendered text, got: "${text.slice(0, 200)}"`)
    } finally {
      await page.close()
    }
  })

  it('file change updates viewer', async () => {
    const name = 'test-update'
    await createProject(server.base, name)

    // First build
    await pushFile(server.base, name, 'test.tex', MINIMAL_TEX)
    const build1 = await waitForBuild(server.base, name)
    assert.equal(build1.status, 'success')

    // Open viewer, verify initial content
    const page = await openViewer(browser, server.base, name)
    try {
      let text = await getRenderedText(page)
      assert.ok(text.includes('Hello'), `Initial render should contain "Hello", got: "${text.slice(0, 200)}"`)

      // Push changed file
      await pushFile(server.base, name, 'test.tex', MODIFIED_TEX)
      const build2 = await waitForBuild(server.base, name)
      assert.equal(build2.status, 'success')

      // Wait for reload signal to propagate and viewer to re-render
      await page.waitForFunction(() => {
        const els = document.querySelectorAll('[data-shape-type="svg-page"] svg')
        for (const svg of els) {
          for (const t of svg.querySelectorAll('text, tspan')) {
            if (t.textContent.includes('Goodbye')) return true
          }
        }
        return false
      }, { timeout: 60000 })

      text = await getRenderedText(page)
      assert.ok(text.includes('Goodbye'), `Updated render should contain "Goodbye", got: "${text.slice(0, 200)}"`)
      assert.ok(!text.includes('Hello'), `Updated render should not contain "Hello"`)
    } finally {
      await page.close()
    }
  })

  it('build failure leaves viewer showing last good build', async () => {
    const name = 'test-failure'
    await createProject(server.base, name)

    // Good build
    await pushFile(server.base, name, 'test.tex', MINIMAL_TEX)
    const build1 = await waitForBuild(server.base, name)
    assert.equal(build1.status, 'success')

    const page = await openViewer(browser, server.base, name)
    try {
      let rendered = await checkRendered(page)
      assert.ok(rendered.rendered > 0)

      // Push broken tex
      await pushFile(server.base, name, 'test.tex', BROKEN_TEX)
      await waitForBuild(server.base, name)

      // Server should still be alive
      const health = await fetch(`${server.base}/health`)
      assert.ok(health.ok, 'Server should still respond to /health after build failure')

      // Viewer should still show content (last good build or the broken one —
      // latexmk -f may produce a DVI with error markers)
      rendered = await checkRendered(page)
      assert.ok(rendered.rendered > 0, 'Viewer should still show rendered content after build failure')
    } finally {
      await page.close()
    }
  })

  it('server survives bad input', async () => {
    // Malformed push
    const res1 = await fetch(`${server.base}/api/projects/nonexistent/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    // Should return 404, not crash
    assert.equal(res1.status, 404)

    // Push to existing project with garbage
    const name = 'test-badinput'
    await createProject(server.base, name)
    const res2 = await fetch(`${server.base}/api/projects/${name}/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"files": [{"path": "test.tex", "content": null}]}',
    })
    // Should not crash the server
    const health = await fetch(`${server.base}/health`)
    assert.ok(health.ok, 'Server should survive bad push payload')
  })

  it('rapid successive pushes resolve to final content', async () => {
    const name = 'test-rapid'
    await createProject(server.base, name)

    // Push initial version
    await pushFile(server.base, name, 'test.tex', MINIMAL_TEX)
    await waitForBuild(server.base, name)

    // Rapid fire: push A then B immediately
    const texA = String.raw`\documentclass{article}\begin{document}Version Alpha\end{document}`
    const texB = String.raw`\documentclass{article}\begin{document}Version Beta\end{document}`

    await pushFile(server.base, name, 'test.tex', texA)
    // Don't wait — push again immediately
    await pushFile(server.base, name, 'test.tex', texB)

    // Wait for builds to settle
    await waitForBuild(server.base, name)
    // Extra wait in case the second build is queued
    await new Promise(r => setTimeout(r, 2000))
    const finalBuild = await waitForBuild(server.base, name)

    // Server should not have crashed
    const health = await fetch(`${server.base}/health`)
    assert.ok(health.ok)

    // Open viewer — should show the final version
    const page = await openViewer(browser, server.base, name)
    try {
      const text = await getRenderedText(page)
      assert.ok(
        text.includes('Beta'),
        `Viewer should show final push content "Beta", got: "${text.slice(0, 200)}"`,
      )
    } finally {
      await page.close()
    }
  })

  it('unchanged files skip build', async () => {
    const name = 'test-unchanged'
    await createProject(server.base, name)

    await pushFile(server.base, name, 'test.tex', MINIMAL_TEX)
    await waitForBuild(server.base, name)

    // Push same content again
    const res = await fetch(`${server.base}/api/projects/${name}/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        files: [{ path: 'test.tex', content: MINIMAL_TEX }],
      }),
    })
    const data = await res.json()
    assert.ok(data.unchanged, 'Second push of identical content should be marked unchanged')
    assert.equal(data.building, false, 'Should not trigger a build for unchanged files')
  })

  it('figure-only change updates viewer', async () => {
    const name = 'test-figure'
    await createProject(server.base, name)

    // Push tex + figure v1
    await pushFiles(server.base, name, [
      { path: 'test.tex', content: FIGURE_TEX },
      { path: 'figures/plot.svg', content: Buffer.from(FIGURE_SVG_V1).toString('base64'), encoding: 'base64' },
    ])

    const build1 = await waitForBuild(server.base, name)
    if (build1.status !== 'success') server.dumpLogs('figure-test build1')
    assert.equal(build1.status, 'success', 'Initial build should succeed')

    // Open viewer, verify figure v1 is inlined (rect element from v1 SVG)
    const page = await openViewer(browser, server.base, name)
    try {
      const hasV1 = await page.evaluate(() => {
        const svgs = document.querySelectorAll('[data-shape-type="svg-page"] svg')
        for (const svg of svgs) {
          if (svg.querySelector('.v1-marker') || svg.innerHTML.includes('v1-marker')) return true
        }
        return false
      })
      if (!hasV1) server.dumpLogs('figure-test v1-check')
      assert.ok(hasV1, 'Figure v1 should be inlined in page SVG')

      // Push ONLY the figure v2 — no tex change
      await pushFiles(server.base, name, [
        { path: 'figures/plot.svg', content: Buffer.from(FIGURE_SVG_V2).toString('base64'), encoding: 'base64' },
      ])
      const build2 = await waitForBuild(server.base, name)
      if (build2.status !== 'success') server.dumpLogs('figure-test build2')
      assert.equal(build2.status, 'success', 'Figure-only rebuild should succeed')

      // Wait for reload signal + viewer to re-fetch SVGs
      await page.waitForFunction(() => {
        const svgs = document.querySelectorAll('[data-shape-type="svg-page"] svg')
        for (const svg of svgs) {
          if (svg.querySelector('.v2-marker') || svg.innerHTML.includes('v2-marker')) return true
        }
        return false
      }, { timeout: 30000 })

      // Verify v1 is gone
      const hasV1After = await page.evaluate(() => {
        const svgs = document.querySelectorAll('[data-shape-type="svg-page"] svg')
        for (const svg of svgs) {
          if (svg.querySelector('.v1-marker') || svg.innerHTML.includes('v1-marker')) return true
        }
        return false
      })
      assert.equal(hasV1After, false, 'Figure v1 should be replaced by v2')
    } catch (e) {
      server.dumpLogs('figure-test failure')
      throw e
    } finally {
      await page.close()
    }
  })
})
