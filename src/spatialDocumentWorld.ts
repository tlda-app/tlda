import { createShapeId, type Editor, type TLShape, type TLShapeId } from 'tldraw'

export const SPATIAL_MAP_ZOOM = 0.28
const WORLD_GAP = 1400
const DOCUMENT_W = 800
const DOCUMENT_H = 1200

type SpatialDocumentShape = TLShape & {
  x: number
  y: number
  props: TLShape['props'] & { w?: number; h?: number }
  meta: TLShape['meta'] & {
    temporaryMarkdownColumn?: boolean
    spatialWorldDocument?: boolean
    spatialWorldTitle?: string
    spatialWorldRoads?: SpatialWorldRoad[]
  }
}

export type SpatialWorldRoad = {
  sourceNodeId: string
  strength: number
}

export type SpatialDocumentNode = {
  id: string
  bounds: { x: number; y: number; w: number; h: number }
  title: string
  shape?: SpatialDocumentShape
}

function stableHash(value: string) {
  let hash = 2166136261
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function rawDocumentPage(value: TLShape): value is SpatialDocumentShape {
  const candidate = value as unknown as { type: string; props: { w?: unknown; h?: unknown } }
  if (candidate.type !== 'svg-page' && candidate.type !== 'html-page') return false
  const props = candidate.props
  return typeof props.w === 'number' && typeof props.h === 'number'
}

function shapeBounds(shape: SpatialDocumentShape) {
  return {
    x: shape.x,
    y: shape.y,
    w: Number(shape.props.w || DOCUMENT_W),
    h: Number(shape.props.h || DOCUMENT_H),
  }
}

function rectGap(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
) {
  const dx = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w), 0)
  const dy = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h), 0)
  return Math.hypot(dx, dy)
}

export function spatialDocumentShapeId(identity: string): TLShapeId {
  return createShapeId(`spatial-document-${stableHash(identity).toString(36)}`)
}

export function spatialDocumentIdentity(
  title: string,
  url: string,
  meta: Record<string, unknown>,
) {
  const durableKey = meta.sharedDocPath || meta.materializedFile
  if (typeof durableKey === 'string' && durableKey) return durableKey
  const stableUrl = url.replace(/([?&])t=\d+(&|$)/, '$1').replace(/[?&]$/, '')
  return `${title}\0${stableUrl}`
}

export function findSpatialSourceShape(
  editor: Editor,
  excludedId?: TLShapeId,
): SpatialDocumentNode | null {
  const center = editor.getViewportPageBounds().center
  const candidates = spatialWorldDocuments(editor)
    .filter(node => node.shape?.id !== excludedId)
  let best: SpatialDocumentNode | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const node of candidates) {
    const bounds = node.bounds
    const distance = Math.hypot(
      center.x - (bounds.x + bounds.w / 2),
      center.y - (bounds.y + bounds.h / 2),
    )
    if (distance < bestDistance) {
      best = node
      bestDistance = distance
    }
  }
  return best
}

export function placeSpatialDocument(
  editor: Editor,
  identity: string,
  source: SpatialDocumentNode | null,
  size = { w: DOCUMENT_W, h: DOCUMENT_H },
  anchor?: { x: number; y: number },
) {
  const occupied = spatialWorldDocuments(editor).map(node => node.bounds)
  const viewport = editor.getViewportPageBounds()
  const origin = source
    ? source.bounds
    : {
        x: (anchor?.x ?? viewport.center.x) - size.w / 2,
        y: (anchor?.y ?? viewport.center.y) - size.h / 2,
        w: size.w,
        h: size.h,
      }
  const originCenter = { x: origin.x + origin.w / 2, y: origin.y + origin.h / 2 }
  const startAngle = stableHash(identity) / 0xffffffff * Math.PI * 2
  const horizontalClearance = origin.w / 2 + size.w / 2 + WORLD_GAP
  const verticalClearance = origin.h / 2 + size.h / 2 + WORLD_GAP
  let best = { x: origin.x + origin.w + WORLD_GAP, y: originCenter.y - size.h / 2 }
  let bestScore = Number.POSITIVE_INFINITY

  // This is an incremental force layout: the source attracts the new document,
  // every fixed document repels it, and only the new node moves. Once chosen,
  // the result is stored on the shape and is never recomputed.
  for (let ring = 1; ring <= 4; ring++) {
    for (let step = 0; step < 24; step++) {
      const angle = startAngle + step * Math.PI * 2 / 24
      const candidate = {
        x: originCenter.x + Math.cos(angle) * horizontalClearance * ring - size.w / 2,
        y: originCenter.y + Math.sin(angle) * verticalClearance * ring - size.h / 2,
        w: size.w,
        h: size.h,
      }
      let score = ring * 10
      for (const other of occupied) {
        const gap = rectGap(candidate, other)
        if (gap === 0) score += 1_000_000
        else score += 50_000 / (gap * gap)
      }
      if (score < bestScore) {
        bestScore = score
        best = { x: candidate.x, y: candidate.y }
      }
    }
  }
  return best
}

function updateUnlocked(editor: Editor, shape: SpatialDocumentShape, meta: Record<string, unknown>) {
  const wasLocked = !!shape.isLocked
  if (wasLocked) editor.updateShape({ id: shape.id, type: shape.type, isLocked: false })
  editor.updateShape({
    id: shape.id,
    type: shape.type,
    meta: { ...shape.meta, ...meta },
  } as Parameters<Editor['updateShape']>[0])
  if (wasLocked) editor.updateShape({ id: shape.id, type: shape.type, isLocked: true })
}

export function recordSpatialTraversal(
  editor: Editor,
  sourceShapeId: string | null,
  targetShapeId: TLShapeId,
) {
  if (!sourceShapeId || sourceShapeId === targetShapeId) return
  const target = editor.getShape(targetShapeId)
  if (!target || !rawDocumentPage(target)) return
  const existing = Array.isArray(target.meta?.spatialWorldRoads)
    ? target.meta.spatialWorldRoads as SpatialWorldRoad[]
    : []
  if (existing.some(road => road.sourceNodeId === sourceShapeId)) return
  const strength = 0.65 + (stableHash(`${sourceShapeId}\0${targetShapeId}`) % 25) / 100
  updateUnlocked(editor, target, {
    spatialWorldRoads: [...existing, { sourceNodeId: sourceShapeId, strength }],
  })
}

export function recordSpatialTraversalToShape(editor: Editor, targetShapeId: TLShapeId) {
  const source = findSpatialSourceShape(editor, targetShapeId)
  recordSpatialTraversal(editor, source?.id || null, targetShapeId)
}

function currentProjectName() {
  if (typeof window === 'undefined') return 'document'
  return new URLSearchParams(window.location.search).get('project') || 'document'
}

export function spatialWorldDocuments(editor: Editor, projectName = currentProjectName()): SpatialDocumentNode[] {
  const pages = editor.getCurrentPageShapes().filter(rawDocumentPage)
  const primaryPages = pages.filter(shape => !shape.meta?.temporaryMarkdownColumn)
  const nodes: SpatialDocumentNode[] = []
  if (primaryPages.length > 0) {
    const bounds = primaryPages.map(shapeBounds)
    const x = Math.min(...bounds.map(bound => bound.x))
    const y = Math.min(...bounds.map(bound => bound.y))
    const right = Math.max(...bounds.map(bound => bound.x + bound.w))
    const bottom = Math.max(...bounds.map(bound => bound.y + bound.h))
    nodes.push({
      id: `spatial-primary:${projectName}`,
      bounds: { x, y, w: right - x, h: bottom - y },
      title: projectName,
    })
  }
  for (const shape of pages) {
    if (!shape.meta?.spatialWorldDocument) continue
    nodes.push({
      id: shape.id,
      bounds: shapeBounds(shape),
      title: typeof shape.meta.spatialWorldTitle === 'string' ? shape.meta.spatialWorldTitle : 'Shared document',
      shape,
    })
  }
  return nodes
}
