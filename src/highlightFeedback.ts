/**
 * Highlight → structured feedback integration.
 *
 * Maps highlight colors to semantic feedback types and:
 * 1. Updates overlapping understanding-line shapes based on highlight color
 * 2. Broadcasts structured feedback via signal for fleet consumption
 * 3. Writes feedback to server endpoint for persistence
 *
 * Color → feedback mapping matches fleet's HIGHLIGHT_THEMES:
 *   light-red / red    → reject  ("Fix this")
 *   orange             → comment ("cite/prove")
 *   yellow             → question ("explain")
 *   light-blue / blue  → info    ("notation")
 *   light-green / green → approve ("Good, keep this")
 *   light-violet / violet → expand ("Develop further")
 */

import type { Editor } from 'tldraw'

export interface HighlightFeedback {
  type: 'approve' | 'reject' | 'question' | 'expand' | 'comment' | 'info'
  label: string
  color: string
  shapeId: string
  lines: [number, number] | null  // [startLine, endLine] or null if unknown
  text: string                     // extracted highlight text
  highlightLines: string[]         // per-baseline text lines
  page: number | null              // source page
  timestamp: number
}

const HIGHLIGHT_THEMES: Record<string, { type: HighlightFeedback['type']; label: string }> = {
  'light-green': { type: 'approve', label: 'Good, keep this' },
  'green':       { type: 'approve', label: 'Good, keep this' },
  'light-red':   { type: 'reject', label: 'Fix this' },
  'red':         { type: 'reject', label: 'Fix this' },
  'yellow':      { type: 'question', label: 'Question / unsure' },
  'light-violet': { type: 'expand', label: 'Develop further' },
  'violet':      { type: 'expand', label: 'Develop further' },
  'orange':      { type: 'comment', label: 'General comment' },
  'light-blue':  { type: 'info', label: 'Note / reference' },
  'blue':        { type: 'info', label: 'Note / reference' },
}

/** Map a highlight color name to its semantic feedback type. */
export function colorToFeedback(color: string): { type: HighlightFeedback['type']; label: string } {
  return HIGHLIGHT_THEMES[color] || { type: 'comment', label: 'General comment' }
}

/**
 * Color → understanding-line status mapping.
 * Only some highlight types map to understanding-line status changes.
 * null means "delete the understanding line" (reject = mark as wrong).
 */
const COLOR_TO_UL_STATUS: Record<string, string | null> = {
  'light-green': 'approved',
  'green': 'approved',
  'yellow': 'understood',  // uncertain — understood but flagged
  'orange': 'understood',
  'light-red': null,        // reject → delete the understanding line
  'red': null,
}

/**
 * After a highlight is completed, check for overlapping understanding-line shapes
 * and update their status based on the highlight color.
 */
export function updateOverlappingUnderstandingLines(editor: Editor, shapeId: string) {
  const shape = editor.getShape(shapeId as any)
  if (!shape) return

  const hlColor = (shape.props as any).color || 'yellow'
  const targetStatus = COLOR_TO_UL_STATUS[hlColor]

  // If this color doesn't map to any understanding-line action, skip
  if (targetStatus === undefined) return

  const hlBounds = editor.getShapePageBounds(shapeId as any)
  if (!hlBounds) return

  // Find overlapping understanding-line shapes
  const allShapes = editor.getCurrentPageShapes()
  const overlapping = allShapes.filter(s => {
    if ((s.type as string) !== 'understanding-line') return false
    const ulBounds = editor.getShapePageBounds(s.id)
    if (!ulBounds) return false
    // Check vertical overlap (understanding lines are thin vertical bars)
    return hlBounds.maxY > ulBounds.minY && hlBounds.minY < ulBounds.maxY
      && hlBounds.maxX > ulBounds.minX && hlBounds.minX < ulBounds.maxX
  })

  if (overlapping.length === 0) return

  for (const ul of overlapping) {
    if (targetStatus === null) {
      // Delete the understanding line (reject = mark as wrong)
      editor.deleteShape(ul.id)
    } else {
      // Update the status
      editor.store.update(ul.id, (s: any) => ({
        ...s,
        props: { ...s.props, status: targetStatus },
      }))
    }
  }

  console.log(`[highlight-feedback] Updated ${overlapping.length} understanding-line(s) → ${targetStatus ?? 'deleted'}`)
}

/**
 * Create a structured feedback object from a highlight shape.
 * Call after snapHighlighterToText has populated the shape meta.
 */
export function createFeedbackFromHighlight(editor: Editor, shapeId: string): HighlightFeedback | null {
  const shape = editor.getShape(shapeId as any)
  if (!shape) return null

  const meta = shape.meta as any
  const hlColor = (shape.props as any).color || 'yellow'
  const { type, label } = colorToFeedback(hlColor)

  const text = meta?.highlightText || ''
  const highlightLines = meta?.highlightLines || []
  const sourceLine = meta?.sourceLine ?? null

  if (!text) return null

  return {
    type,
    label,
    color: hlColor,
    shapeId: shape.id,
    lines: sourceLine != null ? [sourceLine, sourceLine] : null,
    text,
    highlightLines,
    page: sourceLine,
    timestamp: Date.now(),
  }
}

/**
 * Broadcast highlight feedback via signal to the server.
 * This makes the feedback available to fleet agents via SSE/REST.
 */
export async function broadcastHighlightFeedback(docName: string, feedback: HighlightFeedback) {
  try {
    const serverUrl = (window as any).__tlda_server || `${window.location.origin}`
    const res = await fetch(`${serverUrl}/api/projects/${docName}/signal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key: 'signal:highlight-feedback',
        feedback,
      }),
    })
    if (!res.ok) {
      console.warn(`[highlight-feedback] Signal POST failed: ${res.status}`)
    }
  } catch (e: any) {
    console.warn(`[highlight-feedback] Signal POST error: ${e?.message}`)
  }
}

/**
 * Main entry point: process a completed highlight for feedback integration.
 * Call this after snapHighlighterToText has finished populating the shape meta.
 *
 * @param editor - TLDraw editor instance
 * @param shapeId - The highlight shape ID
 * @param docName - The document name (for signal broadcasting)
 */
export function processHighlightFeedback(editor: Editor, shapeId: string, docName: string | null) {
  // 1. Update overlapping understanding-line shapes
  updateOverlappingUnderstandingLines(editor, shapeId)

  // 2. Create structured feedback object (needs meta to be populated first)
  // Defer slightly to let the meta update from snapHighlighterToText settle
  setTimeout(() => {
    const feedback = createFeedbackFromHighlight(editor, shapeId)
    if (!feedback) return

    console.log(`[highlight-feedback] ${feedback.type}: "${feedback.text.substring(0, 60)}..."`)

    // 3. Broadcast to server via signal
    if (docName) {
      broadcastHighlightFeedback(docName, feedback)
    }
  }, 200)
}
