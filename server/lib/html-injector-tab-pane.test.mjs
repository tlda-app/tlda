import assert from 'node:assert/strict'
import test from 'node:test'

import { injectBridge } from './html-injector.mjs'

// A link can name a figure inside a closed tab pane (measured: the book keeps
// one letter-figure per pane with only the first open). Posting the navigation
// with the pane closed lands the reader on the slot showing a different
// figure, so the bridge opens the anchor's pane through its tab first and
// re-measures while it is open.

test('a same-document anchor link opens its tab pane before navigating', () => {
  const html = injectBridge('<html><body><main></main></body></html>')
  const defn = html.indexOf('function activateTabPaneForAnchor(anchorId)')
  assert.notEqual(defn, -1)
  const call = html.indexOf('activateTabPaneForAnchor(anchor)', defn)
  const remeasure = html.indexOf('reportHeadings();', call)
  const post = html.indexOf("type: 'tlda-navigate'", remeasure)
  assert.ok(call > defn, 'activation is called on the click path')
  assert.ok(remeasure > call, 'positions are re-measured after opening')
  assert.ok(post > remeasure, 'navigation posts after the fresh positions')
})

test('pane activation applies to same-document anchors only', () => {
  const html = injectBridge('<html><body><main></main></body></html>')
  assert.ok(html.includes('if (anchor && !targetFile && activateTabPaneForAnchor(anchor))'))
})

test('pane activation goes through the tab, not a synthetic click', () => {
  // A synthetic tab.click() would bubble back into this same interceptor and
  // post a second navigation, so the bridge manipulates tab classes directly.
  const html = injectBridge('<html><body><main></main></body></html>')
  const defn = html.indexOf('function activateTabPaneForAnchor(anchorId)')
  const end = html.indexOf('// Intercept link clicks', defn)
  const body = html.slice(defn, end)
  assert.ok(!body.includes('.click('), 'no synthetic click inside activation')
  assert.ok(body.includes('aria-controls'), 'tab found through its pane linkage')
})
