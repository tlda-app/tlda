import assert from 'node:assert/strict'
import test from 'node:test'

import { injectBridge } from './html-injector.mjs'

test('injectBridge leaves ../figs/ references untouched on every route', () => {
  const html = '<html><head></head><body><img src="../figs/a.png"><img src="../../figs/b.png"></body></html>'
  for (const basePath of ['', '/docs/book/', '/docs/book/app/book/chapters/']) {
    const out = injectBridge(html, basePath)
    assert.match(out, /src="\.\.\/figs\/a\.png"/, `../figs/ survives basePath ${JSON.stringify(basePath)}`)
    assert.match(out, /src="\.\.\/\.\.\/figs\/b\.png"/, `../../figs/ survives basePath ${JSON.stringify(basePath)}`)
    assert.doesNotMatch(out, /\/docs\/[^"]*figs\//, `no root figs rewrite for basePath ${JSON.stringify(basePath)}`)
  }
})
