#!/usr/bin/env node
/**
 * tlda-test-setup — bring up a clean, agent-friendly test surface.
 *
 * Idempotent setup for any agent about to test viewer behavior in playwright:
 *   1. Ensure the `test-fleet` LaTeX project exists on the local server (creates + pushes
 *      a small canonical document if missing, then waits for build).
 *   2. Open the doc in chromium at a realistic laptop viewport (1280x800).
 *   3. Apply the default 3-column fleet layout via the FleetIconPill (drag gesture —
 *      same code path the user takes).
 *   4. Center the camera so all three columns + doc are visible.
 *
 * Yjs sync makes the resulting room state visible to any subsequent playwright
 * MCP session that opens the same URL. Run this once before testing; the canvas
 * state persists until you (or another agent) mutates it.
 *
 * Usage:
 *   node bin/tlda-test-setup.mjs            # default: 3col, 1280x800, headless
 *   node bin/tlda-test-setup.mjs --headed   # visible browser
 *   node bin/tlda-test-setup.mjs --keep-open  # don't close after setup (for debugging)
 *
 * The `test-fleet` project exists so agent activity stays out of Skip's real
 * rooms (survival-draft, bregman, etc). See ~/.claude/skills/test-as-the-user/.
 */

import { chromium } from 'playwright'
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const SERVER = process.env.TLDA_SERVER || 'http://localhost:5176'
const PROJECT = 'test-fleet'
const VIEWPORT = { width: 1280, height: 800 }
const HEADED = process.argv.includes('--headed')
const KEEP_OPEN = process.argv.includes('--keep-open')

const TEST_LATEX = String.raw`\documentclass[11pt]{article}
\usepackage{amsmath,amsthm,amssymb}
\usepackage[margin=1in]{geometry}

\newtheorem{theorem}{Theorem}
\newtheorem{lemma}{Lemma}
\newtheorem{definition}{Definition}

\title{Test Fleet Document}
\author{tlda test harness}
\date{}

\begin{document}
\maketitle

\section{Introduction}

This document is the canonical test surface for tlda agents. Its content is
deliberately ordinary so the focus stays on viewer behavior rather than
document content.

\begin{definition}
A \emph{test surface} is a document with enough structure (sections, math,
theorems, multiple pages) to exercise typical viewer interactions.
\end{definition}

Inline math: $\int_0^1 f(x)\, dx = F(1) - F(0)$. Display math:
$$\sum_{n=1}^{\infty} \frac{1}{n^2} = \frac{\pi^2}{6}.$$

\section{A Theorem and Its Proof}

\begin{theorem}\label{thm:main}
Let $f : [0,1] \to \mathbb{R}$ be continuous. Then $f$ is uniformly
continuous on $[0,1]$.
\end{theorem}

\begin{proof}
Suppose for contradiction that $f$ is not uniformly continuous. Then there
exists $\varepsilon > 0$ and sequences $(x_n), (y_n) \subset [0,1]$ with
$|x_n - y_n| \to 0$ but $|f(x_n) - f(y_n)| \geq \varepsilon$ for all $n$.

By Bolzano--Weierstrass, $(x_n)$ has a convergent subsequence
$x_{n_k} \to x \in [0,1]$. Since $|x_{n_k} - y_{n_k}| \to 0$, also
$y_{n_k} \to x$. Continuity of $f$ at $x$ gives
$f(x_{n_k}) \to f(x)$ and $f(y_{n_k}) \to f(x)$, so
$|f(x_{n_k}) - f(y_{n_k})| \to 0$, contradicting the assumption.
\end{proof}

\section{A Second Page of Content}

\begin{lemma}
Every Cauchy sequence in $\mathbb{R}$ converges.
\end{lemma}

This page exists so the document has more than one page — useful for testing
scroll, page-fetch, and proof-pairing behaviors in the viewer.

\subsection{More math}

The Cauchy--Schwarz inequality:
$$\left| \sum_{i=1}^n a_i b_i \right| \leq \sqrt{\sum_{i=1}^n a_i^2} \sqrt{\sum_{i=1}^n b_i^2}.$$

The triangle inequality, in $\mathbb{R}^n$:
$$\|x + y\| \leq \|x\| + \|y\|.$$

\section{A Third Page}

This section pads to a third page so multi-page behaviors (page navigation,
viewport-driven fetch, etc.) have something to exercise. The text here is
filler.

\subsection{Filler}

Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor
incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis
nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.

Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore
eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt
in culpa qui officia deserunt mollit anim id est laborum.

\subsection{More filler}

Sed ut perspiciatis unde omnis iste natus error sit voluptatem accusantium
doloremque laudantium, totam rem aperiam, eaque ipsa quae ab illo inventore
veritatis et quasi architecto beatae vitae dicta sunt explicabo.

\end{document}
`

function readToken() {
  const cfgPath = join(homedir(), '.config', 'tlda', 'config.json')
  if (!existsSync(cfgPath)) {
    throw new Error(`Missing tlda config at ${cfgPath}`)
  }
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
  const token = cfg.tokenRw || cfg.token
  if (!token) throw new Error('No tokenRw or token in tlda config')
  return token
}

async function api(method, path, body, token) {
  const res = await fetch(`${SERVER}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch {}
  if (!res.ok) {
    const msg = json?.error || text || res.statusText
    const err = new Error(`${method} ${path} → ${res.status}: ${msg}`)
    err.status = res.status
    throw err
  }
  return json
}

async function waitForBuildSettle(token) {
  for (let i = 0; i < 120; i++) {
    const status = await api('GET', `/api/projects/${PROJECT}/build/status`, null, token).catch(() => null)
    if (!status) { await new Promise(r => setTimeout(r, 1000)); continue }
    if (status.status === 'success') return
    if (status.status === 'error' || status.status === 'failed') {
      // bibtex failures are non-fatal — pages still render. Only bail on real errors.
      const log = (status.log || '').toString()
      if (log.includes('bibtex failed') && !log.includes('LaTeX Error')) return
      throw new Error(`build failed: ${log.slice(-500) || 'see build.log'}`)
    }
    await new Promise(r => setTimeout(r, 1000))
  }
  throw new Error('build did not settle in 120s')
}

async function ensureProject(token) {
  let existing = null
  try {
    existing = await api('GET', `/api/projects/${PROJECT}`, null, token)
  } catch (e) {
    if (e.status !== 404) throw e
  }

  if (existing) {
    const matches = existing.mainFile === 'main.tex' && existing.format !== 'book'
    const looksDisposable = !existing.sourceDir || existing.sourceDir.startsWith('/tmp/')
    if (matches) {
      console.log(`✓ project "${PROJECT}" exists (main.tex, ${existing.pages || '?'} pages)`)
      await waitForBuildSettle(token)
      return false
    }
    if (!looksDisposable) {
      throw new Error(
        `project "${PROJECT}" exists with mainFile=${existing.mainFile} and sourceDir=${existing.sourceDir}. ` +
        `That doesn't look disposable — refusing to clobber. Delete it manually first if you want this script to recreate it.`
      )
    }
    console.log(`replacing stale "${PROJECT}" (mainFile=${existing.mainFile}, sourceDir=${existing.sourceDir})…`)
    await api('DELETE', `/api/projects/${PROJECT}`, null, token)
  }

  console.log(`creating project "${PROJECT}"…`)
  await api('POST', '/api/projects', {
    name: PROJECT,
    title: 'Test Fleet (agent test surface)',
    mainFile: 'main.tex',
  }, token)

  console.log('pushing main.tex…')
  await api('POST', `/api/projects/${PROJECT}/push`, {
    files: [{
      path: 'main.tex',
      content: Buffer.from(TEST_LATEX).toString('base64'),
      encoding: 'base64',
    }],
  }, token)

  // SVG/LaTeX projects don't auto-build on push (the source.stamp marker
  // triggers a build on the next page request). Kick it explicitly so the
  // viewer has pages ready before we apply the layout.
  console.log('triggering build…')
  await api('POST', `/api/projects/${PROJECT}/build`, {}, token)

  console.log('waiting for build…')
  for (let i = 0; i < 120; i++) {
    await new Promise(r => setTimeout(r, 1000))
    const status = await api('GET', `/api/projects/${PROJECT}/build/status`, null, token).catch(() => null)
    if (!status) continue
    if (status.status === 'success') {
      const proj = await api('GET', `/api/projects/${PROJECT}`, null, token)
      console.log(`✓ build complete (${proj.pages || '?'} pages)`)
      return true
    }
    if (status.status === 'error' || status.status === 'failed') {
      throw new Error(`build failed: ${status.log?.slice(-500) || 'see build.log'}`)
    }
  }
  throw new Error('build did not complete in 120s')
}

async function applyLayoutAndCamera(page) {
  // Wait for tldraw editor to mount.
  await page.waitForFunction(() => !!(window).__tldraw_editor__, null, { timeout: 30000 })

  // Wait for at least one svg-page shape (so the doc has rendered).
  await page.waitForFunction(() => {
    const ed = (window).__tldraw_editor__
    return ed && ed.getCurrentPageShapes().some(s => s.type === 'svg-page' || s.type === 'html-page')
  }, null, { timeout: 30000 })

  // Frame the camera FIRST so createFleetLayout sees the final doc position
  // when it computes anchor coordinates and the FleetHUD computes its
  // panOffset.
  await page.evaluate(() => {
    const ed = (window).__tldraw_editor__
    const pages = ed.getCurrentPageShapes()
      .filter(s => s.type === 'svg-page' || s.type === 'html-page')
    if (pages.length === 0) return
    const first = pages.slice().sort((a, b) => {
      const ba = ed.getShapePageBounds(a.id)
      const bb = ed.getShapePageBounds(b.id)
      if (!ba || !bb) return 0
      return ba.y - bb.y || ba.x - bb.x
    })[0]
    const b = ed.getShapePageBounds(first.id)
    if (!b) return
    // Pad bounds to the LEFT by 1.0× page width so the doc lands on the right
    // half of the viewport — leaves room for the FleetHUD overlay on the left.
    const padLeft = b.w * 1.0
    ed.zoomToBounds(
      { x: b.x - padLeft, y: b.y, w: b.w + padLeft, h: b.h },
      { inset: 16, animation: { duration: 0 } }
    )
    // Clear any stale HUD position from prior sessions so the layout step
    // recomputes against the current camera.
    try { localStorage.removeItem('fleet-hud-panOffset') } catch {}
    try { localStorage.removeItem('fleet-hud-override') } catch {}
  })
  console.log('✓ camera framed (doc right, fleet left)')

  // Wait for the FleetIconPill (and the fleet agent list) to be ready.
  await page.waitForSelector('.fleet-icon-pill-container', { timeout: 15000 })

  // Drag the pill ~22px to the right to select preset 0 = 3col.
  // Drag formula in FleetIconPill: idx = floor((dx) / (ITEM_W + ITEM_GAP)) = floor(dx / 44).
  // Threshold to activate drag is 6px. So 22px lands cleanly inside idx=0.
  const pill = await page.$('.fleet-icon-pill-container')
  const box = await pill.boundingBox()
  const startX = box.x + box.width / 2
  const startY = box.y + box.height / 2

  await page.mouse.move(startX, startY)
  await page.mouse.down()
  // Move past threshold (8px), then settle on idx=0.
  await page.mouse.move(startX + 10, startY, { steps: 5 })
  await page.mouse.move(startX + 22, startY, { steps: 5 })
  await page.waitForTimeout(150)
  await page.mouse.up()

  // Confirm fleet shapes were created.
  await page.waitForFunction(() => {
    const ed = (window).__tldraw_editor__
    if (!ed) return false
    const fleet = ed.getCurrentPageShapes().filter(s =>
      ['fleet-chat', 'fleet-agents', 'fleet-search', 'fleet-docview'].includes(s.type))
    return fleet.length >= 4
  }, null, { timeout: 10000 })

  const counts = await page.evaluate(() => {
    const ed = (window).__tldraw_editor__
    const types = {}
    for (const s of ed.getCurrentPageShapes()) types[s.type] = (types[s.type] || 0) + 1
    return types
  })
  console.log('✓ fleet shapes:', counts)

  // Give the FleetHUD overlay time to settle into its computed position.
  await page.waitForTimeout(500)
}

async function main() {
  const token = readToken()

  // 1. Ensure project exists and is built.
  await ensureProject(token)

  // 2. Open the viewer.
  const url = `${SERVER}/?doc=${PROJECT}&name=tester&token=${token}`
  console.log(`opening ${url}`)
  const browser = await chromium.launch({ headless: !HEADED })
  const context = await browser.newContext({ viewport: VIEWPORT })
  const page = await context.newPage()
  page.on('pageerror', e => console.error('  [page error]', e.message))
  page.on('console', msg => {
    if (msg.type() === 'error') console.error('  [console]', msg.text())
  })
  // Pre-set localStorage so the FleetHUD overlay is expanded by default.
  // A fresh browser context has no localStorage; without this the HUD stays
  // collapsed and the test surface looks like the user has hidden fleet.
  await page.addInitScript(() => {
    try { localStorage.setItem('fleet-hud-expanded', '1') } catch {}
  })
  await page.goto(url, { waitUntil: 'domcontentloaded' })

  // 3. Apply 3-col layout + center camera.
  try {
    await applyLayoutAndCamera(page)
  } catch (e) {
    try {
      await page.screenshot({ path: '/tmp/tlda-test-setup-failure.png', fullPage: false })
      console.error('  saved failure screenshot to /tmp/tlda-test-setup-failure.png')
    } catch {}
    throw e
  }

  // 4. Save a verification screenshot so the human (or this script's caller)
  // can sanity-check the layout — three fleet columns + doc, no overlap.
  const shotPath = '/tmp/tlda-test-setup.png'
  await page.screenshot({ path: shotPath, fullPage: false })
  console.log(`✓ verification screenshot: ${shotPath}`)

  if (KEEP_OPEN) {
    console.log('--keep-open: leaving browser running. Ctrl-C to exit.')
    await new Promise(() => {})
  } else {
    await browser.close()
    console.log('done. test-fleet is ready for agents to open.')
  }
}

main().catch(err => {
  console.error('test-setup failed:', err.message)
  process.exit(1)
})
