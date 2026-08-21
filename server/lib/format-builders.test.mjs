import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { setBuildReporter } from './build-runner.mjs'
import { createDocumentManifest } from './document-manifest.mjs'
import { buildHtml, buildHtmlDocument, buildSlides, buildSlidesDocument, finalizeDocumentBuild } from './format-builders.mjs'
import { closeProjectStore, createProject, initProjectStore } from './project-store.mjs'

test('the common finalizer owns manifest publication, project metadata, and reload', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-document-finalizer-'))
  const updates = []
  const signals = []
  try {
    await initProjectStore(root)
    createProject({
      name: 'notes', mainFile: 'notes.md', format: 'markdown',
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
      { sourceMapping: 'page-source' },
    )
    await finalizeDocumentBuild('notes', { manifest, writePageInfo: true })

    assert.equal(existsSync(join(root, 'notes', 'output', 'document-manifest.json')), true)
    assert.equal(JSON.parse(readFileSync(join(root, 'notes', 'output', 'page-info.json'), 'utf8')).length, 1)
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
  await assert.rejects(finalizeDocumentBuild('missing-result', null), /returned no manifest/)
})

test('format adapters cannot publish common build side effects themselves', () => {
  for (const file of ['build-markdown.mjs', 'build-qmd.mjs', 'build-pdf.mjs']) {
    const source = readFileSync(join(import.meta.dirname, file), 'utf8')
    assert.doesNotMatch(source, /getBuildReporter|updateProject|broadcastSignal|writeDocumentManifest/)
  }
  assert.doesNotMatch(buildHtmlDocument.toString(), /finalizeDocumentBuild|updateProject|broadcastSignal/)
  assert.doesNotMatch(buildSlidesDocument.toString(), /finalizeDocumentBuild|updateProject|broadcastSignal/)
  assert.match(buildHtml.toString(), /runDocumentBuilder/)
  assert.match(buildSlides.toString(), /runDocumentBuilder/)
})
