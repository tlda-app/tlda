import { useCallback, useState } from 'react'
import type { Editor } from 'tldraw'
import { SvgDocumentEditor } from '../SvgDocument'
import type { SvgDocument } from '../loaders/types'
import { LayersContext } from './layersContext'
import { useDocumentLayers } from './useDocumentLayers'
import './DocumentWithLayers.css'

/**
 * An ordinary document or deck, with the reader's layers over it.
 *
 * Skip, 2026-09-02: "ps the layers ui is complete bullshit… it's like 'draft
 * mode', an old fucking thing." He was right, and not about the control: on this
 * surface the real one could not render at all. It needs the layers, the layers
 * hung off the book context, and `App` renders anything whose format is not
 * `book` through `SvgDocumentEditor` directly — so `useLayers()` was null, the
 * control returned null, and the only things left in the pills row were the two
 * draft-mode pills. That is what he was looking at when he judged the layers UI.
 *
 * A book already had this. Everything here is the same call a book makes.
 */
export function DocumentWithLayers({
  document,
  roomId,
  initialCamera,
  onEditorMount,
}: {
  document: SvgDocument
  roomId: string
  initialCamera?: { x: number; y: number; z: number }
  onEditorMount?: (editor: Editor | null) => void
}) {
  // The editor comes from the thing we are rendering, and the layers need it to
  // know which canvas holds the common layer — so it is held here and passed on
  // to the original caller unchanged.
  const [documentEditor, setDocumentEditor] = useState<Editor | null>(null)
  const handleEditorMount = useCallback((editor: Editor | null) => {
    setDocumentEditor(editor)
    onEditorMount?.(editor)
  }, [onEditorMount])

  const { layersValue, annotationsHidden, overlays } = useDocumentLayers({
    roomId,
    documentEditor,
  })

  return (
    <LayersContext.Provider value={layersValue}>
      {/* The overlays are `position: absolute; inset: 0`, so they need a
          positioned ancestor to size against. A book gives them `.book-viewer`;
          this is the same thing for a document rendered on its own. */}
      <div className="documentWithLayers">
        <SvgDocumentEditor
          document={document}
          roomId={roomId}
          initialCamera={initialCamera}
          annotationsHidden={annotationsHidden}
          onEditorMount={handleEditorMount}
        />
        {overlays}
      </div>
    </LayersContext.Provider>
  )
}
