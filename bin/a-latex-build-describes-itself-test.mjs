#!/usr/bin/env node
// A LaTeX build has to DESCRIBE what it built, or it cannot pass through the
// same completion boundary as every other renderer.
//
// `buildDocument()` refuses an adapter that returns no manifest, and the
// registry's `latex` adapter IS `runBuild`. So until runBuild returned one, the
// registry named an adapter nothing could call and production kept its own
// format dispatch -- which is the gap this RC exists to close.
//
// THREE CONTROLS, because two of the three facts in a manifest were being
// asserted rather than measured:
//
//   paged Letter  -- an article with no papersize special; the driver default,
//                    which is the US Letter constant
//   non-Letter    -- an a4paper article; `geometry` writes a papersize special
//   Beamer        -- 128x96mm landscape AND presentation: true
//
// Page geometry comes from the DVI, not from an emitted SVG, because a LaTeX
// build emits none: pages are rendered on demand by `buildCurrentPage`. Listing
// a real build's whole `output/` shows a DVI, synctex and lookup maps and no
// `-page-N.svg`. dvisvgm is invoked with `--bbox=papersize`, so the DVI's
// `papersize` special IS the size the renderer will use -- reading it is reading
// the same fact one step earlier, and it needs no renderer at all. That matters
// here: this machine's dvisvgm fails on Beamer's pgf with a PostScript error, and
// the geometry proof does not depend on it.
//
// A script rather than a `node --test` file, and ending in process.exit(0), for
// the same reason as its neighbours: the build stack holds handles open and the
// runner hangs rather than reporting.
//
// RUN IT OUTSIDE THE FENCE: `env -u FLEET_ID node bin/a-latex-build-describes-itself-test.mjs`.
// ~/.claude/bin/pdflatex exits 64 without compiling when FLEET_ID is set, so an
// agent-run build fails with "DVI file not created" for a reason that has
// nothing to do with the code under test.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { initProjectStore, createProject, sourceDir } = await import('../server/lib/project-store.mjs')
const { initSyncRooms } = await import('../server/lib/sync-rooms.mjs')
const { runBuild } = await import('../server/lib/build-runner.mjs')
const { normalizeDocumentManifest } = await import('../server/lib/document-manifest.mjs')

try {
  execFileSync('pdflatex', ['--version'], { stdio: 'ignore' })
} catch {
  console.log('SKIP: no usable pdflatex on PATH (run with env -u FLEET_ID)')
  process.exit(0)
}

const PAGED_VIEW = { kind: 'svg-pages', capabilities: { presentation: false, sourceMapping: true, searchableText: false } }
const SLIDES_VIEW = { kind: 'svg-pages', capabilities: { presentation: true, sourceMapping: true, searchableText: false } }

// A store per control. Building three projects into one store made the second
// fail in the shadow-repo path on `git config user.email` — a local config write
// in a directory that is not a repo yet. That is not what this test is about,
// and one document per store is the honest isolation anyway: a control that
// only passes when its siblings ran first is not a control.
async function build(name, tex, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'latex-manifest-'))
  await initProjectStore(root)
  initSyncRooms(root)
  createProject({ name, title: name, mainFile: 'main.tex' })
  const src = sourceDir(name)
  mkdirSync(src, { recursive: true })
  writeFileSync(join(src, 'main.tex'), tex)
  const status = await runBuild(name, { sourceRevision: null, acceptSeq: 1, ...options })
  assert.ok(status?.manifest, `${name}: runBuild must return a manifest — buildDocument refuses an adapter without one`)
  return normalizeDocumentManifest(status.manifest)
}

/** A two-page document under whatever preamble the control needs. */
const body = preamble => [
  preamble,
  '\\begin{document}',
  'A page of ordinary prose, so the build has something to typeset.',
  '\\newpage',
  'A second page, so a one-page manifest cannot pass by accident.',
  '\\end{document}',
  '',
].join('\n')

// ── paged Letter ────────────────────────────────────────────────────────────
const letter = await build('a-letter-article', body('\\documentclass{article}'))
assert.equal(letter.source.format, 'tex')
assert.equal(letter.source.renderer, 'latex')
assert.equal(letter.document.format, 'paged')
assert.equal(letter.sourceMapping, 'synctex')
assert.equal(letter.view.capabilities.sourceMapping, true)
assert.equal(letter.view.capabilities.presentation, false, 'a paged article is not a presentation')
assert.equal(letter.pages.length, 2)
assert.equal(letter.pages[0].file, 'main-page-1.svg', 'pages are keyed on the tex base')
assert.equal(letter.pages[0].width, 612)
assert.equal(letter.pages[0].height, 792)

// ── non-Letter ──────────────────────────────────────────────────────────────
// `geometry` writes a papersize special, so this must NOT come back as Letter.
const a4 = await build('an-a4-article', body('\\documentclass{article}\n\\usepackage[a4paper]{geometry}'))
assert.ok(Math.abs(a4.pages[0].width - 597) < 6, `a4 width ${a4.pages[0].width} should be ~595, not 612`)
assert.ok(Math.abs(a4.pages[0].height - 845) < 6, `a4 height ${a4.pages[0].height} should be ~842, not 792`)
assert.notEqual(a4.pages[0].width, 612, 'a non-Letter document must not report the Letter constant')

// ── Beamer ──────────────────────────────────────────────────────────────────
// Landscape 128x96mm, and the capability the adapter declares. Passing the
// slides view is what `buildDocument` does: `adapter.build({ ...context, view })`.
const beamer = await build('a-beamer-deck', [
  '\\documentclass{beamer}',
  '\\begin{document}',
  '\\begin{frame}{First}A slide.\\end{frame}',
  '\\begin{frame}{Second}Another slide.\\end{frame}',
  '\\end{document}',
  '',
].join('\n'), { view: SLIDES_VIEW })
assert.equal(beamer.view.capabilities.presentation, true, 'a Beamer deck IS a presentation — hardcoding false mislabelled every one')
assert.ok(beamer.pages[0].width > beamer.pages[0].height, 'a Beamer frame is landscape')
assert.ok(Math.abs(beamer.pages[0].width - 364) < 6, `beamer width ${beamer.pages[0].width} should be ~364pt (128mm)`)
assert.ok(Math.abs(beamer.pages[0].height - 273) < 6, `beamer height ${beamer.pages[0].height} should be ~273pt (96mm)`)

// And the paged default still applies when no view is supplied, which is what a
// direct caller of runBuild gets.
assert.deepEqual(letter.view, PAGED_VIEW)

console.log(`latex manifest proof: letter ${letter.pages[0].width}x${letter.pages[0].height}, `
  + `a4 ${a4.pages[0].width}x${a4.pages[0].height}, `
  + `beamer ${beamer.pages[0].width}x${beamer.pages[0].height} presentation=${beamer.view.capabilities.presentation}`)
process.exit(0)
