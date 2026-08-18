// Room-daemon-shape adapter over the new JSON-carrier accept, mirroring
// `POST /:name/source-snapshot` field-for-field (server/routes/projects.mjs)
// so an in-process caller gets the same promise an HTTP caller gets, without
// a second implementation of the accept itself -- `bootstrap`/`submit` and
// `applyAcceptedSourceEffects` are the same exported functions the route
// calls. Not a bundle: a room has no git objects to carry, same as every
// other JSON-carrier participant.
//
// Production `server/lib/source-room-daemon.mjs` is not wired to this carrier
// yet -- that repoint belongs to a different track. This exists so the tests
// in this file can prove the promise against the real accept, in the shape
// the room daemon's injected `processProjectPush` dependency is expected to
// return, rather than against the old `processProjectPushSerialized` path.
import { randomUUID } from 'crypto'
import { SOURCE_AUTHORITY_UNINITIALIZED } from '../../server/lib/source-lifecycle.mjs'
import { applyAcceptedSourceEffects, runSerializedProjectSourceOperation } from '../../server/routes/projects.mjs'
import { sourceLifecycleStore, updateProject } from '../../server/lib/project-store.mjs'

export async function acceptSourceSnapshot(project, body) {
  const {
    files, sourceManifest, expectedRevision = null,
    editedBy = null, requestId, sourceBindingId = null,
  } = body || {}
  const lifecycle = await sourceLifecycleStore(project)
  const previousRevision = (await lifecycle.readAuthority()).currentRevision || null
  const result = await runSerializedProjectSourceOperation(project, async () => {
    const before = await lifecycle.readAuthority()
    const input = { expectedRevision, files, sourceManifest, dependencyPins: [] }
    return before.state === SOURCE_AUTHORITY_UNINITIALIZED
      ? lifecycle.bootstrap(input)
      : lifecycle.submit(input)
  })
  if (!result.ok) {
    // HTTP-status-coded, matching the old `processProjectPush` contract these
    // tests and `source-collaborators.mjs` already check against — the same
    // convention `POST /:name/source-snapshot` uses in its own response
    // (`server/routes/projects.mjs`: `{status: 409, body: {...}}` on refusal).
    return {
      ok: false,
      status: 409,
      lifecycleStatus: result.status,
      authority: result.authority,
      currentRevision: result.authority?.currentRevision ?? null,
      refusedRevision: result.refusedRevision ?? null,
      evidence: result.evidence ?? null,
      error: `source push refused: ${result.status}`,
    }
  }
  const sourceRevision = result.revision?.id ?? result.revision ?? null
  const acceptSeq = result.authority?.acceptSeq ?? null
  if (editedBy) await updateProject(project, { lastEditedBy: editedBy, lastEditedByAt: Date.now() })
  const ran = await applyAcceptedSourceEffects(project, lifecycle, {
    sourceRevision, acceptSeq, previousRevision: result.previous ?? previousRevision,
    editedBy: editedBy || null, sourceBindingId, requestId: requestId || randomUUID(),
  })
  return {
    ok: true,
    status: 200,
    unchanged: result.status === 'already-current',
    sourceRevision,
    acceptSeq,
    authority: result.authority,
    building: ran.includes('build'),
    postAcceptEffects: ran,
  }
}
