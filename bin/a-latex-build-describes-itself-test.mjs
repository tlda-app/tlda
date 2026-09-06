#!/usr/bin/env node
// A LaTeX build has to DESCRIBE what it built, or it cannot pass through the
// same completion boundary as every other renderer.
//
// `buildDocument()` refuses an adapter that returns no manifest, and the
// registry's `latex` adapter IS `runBuild`. So until runBuild returned one, the
// registry named an adapter nothing could call and production kept its own
// format dispatch -- which is the gap this RC exists to close.
//
// This asserts the manifest against a REAL build: a two-page document through
// the real runBuild pipeline, read back through the same normalizer the
// contract is defined by, which throws on a manifest that does not meet it.
//
// A script rather than a `node --test` file, and ending in process.exit(0), for
// the same reason as its neighbours here: the build stack keeps handles open
// and the runner hangs rather than reporting.
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

const root = mkdtempSync(join(tmpdir(), 'latex-manifest-'))
await initProjectStore(root)
initSyncRooms(root)

const NAME = 'a-latex-paper'
createProject({ name: NAME, title: NAME, mainFile: 'main.tex' })
const src = sourceDir(NAME)
mkdirSync(src, { recursive: true })
writeFileSync(join(src, 'main.tex'), [
  '\\documentclass{article}',
  '\\begin{document}',
  'A page of ordinary prose, so the build has something to typeset.',
  '\\newpage',
  'A second page, so a one-page manifest cannot pass by accident.',
  '\\end{document}',
  '',
].join('\n'))

const status = await runBuild(NAME, { sourceRevision: null, acceptSeq: 1 })

assert.ok(status?.manifest, 'runBuild must return a manifest -- buildDocument refuses an adapter without one')
const manifest = normalizeDocumentManifest(status.manifest)

assert.equal(manifest.kind, 'tlda-document')
assert.equal(manifest.source.format, 'tex')
assert.equal(manifest.source.renderer, 'latex')
assert.equal(manifest.document.format, 'paged')

// A LaTeX render is the one thing that HAS source mapping. If this flips to
// 'none', annotations stop anchoring to source lines.
assert.equal(manifest.sourceMapping, 'synctex')
assert.equal(manifest.view.kind, 'svg-pages')
assert.equal(manifest.view.capabilities.sourceMapping, true)

assert.equal(manifest.pages.length, 2, 'two pages were typeset')
manifest.pages.forEach((page, index) => {
  // Page files are keyed on the TEX BASE, which is what the server routes on
  // and is not derivable from the project name.
  assert.equal(page.file, `main-page-${index + 1}.svg`)
  assert.equal(page.width, 612)
  assert.equal(page.height, 792)
})

console.log(`latex manifest proof: ${manifest.pages.length} pages, sourceMapping=${manifest.sourceMapping}, view=${manifest.view.kind}`)
process.exit(0)
