import test, { after } from 'node:test'
import assert from 'node:assert/strict'

// tldraw throttles store listeners to the next animation frame, which node has
// no notion of. Without this the listener never runs and every count is zero —
// which would make the "emits nothing" assertion pass for the wrong reason.
if (!globalThis.requestAnimationFrame) {
  globalThis.requestAnimationFrame = (fn: FrameRequestCallback) =>
    setTimeout(() => fn(0), 0) as unknown as number
  globalThis.cancelAnimationFrame = (id: number) => clearTimeout(id)
}
const nextFrame = () => new Promise(resolve => setTimeout(resolve, 5))

// tldraw opens an internal MessagePort when its runtime is imported.
const handlesBefore = new Set(process._getActiveHandles())
const { createTLStore, defaultShapeUtils, PageRecordType, ZERO_INDEX_KEY } = await import('tldraw')
const tldrawHandles = process._getActiveHandles().filter(handle => !handlesBefore.has(handle))
after(() => {
  for (const handle of tldrawHandles) {
    if (handle.constructor?.name === 'MessagePort' && 'close' in handle) {
      (handle as { close: () => void }).close()
    }
  }
})

/**
 * Does an update to the values a record already holds emit anything?
 *
 * The local measured-height fallback puts the measured `w`/`h` into the store
 * without sending them. If a later authorized session re-issues the SAME values
 * through the ordinary synced path, whether the room ever learns them depends
 * entirely on this question — and it is exactly the sort of thing that reads as
 * working, because the call returns normally either way.
 *
 * `listen({ source: 'user' })` is the channel the sync client subscribes to: a
 * change it does not see is a change the room does not get. The mechanism under
 * test belongs to `Store`, not to the shape, so this uses a page record — same
 * store, same listener, no shape-schema noise.
 */

const PAGE = PageRecordType.createId('measured-geometry-control')

function storeWithPage(name: string) {
  const store = createTLStore({ shapeUtils: defaultShapeUtils })
  // `PageRecordType.create` fills defaults and types the required properties; it
  // does NOT validate at runtime. The validation happens in `store.put`, which
  // runs the record through the schema — a malformed fixture fails here, which
  // is how the first version of this file was caught.
  store.put([PageRecordType.create({ id: PAGE, name, index: ZERO_INDEX_KEY })])
  return store
}

function pageName(store: ReturnType<typeof createTLStore>): string {
  const page = store.get(PAGE)
  assert.ok(page, 'the fixture page is in the store')
  return page.name
}

/** Count user-sourced changes TO THIS RECORD only.
 *
 * A bare listener count is not the instrument it looks like: wrapping one update
 * in `mergeRemoteChanges` produces two entries here, `remote` and `user`, and the
 * `user` one is tldraw's own bookkeeping rather than the write under test. */
async function countUserChanges(store: ReturnType<typeof createTLStore>, run: () => void) {
  let changes = 0
  const stop = store.listen(entry => {
    const touched = { ...entry.changes.added, ...entry.changes.updated, ...entry.changes.removed }
    if (Object.keys(touched).includes(PAGE)) changes++
  }, { source: 'user', scope: 'document' })
  run()
  await nextFrame()
  stop()
  return changes
}

test('a real change emits, so the instrument can distinguish', async () => {
  const store = storeWithPage('h1200')
  const emitted = await countUserChanges(store, () => {
    store.update(PAGE, page => ({ ...page, name: 'h24361' }))
  })
  assert.ok(emitted > 0, 'positive control: a genuine update is seen on the user channel')
})

test('an update to the value the record already holds emits nothing', async () => {
  const store = storeWithPage('h24361')
  const emitted = await countUserChanges(store, () => {
    store.update(PAGE, page => ({ ...page, name: 'h24361' }))
  })
  assert.equal(emitted, 0, 're-issuing the same geometry reaches nobody')
})

test('mergeRemoteChanges keeps a write off the user channel', async () => {
  const store = storeWithPage('h1200')
  const emitted = await countUserChanges(store, () => {
    store.mergeRemoteChanges(() => {
      store.update(PAGE, page => ({ ...page, name: 'h24361' }))
    })
  })
  assert.equal(emitted, 0, 'the local fallback does not reach the room')
  assert.equal(pageName(store), 'h24361', 'but it does take effect locally')
})

/**
 * What the second test forces. Revert locally to the value the room still holds,
 * then write the measured one through the ordinary path, so the authorized write
 * is a genuine diff instead of a silent no-op.
 */
test('revert-then-write publishes what a plain re-issue would not', async () => {
  const store = storeWithPage('h1200')
  store.mergeRemoteChanges(() => {
    store.update(PAGE, page => ({ ...page, name: 'h24361' }))   // the local fallback
  })

  const emitted = await countUserChanges(store, () => {
    store.mergeRemoteChanges(() => {
      store.update(PAGE, page => ({ ...page, name: 'h1200' }))  // back to the room's value, silently
    })
    store.update(PAGE, page => ({ ...page, name: 'h24361' }))   // now a real diff
  })

  assert.ok(emitted > 0, 'the authorized value reaches the user channel')
  assert.equal(pageName(store), 'h24361', 'and the record ends at the measured value')
})
