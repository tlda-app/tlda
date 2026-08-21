import assert from 'node:assert/strict'
import { readFileSync } from 'fs'
import { join } from 'path'
import test from 'node:test'
import { buildAdapterFor, registeredBuildAdapters } from './build-adapter-registry.mjs'
import { buildDocument } from './build-document.mjs'

test('PDF and Beamer resolve through registration without dispatch branches', () => {
  assert.equal(buildAdapterFor({ sourceFormat: 'pdf', renderer: 'identity', documentFormat: 'paged' }).id, 'native-pdf')
  assert.equal(buildAdapterFor({ sourceFormat: 'tex', renderer: 'latex', documentFormat: 'slides' }).id, 'latex')
  assert.ok(registeredBuildAdapters().some(adapter => adapter.renderer === 'latex'))
  const worker = readFileSync(join(import.meta.dirname, '..', '..', 'bin', 'build-worker.mjs'), 'utf8')
  assert.doesNotMatch(worker, /axes\.sourceFormat|axes\.documentFormat|\[axes\.|buildMarkdown,|buildSlides,|buildPdf,/)
  assert.match(worker, /buildDocument\(project/)
})

test('one BuildResult completion boundary versions then publishes every adapter', async () => {
  const calls = []
  const manifest = { version: 1, kind: 'tlda-document', pages: [] }
  const adapter = { id: 'proof', build: async () => { calls.push('build'); return { manifest } } }
  await buildDocument({}, { name: 'proof', reporter: {} }, {
    adapter,
    versioner: async () => calls.push('version'),
    finalizer: async (_name, result) => { calls.push('finalize'); assert.equal(result.recordLastBuildSuccess, true) },
    completer: () => calls.push('complete'),
  })
  assert.deepEqual(calls, ['build', 'version', 'finalize', 'complete'])
})

test('direct and foreign open use the same manifest loader registry', () => {
  const app = readFileSync(join(import.meta.dirname, '..', '..', 'src', 'App.tsx'), 'utf8')
  const autoOpen = readFileSync(join(import.meta.dirname, '..', '..', 'src', 'hooks', 'useDocAutoOpen.ts'), 'utf8')
  assert.match(app, /loadDocumentFromManifest/)
  assert.match(autoOpen, /loadDocumentFromManifest/)
  assert.doesNotMatch(app, /shownAs ===|sourceFormat === 'pdf'|renderer !== 'latex'/)
})
