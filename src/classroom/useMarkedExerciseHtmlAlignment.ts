import { useEffect, type MutableRefObject } from 'react'
import { createShapeId, type Editor } from 'tldraw'
import type { SvgDocument } from '../svgDocumentLoader'

const HANDLE_ID = createShapeId('marked-exercise-alignment-handle')
const HANDLE_GAP = 12

export function useMarkedExerciseHtmlAlignment(
  editorRef: MutableRefObject<Editor | null>,
  document: SvgDocument,
  editorMounted: number,
) {
  useEffect(() => {
    const compareDoc = new URLSearchParams(window.location.search).get('compareDoc')
    const editor = editorRef.current
    if (!compareDoc || document.format !== 'html' || document.pages.length < 2 || !editorMounted || !editor) return

    const comparisonId = document.pages[1].shapeId

    const ensureHandle = () => {
      const comparison = editor.getShape(comparisonId)
      if (!comparison || editor.getShape(HANDLE_ID)) return
      editor.createShape({
        id: HANDLE_ID,
        type: 'line' as any,
        x: comparison.x - HANDLE_GAP,
        y: comparison.y,
        opacity: 0.1,
        props: {
          points: {
            a1: { id: 'a1', index: 'a1', x: 0, y: 0 },
            a2: { id: 'a2', index: 'a2', x: 0, y: Number((comparison.props as any)?.h) || 1000 },
          },
          color: 'grey', dash: 'solid', size: 's', spline: 'line', scale: 1,
        },
        meta: { classroomMarkedExerciseAlignment: true },
      })
    }

    const alignComparison = (handle = editor.getShape(HANDLE_ID)) => {
      const comparison = editor.getShape(comparisonId)
      if (!comparison || !handle) return
      editor.store.put([{ ...comparison, x: handle.x + HANDLE_GAP, y: handle.y }])
    }

    let frame = 0
    let lastHandleX: number | null = null
    let lastHandleY: number | null = null
    const sync = () => {
      ensureHandle()
      const handle = editor.getShape(HANDLE_ID)
      const comparison = editor.getShape(comparisonId)
      if (handle && comparison && (handle.x !== lastHandleX || handle.y !== lastHandleY)) {
        lastHandleX = handle.x
        lastHandleY = handle.y
        alignComparison(handle)
      }
      frame = requestAnimationFrame(sync)
    }
    frame = requestAnimationFrame(sync)
    return () => cancelAnimationFrame(frame)
  }, [document, editorMounted, editorRef])
}
