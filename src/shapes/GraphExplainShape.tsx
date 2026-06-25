/**
 * GraphExplainShape — the explanation zone at the bottom of the argument-graph
 * container. It's a real canvas shape (pans with the graph), parented inside the
 * frame. It carries no content of its own; it reactively shows the hovered (or
 * selected) arrow's `detail` — the long reason behind that inference. Like a
 * subtitle box: the short verb is on the arrow, the full reasoning lands here.
 */
import { BaseBoxShapeUtil, HTMLContainer, useEditor, useValue } from 'tldraw'
import { renderMarkdownMath } from './MathNoteShape'
import { graphExplainProps } from '../../shared/shapes/graph-node-schema.mjs'

function mathHtml(s: string): { __html: string } {
  return { __html: renderMarkdownMath(String(s ?? '')) }
}
function inlineHtml(s: string): { __html: string } {
  return { __html: renderMarkdownMath(String(s ?? '')).replace(/^<p>([\s\S]*?)<\/p>\s*$/, '$1') }
}

function ExplainBody() {
  const editor = useEditor()
  const info = useValue(
    'graph-explain-body',
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

  if (!info) {
    return (
      <div style={{ fontSize: 12, fontStyle: 'italic', color: 'rgba(120,120,120,0.85)' }}>
        Hover an arrow to see the reasoning behind that step.
      </div>
    )
  }
  return (
    <>
      <div style={{ fontSize: 10, letterSpacing: 0.4, fontWeight: 700, marginBottom: 6, color: info.lb ? '#7c3aed' : 'rgba(110,110,110,0.95)' }}>
        {info.lb ? 'LOAD-BEARING STEP' : 'STEP'}{info.rule ? ' · ' : ''}
        <span style={{ fontWeight: 500 }} dangerouslySetInnerHTML={inlineHtml(info.rule)} />
      </div>
      <div style={{ fontSize: 13, lineHeight: 1.5 }} dangerouslySetInnerHTML={mathHtml(info.detail)} />
    </>
  )
}

export class GraphExplainShapeUtil extends BaseBoxShapeUtil<any> {
  static override type = 'graph-explain' as const
  static override props = graphExplainProps

  getDefaultProps() {
    return { w: 600, h: 130 }
  }

  override canEdit = () => false
  override canResize = () => true
  override canBind = () => false
  override isAspectRatioLocked = () => false

  component(_shape: any) {
    return (
      <HTMLContainer style={{ width: '100%', height: '100%', pointerEvents: 'all' }}>
        <div
          style={{
            width: '100%', height: '100%', boxSizing: 'border-box', overflow: 'auto',
            padding: '10px 14px', borderRadius: 8,
            background: '#f6f7f9', border: '1px solid rgba(127,127,127,0.28)',
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
            color: '#1a1a1a',
          }}
        >
          <ExplainBody />
        </div>
      </HTMLContainer>
    )
  }

  getIndicatorPath(shape: any) {
    const path = new Path2D()
    path.rect(0, 0, shape.props.w, shape.props.h)
    return path
  }

  indicator(shape: any) {
    return <rect width={shape.props.w} height={shape.props.h} rx={8} ry={8} />
  }
}
