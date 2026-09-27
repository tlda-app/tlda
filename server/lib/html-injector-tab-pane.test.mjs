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

test('pane activation clears the whole tabset, tablist included', () => {
  // The tab buttons live in a tablist beside .tab-content, so clearing only
  // .tab-content swaps the panes while both tab buttons stay selected.
  const html = injectBridge('<html><body><main></main></body></html>')
  const defn = html.indexOf('function openTabPaneById(paneId, broadcast)')
  const end = html.indexOf('// Intercept link clicks', defn)
  const body = html.slice(defn, end)
  assert.ok(body.includes("pane.closest('.panel-tabset')"), 'clearing scopes to the tabset')
  assert.ok(!body.includes("closest('.panel-tabset, .tab-content')"), 'not to .tab-content alone')
})

test('a link-opened pane broadcasts to same-document instances', () => {
  // The docview renders its own iframe of the target document; without the
  // broadcast its copy keeps default tabs and shows the wrong figure.
  const html = injectBridge('<html><body><main></main></body></html>')
  assert.ok(html.includes("new BroadcastChannel('tlda-tab-panes')"))
  const defn = html.indexOf('function activateTabPaneForAnchor(anchorId)')
  const end = html.indexOf('// Intercept link clicks', defn)
  const body = html.slice(defn, end)
  assert.ok(body.includes('openTabPaneById(pane.id, true)'), 'click path broadcasts')
  assert.ok(body.includes('openTabPaneById(msg.pane, false)'), 'remote apply does not rebroadcast')
})

test('a late joiner converges through the parent post, not a peer query', () => {
  // Peer queries never observed firing on late mounts; the parent posts
  // tlda-activate-pane to the target's iframes as load signals arrive.
  const html = injectBridge('<html><body><main></main></body></html>')
  assert.ok(!html.includes('queryTabSyncPeers'), 'no peer query mechanism')
  assert.ok(!html.includes('tlda-tab-query'), 'no query message shape')
  assert.ok(html.includes("msg.type !== 'tlda-activate-pane'"), 'parent post handled')
  assert.ok(html.includes("activateTabPaneForAnchor(msg.anchor)"), 'parent post activates the pane')
})

test('hidden-pane measurement parks the active sibling, not stacked alongside', () => {
  // Revealing a hidden pane alongside the active one stacks both, and the
  // revealed content measures below the sibling's (measured: y=7456 stacked
  // against a true y=6833). The helper parks each tabset's active pane while
  // measuring, restoring exact classes afterwards.
  const html = injectBridge('<html><body><main></main></body></html>')
  const defn = html.indexOf('function measureWithHiddenPanesShown(el, measure)')
  const end = html.indexOf('function reportHeadings()', defn)
  const body = html.slice(defn, end)
  assert.ok(body.includes("querySelectorAll('.tab-pane.active')"), 'active siblings are found')
  assert.ok(body.includes("p.classList.remove('active')"), 'siblings parked while measuring')
  assert.ok(body.includes('entry.active'), 'exact classes restored afterwards')
})

test('pane activation goes through the tab, not a synthetic click', () => {
  // A synthetic tab.click() would bubble back into this same interceptor and
  // post a second navigation, so the bridge manipulates tab classes directly.
  const html = injectBridge('<html><body><main></main></body></html>')
  const defn = html.indexOf('function openTabPaneById(paneId, broadcast)')
  const end = html.indexOf('// Intercept link clicks', defn)
  const body = html.slice(defn, end)
  assert.ok(!body.includes('.click('), 'no synthetic click inside activation')
  assert.ok(body.includes('aria-controls'), 'tab found through its pane linkage')
})
