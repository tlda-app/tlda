import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { setBuildReporter } from './build-runner.mjs'
import { createDocumentManifest } from './document-manifest.mjs'
import { finalizeDocumentBuild } from './document-build-finalizer.mjs'
import { closeProjectStore, createProject, initProjectStore } from './project-store.mjs'

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
      { sourceMapping: 'page-source', viewKind: 'html-pages' },
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
