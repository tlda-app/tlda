/**
 * Note threading helpers.
 *
 * Threading state lives entirely in shape `meta`:
 *   Root note:  { threadId, activeReplyId }
 *   Reply note: { threadId, threadOrder, threadRootId }
 *
 * Reply shapes sit at the same (x, y) as the root. Only the active shape
 * has opacity 1; all others are opacity 0.
 */
import type { Editor, TLShape, TLShapeId } from 'tldraw'

// ---- Types ----

export interface ThreadMeta {
  threadId?: string
  threadRootId?: string
  threadOrder?: number
  activeReplyId?: string | null
}

// ---- Queries ----

/** Get the thread meta from a shape, if any. */
export function getThreadMeta(shape: TLShape): ThreadMeta {
  return (shape.meta || {}) as ThreadMeta
}

/** Is this shape part of a thread? */
export function isThreaded(shape: TLShape): boolean {
  const m = getThreadMeta(shape)
  return !!m.threadId
}

/** Is this shape a reply (not the root) in a thread? */
export function isReply(shape: TLShape): boolean {
  return !!getThreadMeta(shape).threadRootId
}

/** Find the root shape of a thread. If shape is already root, returns it. */
export function findRoot(editor: Editor, shape: TLShape): TLShape {
  const m = getThreadMeta(shape)
  if (m.threadRootId) {
    const root = editor.getShape(m.threadRootId as TLShapeId)
    if (root) return root
  }
  return shape
}

/** Get all shapes in a thread (root + replies), sorted by threadOrder. */
export function getThreadMembers(editor: Editor, rootOrMember: TLShape): TLShape[] {
  const root = findRoot(editor, rootOrMember)
  const m = getThreadMeta(root)
  if (!m.threadId) return [root]

  const tid = m.threadId
  const members: TLShape[] = [root]

  for (const shape of editor.getCurrentPageShapes()) {
    if (shape.id === root.id) continue
    if (getThreadMeta(shape).threadId === tid) {
      members.push(shape)
    }
  }

  // Sort: root first, then by threadOrder
  members.sort((a, b) => {
    if (a.id === root.id) return -1
    if (b.id === root.id) return 1
    return (getThreadMeta(a).threadOrder || 0) - (getThreadMeta(b).threadOrder || 0)
  })

  return members
}

/** Get the currently active (visible) shape in a thread. */
export function getActiveShape(editor: Editor, rootOrMember: TLShape): TLShape {
  const root = findRoot(editor, rootOrMember)
  const m = getThreadMeta(root)
  if (m.activeReplyId) {
    const active = editor.getShape(m.activeReplyId as TLShapeId)
    if (active) return active
  }
  return root
}

// ---- Mutations ----

let threadCounter = 0

function generateThreadId(): string {
  return `thread-${Date.now()}-${++threadCounter}`
}

/** Switch the visible tab in a thread. */
export function switchTab(editor: Editor, rootOrMember: TLShape, targetId: TLShapeId) {
  const root = findRoot(editor, rootOrMember)
  const members = getThreadMembers(editor, root)

  editor.updateShapes([
    {
      id: root.id,
      type: root.type,
      meta: {
        ...root.meta,
        activeReplyId: targetId === root.id ? null : targetId,
      },
    },
    ...members.map(m => ({
      id: m.id,
      type: m.type,
      opacity: m.id === targetId ? 1 : 0 as const,
    })),
  ])
}

/** Create a reply in a thread. Returns the new shape's ID. */
export function createReply(
  editor: Editor,
  rootOrMember: TLShape,
  initialText = '',
): TLShapeId {
  const root = findRoot(editor, rootOrMember)
  const rootMeta = getThreadMeta(root)

  // Ensure root has a threadId
  let threadId = rootMeta.threadId
  if (!threadId) {
    threadId = generateThreadId()
    editor.updateShape({
      id: root.id,
      type: root.type,
      meta: { ...root.meta, threadId },
    })
  }

  // Count existing replies for ordering
  const members = getThreadMembers(editor, root)
  const nextOrder = members.length // root is 0, first reply is 1, etc.

  // Create the reply shape at same position as root
  const replyId = `shape:reply-${Date.now()}-${nextOrder}` as TLShapeId

  editor.createShape({
    id: replyId,
    type: 'math-note',
    x: root.x,
    y: root.y,
    opacity: 0,
    props: {
      w: (root.props as any).w || 200,
      h: (root.props as any).h || 50,
      text: initialText,
      color: (root.props as any).color || 'light-blue',
      autoSize: true,
    },
    meta: {
      sourceAnchor: (root.meta as any).sourceAnchor || undefined,
      threadId,
      threadRootId: root.id,
      threadOrder: nextOrder,
    },
  })

  // Switch to the new reply (re-fetch root since we just updated its meta)
  const freshRoot = editor.getShape(root.id)!
  switchTab(editor, freshRoot, replyId)

  return replyId
}

/** Merge a standalone note into another note's thread. */
export function mergeIntoThread(editor: Editor, dragged: TLShape, target: TLShape) {
  const targetRoot = findRoot(editor, target)
  const targetMeta = getThreadMeta(targetRoot)

  // Ensure target has a threadId
  let threadId = targetMeta.threadId
  if (!threadId) {
    threadId = generateThreadId()
    editor.updateShape({
      id: targetRoot.id,
      type: targetRoot.type,
      meta: { ...targetRoot.meta, threadId },
    })
  }

  const members = getThreadMembers(editor, targetRoot)
  const nextOrder = members.length

  // Move dragged to target's position and make it a reply
  editor.updateShape({
    id: dragged.id,
    type: dragged.type,
    x: targetRoot.x,
    y: targetRoot.y,
    opacity: 0,
    meta: {
      ...dragged.meta,
      threadId,
      threadRootId: targetRoot.id,
      threadOrder: nextOrder,
    },
  })

  // Switch to the merged note
  switchTab(editor, targetRoot, dragged.id)
}

/** Detach a reply from its thread. */
export function detachFromThread(editor: Editor, reply: TLShape) {
  const m = getThreadMeta(reply)
  if (!m.threadRootId) return // not a reply

  const root = editor.getShape(m.threadRootId as TLShapeId)

  // Clear thread meta, make visible, offset slightly
  const newMeta = { ...reply.meta }
  delete (newMeta as any).threadId
  delete (newMeta as any).threadRootId
  delete (newMeta as any).threadOrder

  editor.updateShape({
    id: reply.id,
    type: reply.type,
    x: reply.x + 30,
    y: reply.y + 30,
    opacity: 1,
    meta: newMeta,
  })

  // If root was showing this reply, switch back to root
  if (root) {
    const rootMeta = getThreadMeta(root)
    if (rootMeta.activeReplyId === reply.id) {
      editor.updateShape({
        id: root.id,
        type: root.type,
        opacity: 1,
        meta: { ...root.meta, activeReplyId: null },
      })
    }

    // If thread now has only root, clean up threadId
    const remaining = getThreadMembers(editor, root)
    if (remaining.length <= 1) {
      const cleanMeta = { ...root.meta }
      delete (cleanMeta as any).threadId
      delete (cleanMeta as any).activeReplyId
      editor.updateShape({
        id: root.id,
        type: root.type,
        meta: cleanMeta,
      })
    }
  }
}

/** Delete a shape from a thread. If root, promotes first reply. */
export function deleteFromThread(editor: Editor, shape: TLShape) {
  const m = getThreadMeta(shape)
  if (!m.threadId) {
    // Not threaded — just delete
    editor.deleteShape(shape.id)
    return
  }

  if (m.threadRootId) {
    // Deleting a reply — just remove it and reorder
    editor.deleteShape(shape.id)
    const root = editor.getShape(m.threadRootId as TLShapeId)
    if (root) {
      // Reorder remaining replies
      const members = getThreadMembers(editor, root)
      const updates = members
        .filter(s => s.id !== root.id)
        .map((s, i) => ({
          id: s.id,
          type: s.type,
          meta: { ...s.meta, threadOrder: i + 1 },
        }))
      if (updates.length > 0) editor.updateShapes(updates)

      // If only root left, clean up
      if (updates.length === 0) {
        const cleanMeta = { ...root.meta }
        delete (cleanMeta as any).threadId
        delete (cleanMeta as any).activeReplyId
        editor.updateShape({ id: root.id, type: root.type, meta: cleanMeta })
      }
    }
  } else {
    // Deleting root — promote first reply
    const members = getThreadMembers(editor, shape)
    const replies = members.filter(s => s.id !== shape.id)

    if (replies.length === 0) {
      editor.deleteShape(shape.id)
      return
    }

    const newRoot = replies[0]
    const otherReplies = replies.slice(1)

    // Promote newRoot: clear threadRootId, set activeReplyId
    const newRootMeta = { ...newRoot.meta } as any
    delete newRootMeta.threadRootId
    delete newRootMeta.threadOrder
    newRootMeta.activeReplyId = null

    editor.updateShape({
      id: newRoot.id,
      type: newRoot.type,
      opacity: 1,
      meta: newRootMeta,
    })

    // Update remaining replies to point to new root
    if (otherReplies.length > 0) {
      editor.updateShapes(otherReplies.map((s, i) => ({
        id: s.id,
        type: s.type,
        meta: { ...s.meta, threadRootId: newRoot.id, threadOrder: i + 1 },
      })))
    } else {
      // Only one shape left — clean up thread
      const cleanMeta = { ...newRoot.meta }
      delete (cleanMeta as any).threadId
      delete (cleanMeta as any).activeReplyId
      editor.updateShape({ id: newRoot.id, type: newRoot.type, meta: cleanMeta })
    }

    editor.deleteShape(shape.id)
  }
}
