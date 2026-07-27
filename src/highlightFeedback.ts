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
import type { SourceLineMeta } from './sourceLocation'
import { HIGHLIGHT_TO_STATUS } from './shapes/UnderstandingLineShape'

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
 * After a highlight is completed, check for overlapping understanding-line shapes
 * and update their status based on the highlight color.
 */
export function updateOverlappingUnderstandingLines(editor: Editor, shapeId: string) {
  const shape = editor.getShape(shapeId as any)
  if (!shape) return

  const hlColor = (shape.props as any).color || 'yellow'
  const targetStatus = HIGHLIGHT_TO_STATUS[hlColor]

  // If this color doesn't map to any understanding-line action, skip
  if (!targetStatus) return

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
    editor.store.update(ul.id, (s: any) => ({
      ...s,
      props: { ...s.props, status: targetStatus },
    }))
  }

  console.log(`[highlight-feedback] Updated ${overlapping.length} understanding-line(s) → ${targetStatus}`)
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
  const sourceLines = meta?.sourceLines as SourceLineMeta[] | undefined

  if (!text) return null

  // Derive line range and page from sourceLines
  const anchoredLines = sourceLines?.filter((line: any): line is SourceLineMeta & { line: number } => (
    line?.anchored !== false && Number.isFinite(Number(line?.line))
  )) ?? []
  const firstLine = anchoredLines[0]?.line ?? null
  const lastLine = anchoredLines[anchoredLines.length - 1]?.line ?? null

  return {
    type,
    label,
    color: hlColor,
    shapeId: shape.id,
    lines: firstLine != null && lastLine != null ? [firstLine, lastLine] : null,
    text,
    highlightLines,
    page: null,
    timestamp: Date.now(),
  }
}

/**
 * Broadcast highlight feedback via signal to the server.
 * This makes the feedback available to fleet agents via SSE/REST.
 */
export async function broadcastHighlightFeedback(projectName: string, feedback: HighlightFeedback) {
  try {
    const serverUrl = (window as any).__tlda_server || `${window.location.origin}`
    const res = await fetch(`${serverUrl}/api/projects/${projectName}/signal`, {
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
 * @param projectName - The document name (for signal broadcasting)
 */
export function processHighlightFeedback(editor: Editor, shapeId: string, projectName: string | null) {
  // 1. Update overlapping understanding-line shapes
  updateOverlappingUnderstandingLines(editor, shapeId)

  // 2. Create structured feedback object (needs meta to be populated first)
  // Defer slightly to let the meta update from snapHighlighterToText settle
  setTimeout(() => {
    const feedback = createFeedbackFromHighlight(editor, shapeId)
    if (!feedback) return

    console.log(`[highlight-feedback] ${feedback.type}: "${feedback.text.substring(0, 60)}..."`)

    // 3. Broadcast to server via signal
    if (projectName) {
      broadcastHighlightFeedback(projectName, feedback)
    }
  }, 200)
}
