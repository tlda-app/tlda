/**
 * An editor for a page with no canvas.
 *
 * Skip, 2026-08-25: "just create an 'index editor' with the same interface
 * used."
 *
 * The chat panel is a normal component wearing a canvas costume: the message
 * list, history paging, the scroll model, folds, refs, filters and the composer
 * are plain DOM, and the only reason `FleetChatShape.tsx` cannot render anywhere
 * else is that it reaches for `useEditor()` in about fifty places — to store its
 * filter, to open a reference on the canvas, to carry a dragged pill.
 *
 * So this implements that interface instead of changing those fifty places.
 * `useEditor()` reads tldraw's `EditorContext`, so putting one of these in that
 * context is the whole integration: the chat is untouched, and every call it
 * makes lands here.
 *
 * Two kinds of member, and the split is the design:
 *
 * - **Shape state is real.** The chat's filter and traffic mode live in shape
 *   props, so `getShape`/`updateShape`/`createShape`/`deleteShapes` keep an
 *   actual record map, in a tldraw atom so `useValue` stays reactive. A chat
 *   whose filter did not stick would not be the chat.
 * - **Canvas operations do nothing**, because there is no canvas: no camera to
 *   move, no z-order to change, no selection, no tool. Each one below says so.
 *
 * Page space is client space here — there is no camera — so `screenToPage` and
 * `pageToScreen` are the identity rather than a stubbed-out zero.
 */

import { atom, type Editor, type TLShapeId } from 'tldraw'

export const INDEX_EDITOR_PAGE_ID = 'page:index' as const

/** What this store holds: enough of a shape for the chat to read itself out of. */
export type IndexEditorShape = {
  id: string
  type: string
  x: number
  y: number
  props: Record<string, unknown>
}

type ShapeRecord = IndexEditorShape

function boundsOf(shape: ShapeRecord | undefined) {
  if (!shape) return undefined
  const w = Number(shape.props?.w) || 0
  const h = Number(shape.props?.h) || 0
  return { x: shape.x, y: shape.y, w, h }
}

export function createIndexEditor(initialShapes: ShapeRecord[] = []) {
  const shapes = atom<Map<string, ShapeRecord>>(
    'index-editor-shapes',
    new Map(initialShapes.map(shape => [String(shape.id), shape])),
  )

  const write = (next: Map<string, ShapeRecord>) => shapes.set(next)
  const snapshot = () => new Map(shapes.get())

  const editor = {
    // --- shape state: the part that is real -------------------------------
    getCurrentPageId: () => INDEX_EDITOR_PAGE_ID,
    getCurrentPageShapes: () => [...shapes.get().values()],
    getShape: (id: TLShapeId | string) => shapes.get().get(String(id)),
    getShapePageBounds: (id: TLShapeId | string) => boundsOf(shapes.get().get(String(id))),
    createShape: (shape: { id: TLShapeId | string; type: string; x?: number; y?: number; props?: Record<string, unknown>; [key: string]: unknown }) => {
      const next = snapshot()
      next.set(String(shape.id), { x: 0, y: 0, props: {}, ...shape } as ShapeRecord)
      write(next)
      return editor
    },
    updateShape: (update: { id: TLShapeId | string; props?: Record<string, unknown>; [key: string]: unknown }) => {
      const next = snapshot()
      const current = next.get(String(update.id))
      if (!current) return editor
      next.set(String(update.id), {
        ...current,
        ...update,
        // Props merge rather than replace: every caller in the chat passes the
        // one prop it is changing, the way updateShape behaves on the canvas.
        props: { ...current.props, ...(update.props ?? {}) },
      } as ShapeRecord)
      write(next)
      return editor
    },
    deleteShapes: (ids: (TLShapeId | string)[]) => {
      const next = snapshot()
      for (const id of ids) next.delete(String(id))
      write(next)
      return editor
    },
    deleteShape: (id: TLShapeId | string) => editor.deleteShapes([id]),
    /** Ran for its side effects on the canvas store; here it is just the call. */
    run: (fn: () => void) => { fn(); return editor },

    // --- page space is client space: no camera ----------------------------
    screenToPage: (point: { x: number; y: number }) => ({ ...point }),
    pageToScreen: (point: { x: number; y: number }) => ({ ...point }),
    getZoomLevel: () => 1,
    getCamera: () => ({ x: 0, y: 0, z: 1 }),
    getViewportPageBounds: () => ({
      x: 0,
      y: 0,
      w: typeof window === 'undefined' ? 0 : window.innerWidth,
      h: typeof window === 'undefined' ? 0 : window.innerHeight,
    }),

    // --- no canvas, so these do nothing -----------------------------------
    /** No camera to move. */
    zoomToBounds: () => editor,
    /** No camera to move. */
    centerOnPoint: () => editor,
    /** No canvas selection: nothing here is ever selected. */
    select: () => editor,
    getSelectedShapeIds: () => [] as TLShapeId[],
    /** No shape is edited in place off the canvas. */
    getEditingShapeId: () => null,
    /** No toolbar, so the tool is always plain select — never the pen. */
    getCurrentToolId: () => 'select',
    /** No z-order: the index page stacks in DOM order. */
    bringToFront: () => editor,
    sendToBack: () => editor,
    /** No tldraw interaction state machine to cancel out of. */
    cancel: () => editor,
    /** Nothing downstream competes for the event, so nothing has to be claimed. */
    markEventAsHandled: () => {},

    // --- the record store: assets only, and there are none ----------------
    // The chat reads this to resolve image chips pasted as tldraw assets. Those
    // are canvas records, so off the canvas there are none and nothing ever
    // arrives — an empty store rather than a missing one.
    store: {
      /** Records here are the shapes, keyed the way the canvas store keys them. */
      get: (id: TLShapeId | string) => shapes.get().get(String(id)),
      has: (id: TLShapeId | string) => shapes.get().has(String(id)),
      allRecords: () => [...shapes.get().values()] as unknown[],
      listen: () => () => {},
    },

    /** The shapes atom, for a surface that wants to render them itself. */
    shapes,
  }

  return editor
}

export type IndexEditor = ReturnType<typeof createIndexEditor>

/**
 * The cast that puts one of these in `EditorContext`. It implements what the
 * chat reaches for and nothing else, so this is a claim about the chat's
 * surface rather than about `Editor` — narrow it here, in one place, rather
 * than at each use.
 */
export function asEditorContextValue(indexEditor: IndexEditor): Editor {
  return indexEditor as unknown as Editor
}
