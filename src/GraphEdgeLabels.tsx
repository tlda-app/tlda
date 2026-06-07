/**
 * Graph overlay: tiny rule-tags on the arrows (structural, on the surface) + a
 * fixed DETAIL PANEL that shows the substance of whatever inference you point at.
 *
 * "Arrows are where the work happens; it shouldn't be 100% visible but it should
 * be accessible — and it shouldn't occlude." So: the surface stays a clean
 * skeleton (claims + arrows + a one-word rule tag); the inference's full "why"
 * lives in `meta.detail` and only appears in the side panel, pinned to the
 * screen edge so it never covers the graph.
 */
import { useEditor, useValue } from 'tldraw'
import { renderMarkdownMath } from './shapes/MathNoteShape'

function mathHtml(s: string): { __html: string } {
  return { __html: renderMarkdownMath(String(s ?? '')) }
}
function inlineHtml(s: string): { __html: string } {
  return { __html: renderMarkdownMath(String(s ?? '')).replace(/^<p>([\s\S]*?)<\/p>\s*$/, '$1') }
}

export function GraphEdgeLabels() {
  const editor = useEditor()

  // tiny rule tags at each arrow's midpoint (only where a rule is set)
  const tags = useValue(
    'graph-rule-tags',
    () => {
      const out: { id: string; x: number; y: number; html: { __html: string }; lb: boolean }[] = []
      for (const s of editor.getCurrentPageShapes()) {
        if (s.type !== 'arrow' || !s.meta?.graphEdge) continue
        if (!s.meta.showTag) continue // surface tags only where they sit cleanly (assumption edges)
        const rule = String(s.meta.rule ?? '')
        if (!rule) continue
        const b = editor.getShapePageBounds(s.id)
        if (!b) continue
        out.push({ id: s.id, x: b.midX, y: b.midY, html: inlineHtml(rule), lb: !!s.meta.lb })
      }
      return out
    },
    [editor],
  )

  // detail of the hovered (or selected) graph edge/node — for the side panel
  const detail = useValue(
    'graph-detail',
    () => {
      const id = editor.getHoveredShapeId() || editor.getOnlySelectedShapeId()
      if (!id) return null
      const s = editor.getShape(id)
      if (!s || !s.meta?.graphEdge) return null
      const d = String(s.meta.detail ?? '')
      if (!d) return null
      return { rule: String(s.meta.rule ?? ''), detail: d, lb: !!s.meta.lb }
    },
    [editor],
  )

  return (
    <>
      {tags.map((t) => (
        <div
          key={t.id}
          style={{
            position: 'absolute', left: t.x, top: t.y, transform: 'translate(-50%,-50%)',
            pointerEvents: 'none', whiteSpace: 'nowrap',
            background: 'var(--note-bg,#fbfbfa)', padding: '0 3px', borderRadius: 3,
            fontSize: 10.5, lineHeight: 1.1,
            color: t.lb ? '#7c3aed' : 'rgba(110,110,110,0.9)', fontWeight: t.lb ? 600 : 400,
          }}
          dangerouslySetInnerHTML={t.html}
        />
      ))}

      {/* fixed, non-occluding detail panel */}
      <div
        style={{
          position: 'fixed', top: 12, right: 12, width: 320, maxHeight: '60vh', overflowY: 'auto',
          pointerEvents: 'none', zIndex: 400,
          background: 'rgba(251,251,250,0.97)', border: '1px solid rgba(127,127,127,0.25)',
          borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,0.10)',
          padding: detail ? '11px 13px' : 0, opacity: detail ? 1 : 0, transition: 'opacity 0.12s',
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
          color: 'var(--text,#1a1a1a)',
        }}
      >
        {detail && (
          <>
            <div style={{ fontSize: 10, letterSpacing: 0.4, fontWeight: 700, color: detail.lb ? '#7c3aed' : 'rgba(110,110,110,0.9)', marginBottom: 6 }}>
              {detail.lb ? 'LOAD-BEARING STEP' : 'STEP'}{detail.rule ? ' · ' : ''}<span style={{ fontWeight: 500 }} dangerouslySetInnerHTML={inlineHtml(detail.rule)} />
            </div>
            <div style={{ fontSize: 12.5, lineHeight: 1.5 }} dangerouslySetInnerHTML={mathHtml(detail.detail)} />
          </>
        )}
      </div>
    </>
  )
}
