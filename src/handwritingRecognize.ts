/**
 * Handwriting recognition: collect strokes from selected draw shapes,
 * send to MyScript via server proxy, attach LaTeX transcription as metadata.
 *
 * The ink stays as-is — transcription is derived metadata, like the magic highlighter.
 */

import type { Editor, TLShape } from 'tldraw'
import { b64Vecs } from 'tldraw'

/** Check if selected shapes are all draw shapes (candidates for recognition). */
export function canRecognize(editor: Editor): boolean {
  const ids = editor.getSelectedShapeIds()
  if (ids.length === 0) return false
  return ids.every(id => {
    const shape = editor.getShape(id)
    return shape && shape.type === 'draw'
  })
}

/** Extract stroke point arrays from a draw shape's segments. */
function extractStrokes(shape: TLShape): { x: number[]; y: number[] }[] {
  const props = shape.props as any
  if (!props.segments) return []

  const strokes: { x: number[]; y: number[] }[] = []
  for (const seg of props.segments) {
    // TLDraw v4 stores points as base64-encoded path via b64Vecs
    const points = seg.path ? b64Vecs.decodePoints(seg.path) : seg.points
    if (!points || points.length < 2) continue
    const x: number[] = []
    const y: number[] = []
    for (const pt of points) {
      // Draw shape points are relative to shape origin
      x.push(shape.x + pt.x)
      y.push(shape.y + pt.y)
    }
    strokes.push({ x, y })
  }
  return strokes
}

/** Recognize selected draw shapes and attach transcription metadata. */
export async function recognizeSelection(editor: Editor): Promise<string | null> {
  const ids = editor.getSelectedShapeIds()
  const shapes = ids
    .map(id => editor.getShape(id))
    .filter((s): s is TLShape => s != null && s.type === 'draw')

  if (shapes.length === 0) return null

  // Collect all strokes, normalized to a common origin
  const allStrokes: { x: number[]; y: number[] }[] = []
  for (const shape of shapes) {
    allStrokes.push(...extractStrokes(shape))
  }

  if (allStrokes.length === 0) return null

  // Normalize coordinates to start near (0,0) — MyScript works in pixel space
  let minX = Infinity, minY = Infinity
  for (const s of allStrokes) {
    for (const v of s.x) if (v < minX) minX = v
    for (const v of s.y) if (v < minY) minY = v
  }
  const normalized = allStrokes.map(s => ({
    x: s.x.map(v => v - minX),
    y: s.y.map(v => v - minY),
  }))

  // Call server proxy
  const serverUrl = (window as any).__TLDA_SERVER || window.location.origin
  const resp = await fetch(`${serverUrl}/api/recognize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ strokes: normalized }),
  })

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: 'Unknown error' }))
    console.error('[recognize] Server error:', err)
    return null
  }

  const { latex } = await resp.json()
  if (!latex) return null

  // Attach transcription to all selected draw shapes
  for (const shape of shapes) {
    editor.updateShape({
      id: shape.id,
      type: shape.type,
      meta: {
        ...shape.meta,
        transcription: latex,
        transcriptionVerified: false,
      },
    } as any)
  }

  return latex
}
