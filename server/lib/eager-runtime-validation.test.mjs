import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { validatePublishedDocumentRuntime } from './eager-runtime-validation.mjs'
import { createDocumentManifest, writeDocumentManifest } from './document-manifest.mjs'
import { closeProjectStore, initProjectStore } from './project-store.mjs'

test('eager runtime validation loads every published HTML page through its served URL', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-eager-runtime-'))
  const output = join(root, 'off-map', 'output')
  const visited = []
  let closed = false
  try {
    mkdirSync(join(output, 'chapters'), { recursive: true })
    writeFileSync(join(output, 'index.html'), '<html></html>')
    writeFileSync(join(output, 'chapters', 'one.html'), '<html></html>')
    writeFileSync(join(output, 'cover.svg'), '<svg></svg>')
    await initProjectStore(root)
    writeDocumentManifest(output, createDocumentManifest(
      { sourceFormat: 'qmd', renderer: 'quarto', documentFormat: 'html' },
      [
        { file: 'index.html', width: 800, height: 1000 },
        { file: 'chapters/one.html', width: 800, height: 1000 },
        { file: 'cover.svg', width: 800, height: 1000 },
      ],
      { view: { kind: 'html-pages', capabilities: { presentation: false, sourceMapping: true, searchableText: true } } },
    ))

    const result = await validatePublishedDocumentRuntime('off-map', {
      baseUrl: 'https://localhost:5176',
      token: 'read token',
      settleMs: 0,
      launch: async () => ({
        newContext: async options => {
          assert.deepEqual(options, { ignoreHTTPSErrors: true })
          return {
            newPage: async () => ({
              goto: async (url, options) => visited.push({ url, options }),
              waitForTimeout: async () => {},
            }),
          }
        },
        close: async () => { closed = true },
      }),
    })

    assert.equal(result.checked, 2)
    assert.deepEqual(visited.map(entry => entry.url), [
      'https://localhost:5176/docs/off-map/index.html?token=read+token',
      'https://localhost:5176/docs/off-map/chapters/one.html?token=read+token',
    ])
    assert.equal(closed, true)
  } finally {
    await closeProjectStore()
    rmSync(root, { recursive: true, force: true })
  }
})

test('eager runtime validation fails when a declared HTML output is missing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-eager-runtime-missing-'))
  const output = join(root, 'off-map', 'output')
  let launched = false
  try {
    mkdirSync(output, { recursive: true })
    await initProjectStore(root)
    writeDocumentManifest(output, createDocumentManifest(
      { sourceFormat: 'qmd', renderer: 'quarto', documentFormat: 'html' },
      [{ file: 'missing.html', width: 800, height: 1000 }],
      { view: { kind: 'html-pages', capabilities: { presentation: false, sourceMapping: true, searchableText: true } } },
    ))

    await assert.rejects(
      validatePublishedDocumentRuntime('off-map', {
        baseUrl: 'https://localhost:5176',
        launch: async () => {
          launched = true
          throw new Error('browser must not launch')
        },
      }),
      /off-map: declared runtime-validation output is missing: missing\.html/,
    )
    assert.equal(launched, false)
  } finally {
    await closeProjectStore()
    rmSync(root, { recursive: true, force: true })
  }
})
