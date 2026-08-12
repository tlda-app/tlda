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
// HISTORY, because this file was deleted once and the failure came straight back.
// The first fix drove the node through React state (`useState` + a callback ref)
// so an effect could re-run. During a live React #185 investigation that commit
// was reverted — taking this test with it — and the silent overlay death
// returned to main. The rework registers INSIDE the callback ref instead: no
// state, no effect, nothing routed through render. That is strictly better,
// because "the registration must follow the node" never needed a render, and a
// registration that cannot touch state cannot participate in an update cascade.
//
// So this file asserts the current shape AND forbids the reverted one.
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

const source = readFileSync(new URL('../src/shapes/FleetChatShape.tsx', import.meta.url), 'utf8')

test('the chat registers its pill drop target from the callback ref, so it follows the node', () => {
  // A source contract, deliberately. The failure is in the WIRING — whether the
  // registration is renewed when the node changes — and that cannot be observed
  // by calling the registry, because a test that re-registers by hand proves
  // only that the registry works. It has to be asserted where the bug was.
  const at = source.indexOf('const setShapeContainer = useCallback(')
  assert.ok(at > 0, 'the container must take a callback ref that owns the registration')
  const cb = source.slice(at, at + 2000)

  assert.match(
    cb, /registerWMDropTarget<FleetPillDropData>\(element,/,
    'registration must happen inside the callback ref, against the element React just gave us',
  )
  assert.match(
    cb, /dropRegistrationRef\.current\?\.\(\)/,
    'the previous registration must be detached before a new one is attached',
  )
  assert.match(
    source, /ref=\{setShapeContainer\}/,
    'the container must take the callback ref, since assigning a ref object renews nothing',
  )
  assert.doesNotMatch(
    source, /ref=\{shapeContainerRef\}/,
    'a plain ref object on the container is the original bug: registration stops following the node',
  )
})

test('the registration is not routed through React state', () => {
  // The reverted shape. It worked, but it put a setState on a node-identity path
  // during a crash investigation, which is a cost with no benefit — the
  // registration needs the node, not a render.
  assert.doesNotMatch(
    source, /shapeContainerEl/,
    'node identity must not be held in React state; register from the ref callback instead',
  )
  const at = source.indexOf('const setShapeContainer = useCallback(')
  const cb = source.slice(at, at + 2000)
  assert.doesNotMatch(
    cb, /setShapeContainerEl|useState/,
    'the callback ref must not set state — it runs during commit and must stay render-free',
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
