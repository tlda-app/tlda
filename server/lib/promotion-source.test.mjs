import assert from 'node:assert/strict'
import test from 'node:test'

import { promotionExportHeaders, requirePromotionExport, validatePromotionSourceOrigin } from './promotion-source.mjs'
import { isManagedSourcePath, isSourceFilePath, normalizeSourceManifest } from '../../shared/source-manifest.mjs'

function withToken(value, fn) {
  const before = process.env.TLDA_PROMOTION_EXPORT_TOKEN
  if (value == null) delete process.env.TLDA_PROMOTION_EXPORT_TOKEN
  else process.env.TLDA_PROMOTION_EXPORT_TOKEN = value
  try { return fn() } finally {
    if (before == null) delete process.env.TLDA_PROMOTION_EXPORT_TOKEN
    else process.env.TLDA_PROMOTION_EXPORT_TOKEN = before
  }
}

test('promotion source accepts HTTPS and only authenticated Fly internal HTTP', () => {
  assert.equal(validatePromotionSourceOrigin('https://preview.example.test'), 'https://preview.example.test')
  withToken('export-only', () => {
    assert.equal(validatePromotionSourceOrigin('http://pic-preview.internal:5176'), 'http://pic-preview.internal:5176')
    for (const value of [
      'http://pic-preview.internal', 'http://a.b.internal:5176', 'http://127.0.0.1:5176',
      'http://pic-preview.internal:5176/path', 'http://pic-preview.internal:5176/?x=1',
      'http://user@pic-preview.internal:5176', 'http://example.test:5176',
    ]) assert.throws(() => validatePromotionSourceOrigin(value), /invalid promotion source origin/)
  })
  withToken(null, () => assert.throws(
    () => validatePromotionSourceOrigin('http://pic-preview.internal:5176'),
    /requires a dedicated export token/,
  ))
})

test('promotion export accepts only the dedicated token', () => withToken('export-only', () => {
  assert.deepEqual(promotionExportHeaders(), { authorization: 'Bearer export-only' })
  const response = () => ({ status(code) { this.code = code; return this }, json(value) { this.body = value; return this } })
  for (const authorization of [undefined, 'Bearer rw-token', 'Bearer export-onlx']) {
    const res = response()
    let called = false
    requirePromotionExport({ headers: { authorization } }, res, () => { called = true })
    assert.equal(called, false)
    assert.equal(res.code, 401)
    assert.deepEqual(res.body, { error: 'Unauthorized' })
  }
  let called = false
  requirePromotionExport({ headers: { authorization: 'Bearer export-only' } }, response(), () => { called = true })
  assert.equal(called, true)
}))

test('root MCP configuration is never document source authority', () => {
  const context = { format: 'qmd', mainFile: 'index.qmd', referencedRoots: ['.mcp.json'] }
  assert.equal(isSourceFilePath('.mcp.json', context), false)
  assert.equal(isManagedSourcePath('.mcp.json', context), false)
  assert.deepEqual(normalizeSourceManifest(['index.qmd', '.mcp.json', 'config/.mcp.json'], context), [
    'config/.mcp.json',
    'index.qmd',
  ])
})
