/**
 * Temporal clustering for annotation persistence.
 *
 * When the user draws shapes (pen strokes, highlights, arrows, etc.), this module
 * anchors them to source lines via synctex. Shapes created in rapid succession
 * (within CLUSTER_GAP ms) on the same page share one anchor and move as a unit
 * when the document rebuilds and content shifts.
 *
 * The cluster anchor comes from the first shape's position — where you started writing.
 */

import type { Editor, JsonObject, TLShape } from 'tldraw'
import { currentDocumentInfo } from './svgDocumentLoader'
import { annotationSourceAnchorAtCanvasPoint, type AnnotationSourceAnchor } from './annotationSourceAnchor'

const CLUSTER_GAP = 5000 // ms — shapes within this window share an anchor

/** Shape types that should be auto-anchored. Math notes are excluded — they
 *  get anchored at creation time by MathNoteTool. */
const ANCHORABLE_TYPES = new Set(['draw', 'highlight', 'arrow', 'geo', 'text', 'line'])

/** System shape ID prefixes to skip (deterministic IDs from overlays). */
const SYSTEM_PREFIXES = ['diff-', 'proof-', 'hist-']

interface ActiveCluster {
  anchor: AnnotationSourceAnchor
  anchorCanvasX: number
  anchorCanvasY: number
  clusterId: string
  lastShapeTime: number
  page: number  // 1-indexed
}

let activeCluster: ActiveCluster | null = null
let clusterCounter = 0

function isSystemShape(shapeId: string): boolean {
  // TLDraw shape IDs have a 'shape:' prefix
  const id = shapeId.startsWith('shape:') ? shapeId.slice(6) : shapeId
  return SYSTEM_PREFIXES.some(p => id.startsWith(p))
}

function annotationAnchorLabel(anchor: AnnotationSourceAnchor): string {
  if (anchor.anchored === false) return anchor.reason
  return `${anchor.file}:${anchor.line}`
}

/** Determine which page (1-indexed) a shape falls on by its y coordinate. */
function getShapePage(
  shapeY: number,
  pages: Array<{ bounds: { x: number, y: number, width: number, height: number } }>
): number | null {
  for (let i = 0; i < pages.length; i++) {
    const b = pages[i].bounds
    if (shapeY >= b.y && shapeY < b.y + b.height) {
      return i + 1
    }
  }
  return null
}

/**
 * Anchor a newly created shape to a source line via temporal clustering.
 * Called from the afterCreate handler — async but fire-and-forget.
 */
export async function anchorShape(
  editor: Editor,
  shape: TLShape,
): Promise<void> {
  if (!ANCHORABLE_TYPES.has(shape.type)) return
  if (isSystemShape(shape.id)) return
  // Outline notes set their own source anchor (the selected span); don't
  // re-anchor them by their drop position.
  if ((shape.meta as any)?.anchorLocked) return

  const doc = currentDocumentInfo
  if (!doc) return

  const now = Date.now()
  const shapePage = getShapePage(shape.y, doc.pages)
  if (!shapePage) return

  // Join existing cluster if within time window and same page
  if (activeCluster &&
      now - activeCluster.lastShapeTime < CLUSTER_GAP &&
      activeCluster.page === shapePage) {
    activeCluster.lastShapeTime = now

    editor.updateShape({
      id: shape.id,
      type: shape.type,
      meta: {
        ...shape.meta,
        sourceAnchor: activeCluster.anchor as unknown as JsonObject,
        clusterId: activeCluster.clusterId,
        anchorCanvasX: activeCluster.anchorCanvasX,
        anchorCanvasY: activeCluster.anchorCanvasY,
      },
    })
    return
  }

  // New cluster — look up source anchor for this position
  const anchor = await annotationSourceAnchorAtCanvasPoint(editor, doc, shape.x, shape.y)
  if (!anchor) return

  const clusterId = `cluster-${++clusterCounter}-${now}`

  activeCluster = {
    anchor,
    anchorCanvasX: shape.x,
    anchorCanvasY: shape.y,
    clusterId,
    lastShapeTime: now,
    page: shapePage,
  }

  // Verify shape still exists after async gap
  if (!editor.getShape(shape.id)) return

  editor.updateShape({
    id: shape.id,
    type: shape.type,
    meta: {
      ...shape.meta,
      sourceAnchor: anchor as unknown as JsonObject,
      clusterId,
      anchorCanvasX: shape.x,
      anchorCanvasY: shape.y,
    },
  })

  console.log(`[Anchor] New cluster ${clusterId} at ${annotationAnchorLabel(anchor)}`)
}
