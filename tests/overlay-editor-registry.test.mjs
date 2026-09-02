import test from 'node:test'
import assert from 'node:assert/strict'
import { withOverlayEditor, withoutOverlayEditor } from '../src/classroom/overlayEditorRegistry.ts'

// The live failure this comes from, app-tester on pic-dev sha 599f9d081:
//
//   "With exactly ONE annotation selected ... badge label 'Mine', expected
//   'Move 1'. The control stays in target-setting mode."
//
// and the mechanism they named: `selectionCount` is 0 while the selection
// exists. `selectionCount` is 0 whenever the write target's editor is not in
// this registry — so a registry that loses a live editor produces exactly that,
// and produces it SILENTLY, because the overlay it dropped is still mounted and
// still drawable. Writing works; every operation that needs the editor does
// nothing at all.
//
// The ordering is the whole subject, so the old behaviour is kept below as the
// control rather than described.

/** What the release used to be: delete whatever is under the key. */
function releaseByKeyOnly(current, id) {
  const next = new Map(current)
  next.delete(id)
  return next
}

const previous = { id: 'editor:previous' }
const next = { id: 'editor:next' }

test('a teardown arriving after its replacement does not drop the live editor', () => {
  // The order that breaks it. The overlays are keyed on `resetKey`, so changing
  // chapter replaces them; tldraw runs the old canvas's teardown from its own
  // effect cleanup, which is not ordered against the new canvas's `onMount`.
  let registry = new Map([['mine', previous]])

  registry = withOverlayEditor(registry, 'mine', next)   // new canvas mounts
  registry = withoutOverlayEditor(registry, 'mine', previous) // old canvas tears down

  assert.equal(registry.get('mine'), next, 'the live editor is still registered')

  // The control: same two events, same order, the previous implementation.
  let broken = new Map([['mine', previous]])
  broken.set('mine', next)
  broken = releaseByKeyOnly(broken, 'mine')
  assert.equal(broken.get('mine'), undefined, 'the old release dropped it — this is the reported failure')
})

test('the ordinary order still releases', () => {
  let registry = new Map([['mine', previous]])
  registry = withoutOverlayEditor(registry, 'mine', previous) // old canvas tears down first
  assert.equal(registry.get('mine'), undefined, 'nothing is registered between the two canvases')

  registry = withOverlayEditor(registry, 'mine', next)        // new canvas mounts
  assert.equal(registry.get('mine'), next)
})

test('a release is idempotent, so replaying it changes nothing', () => {
  // The property that makes the order not matter, rather than a second rule
  // about which order to expect.
  let registry = withOverlayEditor(new Map(), 'mine', previous)
  const once = withoutOverlayEditor(registry, 'mine', previous)
  const twice = withoutOverlayEditor(once, 'mine', previous)
  assert.equal(twice, once, 'replaying returns the same object, not a rebuilt empty one')
})

test('registering the same editor twice is not a change', () => {
  const registry = withOverlayEditor(new Map(), 'mine', previous)
  assert.equal(withOverlayEditor(registry, 'mine', previous), registry)
})

test('layers are independent: releasing one leaves the others', () => {
  // A teacher composites several student layers at once, so a stale teardown on
  // one must not disturb another.
  let registry = new Map()
  registry = withOverlayEditor(registry, 'mine', previous)
  registry = withOverlayEditor(registry, 'student:a', next)
  registry = withoutOverlayEditor(registry, 'mine', previous)

  assert.equal(registry.get('student:a'), next)
  assert.equal(registry.get('mine'), undefined)
})
