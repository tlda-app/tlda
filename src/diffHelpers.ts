import { createShapeId, toRichText } from 'tldraw'
import type { Editor, TLShapeId } from 'tldraw'
import { getYRecords } from './useYjsSync'
import type { SvgDocument, DiffData, DiffHighlight } from './svgDocumentLoader'

/**
 * Create diff overlay shapes: old page opacity styling, labels, and highlight rectangles.
 * Adds created shape IDs to extraShapeIds so they get locked/bottom-sorted with page shapes.
 */
export function setupDiffOverlays(editor: Editor, document: SvgDocument, extraShapeIds: TLShapeId[]) {
  const diff = document.diffLayout!

  // Create labels above old pages
  for (const idx of diff.oldPageIndices) {
    const page = document.pages[idx]
    if (!page) continue
    const match = page.shapeId.match(/old-page-(\d+)/)
    if (!match) continue
    const oldPageNum = match[1]
    const labelId = createShapeId(`${document.name}-old-label-${oldPageNum}`)
    editor.createShapes([{
      id: labelId,
      type: 'text',
      x: page.bounds.x,
      y: page.bounds.y - 26,
      isLocked: true,
      opacity: 0.3,
      props: {
        richText: toRichText(`Old p.${oldPageNum}`),
        font: 'sans',
        size: 's',
        color: 'grey',
        scale: 0.8,
      },
    }])
    extraShapeIds.push(labelId)
  }

  // Create highlight overlay rectangles
  for (let i = 0; i < diff.highlights.length; i++) {
    const hl = diff.highlights[i]
    const hlId = createShapeId(`${document.name}-diff-hl-${i}`)
    editor.createShapes([{
      id: hlId,
      type: 'geo',
      x: hl.x,
      y: hl.y,
      isLocked: true,
      opacity: 0.07,
      props: {
        geo: 'rectangle',
        w: hl.w,
        h: hl.h,
        fill: 'solid',
        color: hl.side === 'current' ? 'light-blue' : 'light-red',
        dash: 'draw',
        size: 's',
      },
    }])
    extraShapeIds.push(hlId)
  }

  // Create connector arrows between corresponding highlight boxes
  for (let i = 0; i < diff.arrows.length; i++) {
    const a = diff.arrows[i]
    const arrowId = createShapeId(`${document.name}-diff-arrow-${i}`)

    editor.createShapes([{
      id: arrowId,
      type: 'arrow',
      x: a.startX,
      y: a.startY,
      isLocked: true,
      opacity: 0.2,
      props: {
        color: 'grey',
        size: 's',
        dash: 'solid',
        start: { x: 0, y: 0 },
        end: { x: a.endX - a.startX, y: a.endY - a.startY },
        arrowheadStart: 'none',
        arrowheadEnd: 'arrow',
      },
    }])
    extraShapeIds.push(arrowId)
  }

  console.log(`[Diff] Created ${diff.highlights.length} highlights, ${diff.arrows.length} arrows for ${diff.oldPageIndices.size} old pages`)
}

/**
 * Set up hover effect: arrows become more visible when pointer is over a connected highlight box.
 * Works regardless of whether shapes were just created or came from Yjs sync.
 */
export function setupDiffHoverEffect(editor: Editor, document: SvgDocument) {
  setupDiffHoverEffectFromData(editor, document.name, {
    highlights: document.diffLayout!.highlights,
    arrows: document.diffLayout!.arrows,
  } as DiffData)
}

/**
 * Hover effect that works with DiffData directly. Returns cleanup function.
 */
export function setupDiffHoverEffectFromData(
  editor: Editor,
  docName: string,
  dd: Pick<DiffData, 'highlights' | 'arrows'>,
): () => void {
  const highlightShapeIds = dd.highlights.map((_, i) =>
    createShapeId(`${docName}-diff-hl-${i}`)
  )
  const arrowShapeIds = dd.arrows.map((_, i) =>
    createShapeId(`${docName}-diff-arrow-${i}`)
  )

  const highlightToArrows = new Map<TLShapeId, TLShapeId[]>()
  for (let i = 0; i < dd.arrows.length; i++) {
    const a = dd.arrows[i]
    const arrowId = arrowShapeIds[i]
    for (const hlId of [highlightShapeIds[a.oldHighlightIdx], highlightShapeIds[a.currentHighlightIdx]]) {
      if (!hlId) continue
      if (!highlightToArrows.has(hlId)) highlightToArrows.set(hlId, [])
      highlightToArrows.get(hlId)!.push(arrowId)
    }
  }

  let activeArrowIds = new Set<TLShapeId>()

  const handlePointerMove = (e: PointerEvent) => {
    const point = editor.screenToPage({ x: e.clientX, y: e.clientY })

    let hoveredHlId: TLShapeId | null = null
    for (const hlId of highlightShapeIds) {
      const bounds = editor.getShapePageBounds(hlId)
      if (bounds && bounds.containsPoint(point)) {
        hoveredHlId = hlId
        break
      }
    }

    const newActive = new Set<TLShapeId>(
      hoveredHlId ? (highlightToArrows.get(hoveredHlId) || []) : []
    )

    if (newActive.size === activeArrowIds.size &&
        [...newActive].every(id => activeArrowIds.has(id))) return

    const updates: Array<{ id: TLShapeId; type: 'arrow'; opacity: number }> = []
    for (const aid of activeArrowIds) {
      if (!newActive.has(aid)) updates.push({ id: aid, type: 'arrow', opacity: 0.2 })
    }
    for (const aid of newActive) {
      if (!activeArrowIds.has(aid)) updates.push({ id: aid, type: 'arrow', opacity: 0.6 })
    }

    if (updates.length > 0) editor.updateShapes(updates)
    activeArrowIds = newActive
  }

  const container = window.document.querySelector('.tl-container')
  if (container) {
    container.addEventListener('pointermove', handlePointerMove as EventListener)
  }

  return () => {
    if (container) {
      container.removeEventListener('pointermove', handlePointerMove as EventListener)
    }
  }
}

/**
 * Watch Yjs review state and adjust highlight box opacity.
 * Chosen side becomes more opaque, rejected side fades.
 */
export function setupDiffReviewEffect(editor: Editor, document: SvgDocument) {
  setupDiffReviewEffectFromData(editor, document.name, {
    highlights: document.diffLayout!.highlights,
  } as DiffData)
}

/**
 * Review effect that works with DiffData directly. Returns cleanup function.
 */
export function setupDiffReviewEffectFromData(
  editor: Editor,
  docName: string,
  dd: Pick<DiffData, 'highlights'>,
): () => void {
  const yRecords = getYRecords()
  if (!yRecords) return () => {}

  const pageHighlights = new Map<number, { current: TLShapeId[], old: TLShapeId[] }>()
  for (let i = 0; i < dd.highlights.length; i++) {
    const hl = dd.highlights[i]
    const hlId = createShapeId(`${docName}-diff-hl-${i}`)
    if (!pageHighlights.has(hl.currentPage)) {
      pageHighlights.set(hl.currentPage, { current: [], old: [] })
    }
    pageHighlights.get(hl.currentPage)![hl.side === 'current' ? 'current' : 'old'].push(hlId)
  }

  const BASE_OPACITY = 0.07
  const CHOSEN_OPACITY = 0.15
  const REJECTED_OPACITY = 0.03

  let lastReviews: Record<number, string> = {}

  function applyReviewState() {
    const signal = yRecords!.get('signal:diff-review' as any) as any
    const reviews: Record<number, string> = signal?.reviews || {}

    const updates: Array<{ id: TLShapeId; type: 'geo'; opacity: number }> = []

    for (const [page, { current, old }] of pageHighlights) {
      const status = reviews[page] || null
      const prevStatus = lastReviews[page] || null
      if (status === prevStatus) continue

      let currentOpacity = BASE_OPACITY
      let oldOpacity = BASE_OPACITY

      if (status === 'new') {
        currentOpacity = CHOSEN_OPACITY
        oldOpacity = REJECTED_OPACITY
      } else if (status === 'old') {
        currentOpacity = REJECTED_OPACITY
        oldOpacity = CHOSEN_OPACITY
      } else if (status === 'discuss') {
        currentOpacity = BASE_OPACITY
        oldOpacity = BASE_OPACITY
      }

      for (const id of current) updates.push({ id, type: 'geo', opacity: currentOpacity })
      for (const id of old) updates.push({ id, type: 'geo', opacity: oldOpacity })
    }

    if (updates.length > 0) editor.updateShapes(updates)
    lastReviews = reviews
  }

  applyReviewState()
  yRecords.observe(applyReviewState)

  return () => {
    yRecords.unobserve(applyReviewState)
  }
}

/**
 * Set up pulse effect for DiffData (used in diff toggle mode).
 */
export function setupPulseForDiffData(
  editor: Editor,
  docName: string,
  dd: DiffData,
  focusChangeRef: React.MutableRefObject<((currentPage: number) => void) | null>,
) {
  let delayTimer: ReturnType<typeof setTimeout> | null = null
  let pulseTimer: ReturnType<typeof setTimeout> | null = null

  focusChangeRef.current = (currentPage: number) => {
    const hlIds: TLShapeId[] = []
    const baseOpacities: number[] = []
    for (let i = 0; i < dd.highlights.length; i++) {
      if (dd.highlights[i].currentPage === currentPage) {
        const hlId = createShapeId(`${docName}-diff-hl-${i}`)
        const shape = editor.getShape(hlId)
        hlIds.push(hlId)
        baseOpacities.push(shape?.opacity ?? 0.07)
      }
    }
    if (hlIds.length === 0) return

    if (delayTimer) clearTimeout(delayTimer)
    if (pulseTimer) clearTimeout(pulseTimer)

    delayTimer = setTimeout(() => {
      editor.updateShapes(hlIds.map(id => ({ id, type: 'geo' as const, opacity: 0.4 })))
      pulseTimer = setTimeout(() => {
        editor.updateShapes(hlIds.map((id, j) => ({ id, type: 'geo' as const, opacity: baseOpacities[j] })))
      }, 700)
    }, 350)
  }
}

/**
 * Set up pulse effect for standalone diff docs (DiffLayout from document).
 */
export function setupPulseForDiffLayout(
  editorRef: React.MutableRefObject<Editor | null>,
  docName: string,
  diff: { highlights: DiffHighlight[] },
  focusChangeRef: React.MutableRefObject<((currentPage: number) => void) | null>,
) {
  let delayTimer: ReturnType<typeof setTimeout> | null = null
  let pulseTimer: ReturnType<typeof setTimeout> | null = null

  focusChangeRef.current = (currentPage: number) => {
    const editor = editorRef.current
    if (!editor) return

    const hlIds: TLShapeId[] = []
    const baseOpacities: number[] = []
    for (let i = 0; i < diff.highlights.length; i++) {
      if (diff.highlights[i].currentPage === currentPage) {
        const hlId = createShapeId(`${docName}-diff-hl-${i}`)
        const shape = editor.getShape(hlId)
        hlIds.push(hlId)
        baseOpacities.push(shape?.opacity ?? 0.07)
      }
    }
    if (hlIds.length === 0) return

    if (delayTimer) clearTimeout(delayTimer)
    if (pulseTimer) clearTimeout(pulseTimer)

    delayTimer = setTimeout(() => {
      editor.updateShapes(hlIds.map(id => ({ id, type: 'geo' as const, opacity: 0.4 })))
      pulseTimer = setTimeout(() => {
        editor.updateShapes(hlIds.map((id, j) => ({ id, type: 'geo' as const, opacity: baseOpacities[j] })))
      }, 700)
    }, 350)
  }
}
