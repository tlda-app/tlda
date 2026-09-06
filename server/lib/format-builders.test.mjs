import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { setBuildReporter } from './build-runner.mjs'
import { createDocumentManifest } from './document-manifest.mjs'
import { finalizeDocumentBuild } from './document-build-finalizer.mjs'
import { closeProjectStore, createProject, initProjectStore } from './project-store.mjs'
import { buildHtmlDocument } from './format-builders.mjs'

test('the common finalizer owns manifest publication, project metadata, and reload', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-document-finalizer-'))
  const updates = []
  const signals = []
  try {
    await initProjectStore(root)
    createProject({
      name: 'notes', mainFile: 'notes.md',
      sourceFormat: 'md', renderer: 'markdown', documentFormat: 'html',
    })
    setBuildReporter({
      updateProject: async (name, update) => updates.push({ name, update }),
      broadcastSignal: (...args) => signals.push(args),
      regenerateBookTocs: async () => {},
    })
    const manifest = createDocumentManifest(
      { sourceFormat: 'md', renderer: 'markdown', documentFormat: 'html', mainFile: 'notes.md' },
      [{ file: 'notes.html', width: 800, height: 1000 }],
      { sourceMapping: 'page-source', view: {
        kind: 'html-pages', capabilities: { presentation: false, sourceMapping: true, searchableText: false },
      } },
    )
    await finalizeDocumentBuild('notes', { manifest }, {
      updateProject: async (name, update) => updates.push({ name, update }),
      broadcastSignal: (...args) => signals.push(args),
      regenerateBookTocs: async () => {},
    })

    assert.equal(existsSync(join(root, 'notes', 'output', 'document-manifest.json')), true)
    assert.deepEqual(updates[0].update.sourceFormat, 'md')
    assert.deepEqual(updates[0].update.renderer, 'markdown')
    assert.deepEqual(updates[0].update.documentFormat, 'html')
    assert.equal(updates[0].update.pages, 1)
    assert.deepEqual(signals[0].slice(0, 2), ['doc-notes', 'signal:reload'])
  } finally {
    setBuildReporter(null)
    await closeProjectStore()
    rmSync(root, { recursive: true, force: true })
  }
})

test('format adapters cannot silently succeed without the common result', async () => {
  await assert.rejects(finalizeDocumentBuild('missing-result', null, {}), /returned no manifest/)
})

// ── the HTML builder describes what it built ────────────────────────────────
//
// Two real builds, because the two HTML shapes differ in the one fact worth
// deriving. A plain rendered document has no source to map back to; a
// tlda-aware Quarto render ships tlda-manifest.json whose every page names its
// .qmd. Asserting one shape would prove the constant, not the derivation --
// which is exactly how `presentation: false` got hardcoded into the LaTeX
// manifest and mislabelled every Beamer deck.
async function buildHtmlProject(root, name, files) {
  await initProjectStore(root)
  // createProject takes no axes -- it derives `format` from mainFile, and
  // documentAxes derives the three axes from that. Passing sourceFormat/renderer
  // here would be ignored, so the extension IS the declaration.
  createProject({ name, mainFile: 'index.html' })
  const src = join(root, name, 'source')
  mkdirSync(src, { recursive: true })
  for (const [rel, body] of Object.entries(files)) writeFileSync(join(src, rel), body)
  setBuildReporter({
    updateProject: async () => {},
    broadcastSignal: () => {},
    regenerateBookTocs: async () => {},
  })
  return (await buildHtmlDocument(name)).manifest
}

const PAGE = title => `<html><head><title>${title}</title></head><body><p>${title}</p></body></html>`

test('a plain HTML document reports no source mapping', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-html-plain-'))
  try {
    const manifest = await buildHtmlProject(root, 'notes', { 'index.html': PAGE('Notes') })
    assert.equal(manifest.source.format, 'html')
    assert.equal(manifest.source.renderer, 'identity')
    assert.equal(manifest.document.format, 'html')
    assert.equal(manifest.view.kind, 'html-pages')
    assert.equal(manifest.view.capabilities.presentation, false, 'a scrolling HTML document is not a presentation')
    assert.equal(manifest.view.capabilities.searchableText, true)
    assert.equal(manifest.sourceMapping, 'none', 'nothing here names a source to map back to')
    assert.equal(manifest.view.capabilities.sourceMapping, false)
    assert.equal(manifest.pages.length, 1)
    assert.equal(manifest.pages[0].file, 'index.html')
    assert.ok(manifest.pages[0].width > 0 && manifest.pages[0].height > 0)
  } finally {
    setBuildReporter(null); await closeProjectStore(); rmSync(root, { recursive: true, force: true })
  }
})

test('a tlda-aware render reports the source mapping its pages carry', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-html-mapped-'))
  try {
    const manifest = await buildHtmlProject(root, 'rendered', {
      'index.html': PAGE('Chapter one'),
      'tlda-manifest.json': JSON.stringify({
        version: 1, kind: 'tlda',
        pages: [{ file: 'index.html', title: 'Chapter one', source: { type: 'project-source', format: 'qmd', file: 'index.qmd' } }],
      }),
    })
    assert.equal(manifest.sourceMapping, 'page-source', 'every page names its .qmd, so it maps back')
    assert.equal(manifest.view.capabilities.sourceMapping, true)
    assert.equal(manifest.pages[0].source.file, 'index.qmd', 'the page keeps the coordinate it was given')
    // The rest is unchanged by the presence of a source coordinate.
    assert.equal(manifest.view.kind, 'html-pages')
    assert.equal(manifest.view.capabilities.presentation, false)
  } finally {
    setBuildReporter(null); await closeProjectStore(); rmSync(root, { recursive: true, force: true })
  }
})
