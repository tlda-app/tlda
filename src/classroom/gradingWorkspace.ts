import { markingLayerCaptures } from './markingCapture'

// Which marks belong to this answer's marking layer.
//
// A marking root shape carries this exact metadata (merged with existing
// metadata such as `t` and `contentAnchor`):
//
//   meta.classroomMarking = { version: 1, assignmentId, studentId, problemId, submissionRoomId }
//
// Stamped only on user-created marking shapes (`draw`, `highlight`, and
// `math-note`; `voice-note` creates a `math-note`) while a marking tool owns the
// private workspace. A type says what a shape is, not which layer
// owns it, so membership is never inferred from shape type during ordinary
// operation. Descendants inherit membership through parentage, so grouped or
// nested records need not duplicate the tag.
//
// The workspace render predicate accepts a shape when its nearest tagged
// ancestor has a tag exactly matching the current assignment, student, problem,
// and submission room. This same exact-match predicate is the client half of
// the server projection; a bare `kind: marking` flag is too weak because stale
// or wrongly routed marks would become returnable to another answer.

export const CLASSROOM_MARKING_VERSION = 1

export interface MarkingIdentity {
  assignmentId: string
  studentId: string
  problemId: string
  submissionRoomId: string
}

export interface MarkingTag extends MarkingIdentity, Record<string, unknown> {
  version: 1
}

/** Shapes whose creation stamps marking membership. `voice-note` is the tool;
 * the shape it creates is a `math-note`, which is why the tool allow-list in
 * `markingCapture.ts` is wider than this set. */
const STAMPED_SHAPE_TYPES = new Set(['draw', 'highlight', 'math-note'])

/**
 * Whether a pane should let the fork viewport own the gesture.
 *
 * While a mark-making tool is active the writable submission pane must step
 * out of the way: `CanvasClipPanel`'s read-only camera capture otherwise
 * prevents/stops every primary pointer before `TldrawViewport` sees it, and
 * marking input dies in the panel. Outside marking tools the pane keeps its
 * normal pan, and the read-only solution pane always keeps its own.
 */
export function gradingPanePanInteraction(isSubmission: boolean, toolId: string): boolean {
  return !isSubmission || !markingLayerCaptures(toolId)
}

/**
 * Whether a created shape is marking input for this answer's layer.
 *
 * The private workspace has exactly one writable viewport — the submission
 * pane — so ownership lasts for the whole tool session rather than one pointer
 * gesture. That is what the transient pane-pointer origin could never say:
 * `math-note` creation is async (the shape lands after an awaited anchor
 * resolve, long after pointer-up cleared the origin) and `voice-note` creates
 * its shape on tool entry, before any pane pointer-down. The caller pairs this
 * with `isStampedMarkingShapeType`, so solution/common-layer shapes are never
 * stamped no matter which tool is active.
 */
export function isWorkspaceMarkingInput(toolId: string): boolean {
  return markingLayerCaptures(toolId)
}

export function isStampedMarkingShapeType(type: string): boolean {
  return STAMPED_SHAPE_TYPES.has(type)
}

export function markingTag(identity: MarkingIdentity): MarkingTag {
  return {
    version: CLASSROOM_MARKING_VERSION,
    assignmentId: identity.assignmentId,
    studentId: identity.studentId,
    problemId: identity.problemId,
    submissionRoomId: identity.submissionRoomId,
  }
}

/** Whether a shape carries a tag exactly matching this answer's identity. */
export function markingTagMatches(tag: unknown, identity: MarkingIdentity): boolean {
  if (typeof tag !== 'object' || tag === null) return false
  const candidate = tag as Record<string, unknown>
  return (
    candidate.version === CLASSROOM_MARKING_VERSION &&
    candidate.assignmentId === identity.assignmentId &&
    candidate.studentId === identity.studentId &&
    candidate.problemId === identity.problemId &&
    candidate.submissionRoomId === identity.submissionRoomId
  )
}

/**
 * Whether a shape belongs to this answer's marking layer.
 *
 * Walks to the nearest tagged ancestor (including the shape itself): a tagged
 * match owns the whole subtree, and an untagged shape with no tagged ancestor
 * belongs to no marking layer. A nearer tag that mismatches stops the walk —
 * the shape sits under a different answer's layer, not under this one.
 */
export function shapeBelongsToMarkingLayer(
  shapeId: string,
  getShape: (id: string) => { id: string; parentId: string; meta?: Record<string, any> } | undefined,
  identity: MarkingIdentity,
): boolean {
  let current = getShape(shapeId)
  while (current) {
    const tag = current.meta?.classroomMarking
    if (tag !== undefined) return markingTagMatches(tag, identity)
    if (!String(current.parentId).startsWith('shape:')) return false
    current = getShape(current.parentId)
  }
  return false
}

/**
 * Render predicate over one editor/store: the submitted page and its
 * descendants, or a shape in this answer's marking layer.
 */
export function isWorkspaceSubmissionShape(
  shape: { id: string; parentId: string; meta?: Record<string, any> },
  getShape: (id: string) => { id: string; parentId: string; meta?: Record<string, any> } | undefined,
  submissionShapeId: string,
  identity: MarkingIdentity,
): boolean {
  let current: { id: string; parentId: string; meta?: Record<string, any> } | undefined = shape
  while (current) {
    if (current.id === submissionShapeId) return true
    const tag = current.meta?.classroomMarking
    if (tag !== undefined) return markingTagMatches(tag, identity)
    if (!String(current.parentId).startsWith('shape:')) return false
    current = getShape(current.parentId)
  }
  return false
}
