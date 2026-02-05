import { useMemo, useState, useCallback, useEffect, useRef } from 'react'
import {
  Box,
  Tldraw,
  AssetRecordType,
  createShapeId,
  getIndicesBetween,
  react,
  sortByIndex,
  useEditor,
  DefaultToolbar,
} from 'tldraw'
import type { TLComponents, TLImageShape, TLShapePartial, Editor, TLShape, TLAssetId, TLShapeId } from 'tldraw'
import 'tldraw/tldraw.css'
import { MathNoteShapeUtil } from './MathNoteShape'
import { MathNoteTool } from './MathNoteTool'
import { setActiveMacros } from './katexMacros'
// import { useYjsSync } from './useYjsSync'

// Sync server URL - use env var for production, localhost for dev
// const SYNC_SERVER = import.meta.env.VITE_SYNC_SERVER || 'ws://localhost:5176'

// Global document info for synctex anchoring
export let currentDocumentInfo: {
  name: string
  pages: Array<{ bounds: { x: number, y: number, width: number, height: number }, width: number, height: number }>
} | null = null

// Inner component to set up Yjs sync (needs useEditor context)
// TEMPORARILY DISABLED - debugging crash
function YjsSyncProvider({ roomId }: { roomId: string }) {
  console.log('[Yjs] Sync disabled for debugging, room:', roomId)
  // const editor = useEditor()
  // useYjsSync({ editor, roomId, serverUrl: SYNC_SERVER })
  return null
}

interface SvgPage {
  src: string
  bounds: Box
  assetId: TLAssetId
  shapeId: TLShapeId
  width: number
  height: number
}

interface SvgDocument {
  name: string
  pages: SvgPage[]
  macros?: Record<string, string>
}

interface SvgDocumentEditorProps {
  document: SvgDocument
  roomId: string
}

const pageSpacing = 32

export async function loadSvgDocument(name: string, svgUrls: string[]): Promise<SvgDocument> {
  // Fetch all SVGs in parallel
  console.log(`Loading ${svgUrls.length} SVG pages...`)

  // Derive macros.json path from first SVG URL
  const basePath = svgUrls[0].replace(/page-\d+\.svg$/, '')
  const macrosUrl = basePath + 'macros.json'

  // Fetch SVGs and macros in parallel
  const [svgTexts, macrosData] = await Promise.all([
    Promise.all(
      svgUrls.map(async (url) => {
        const response = await fetch(url)
        if (!response.ok) throw new Error(`Failed to fetch ${url}`)
        return response.text()
      })
    ),
    fetch(macrosUrl)
      .then(r => r.ok ? r.json() : null)
      .catch(() => null)
  ])

  // Set active macros if loaded
  if (macrosData?.macros) {
    console.log(`Loaded ${Object.keys(macrosData.macros).length} macros from preamble`)
    setActiveMacros(macrosData.macros)
  }

  console.log('All SVGs fetched, processing...')

  const pages: SvgPage[] = []
  let top = 0
  let widest = 0

  for (let i = 0; i < svgTexts.length; i++) {
    const svgText = svgTexts[i]

    // Parse SVG to get dimensions
    const parser = new DOMParser()
    const doc = parser.parseFromString(svgText, 'image/svg+xml')
    const svgEl = doc.querySelector('svg')

    let width = 600
    let height = 800

    if (svgEl) {
      // Try to get dimensions from viewBox or width/height attributes
      const viewBox = svgEl.getAttribute('viewBox')
      const widthAttr = svgEl.getAttribute('width')
      const heightAttr = svgEl.getAttribute('height')

      if (viewBox) {
        const parts = viewBox.split(/\s+/)
        if (parts.length === 4) {
          width = parseFloat(parts[2]) || width
          height = parseFloat(parts[3]) || height
        }
      }

      if (widthAttr) {
        const w = parseFloat(widthAttr)
        if (!isNaN(w)) width = w
      }
      if (heightAttr) {
        const h = parseFloat(heightAttr)
        if (!isNaN(h)) height = h
      }
    }

    // Scale to reasonable size (target ~800px wide)
    const scale = 800 / width
    width = width * scale
    height = height * scale

    // Convert SVG to base64 data URL (TLDraw doesn't accept blob URLs)
    const dataUrl = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgText)))

    // Use deterministic IDs based on document name + page index
    // This prevents duplicates when Yjs syncs existing shapes
    const pageId = `${name}-page-${i}`
    pages.push({
      src: dataUrl,
      bounds: new Box(0, top, width, height),
      assetId: AssetRecordType.createId(pageId),
      shapeId: createShapeId(pageId),
      width,
      height,
    })

    top += height + pageSpacing
    widest = Math.max(widest, width)
  }

  // Center pages
  for (const page of pages) {
    page.bounds.x = (widest - page.bounds.width) / 2
  }

  console.log('SVG document ready')
  return { name, pages }
}

export function SvgDocumentEditor({ document, roomId }: SvgDocumentEditorProps) {
  // Skip sync for now - just use local store
  const editorRef = useRef<Editor | null>(null)

  // WebSocket connection for forward sync (Claude → iPad)
  // Only connect on local network, not in production
  const forwardSyncUrl = import.meta.env.VITE_FORWARD_SYNC_SERVER
  useEffect(() => {
    if (!forwardSyncUrl) return // Skip in production

    const ws = new WebSocket(forwardSyncUrl)

    ws.onopen = () => {
      console.log('WebSocket connected for forward sync')
    }

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        const editor = editorRef.current
        if (!editor) return

        if (data.type === 'highlight') {
          console.log('Received highlight:', data)

          // Scroll to the highlighted location
          editor.centerOnPoint({ x: data.x, y: data.y }, { animation: { duration: 300 } })

          // Create a temporary highlight shape (unless noMarker is set)
          if (!data.noMarker) {
            const markerId = createShapeId()
            editor.createShape({
              id: markerId,
              type: 'geo',
              x: data.x - 30,
              y: data.y - 30,
              props: {
                geo: 'ellipse',
                w: 60,
                h: 60,
                fill: 'none',
                color: 'red',
                size: 'm',
              },
            })

            // Remove after 3 seconds
            setTimeout(() => {
              if (editor.getShape(markerId)) {
                editor.deleteShape(markerId)
              }
            }, 3000)
          }
        }

        // Just scroll, no marker
        if (data.type === 'scroll') {
          editor.centerOnPoint({ x: data.x, y: data.y }, { animation: { duration: 300 } })
        }

        if (data.type === 'note') {
          console.log('Received note:', data)

          // Scroll to the location
          editor.centerOnPoint({ x: data.x, y: data.y }, { animation: { duration: 300 } })

          // Create a note shape (sticky) - TLDraw 4.x uses richText
          editor.createShape({
            id: createShapeId(),
            type: 'note',
            x: data.x,
            y: data.y,
            props: {
              color: 'violet',  // Purple for Claude
              size: 'm',
              font: 'sans',
              align: 'start',
              verticalAlign: 'start',
              richText: {
                type: 'doc',
                content: [
                  {
                    type: 'paragraph',
                    content: [{ type: 'text', text: data.text || '' }],
                  },
                ],
              },
            },
          })
        }

        // Reply to an existing note - append with highlight mark
        if (data.type === 'reply') {
          console.log('Received reply:', data)
          const targetId = data.shapeId as TLShapeId
          const shape = editor.getShape(targetId)

          if (shape && shape.type === 'note') {
            const noteShape = shape as TLShape & { props: { richText: { content: unknown[] } } }
            const existingRichText = noteShape.props.richText

            // Append with highlight mark using TLDraw color name
            const newContent = [
              ...existingRichText.content,
              { type: 'paragraph', content: [] },
              {
                type: 'paragraph',
                content: [{
                  type: 'text',
                  text: 'Claude: ' + (data.text || ''),
                  marks: [{ type: 'highlight', attrs: { color: 'violet' } }]
                }]
              }
            ]

            editor.updateShape({
              id: targetId,
              type: 'note',
              props: {
                richText: {
                  type: 'doc',
                  content: newContent,
                },
              },
            })

            editor.centerOnPoint({ x: shape.x, y: shape.y }, { animation: { duration: 300 } })
          }
        }
      } catch (e) {
        console.error('WebSocket message error:', e)
      }
    }

    ws.onclose = () => {
      console.log('WebSocket disconnected')
    }

    ws.onerror = (e) => {
      console.error('WebSocket error:', e)
    }

    return () => {
      ws.close()
    }
  }, [])

  const components = useMemo<TLComponents>(
    () => ({
      PageMenu: null,
      SharePanel: () => <RoomInfo roomId={roomId} name={document.name} />,
      Toolbar: (props) => <DefaultToolbar {...props} orientation="vertical" />,
    }),
    [document, roomId]
  )

  const shapeUtils = useMemo(() => [MathNoteShapeUtil], [])
  const tools = useMemo(() => [MathNoteTool], [])

  // Override toolbar to replace note with math-note
  const overrides = useMemo(() => ({
    tools: (_editor: Editor, tools: any) => {
      // Add math-note tool definition
      tools['math-note'] = {
        id: 'math-note',
        icon: 'tool-note',
        label: 'Math Note',
        kbd: 'm',
        onSelect: () => _editor.setCurrentTool('math-note'),
      }
      // Override the 'note' tool to activate math-note instead
      if (tools['note']) {
        tools['note'] = {
          ...tools['note'],
          onSelect: () => _editor.setCurrentTool('math-note'),
        }
      }
      return tools
    },
  }), [])

  return (
    <Tldraw
        shapeUtils={shapeUtils}
        tools={tools}
        overrides={overrides}
        onMount={(editor) => {
          // Expose editor for debugging/puppeteer access
          (window as unknown as { __tldraw_editor__: Editor }).__tldraw_editor__ = editor
          editorRef.current = editor
          setupSvgEditor(editor, document)

          // Set global document info for synctex anchoring
          currentDocumentInfo = {
            name: document.name,
            pages: document.pages.map(p => ({
              bounds: { x: p.bounds.x, y: p.bounds.y, width: p.bounds.width, height: p.bounds.height },
              width: p.width,
              height: p.height
            }))
          }

          // Keyboard shortcut: 'm' for math note
          const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'm' && !e.metaKey && !e.ctrlKey && !e.altKey) {
              if (editor.getEditingShapeId()) return // Don't trigger while editing
              editor.setCurrentTool('math-note')
            }
          }
          window.addEventListener('keydown', handleKeyDown)
        }}
        components={components}
        forceMobile
    >
      <YjsSyncProvider roomId={roomId} />
    </Tldraw>
  )
}

function setupSvgEditor(editor: Editor, document: SvgDocument) {
  // Check if assets already exist (from sync)
  const existingAssets = editor.getAssets()
  const hasAssets = existingAssets.some(a => a.props && 'name' in a.props && a.props.name === 'svg-page')

  if (!hasAssets) {
    // Create assets for each page
    editor.createAssets(
      document.pages.map((page) => ({
        id: page.assetId,
        typeName: 'asset',
        type: 'image',
        meta: {},
        props: {
          w: page.width,
          h: page.height,
          mimeType: 'image/svg+xml',
          src: page.src,
          name: 'svg-page',
          isAnimated: false,
        },
      }))
    )

    // Create shapes for each page
    editor.createShapes(
      document.pages.map(
        (page): TLShapePartial<TLImageShape> => ({
          id: page.shapeId,
          type: 'image',
          x: page.bounds.x,
          y: page.bounds.y,
          isLocked: true,
          props: {
            assetId: page.assetId,
            w: page.bounds.w,
            h: page.bounds.h,
          },
        })
      )
    )
  }

  const shapeIds = document.pages.map((page) => page.shapeId)
  const shapeIdSet = new Set(shapeIds)

  // Don't let the user unlock the pages
  editor.sideEffects.registerBeforeChangeHandler('shape', (prev, next) => {
    if (!shapeIdSet.has(next.id)) return next
    if (next.isLocked) return next
    return { ...prev, isLocked: true }
  })

  // Make sure the shapes are below any of the other shapes
  function makeSureShapesAreAtBottom() {
    const shapes = shapeIds
      .map((id) => editor.getShape(id))
      .filter((s): s is TLShape => s !== undefined)
      .sort(sortByIndex)
    if (shapes.length === 0) return

    const pageId = editor.getCurrentPageId()
    const siblings = editor.getSortedChildIdsForParent(pageId)
    const currentBottomShapes = siblings
      .slice(0, shapes.length)
      .map((id) => editor.getShape(id)!)

    if (currentBottomShapes.every((shape, i) => shape?.id === shapes[i]?.id)) return

    const otherSiblings = siblings.filter((id) => !shapeIdSet.has(id))
    if (otherSiblings.length === 0) return

    const bottomSibling = otherSiblings[0]
    const bottomShape = editor.getShape(bottomSibling)
    if (!bottomShape) return

    const lowestIndex = bottomShape.index
    const indexes = getIndicesBetween(undefined, lowestIndex, shapes.length)

    editor.updateShapes(
      shapes.map((shape, i) => ({
        id: shape.id,
        type: shape.type,
        isLocked: true,
        index: indexes[i],
      }))
    )
  }

  makeSureShapesAreAtBottom()
  editor.sideEffects.registerAfterCreateHandler('shape', makeSureShapesAreAtBottom)
  editor.sideEffects.registerAfterChangeHandler('shape', makeSureShapesAreAtBottom)

  // Constrain the camera to the bounds of the pages
  const targetBounds = document.pages.reduce(
    (acc, page) => acc.union(page.bounds),
    document.pages[0].bounds.clone()
  )

  function updateCameraBounds(_isMobile: boolean) {
    editor.setCameraOptions({
      constraints: {
        bounds: targetBounds,
        padding: { x: 100, y: 50 },
        origin: { x: 0.5, y: 0 },
        initialZoom: 'fit-x-100',
        baseZoom: 'default',
        behavior: 'free',
      },
    })
    editor.setCamera(editor.getCamera(), { reset: true })
  }

  let isMobile = editor.getViewportScreenBounds().width < 840

  react('update camera', () => {
    const isMobileNow = editor.getViewportScreenBounds().width < 840
    if (isMobileNow === isMobile) return
    isMobile = isMobileNow
    updateCameraBounds(isMobile)
  })

  updateCameraBounds(isMobile)
}

function RoomInfo({ roomId: _roomId, name: _name }: { roomId: string; name: string }) {
  const editor = useEditor()
  const [shareState, setShareState] = useState<'idle' | 'sending' | 'success' | 'error'>('idle')

  // Snapshot sharing is for local dev only (sharing to iPad)
  const snapshotServerUrl = import.meta.env.VITE_SNAPSHOT_SERVER

  const shareSnapshot = useCallback(async () => {
    if (shareState === 'sending' || !snapshotServerUrl) return

    console.log('Share clicked')
    setShareState('sending')

    try {
      const snapshot = editor.store.getStoreSnapshot()
      console.log('Got snapshot, size:', JSON.stringify(snapshot).length)
      const resp = await fetch(snapshotServerUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(snapshot),
      })
      console.log('Fetch response:', resp.status)

      if (resp.ok) {
        setShareState('success')
        setTimeout(() => setShareState('idle'), 1500)
      } else {
        setShareState('error')
        setTimeout(() => setShareState('idle'), 2000)
      }
    } catch (e) {
      console.error('Share error:', e)
      setShareState('error')
      setTimeout(() => setShareState('idle'), 2000)
    }
  }, [editor, shareState, snapshotServerUrl])

  // Don't render share button in production (when no snapshot server configured)
  if (!snapshotServerUrl) {
    return null
  }

  return (
    <div className="RoomInfo">
      <button
        onClick={shareSnapshot}
        className={`share-btn share-btn--${shareState}`}
        disabled={shareState === 'sending'}
        aria-label="Share"
      >
        ✳
      </button>
    </div>
  )
}
