import { createRoot } from 'react-dom/client'
import { Tldraw, type Editor } from 'tldraw'
import 'tldraw/tldraw.css'
import { GraphNodeShapeUtil } from './shapes/GraphNodeShape'
import { materializeChain } from './graphNativeMaterialize'
import { biasChain } from './graphDemoData'

// Standalone, sync-free harness: a local tldraw canvas with the graph-node shape
// registered, materializing the bias-proof chain into native shapes on mount.
function App() {
  return (
    <Tldraw
      shapeUtils={[GraphNodeShapeUtil]}
      onMount={(editor: Editor) => {
        ;(window as any).__tldraw_editor__ = editor
        try { materializeChain(editor, biasChain) }
        catch (e) { console.error('materialize failed', e) }
      }}
    />
  )
}

createRoot(document.getElementById('host')!).render(<App />)
