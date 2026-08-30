import assert from 'node:assert/strict'
import test from 'node:test'

import { injectBridge } from './html-injector.mjs'

test('the iframe bridge leaves download links to the browser', () => {
  const html = injectBridge('<html><body><main></main></body></html>')
  const downloadGuard = html.indexOf("if (a.hasAttribute('download')) return;")
  const navigationPreventDefault = html.indexOf('e.preventDefault();', downloadGuard)

  assert.notEqual(downloadGuard, -1)
  assert.ok(navigationPreventDefault > downloadGuard)
})
