// The returned-room projection: which workspace records a Return carries.
//
// Builds the returned snapshot as follows:
//
// 1. Select root shapes whose `meta.classroomMarking` exactly matches
//    `{version:1, assignmentId, studentId, problemId, submissionRoomId}`.
// 2. Add every descendant of those roots by following `parentId` transitively.
// 3. Add bindings only when both endpoints are selected; a binding to an
//    excluded source/solution shape is invalid and must make Return fail
//    rather than leak that record.
// 4. Add assets referenced by selected shapes.
// 5. Add the page records needed as parents of selected top-level shapes and
//    the minimum document records required for a valid tldraw snapshot.
// 6. Exclude the `html-page` source shapes, all solution/submission
//    descendants, instance/presence records, and every unmatched shape.
//
// Shape IDs and page coordinates are preserved. The existing returned overlay
// expects the same content-derived `contentAnchorPage` and reads the marks in
// a marks-only room; neither requires copying the source page shape.

export const CLASSROOM_MARKING_VERSION = 1

export const CLASSROOM_MARKING_MIGRATION_VERSION = 1

/**
 * Tag pre-patch draft-room marks with the room's exact marking identity.
 *
 * Old overlay rooms contained annotations only by construction, so every
 * user-created annotation record present at first open is this answer's mark.
 * `html-page` source shapes, pages, bindings, assets, and session records are
 * never tagged. Idempotent via the document record's meta marker: a second
 * pass finds the marker and changes nothing, and records materialized after
 * the first pass (the locked pages, new marks) are never touched — new marks
 * carry the tag from creation.
 */
export function migrateLegacyMarkingSnapshot(snapshot, identity) {
  const documents = snapshot?.documents ?? []
  const states = documents.map(doc => doc.state).filter(state => state?.id)
  const byId = new Map(states.map(state => [state.id, state]))
  const tag = { version: CLASSROOM_MARKING_VERSION, ...identity }

  const documentRecord = states.find(state => state.typeName === 'document')
  const migratedVersions = documentRecord?.meta?.classroomMarkingMigrated
  const alreadyMigrated = Array.isArray(migratedVersions)
    ? migratedVersions.includes(CLASSROOM_MARKING_MIGRATION_VERSION)
    : migratedVersions === CLASSROOM_MARKING_MIGRATION_VERSION
  if (alreadyMigrated) return { snapshot, migrated: 0 }

  // Roots: annotation shapes with no tag yet. Pages/bindings/assets/session
  // records and already-tagged shapes are never roots.
  const roots = states.filter(
    state =>
      state.typeName === 'shape' &&
      state.type !== 'html-page' &&
      state.meta?.classroomMarking === undefined &&
      byId.get(state.parentId)?.typeName !== 'shape',
  )
  const tagged = new Set()
  const childrenByParent = new Map()
  for (const state of states) {
    if (state.typeName !== 'shape' || !String(state.parentId).startsWith('shape:')) continue
    const siblings = childrenByParent.get(state.parentId) ?? []
    siblings.push(state.id)
    childrenByParent.set(state.parentId, siblings)
  }
  // Descendants inherit, but a nearer exact tag from another answer stops the
  // walk — the same rule the Return projection uses.
  const queue = []
  for (const root of roots) {
    root.meta = { ...root.meta, classroomMarking: tag }
    tagged.add(root.id)
    queue.push(root.id)
  }
  while (queue.length > 0) {
    const parentId = queue.pop()
    for (const childId of childrenByParent.get(parentId) ?? []) {
      if (tagged.has(childId)) continue
      const child = byId.get(childId)
      if (!child || child.typeName !== 'shape') continue
      const childTag = child.meta?.classroomMarking
      if (childTag === undefined) child.meta = { ...child.meta, classroomMarking: tag }
      else if (!markingTagMatches(childTag, identity)) continue
      tagged.add(childId)
      queue.push(childId)
    }
  }

  if (documentRecord) {
    documentRecord.meta = {
      ...documentRecord.meta,
      classroomMarkingMigrated: CLASSROOM_MARKING_MIGRATION_VERSION,
    }
  }
  return { snapshot, migrated: tagged.size }
}

function markingTagMatches(tag, identity) {
  if (typeof tag !== 'object' || tag === null) return false
  return (
    tag.version === CLASSROOM_MARKING_VERSION &&
    tag.assignmentId === identity.assignmentId &&
    tag.studentId === identity.studentId &&
    tag.problemId === identity.problemId &&
    tag.submissionRoomId === identity.submissionRoomId
  )
}

/** Collect asset ids referenced by selected shapes (tldraw `asset:<hash>` props). */
function referencedAssetIds(shapes) {
  const ids = new Set()
  const visit = value => {
    if (typeof value === 'string' && value.startsWith('asset:')) ids.add(value.slice('asset:'.length))
    else if (Array.isArray(value)) value.forEach(visit)
    else if (typeof value === 'object' && value !== null) Object.values(value).forEach(visit)
  }
  for (const shape of shapes) visit(shape.props)
  return ids
}

/**
 * Project a workspace snapshot down to the marking dependency closure.
 *
 * Returns `{ snapshot, markCount }` where `markCount` counts selected marking
 * roots and descendants. Throws when a binding would cross the projection
 * boundary, so the caller fails closed instead of copying a partial record.
 */
export function projectMarkingSnapshot(sourceSnapshot, identity) {
  const documents = sourceSnapshot?.documents ?? []
  const states = documents.map(doc => doc.state).filter(state => state?.id)
  const byId = new Map(states.map(state => [state.id, state]))

  // 1. Roots with an exact identity match. Instance/presence records carry no
  // `meta.classroomMarking` and never match; html-page source shapes carry
  // none either and are excluded the same way.
  const roots = states.filter(
    state => state.typeName === 'shape' && markingTagMatches(state.meta?.classroomMarking, identity),
  )

  // 2. Descendants by transitive parentage. A nearer mismatching tag stops
  // inheritance: the shape sits under a different answer's layer.
  const selected = new Set()
  const childrenByParent = new Map()
  for (const state of states) {
    if (state.typeName !== 'shape' || !String(state.parentId).startsWith('shape:')) continue
    const siblings = childrenByParent.get(state.parentId) ?? []
    siblings.push(state.id)
    childrenByParent.set(state.parentId, siblings)
  }
  const queue = []
  for (const root of roots) {
    selected.add(root.id)
    queue.push(root.id)
  }
  while (queue.length > 0) {
    const parentId = queue.pop()
    for (const childId of childrenByParent.get(parentId) ?? []) {
      if (selected.has(childId)) continue
      const child = byId.get(childId)
      if (!child) continue
      const tag = child.meta?.classroomMarking
      if (tag !== undefined && !markingTagMatches(tag, identity)) continue
      selected.add(childId)
      queue.push(childId)
    }
  }

  const selectedShapes = [...selected].map(id => byId.get(id)).filter(Boolean)

  // 3. Bindings only when both endpoints are selected. A binding reaching an
  // excluded source/solution shape fails the return rather than leaking it.
  const bindings = states.filter(state => state.typeName === 'binding')
  for (const binding of bindings) {
    const fromId = binding.fromId ?? binding.props?.fromId
    const toId = binding.toId ?? binding.props?.toId
    const touches = (fromId && selected.has(fromId)) || (toId && selected.has(toId))
    if (!touches) continue
    if (!fromId || !toId || !selected.has(fromId) || !selected.has(toId)) {
      throw new Error(
        `Return refused: marking binding ${binding.id} reaches outside the marking layer.`,
      )
    }
  }
  const selectedBindings = bindings.filter(binding => {
    const fromId = binding.fromId ?? binding.props?.fromId
    const toId = binding.toId ?? binding.props?.toId
    return fromId && toId && selected.has(fromId) && selected.has(toId)
  })

  // 4. Assets referenced by selected shapes.
  const assetIds = referencedAssetIds(selectedShapes)
  const selectedAssets = states.filter(
    state => state.typeName === 'asset' && (assetIds.has(state.id) || assetIds.has(state.id.replace(/^asset:/, ''))),
  )

  // 5. Page parents of selected top-level shapes, plus the minimum document
  // record for a valid tldraw snapshot. Pointer/camera/instance records are
  // session state, not layer content — they never travel.
  const pageIds = new Set()
  for (const shape of selectedShapes) {
    if (String(shape.parentId).startsWith('page:')) pageIds.add(shape.parentId)
  }
  const pages = states.filter(state => state.typeName === 'page' && pageIds.has(state.id))
  const documents_records = states.filter(state => state.typeName === 'document')

  const keep = new Map()
  for (const state of [...selectedShapes, ...selectedBindings, ...selectedAssets, ...pages, ...documents_records]) {
    keep.set(state.id, state)
  }
  const projected = documents.filter(doc => keep.has(doc.state?.id))

  return {
    snapshot: { ...sourceSnapshot, documents: projected },
    markCount: selectedShapes.length,
  }
}
