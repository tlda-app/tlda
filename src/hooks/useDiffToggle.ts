import { useState, useEffect, useRef, useCallback } from 'react'
import { createShapeId, toRichText } from 'tldraw'
import type { TLImageShape, TLShapePartial, Editor, TLShapeId } from 'tldraw'
import { loadDiffData, type SvgDocument, type DiffData } from '../svgDocumentLoader'
import { setupDiffHoverEffectFromData, setupDiffReviewEffectFromData, setupPulseForDiffData } from '../diffHelpers'

function isInputFocused() {
  const tag = window.document.activeElement?.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || (window.document.activeElement as HTMLElement)?.isContentEditable
}

interface UseDiffToggleParams {
  editorRef: React.MutableRefObject<Editor | null>
  document: SvgDocument
  diffConfig?: { basePath: string }
  shapeIdSetRef: React.MutableRefObject<Set<TLShapeId>>
  shapeIdsArrayRef: React.MutableRefObject<TLShapeId[]>
  updateCameraBoundsRef: React.MutableRefObject<((bounds: any) => void) | null>
  focusChangeRef: React.MutableRefObject<((currentPage: number) => void) | null>
}

export function useDiffToggle({
  editorRef, document, diffConfig,
  shapeIdSetRef, shapeIdsArrayRef, updateCameraBoundsRef, focusChangeRef,
}: UseDiffToggleParams) {
  const hasDiffBuiltin = !!document.diffLayout  // standalone diff doc
  const hasDiffToggle = !hasDiffBuiltin && !!diffConfig  // normal doc with diff available

  const [diffMode, setDiffMode] = useState(false)
  const diffDataRef = useRef<DiffData | null>(null)
  const diffShapeIdsRef = useRef<Set<TLShapeId>>(new Set())
  const diffEffectCleanupRef = useRef<(() => void) | null>(null)
  const diffLoadingRef = useRef(false)
  const [diffLoading, setDiffLoading] = useState(false)
  const diffModeRef = useRef(false)
  const toggleDiffRef = useRef<() => void>(() => {})
  const [diffFetchSeq, setDiffFetchSeq] = useState(0) // bumped on reload to re-trigger pre-fetch

  useEffect(() => { diffModeRef.current = diffMode }, [diffMode])

  const toggleDiff = useCallback(async () => {
    const editor = editorRef.current
    if (!editor || !diffConfig || diffLoadingRef.current) return

    if (!diffMode) {
      // Turning ON
      if (!diffDataRef.current) {
        diffLoadingRef.current = true
        setDiffLoading(true)
        try {
          diffDataRef.current = await loadDiffData(document.name, diffConfig.basePath, document.pages)
        } catch (e) {
          console.error('[Diff Toggle] Failed to load diff data:', e)
          diffLoadingRef.current = false
          setDiffLoading(false)
          return
        }
        diffLoadingRef.current = false
        setDiffLoading(false)
      }

      const dd = diffDataRef.current
      const createdIds = new Set<TLShapeId>()

      // Create overlay shapes as local-only (mergeRemoteChanges → source:'remote' → skipped by Yjs sync)
      editor.store.mergeRemoteChanges(() => {
        const mimeType = 'image/svg+xml'
        editor.createAssets(
          dd.pages.map(oldPage => ({
            id: oldPage.assetId,
            typeName: 'asset' as const,
            type: 'image' as const,
            meta: {},
            props: {
              w: oldPage.width,
              h: oldPage.height,
              mimeType,
              src: oldPage.src,
              name: 'diff-old-page',
              isAnimated: false,
            },
          }))
        )

        editor.createShapes(
          dd.pages.map((oldPage): TLShapePartial<TLImageShape> => ({
            id: oldPage.shapeId,
            type: 'image',
            x: oldPage.bounds.x,
            y: oldPage.bounds.y,
            isLocked: true,
            opacity: 0.5,
            props: {
              assetId: oldPage.assetId,
              w: oldPage.bounds.w,
              h: oldPage.bounds.h,
            },
          }))
        )
        for (const oldPage of dd.pages) {
          createdIds.add(oldPage.shapeId)
        }

        const labelShapes: any[] = []
        for (const oldPage of dd.pages) {
          const match = (oldPage.shapeId as string).match(/old-page-(\d+)/)
          if (!match) continue
          const labelId = createShapeId(`${document.name}-old-label-${match[1]}`)
          labelShapes.push({
            id: labelId,
            type: 'text',
            x: oldPage.bounds.x,
            y: oldPage.bounds.y - 26,
            isLocked: true,
            opacity: 0.3,
            props: {
              richText: toRichText(`Old p.${match[1]}`),
              font: 'sans',
              size: 's',
              color: 'grey',
              scale: 0.8,
            },
          })
          createdIds.add(labelId)
        }
        if (labelShapes.length > 0) editor.createShapes(labelShapes)

        editor.createShapes(
          dd.highlights.map((hl, i) => {
            const hlId = createShapeId(`${document.name}-diff-hl-${i}`)
            createdIds.add(hlId)
            return {
              id: hlId,
              type: 'geo' as const,
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
            }
          })
        )

        editor.createShapes(
          dd.arrows.map((a, i) => {
            const arrowId = createShapeId(`${document.name}-diff-arrow-${i}`)
            createdIds.add(arrowId)
            return {
              id: arrowId,
              type: 'arrow' as const,
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
            }
          })
        )
      })

      diffShapeIdsRef.current = createdIds
      for (const id of createdIds) {
        shapeIdSetRef.current.add(id)
        shapeIdsArrayRef.current.push(id)
      }

      const hoverCleanup = setupDiffHoverEffectFromData(editor, document.name, dd)
      const reviewCleanup = setupDiffReviewEffectFromData(editor, document.name, dd)
      diffEffectCleanupRef.current = () => { hoverCleanup(); reviewCleanup() }

      setupPulseForDiffData(editor, document.name, dd, focusChangeRef)

      if (updateCameraBoundsRef.current && dd.pages.length > 0) {
        const allBounds = document.pages.reduce(
          (acc, page) => acc.union(page.bounds),
          document.pages[0].bounds.clone()
        )
        for (const oldPage of dd.pages) {
          allBounds.union(oldPage.bounds)
        }
        updateCameraBoundsRef.current(allBounds)
      }

      setDiffMode(true)
      console.log(`[Diff Toggle] ON — ${createdIds.size} overlay shapes created`)
    } else {
      // Turning OFF
      diffEffectCleanupRef.current?.()
      diffEffectCleanupRef.current = null
      focusChangeRef.current = null

      const idsToRemove = diffShapeIdsRef.current
      if (idsToRemove.size > 0) {
        const assetIds = diffDataRef.current?.pages.map(p => p.assetId) || []
        editor.store.mergeRemoteChanges(() => {
          const allIds = [...idsToRemove, ...assetIds] as any[]
          editor.store.remove(allIds)
        })
        for (const id of idsToRemove) {
          shapeIdSetRef.current.delete(id)
        }
        shapeIdsArrayRef.current = shapeIdsArrayRef.current.filter(id => !idsToRemove.has(id))
      }
      diffShapeIdsRef.current = new Set()

      if (updateCameraBoundsRef.current) {
        const currentBounds = document.pages.reduce(
          (acc, page) => acc.union(page.bounds),
          document.pages[0].bounds.clone()
        )
        updateCameraBoundsRef.current(currentBounds)
      }

      setDiffMode(false)
      console.log('[Diff Toggle] OFF — overlay shapes removed')
    }
  }, [diffMode, diffConfig, document])

  useEffect(() => { toggleDiffRef.current = toggleDiff }, [toggleDiff])

  // Pre-fetch diff data in background for instant first toggle
  useEffect(() => {
    if (!diffConfig) return
    loadDiffData(document.name, diffConfig.basePath, document.pages)
      .then(data => { if (!diffDataRef.current) diffDataRef.current = data })
      .catch(e => console.warn('[Diff] Pre-fetch failed:', e))
  }, [diffConfig, document, diffFetchSeq])

  // Keyboard shortcut: 'd' for diff toggle
  useEffect(() => {
    if (!hasDiffToggle) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'd' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (isInputFocused()) return
        const editor = editorRef.current
        if (!editor) return
        if (editor.getEditingShapeId()) return
        toggleDiff()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [hasDiffToggle, toggleDiff])

  return {
    diffMode, diffLoading, toggleDiff,
    diffDataRef, diffModeRef, toggleDiffRef,
    hasDiffToggle, hasDiffBuiltin, diffShapeIdsRef,
    setDiffFetchSeq,
  }
}
