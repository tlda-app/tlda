import test, { after } from 'node:test'
import assert from 'node:assert/strict'

const g = globalThis as any
if (!g.requestAnimationFrame) {
  g.requestAnimationFrame = (fn: (t: number) => void) => setTimeout(() => fn(0), 0) as unknown as number
  g.cancelAnimationFrame = (id: number) => clearTimeout(id as unknown as NodeJS.Timeout)
}
const nextFrame = () => new Promise(resolve => setTimeout(resolve, 5))

const handlesBefore = new Set((process as any)._getActiveHandles())
const { createTLStore, defaultShapeUtils } = await import('tldraw')
const tldrawHandles = (process as any)._getActiveHandles().filter((h: any) => !handlesBefore.has(h))
after(() => {
  for (const handle of tldrawHandles) {
    if (handle.constructor?.name === 'MessagePort' && 'close' in handle) handle.close()
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
  for (const w of ['classroom-problems', 'classroom-work', 'classroom-comparison']) {
    assert.equal(isClassroomDocumentWorkspace(`?workspace=${w}`), true, `${w} mounts a document`)
  }
  for (const w of ['classroom-gradebook', 'classroom-register', 'classroom-transfer']) {
    assert.equal(isClassroomDocumentWorkspace(`?workspace=${w}`), false, `${w} mounts no document`)
  }
  assert.equal(isClassroomDocumentWorkspace('?project=anything'), false, 'an ordinary route is outside it')
  assert.equal(isClassroomDocumentWorkspace(''), false, 'so is no workspace at all')
})

const PAGE = 'page:scope-control' as any

function store(name: string) {
  const s = createTLStore({ shapeUtils: defaultShapeUtils })
  s.put([{ id: PAGE, typeName: 'page', name, index: 'a1', meta: {} } as any])
  return s
}

async function publishedChanges(s: any, run: () => void) {
  let n = 0
  const stop = s.listen((entry: any) => {
    const touched = { ...entry.changes.added, ...entry.changes.updated, ...entry.changes.removed }
    if (Object.keys(touched).includes(String(PAGE))) n++
  }, { source: 'user', scope: 'document' })
  run()
  await nextFrame()
  stop()
  return n
}

test('ORDINARY: unknown permission parks the write, and resolution publishes it', async () => {
  const s = store('declared')
  const writer = createMeasuredGeometryWriter()

  const wrote = writer.report({ permissionKnown: false, mayWrite: true }, () => {
    s.update(PAGE, (r: any) => ({ ...r, name: 'measured' }))
  })
  assert.equal(wrote, false, 'unknown permission defers rather than writing')
  assert.equal((s.get(PAGE) as any).name, 'declared', 'and nothing has moved yet')

  // No local fallback here, because this is not a classroom document workspace.
  const published = await publishedChanges(s, () => {
    writer.resolve({ permissionKnown: true, mayWrite: true })
  })

  assert.ok(published > 0, 'the authorized value reaches the room')
  assert.equal((s.get(PAGE) as any).name, 'measured')
})

test('and it would NOT publish if a local write had moved the store first', async () => {
  const s = store('declared')
  const writer = createMeasuredGeometryWriter()
  writer.report({ permissionKnown: false, mayWrite: true }, () => {
    const latest = s.get(PAGE) as any
    if (latest.name === 'measured') return          // the real closure's own gate
    s.update(PAGE, (r: any) => ({ ...r, name: 'measured' }))
  })

  // What the unscoped fallback did on every route.
  s.mergeRemoteChanges(() => {
    s.update(PAGE, (r: any) => ({ ...r, name: 'measured' }))
  })

  const published = await publishedChanges(s, () => {
    writer.resolve({ permissionKnown: true, mayWrite: true })
  })

  assert.equal(published, 0, 'the parked write fails its own gate and publishes nothing')
})

test('CLASSROOM: the permission never becomes known, so only the local path can render it', () => {
  const writer = createMeasuredGeometryWriter()
  const s = store('declared')

  const wrote = writer.report({ permissionKnown: false, mayWrite: true }, () => {
    s.update(PAGE, (r: any) => ({ ...r, name: 'measured' }))
  })
  assert.equal(wrote, false)

  // `fetchAuthLevel` is never called on these routes, so nothing ever calls
  // resolve(). Without the local fallback the document stays at its declared
  // size for the life of the page.
  assert.equal((s.get(PAGE) as any).name, 'declared', 'parked forever')

  assert.equal(isClassroomDocumentWorkspace('?workspace=classroom-problems'), true)
  s.mergeRemoteChanges(() => {
    s.update(PAGE, (r: any) => ({ ...r, name: 'measured' }))
  })
  assert.equal((s.get(PAGE) as any).name, 'measured', 'the local fallback renders it')
})
