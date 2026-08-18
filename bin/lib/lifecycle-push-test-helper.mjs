// Shared by test-repoints of the old `processProjectPush` mechanism.
//
// `lifecycle.bootstrap`/`lifecycle.submit` (server/lib/source-lifecycle.mjs)
// require a COMPLETE files array matching `sourceManifest` exactly. The old
// route (`processProjectPushSerialized`, server/routes/projects.mjs
// `lifecycleCandidate` construction) built that array by carrying forward
// every unchanged path from the current revision and overlaying only the
// paths a push actually changed -- that expansion is caller responsibility,
// not something the lifecycle store does for you, and it survives the route
// being deleted because callers of the new carrier still need it.
export async function push(lifecycle, { expectedRevision, sourceManifest, changed }) {
  const authority = await lifecycle.readAuthority()
  const current = authority.currentRevision ? await lifecycle.readRevision(authority.currentRevision) : null
  const byPath = new Map((current?.files || []).map(file => [file.path, file]))
  for (const file of changed) byPath.set(file.path, { path: file.path, content: file.content })
  const files = sourceManifest.map(path => byPath.get(path))
  return authority.state === 'uninitialized'
    ? lifecycle.bootstrap({ expectedRevision, files, sourceManifest })
    : lifecycle.submit({ expectedRevision, files, sourceManifest })
}
