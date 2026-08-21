import { useCallback, useEffect, useRef, useState } from 'react'
import type { Editor, TLShapeId } from 'tldraw'
import { PDF_HEIGHT } from '../layoutConstants'

export function useWholeDocumentDiff(
  editorRef: React.MutableRefObject<Editor | null>,
  projectName: string,
  activeHash: string | null,
  pageCount: number,
  columnX: number,
  shadowYOffset: number,
) {
  const [visible, setVisible] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const shapeIdsRef = useRef<Set<TLShapeId>>(new Set())

  const clear = useCallback(() => {
    const editor = editorRef.current
    const ids = [...shapeIdsRef.current].filter(id => editor?.getShape(id))
    shapeIdsRef.current.clear()
    if (editor && ids.length > 0) editor.deleteShapes(ids)
  }, [editorRef])

  useEffect(() => {
    if (!visible || !activeHash || !columnX || pageCount < 1) {
      clear()
      setLoading(false)
      return
    }

    let cancelled = false
    clear()
    setLoading(true)
    setError(null)
    const triggerId = `whole-doc:${activeHash}`

    void (async () => {
      const received: TLShapeId[] = []
      try {
        for (let page = 1; page <= pageCount; page += 1) {
          const response = await fetch(`/api/projects/${projectName}/history/diff-region`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              hash7: activeHash.slice(0, 7),
              page,
              pdfYMin: 0,
              pdfYMax: PDF_HEIGHT,
              columnX,
              shadowYOffset,
              triggerId,
            }),
          })
          if (!response.ok) throw new Error(`whole-document diff failed on page ${page}: ${response.status}`)
          const body = await response.json() as { shapeIds?: string[] }
          received.push(...(body.shapeIds ?? []) as TLShapeId[])
        }
        if (cancelled) {
          const editor = editorRef.current
          const stale = received.filter(id => editor?.getShape(id))
          if (editor && stale.length > 0) editor.deleteShapes(stale)
          return
        }
        shapeIdsRef.current = new Set(received)
      } catch (error) {
        setError(error instanceof Error ? error.message : String(error))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => {
      cancelled = true
      clear()
    }
  }, [visible, activeHash, pageCount, columnX, shadowYOffset, projectName, editorRef, clear])

  const toggle = useCallback(() => setVisible(value => !value), [])
  return { wholeDocumentDiffVisible: visible, wholeDocumentDiffLoading: loading, wholeDocumentDiffError: error, toggleWholeDocumentDiff: toggle }
}
