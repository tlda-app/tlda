import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { initDataSource } from '../data-source.mjs'
import { canvasToDoc, docToCanvas, PAGE_GAP, PAGE_WIDTH } from './formatCoords.mjs'

test('native PDF coordinates use manifest page dimensions without the TeX origin offset', () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-native-pdf-coords-'))
  const output = join(root, 'server', 'projects', 'book', 'output')
  mkdirSync(output, { recursive: true })
  writeFileSync(join(output, 'document-manifest.json'), JSON.stringify({
    version: 1, kind: 'tlda-document', source: { format: 'pdf', renderer: 'identity' },
    document: { format: 'paged' }, sourceMapping: 'none', assets: [],
    pages: [
      { file: 'book-page-1.svg', width: 400, height: 600 },
      { file: 'book-page-2.svg', width: 800, height: 400 },
    ],
  }))
  initDataSource(root, null)

  assert.deepEqual(docToCanvas('book', 1, 200, 300), { x: PAGE_WIDTH / 2, y: PAGE_WIDTH * 0.75 })
  const pageTwo = docToCanvas('book', 2, 400, 200)
  assert.deepEqual(pageTwo, { x: PAGE_WIDTH / 2, y: PAGE_WIDTH * 1.5 + PAGE_GAP + PAGE_WIDTH / 4 })
  assert.deepEqual(canvasToDoc('book', pageTwo.x, pageTwo.y), { page: 2, pdfX: 400, pdfY: 200 })
})
