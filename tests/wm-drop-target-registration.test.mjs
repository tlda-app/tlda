// A chat's pill drop target is registered against a specific DOM node. If that
// node is replaced and the registration is not renewed, the resolver's
// `!element.isConnected` check returns null forever after: the chat silently
// stops opening its filter overlay, with no error and no log, recoverable only
// by remount. Skip hit exactly that — "no overlay comes up, just doesnt do shit"
// — while dropping onto the canvas kept working.
//
// This is the silent-and-destructive class AGENTS.md keeps tests for: nothing
// throws, nothing logs, and the only signal is a user saying a feature stopped.
//
// The guard is that registration must FOLLOW the node. A callback ref re-runs
// the effect when the element changes; a ref object does not, which is the shape
// the bug had.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>', { pretendToBeVisual: true })
globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window)
globalThis.HTMLElement = dom.window.HTMLElement

const { registerWMDropTarget, updateWMDrop } = await import('../src/wm/drop-targets.ts')

const payload = { kind: 'fleet-pill', data: { pillType: 'label' } }
const target = { accepts: (p) => p.kind === 'fleet-pill', preview: () => {}, drop: () => {} }

function mountNode() {
  const el = document.createElement('div')
  document.getElementById('host').appendChild(el)
  return el
}

test('the chat registers its pill drop target against the live element, not a ref object', () => {
  // A source contract, deliberately. The failure is in the WIRING — whether the
  // registration effect re-runs when the node changes — and that cannot be
  // observed by calling the registry, because a test that re-registers by hand
  // proves only that the registry works. It has to be asserted where the bug was.
  const source = readFileSync(new URL('../src/shapes/FleetChatShape.tsx', import.meta.url), 'utf8')

  const effect = source.slice(
    source.indexOf('registerWMDropTarget<FleetPillDropData>'),
  ).slice(0, 1200)

  assert.match(
    effect,
    /\}, \[shape\.id, shapeContainerEl\]\)/,
    'the pill drop-target effect must depend on the container element, or a replaced node keeps the old registration',
  )
  assert.match(
    source,
    /ref=\{setShapeContainer\}/,
    'the container must take a callback ref, since assigning a ref object does not re-run the effect',
  )
  assert.doesNotMatch(
    source,
    /ref=\{shapeContainerRef\}/,
    'a plain ref object on the container is the bug: registration stops following the node',
  )
})

test('a registration left on a detached node resolves to null, silently', () => {
  // The failure this guards against, stated as a fact about the resolver: it
  // does not throw and does not log, it returns null. That silence is why the
  // outage was invisible until a person reported it.
  const orphan = mountNode()
  registerWMDropTarget(orphan, target)
  orphan.remove()
  document.elementsFromPoint = () => [orphan]

  assert.equal(updateWMDrop(payload, { x: 1, y: 1 }), false, 'stale registration resolves to nothing')
})
