import { createRoot } from 'react-dom/client'
import { Tldraw, type Editor } from 'tldraw'
import 'tldraw/tldraw.css'
import { GraphNodeShapeUtil } from './shapes/GraphNodeShape'
import { materializeChain } from './graphNativeMaterialize'
import { biasChain } from './graphDemoData'
import { GraphEdgeLabels } from './GraphEdgeLabels'

const components = { InFrontOfTheCanvas: GraphEdgeLabels }

// Standalone, sync-free harness: a local tldraw canvas with the graph-node shape
// registered, materializing the bias-proof chain into native shapes on mount.
function App() {
  return (
    <Tldraw
      shapeUtils={[GraphNodeShapeUtil]}
      components={components}
      onMount={(editor: Editor) => {
        ;(window as unknown as { __tldraw_editor__: Editor }).__tldraw_editor__ = editor
        try { materializeChain(editor, biasChain) }
        catch (e) { console.error('materialize failed', e) }
      }}
    />
  )
}

createRoot(document.getElementById('host')!).render(<App />)
