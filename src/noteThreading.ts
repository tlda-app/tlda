/**
 * Note threading — single-shape tab model.
 *
 * Threading state lives entirely in shape props:
 *   tabs: string[]        — all tab texts (absent for single-tab notes)
 *   activeTab: number     — index of visible tab (default 0)
 *
 * The `text` prop always reflects the active tab's content.
 * When switching tabs, current text is saved to tabs[activeTab]
 * and the new tab's text is loaded into `text`.
 *
 * This replaces the old multi-shape model (N shapes with opacity toggling,
 * threadId/threadRootId/threadOrder/activeReplyId in meta).
 */
import type { Editor, TLShape, TLShapeId } from 'tldraw'

// ---- Queries ----

/** Get the number of tabs (1 for non-tabbed notes). */
export function getTabCount(shape: TLShape): number {
  const tabs = (shape.props as any).tabs as string[] | undefined
  return tabs ? tabs.length : 1
}

/** Get the active tab index (0 for non-tabbed notes). */
export function getActiveTabIndex(shape: TLShape): number {
  return (shape.props as any).activeTab || 0
}

/** Get all tab texts. For non-tabbed notes, returns [text]. */
export function getTabTexts(shape: TLShape): string[] {
  const tabs = (shape.props as any).tabs as string[] | undefined
  if (tabs && tabs.length > 0) {
    // Ensure active tab reflects current text prop
    const active = (shape.props as any).activeTab || 0
    const result = [...tabs]
    result[active] = (shape.props as any).text || ''
    return result
  }
  return [(shape.props as any).text || '']
}

// ---- Mutations ----

/** Switch to a different tab. Saves current text, loads new tab text. */
export function switchTab(editor: Editor, shapeId: TLShapeId, index: number) {
  const shape = editor.getShape(shapeId)
  if (!shape) return

  const tabs = (shape.props as any).tabs as string[] | undefined
  if (!tabs || index < 0 || index >= tabs.length) return

  const currentActive = (shape.props as any).activeTab || 0
  if (index === currentActive) return

  // Save current text into current tab slot
  const updatedTabs = [...tabs]
  updatedTabs[currentActive] = (shape.props as any).text || ''

  editor.updateShape({
    id: shapeId,
    type: shape.type,
    props: {
      tabs: updatedTabs,
      activeTab: index,
      text: updatedTabs[index],
    },
  })
}

/** Add a new tab with the given text. Switches to the new tab. Returns new tab index. */
export function addTab(editor: Editor, shapeId: TLShapeId, text = ''): number {
  const shape = editor.getShape(shapeId)
  if (!shape) return -1

  const currentText = (shape.props as any).text || ''
  const currentActive = (shape.props as any).activeTab || 0
  const existing = (shape.props as any).tabs as string[] | undefined

  // Build tabs array (initialize from text if first time)
  const updatedTabs = existing ? [...existing] : [currentText]
  updatedTabs[currentActive] = currentText // save current
  updatedTabs.push(text)
  const newIndex = updatedTabs.length - 1

  editor.updateShape({
    id: shapeId,
    type: shape.type,
    props: {
      tabs: updatedTabs,
      activeTab: newIndex,
      text: text,
    },
  })

  return newIndex
}

/** Remove a tab by index. Deletes the shape if it was the last tab. */
export function removeTab(editor: Editor, shapeId: TLShapeId, index: number) {
  const shape = editor.getShape(shapeId)
  if (!shape) return

  const tabs = (shape.props as any).tabs as string[] | undefined
  if (!tabs || tabs.length <= 1) {
    editor.deleteShape(shapeId)
    return
  }

  // Save current text before splicing
  const currentActive = (shape.props as any).activeTab || 0
  const updatedTabs = [...tabs]
  updatedTabs[currentActive] = (shape.props as any).text || ''
  updatedTabs.splice(index, 1)

  if (updatedTabs.length === 0) {
    editor.deleteShape(shapeId)
    return
  }

  // Pick new active: stay at same index (clamped), or shift left if we removed before current
  let newActive: number
  if (index < currentActive) {
    newActive = currentActive - 1
  } else if (index === currentActive) {
    newActive = Math.min(currentActive, updatedTabs.length - 1)
  } else {
    newActive = currentActive
  }

  editor.updateShape({
    id: shapeId,
    type: shape.type,
    props: {
      activeTab: updatedTabs.length > 1 ? newActive : undefined,
      tabs: updatedTabs.length > 1 ? updatedTabs : undefined,
      text: updatedTabs[newActive],
    },
  })
}

/** Detach a tab into a new standalone shape. Returns new shape ID, or null. */
export function detachTab(editor: Editor, shapeId: TLShapeId, index: number): TLShapeId | null {
  const shape = editor.getShape(shapeId)
  if (!shape) return null

  const tabs = (shape.props as any).tabs as string[] | undefined
  if (!tabs || tabs.length <= 1) return null

  // Save current text
  const currentActive = (shape.props as any).activeTab || 0
  const updatedTabs = [...tabs]
  updatedTabs[currentActive] = (shape.props as any).text || ''

  const detachedText = updatedTabs[index]
  updatedTabs.splice(index, 1)

  let newActive: number
  if (index < currentActive) {
    newActive = currentActive - 1
  } else if (index === currentActive) {
    newActive = Math.min(currentActive, updatedTabs.length - 1)
  } else {
    newActive = currentActive
  }

  editor.updateShape({
    id: shapeId,
    type: shape.type,
    props: {
      tabs: updatedTabs.length > 1 ? updatedTabs : undefined,
      activeTab: updatedTabs.length > 1 ? newActive : undefined,
      text: updatedTabs[newActive],
    },
  })

  // Create detached shape offset from original
  const newId = `shape:detached-${Date.now()}` as TLShapeId
  editor.createShape({
    id: newId,
    type: 'math-note',
    x: shape.x + 30,
    y: shape.y + 30,
    props: {
      w: (shape.props as any).w || 200,
      h: (shape.props as any).h || 50,
      text: detachedText,
      color: (shape.props as any).color || 'light-blue',
      autoSize: true,
    },
    meta: {
      sourceAnchor: (shape.meta as any).sourceAnchor || undefined,
    },
  })

  return newId
}

/** Merge all tabs from source into target. Deletes source. */
export function mergeTabs(editor: Editor, sourceId: TLShapeId, targetId: TLShapeId) {
  const source = editor.getShape(sourceId)
  const target = editor.getShape(targetId)
  if (!source || !target) return

  const sourceTexts = getTabTexts(source)
  const targetTexts = getTabTexts(target)

  const merged = [...targetTexts, ...sourceTexts]
  const newActive = merged.length - 1

  editor.updateShape({
    id: targetId,
    type: target.type,
    props: {
      tabs: merged,
      activeTab: newActive,
      text: merged[newActive],
    },
  })

  editor.deleteShape(sourceId)
}
