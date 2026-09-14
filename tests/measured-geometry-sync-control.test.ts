import test, { after } from 'node:test'
import assert from 'node:assert/strict'

// tldraw throttles store listeners to the next animation frame, which node has
// no notion of. Without this the listener never runs and every count is zero —
// which would make the "emits nothing" assertion pass for the wrong reason.
const g = globalThis as any
if (!g.requestAnimationFrame) {
  g.requestAnimationFrame = (fn: (t: number) => void) => setTimeout(() => fn(0), 0) as unknown as number
  g.cancelAnimationFrame = (id: number) => clearTimeout(id as unknown as NodeJS.Timeout)
}
const nextFrame = () => new Promise(resolve => setTimeout(resolve, 5))

// tldraw opens an internal MessagePort when its runtime is imported.
const handlesBefore = new Set((process as any)._getActiveHandles())
const { createTLStore, defaultShapeUtils } = await import('tldraw')
const tldrawHandles = (process as any)._getActiveHandles().filter((h: any) => !handlesBefore.has(h))
after(() => {
  for (const handle of tldrawHandles) {
    if (handle.constructor?.name === 'MessagePort' && 'close' in handle) handle.close()
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
 * test is `Store`'s, not the shape's, so this uses a page record rather than
 * building a valid geo shape — same store, same listener, no schema noise.
 */

const PAGE = 'page:measured-geometry-control' as any

function storeWithPage(name: string) {
  const store = createTLStore({ shapeUtils: defaultShapeUtils })
  store.put([{ id: PAGE, typeName: 'page', name, index: 'a1', meta: {} } as any])
  return store
}

// Count user-sourced changes TO THIS RECORD only.
//
// A bare listener count is not the instrument it looks like: wrapping one update
// in `mergeRemoteChanges` produces two entries here, `remote` and `user`, and the
// `user` one is tldraw's own bookkeeping rather than the write under test. So
// this asks whether the record itself appears in a user-sourced change.
async function countUserChanges(store: any, run: () => void): Promise<number> {
  let changes = 0
  const stop = store.listen((entry: any) => {
    const touched = { ...entry.changes.added, ...entry.changes.updated, ...entry.changes.removed }
    if (Object.keys(touched).includes(String(PAGE))) changes++
  }, { source: 'user', scope: 'document' })
  run()
  await nextFrame()
  stop()
  return changes
}

test('a real change emits, so the instrument can distinguish', async () => {
  const store = storeWithPage('h1200')
  const emitted = await countUserChanges(store, () => {
    store.update(PAGE, (r: any) => ({ ...r, name: 'h24361' }))
  })
  assert.ok(emitted > 0, 'positive control: a genuine update is seen on the user channel')
})

test('an update to the value the record already holds emits nothing', async () => {
  const store = storeWithPage('h24361')
  const emitted = await countUserChanges(store, () => {
    store.update(PAGE, (r: any) => ({ ...r, name: 'h24361' }))
  })
  assert.equal(emitted, 0, 're-issuing the same geometry reaches nobody')
})

test('mergeRemoteChanges keeps a write off the user channel', async () => {
  const store = storeWithPage('h1200')
  const emitted = await countUserChanges(store, () => {
    store.mergeRemoteChanges(() => {
      store.update(PAGE, (r: any) => ({ ...r, name: 'h24361' }))
    })
  })
  assert.equal(emitted, 0, 'the local fallback does not reach the room')
  assert.equal((store.get(PAGE) as any).name, 'h24361', 'but it does take effect locally')
})

/**
 * What the second test forces. Revert locally to the value the room still holds,
 * then write the measured one through the ordinary path, so the authorized write
 * is a genuine diff instead of a silent no-op.
 */
test('revert-then-write publishes what a plain re-issue would not', async () => {
  const store = storeWithPage('h1200')
  store.mergeRemoteChanges(() => {
    store.update(PAGE, (r: any) => ({ ...r, name: 'h24361' }))   // the local fallback
  })

  const emitted = await countUserChanges(store, () => {
    store.mergeRemoteChanges(() => {
      store.update(PAGE, (r: any) => ({ ...r, name: 'h1200' }))  // back to the room's value, silently
    })
    store.update(PAGE, (r: any) => ({ ...r, name: 'h24361' }))   // now a real diff
  })

  assert.ok(emitted > 0, 'the authorized value reaches the user channel')
  assert.equal((store.get(PAGE) as any).name, 'h24361', 'and the record ends at the measured value')
})
