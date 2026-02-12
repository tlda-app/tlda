import { useState, useEffect, useRef, useCallback } from 'react'
import { createShapeId } from 'tldraw'
import type { Editor, TLShapeId } from 'tldraw'
import { loadProofData, type SvgDocument, type ProofData } from '../svgDocumentLoader'

function isInputFocused() {
  const tag = window.document.activeElement?.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || (window.document.activeElement as HTMLElement)?.isContentEditable
}

interface UseProofToggleParams {
  editorRef: React.MutableRefObject<Editor | null>
  document: SvgDocument
  shapeIdSetRef: React.MutableRefObject<Set<TLShapeId>>
  shapeIdsArrayRef: React.MutableRefObject<TLShapeId[]>
}

export function useProofToggle({
  editorRef, document,
  shapeIdSetRef, shapeIdsArrayRef,
}: UseProofToggleParams) {
  const hasProofInfo = !!document.basePath

  const [proofMode, setProofMode] = useState(false)
  const proofDataRef = useRef<ProofData | null>(null)
  const proofShapeIdsRef = useRef<Set<TLShapeId>>(new Set())
  const proofLoadingRef = useRef(false)
  const [proofLoading, setProofLoading] = useState(false)
  const proofModeRef = useRef(false)
  const toggleProofRef = useRef<() => void>(() => {})
  const [proofFetchSeq, setProofFetchSeq] = useState(0)
  const [proofDataReady, setProofDataReady] = useState(false)

  useEffect(() => { proofModeRef.current = proofMode }, [proofMode])

  const toggleProof = useCallback(async () => {
    const editor = editorRef.current
    if (!editor || proofLoadingRef.current) return

    const basePath = document.basePath || `${import.meta.env.BASE_URL || '/'}docs/${document.name}/`

    if (!proofMode) {
      // Turning ON
      if (!proofDataRef.current) {
        proofLoadingRef.current = true
        setProofLoading(true)
        try {
          proofDataRef.current = await loadProofData(document.name, basePath, document.pages)
        } catch (e) {
          console.error('[Proof Toggle] Failed to load proof data:', e)
          proofLoadingRef.current = false
          setProofLoading(false)
          return
        }
        proofLoadingRef.current = false
        setProofLoading(false)
      }

      const pd = proofDataRef.current
      if (pd.highlights.length === 0) {
        console.log('[Proof Toggle] No cross-page pairs found')
        return
      }

      const createdIds = new Set<TLShapeId>()

      editor.store.mergeRemoteChanges(() => {
        editor.createShapes(
          pd.highlights.map((hl, i) => {
            const hlId = createShapeId(`${document.name}-proof-hl-${i}`)
            createdIds.add(hlId)
            return {
              id: hlId,
              type: 'geo' as const,
              x: hl.x,
              y: hl.y,
              isLocked: true,
              opacity: 0,
              props: {
                geo: 'rectangle',
                w: hl.w,
                h: hl.h,
                fill: 'solid',
                color: 'light-green',
                dash: 'draw',
                size: 's',
              },
            }
          })
        )
      })

      proofShapeIdsRef.current = createdIds
      for (const id of createdIds) {
        shapeIdSetRef.current.add(id)
        shapeIdsArrayRef.current.push(id)
      }

      setProofMode(true)
      console.log(`[Proof Toggle] ON — ${createdIds.size} highlight shapes, overlay active`)
    } else {
      // Turning OFF
      const idsToRemove = proofShapeIdsRef.current
      if (idsToRemove.size > 0) {
        editor.store.mergeRemoteChanges(() => {
          editor.store.remove([...idsToRemove] as any[])
        })
        for (const id of idsToRemove) {
          shapeIdSetRef.current.delete(id)
        }
        shapeIdsArrayRef.current = shapeIdsArrayRef.current.filter(id => !idsToRemove.has(id))
      }
      proofShapeIdsRef.current = new Set()

      setProofMode(false)
      console.log('[Proof Toggle] OFF — highlights removed, overlay dismissed')
    }
  }, [proofMode, document])

  useEffect(() => { toggleProofRef.current = toggleProof }, [toggleProof])

  // Pre-fetch proof data in background for instant first toggle
  useEffect(() => {
    if (!hasProofInfo) return
    setProofDataReady(false)
    const basePath = document.basePath || `${import.meta.env.BASE_URL || '/'}docs/${document.name}/`
    loadProofData(document.name, basePath, document.pages)
      .then(data => {
        if (!proofDataRef.current) proofDataRef.current = data
        setProofDataReady(true)
      })
      .catch(() => {}) // proof-info.json may not exist — that's fine
  }, [hasProofInfo, document, proofFetchSeq])

  // Keyboard shortcut: 'r' for proof reader toggle
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'r' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (isInputFocused()) return
        const editor = editorRef.current
        if (!editor) return
        if (editor.getEditingShapeId()) return
        toggleProof()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [toggleProof])

  return {
    proofMode, proofLoading, toggleProof,
    proofDataRef, proofModeRef, toggleProofRef,
    proofDataReady, setProofDataReady, setProofFetchSeq,
  }
}
