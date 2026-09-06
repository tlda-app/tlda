import assert from 'node:assert/strict'
import test from 'node:test'
import { buildAdapterFor, registeredBuildAdapters } from './build-adapter-registry.mjs'
import { buildDocument } from './build-document.mjs'

test('PDF and Beamer resolve through the document build registry', () => {
  assert.equal(buildAdapterFor({ sourceFormat: 'pdf', renderer: 'identity', documentFormat: 'paged' }).id, 'native-pdf')
  assert.equal(buildAdapterFor({ sourceFormat: 'tex', renderer: 'latex', documentFormat: 'slides' }).id, 'latex-slides')
  assert.ok(registeredBuildAdapters().some(adapter => adapter.renderer === 'latex'))
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
