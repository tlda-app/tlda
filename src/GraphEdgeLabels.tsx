/**
 * GraphEdgeLabels — KaTeX labels for the native graph's bound arrows.
 *
 * Native TLDraw arrow labels can't render math, so graph edges carry their
 * property in `meta.property` and this overlay renders it with KaTeX at the
 * arrow's midpoint. It lives in `InFrontOfTheCanvas` (page space, in front of
 * shapes) and reads arrow page-bounds reactively — so when a node is dragged and
 * its bound arrow re-routes, the label moves with it.
 */
import { useEditor, useValue } from 'tldraw'
import { renderMarkdownMath } from './shapes/MathNoteShape'

function renderLabel(s: string): { __html: string } {
  return { __html: renderMarkdownMath(String(s ?? '')).replace(/^<p>([\s\S]*?)<\/p>\s*$/, '$1') }
}

export function GraphEdgeLabels() {
  const editor = useEditor()
  const labels = useValue(
    'graph-edge-labels',
    () => {
      const out: { id: string; x: number; y: number; html: { __html: string }; lb: boolean }[] = []
      for (const s of editor.getCurrentPageShapes()) {
        if (s.type !== 'arrow' || !s.meta?.graphEdge) continue
        const via = String(s.meta.via ?? '')
        if (!via) continue // bare spine edge — no label
        const b = editor.getShapePageBounds(s.id)
        if (!b) continue
        out.push({ id: s.id, x: b.midX, y: b.midY, html: renderLabel(via), lb: !!s.meta.lb })
      }
      return out
    },
    [editor],
  )

  return (
    <>
      {labels.map((l) => (
        <div
          key={l.id}
          style={{
            position: 'absolute', left: l.x, top: l.y, transform: 'translate(-50%,-50%)',
            pointerEvents: 'none', whiteSpace: 'nowrap',
            background: 'var(--note-bg,#fbfbfa)', padding: '0 4px', borderRadius: 3,
            fontSize: 12, lineHeight: 1.1,
            color: l.lb ? '#7c3aed' : 'rgba(90,90,90,0.95)',
            fontWeight: l.lb ? 600 : 400,
          }}
          dangerouslySetInnerHTML={l.html}
        />
      ))}
    </>
  )
}
