import test, { after } from 'node:test'
import assert from 'node:assert/strict'

if (!globalThis.requestAnimationFrame) {
  globalThis.requestAnimationFrame = (fn: FrameRequestCallback) =>
    setTimeout(() => fn(0), 0) as unknown as number
  globalThis.cancelAnimationFrame = (id: number) => clearTimeout(id)
}
const nextFrame = () => new Promise(resolve => setTimeout(resolve, 5))

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

const { isClassroomDocumentWorkspace } = await import('../src/classroom/classroomDocumentWorkspace')
const { createMeasuredGeometryWriter } = await import('../src/measuredGeometryWrite')

/**
 * The boundary, and the two behaviours either side of it.
 *
 * Local measured geometry belongs only where viewer auth is deliberately never
 * initialized AND a document is on screen. Everywhere else the deferral and its
 * authorized resolution have to keep working — and the way to get that wrong is
 * to move the store before the parked write runs, because it re-checks its own
 * gate against the store and then publishes nothing.
 */

test('the boundary is the three document-bearing classroom workspaces', () => {
  for (const workspace of ['classroom-problems', 'classroom-work', 'classroom-comparison']) {
    assert.equal(isClassroomDocumentWorkspace(`?workspace=${workspace}`), true, `${workspace} mounts a document`)
  }
  for (const workspace of ['classroom-gradebook', 'classroom-register', 'classroom-transfer']) {
    assert.equal(isClassroomDocumentWorkspace(`?workspace=${workspace}`), false, `${workspace} mounts no document`)
  }
  assert.equal(isClassroomDocumentWorkspace('?project=anything'), false, 'an ordinary route is outside it')
  assert.equal(isClassroomDocumentWorkspace(''), false, 'so is no workspace at all')
})

const PAGE = PageRecordType.createId('scope-control')

function storeWithPage(name: string) {
  const store = createTLStore({ shapeUtils: defaultShapeUtils })
  // `create` types the required properties and fills defaults; it does not
  // validate. `store.put` runs the schema, so a malformed fixture fails there.
  store.put([PageRecordType.create({ id: PAGE, name, index: ZERO_INDEX_KEY })])
  return store
}

function pageName(store: ReturnType<typeof createTLStore>): string {
  const page = store.get(PAGE)
  assert.ok(page, 'the fixture page is in the store')
  return page.name
}

async function publishedChanges(store: ReturnType<typeof createTLStore>, run: () => void) {
  let published = 0
  const stop = store.listen(entry => {
    const touched = { ...entry.changes.added, ...entry.changes.updated, ...entry.changes.removed }
    if (Object.keys(touched).includes(PAGE)) published++
  }, { source: 'user', scope: 'document' })
  run()
  await nextFrame()
  stop()
  return published
}

test('ORDINARY: unknown permission parks the write, and resolution publishes it', async () => {
  const store = storeWithPage('declared')
  const writer = createMeasuredGeometryWriter()

  const wrote = writer.report({ permissionKnown: false, mayWrite: true }, () => {
    store.update(PAGE, page => ({ ...page, name: 'measured' }))
  })
  assert.equal(wrote, false, 'unknown permission defers rather than writing')
  assert.equal(pageName(store), 'declared', 'and nothing has moved yet')

  // No local fallback here, because this is not a classroom document workspace.
  const published = await publishedChanges(store, () => {
    writer.resolve({ permissionKnown: true, mayWrite: true })
  })

  assert.ok(published > 0, 'the authorized value reaches the room')
  assert.equal(pageName(store), 'measured')
})

test('and it would NOT publish if a local write had moved the store first', async () => {
  const store = storeWithPage('declared')
  const writer = createMeasuredGeometryWriter()
  writer.report({ permissionKnown: false, mayWrite: true }, () => {
    if (pageName(store) === 'measured') return          // the real closure's own gate
    store.update(PAGE, page => ({ ...page, name: 'measured' }))
  })

  // What the unscoped fallback did on every route.
  store.mergeRemoteChanges(() => {
    store.update(PAGE, page => ({ ...page, name: 'measured' }))
  })

  const published = await publishedChanges(store, () => {
    writer.resolve({ permissionKnown: true, mayWrite: true })
  })

  assert.equal(published, 0, 'the parked write fails its own gate and publishes nothing')
})

test('CLASSROOM: the permission never becomes known, so only the local path can render it', () => {
  const store = storeWithPage('declared')
  const writer = createMeasuredGeometryWriter()

  const wrote = writer.report({ permissionKnown: false, mayWrite: true }, () => {
    store.update(PAGE, page => ({ ...page, name: 'measured' }))
  })
  assert.equal(wrote, false)

  // `fetchAuthLevel` is never called on these routes, so nothing ever calls
  // resolve(). Without the local fallback the document stays at its declared
  // size for the life of the page.
  assert.equal(pageName(store), 'declared', 'parked forever')

  assert.equal(isClassroomDocumentWorkspace('?workspace=classroom-problems'), true)
  store.mergeRemoteChanges(() => {
    store.update(PAGE, page => ({ ...page, name: 'measured' }))
  })
  assert.equal(pageName(store), 'measured', 'the local fallback renders it')
})
