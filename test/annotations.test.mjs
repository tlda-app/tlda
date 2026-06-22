#!/usr/bin/env node
/**
 * Annotation & text-sync end-to-end tests.
 *
 * Verifies that the annotation pipeline works correctly:
 *   synctex lookup → SVG text extraction → shape API storage → source anchoring
 *
 * Usage:
 *   node --test test/annotations.test.mjs
 *
 * Requires: LaTeX (latexmk, dvisvgm).
 * Does NOT require Chrome/Puppeteer — tests the data layer directly.
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startServer, createProject, pushFile, pushFiles, waitForBuild, ROOT } from './helpers.mjs'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

// Layout constants — same as mcp-server/index.mjs
const _lc = JSON.parse(readFileSync(join(ROOT, 'shared', 'layout-constants.json'), 'utf8'))
const PDF_WIDTH = _lc.PDF_WIDTH       // 612
const PDF_HEIGHT = _lc.PDF_HEIGHT     // 792
const TARGET_WIDTH = _lc.TARGET_WIDTH // 800
const PAGE_GAP = _lc.PAGE_GAP         // 32
const PAGE_HEIGHT = PDF_HEIGHT * (TARGET_WIDTH / PDF_WIDTH)

const VIEWBOX_OFFSET = 72
function pdfToCanvas(page, pdfX, pdfY) {
  const scaleX = TARGET_WIDTH / PDF_WIDTH
  const scaleY = PAGE_HEIGHT / PDF_HEIGHT
  return {
    x: (pdfX + VIEWBOX_OFFSET) * scaleX,
    y: (page - 1) * (PAGE_HEIGHT + PAGE_GAP) + (pdfY + VIEWBOX_OFFSET) * scaleY,
  }
}

// ---------------------------------------------------------------------------
// Test tex content — short, deterministic, distinctive per line
// ---------------------------------------------------------------------------

const ANNOT_TEX = String.raw`\documentclass{article}
\begin{document}
\section{Introduction}
The quick brown fox jumps over the lazy dog.
This is the second paragraph with a known formula $x^2 + y^2 = z^2$.

\section{Results}
Here we present our main theorem.
\begin{theorem}
For all $n \geq 1$, the inequality $a_n \leq b_n$ holds.
\end{theorem}
\begin{proof}
The proof follows by induction on $n$.
\end{proof}

\section{Conclusion}
This completes the argument.
\end{document}
`

// Modified version with extra lines before "quick brown fox" to test line shift
const ANNOT_TEX_SHIFTED = String.raw`\documentclass{article}
\begin{document}
\section{Introduction}
This is a new first line that was not here before.
And another new line for good measure.
And yet a third new line to really shift things.
The quick brown fox jumps over the lazy dog.
This is the second paragraph with a known formula $x^2 + y^2 = z^2$.

\section{Results}
Here we present our main theorem.
\begin{theorem}
For all $n \geq 1$, the inequality $a_n \leq b_n$ holds.
\end{theorem}
\begin{proof}
The proof follows by induction on $n$.
\end{proof}

\section{Conclusion}
This completes the argument.
\end{document}
`

const MULTI_MAIN_TEX = String.raw`\documentclass{article}
\begin{document}
\section{Main Body}
Content in the main file.
\input{appendix}
\end{document}
`

const MULTI_APPENDIX_TEX = String.raw`\section{Appendix}
This is appendix content with formula $e^{i\pi} + 1 = 0$.
`

// ---------------------------------------------------------------------------
// Shape API test client
// ---------------------------------------------------------------------------

/** Create a math-note shape through the server shape API. */
async function createAnnotation(base, project, { id, x, y, text, sourceAnchor, color = 'violet' }) {
  const shape = {
    id,
    typeName: 'shape',
    type: 'math-note',
    x,
    y,
    rotation: 0,
    isLocked: false,
    opacity: 1,
    parentId: 'page:page',
    index: 'a1',
    props: {
      text,
      color,
      w: 200,
      h: 150,
      tabs: [text],
      activeTab: 0,
    },
    meta: {
      sourceAnchor: sourceAnchor || null,
    },
  }
  const res = await fetch(`${base}/api/projects/${project}/shapes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(shape),
  })
  if (!res.ok) assert.fail(`create shape failed: ${res.status} ${await res.text()}`)
}

/** Read all math-note shapes through the server shape API. */
async function readAnnotations(base, project) {
  const res = await fetch(`${base}/api/projects/${project}/shapes?type=math-note`)
  if (!res.ok) assert.fail(`read shapes failed: ${res.status} ${await res.text()}`)
  const records = await res.json()
  return records.map(val => ({
    id: val.id,
    text: val.props?.text,
    color: val.props?.color,
    x: val.x,
    y: val.y,
    sourceAnchor: val.meta?.sourceAnchor,
    tabs: val.props?.tabs,
  }))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('annotations', { timeout: 300000 }, () => {
  let server
  const PROJECT = 'test-annot'

  before(async () => {
    server = await startServer(15178)
    console.log(`  Server on port ${server.port}`)

    // Build the test document
    await createProject(server.base, PROJECT)
    await pushFile(server.base, PROJECT, 'test.tex', ANNOT_TEX)
    const build = await waitForBuild(server.base, PROJECT)
    if (build.status !== 'success') server.dumpLogs('annot-build')
    assert.equal(build.status, 'success', 'Test document build should succeed')
  })

  after(async () => {
    if (server) await server.cleanup()
  })

  // ---- Test 1: lookup.json correctness ----

  it('lookup.json has correct entries for known content', async () => {
    const res = await fetch(`${server.base}/docs/${PROJECT}/lookup.json`)
    assert.ok(res.ok, 'Should be able to fetch lookup.json')
    const lookup = await res.json()

    // Meta
    assert.equal(lookup.meta.texFile, 'test.tex')

    // Should have line entries
    const lineKeys = Object.keys(lookup.lines)
    assert.ok(lineKeys.length > 0, 'lookup.json should have line entries')

    // Find the "quick brown fox" line by content fingerprint
    let foxEntry = null
    let foxLine = null
    for (const [line, entry] of Object.entries(lookup.lines)) {
      if (entry.content && entry.content.includes('quick brown fox')) {
        foxEntry = entry
        foxLine = line
        break
      }
    }
    assert.ok(foxEntry, 'Should find "quick brown fox" in lookup content fingerprints')
    assert.equal(foxEntry.page, 1, 'Test doc is 1 page')
    assert.ok(foxEntry.x >= 0 && foxEntry.x <= 612, `x coord ${foxEntry.x} should be in PDF range`)
    assert.ok(foxEntry.y >= 0 && foxEntry.y <= 792, `y coord ${foxEntry.y} should be in PDF range`)

    // Find "Introduction" section heading
    let hasIntro = false
    for (const entry of Object.values(lookup.lines)) {
      if (entry.content && entry.content.includes('Introduction')) {
        hasIntro = true
        break
      }
    }
    assert.ok(hasIntro, 'Should find "Introduction" in lookup fingerprints')
  })

  // ---- Test 2: SVG text extraction ----

  it('SVG text extraction matches source content', async () => {
    const { loadPageText } = await import('../mcp-server/svg-text.mjs')
    const svgPath = join(server.projectsDir, PROJECT, 'output', 'test-page-1.svg')
    const result = loadPageText(svgPath)

    assert.ok(result.lines.length > 0, 'Should extract text lines from SVG')
    assert.ok(result.viewBox.width > 0, 'viewBox should have width')

    const allText = result.lines.map(l => l.text).join(' ')

    // These strings should appear in the rendered SVG
    assert.ok(allText.includes('Introduction'), `Should contain "Introduction", got: "${allText.slice(0, 300)}"`)
    assert.ok(
      allText.includes('quick') || allText.includes('brown') || allText.includes('fox'),
      `Should contain words from "quick brown fox" line`
    )
    assert.ok(
      allText.includes('Conclusion') || allText.includes('completes'),
      `Should contain words from conclusion section`
    )
  })

  // ---- Test 3: Annotation round-trip via shape API ----

  it('annotation round-trips correctly via shape API', async () => {
    // Get a position from lookup
    const res = await fetch(`${server.base}/docs/${PROJECT}/lookup.json`)
    const lookup = await res.json()

    // Find the fox line
    let foxLine = null, foxEntry = null
    for (const [line, entry] of Object.entries(lookup.lines)) {
      if (entry.content?.includes('quick brown fox')) {
        foxLine = line
        foxEntry = entry
        break
      }
    }
    assert.ok(foxEntry, 'Need fox entry for this test')

    const canvasPos = pdfToCanvas(foxEntry.page, foxEntry.x, foxEntry.y)

    const shapeId = 'shape:test-annot-1'
    await createAnnotation(server.base, PROJECT, {
      id: shapeId,
      x: canvasPos.x + TARGET_WIDTH + 20, // right margin
      y: canvasPos.y,
      text: 'Test annotation on fox line',
      sourceAnchor: {
        file: './test.tex',
        line: parseInt(foxLine),
        column: -1,
        content: foxEntry.content,
      },
    })

    const notes = await readAnnotations(server.base, PROJECT)
    const created = notes.find(n => n.id === shapeId)
    assert.ok(created, 'Created annotation should be readable')
    assert.equal(created.text, 'Test annotation on fox line')
    assert.equal(created.sourceAnchor.file, './test.tex')
    assert.equal(created.sourceAnchor.line, parseInt(foxLine))
    assert.ok(created.sourceAnchor.content.includes('quick brown fox'))
  })

  // ---- Test 4: Content fingerprint survives line shift ----

  it('content fingerprint survives line shift after rebuild', async () => {
    // Get original fox line from lookup
    const res1 = await fetch(`${server.base}/docs/${PROJECT}/lookup.json`)
    const lookup1 = await res1.json()

    let origFoxLine = null
    for (const [line, entry] of Object.entries(lookup1.lines)) {
      if (entry.content?.includes('quick brown fox')) {
        origFoxLine = parseInt(line)
        break
      }
    }
    assert.ok(origFoxLine, 'Should find fox line in original lookup')

    // Push shifted tex (3 new lines before fox)
    await pushFile(server.base, PROJECT, 'test.tex', ANNOT_TEX_SHIFTED)
    const build = await waitForBuild(server.base, PROJECT)
    if (build.status !== 'success') server.dumpLogs('shift-build')
    assert.equal(build.status, 'success', 'Shifted build should succeed')

    // Fetch new lookup
    const res2 = await fetch(`${server.base}/docs/${PROJECT}/lookup.json`)
    const lookup2 = await res2.json()

    // Find fox line in new lookup
    let newFoxLine = null
    for (const [line, entry] of Object.entries(lookup2.lines)) {
      if (entry.content?.includes('quick brown fox')) {
        newFoxLine = parseInt(line)
        break
      }
    }
    assert.ok(newFoxLine, 'Should still find "quick brown fox" in shifted lookup')
    assert.ok(newFoxLine > origFoxLine, `Fox line should have shifted down: was ${origFoxLine}, now ${newFoxLine}`)
    assert.equal(newFoxLine, origFoxLine + 3, `Fox line should shift by exactly 3 (was ${origFoxLine}, now ${newFoxLine})`)

    // Restore original tex for subsequent tests
    await pushFile(server.base, PROJECT, 'test.tex', ANNOT_TEX)
    const restore = await waitForBuild(server.base, PROJECT)
    assert.equal(restore.status, 'success')
  })

  // ---- Test 5: Rendered text at annotation position ----

  it('rendered text at lookup position matches source content', async () => {
    const { loadPageText } = await import('../mcp-server/svg-text.mjs')

    // Get lookup data
    const res = await fetch(`${server.base}/docs/${PROJECT}/lookup.json`)
    const lookup = await res.json()

    // Find fox entry
    let foxEntry = null
    for (const entry of Object.values(lookup.lines)) {
      if (entry.content?.includes('quick brown fox')) {
        foxEntry = entry
        break
      }
    }
    assert.ok(foxEntry, 'Need fox entry')

    // Load the SVG page text
    const svgPath = join(server.projectsDir, PROJECT, 'output', `test-page-${foxEntry.page}.svg`)
    const pageData = loadPageText(svgPath)

    // The lookup y is in PDF coordinates. Convert to SVG viewBox coordinates.
    // lookup.json y values come from synctex which uses the same coordinate system
    // as the SVG viewBox (origin at top-left, y increases downward).
    const svgY = foxEntry.y

    // Find text lines near this y position (within a generous margin)
    const margin = 15
    const nearbyLines = pageData.lines.filter(
      l => l.y >= svgY - margin && l.y <= svgY + margin
    )

    assert.ok(nearbyLines.length > 0, `Should find text lines near y=${svgY.toFixed(1)}`)

    const nearbyText = nearbyLines.map(l => l.text).join(' ')
    assert.ok(
      nearbyText.includes('quick') || nearbyText.includes('brown') || nearbyText.includes('fox'),
      `Text near fox lookup position should contain fox-related words, got: "${nearbyText}"`
    )
  })

  // ---- Test 6: Multi-file project ----

  describe('multi-file project', () => {
    const MULTI_PROJECT = 'test-multi'

    before(async () => {
      await createProject(server.base, MULTI_PROJECT, 'main.tex')
      await pushFiles(server.base, MULTI_PROJECT, [
        { path: 'main.tex', content: MULTI_MAIN_TEX },
        { path: 'appendix.tex', content: MULTI_APPENDIX_TEX },
      ])
      const build = await waitForBuild(server.base, MULTI_PROJECT)
      if (build.status !== 'success') server.dumpLogs('multi-build')
      assert.equal(build.status, 'success', 'Multi-file build should succeed')
    })

    it('lookup.json contains input file entries', async () => {
      const res = await fetch(`${server.base}/docs/${MULTI_PROJECT}/lookup.json`)
      const lookup = await res.json()

      // Should mention appendix in inputFiles or have appendix.tex keys
      const lineKeys = Object.keys(lookup.lines)
      const appendixKeys = lineKeys.filter(k => k.startsWith('appendix.tex:'))
      assert.ok(
        appendixKeys.length > 0,
        `Should have appendix.tex:N keys in lookup, got keys: ${lineKeys.slice(0, 20).join(', ')}`
      )

      // Verify appendix content fingerprint
      let hasAppendixContent = false
      for (const key of appendixKeys) {
        const entry = lookup.lines[key]
        if (entry.content && (entry.content.includes('appendix') || entry.content.includes('Appendix') || entry.content.includes('formula'))) {
          hasAppendixContent = true
          break
        }
      }
      assert.ok(hasAppendixContent, 'Appendix entries should have recognizable content fingerprints')
    })

    it('annotation on input file round-trips via shape API', async () => {
      const res = await fetch(`${server.base}/docs/${MULTI_PROJECT}/lookup.json`)
      const lookup = await res.json()

      // Find an appendix line
      let appendixLine = null, appendixEntry = null
      for (const [key, entry] of Object.entries(lookup.lines)) {
        if (key.startsWith('appendix.tex:')) {
          appendixLine = key
          appendixEntry = entry
          break
        }
      }
      assert.ok(appendixEntry, 'Need an appendix lookup entry')

      const canvasPos = pdfToCanvas(appendixEntry.page, appendixEntry.x, appendixEntry.y)

      const shapeId = 'shape:test-multi-annot'
      const lineNum = parseInt(appendixLine.split(':')[1])
      await createAnnotation(server.base, MULTI_PROJECT, {
        id: shapeId,
        x: canvasPos.x + TARGET_WIDTH + 20,
        y: canvasPos.y,
        text: 'Note on appendix line',
        sourceAnchor: {
          file: './appendix.tex',
          line: lineNum,
          column: -1,
          content: appendixEntry.content,
        },
      })

      const notes = await readAnnotations(server.base, MULTI_PROJECT)
      const created = notes.find(n => n.id === shapeId)
      assert.ok(created, 'Should create annotation on input file')
      assert.equal(created.sourceAnchor.file, './appendix.tex')
      assert.equal(created.sourceAnchor.line, lineNum)
    })
  })
})
