/**
 * GraphNodeShape — a single claim-node in the native argument graph (approach B).
 *
 * One shape = one claim. Native TLDraw bound arrows connect them and frames
 * group them into boxes, so drag / zoom / arrows-follow all come for free.
 * The shape only holds its own content (label + kind); the graph's structure
 * lives in the arrows/frames, and the source-of-truth content lives in the
 * chain (non-layout). canBind = true so arrows can attach to its outline.
 */
import { BaseBoxShapeUtil, HTMLContainer, T } from 'tldraw'
import { renderMarkdownMath } from './MathNoteShape'

const ACCENT = '#7c3aed'

export const graphNodeProps = {
  w: T.number,
  h: T.number,
  label: T.string,
  kind: T.string, // 'object' | 'state' | 'roadmap'
}

function renderLabel(s: string): { __html: string } {
  const html = renderMarkdownMath(String(s ?? '')).replace(/^<p>([\s\S]*?)<\/p>\s*$/, '$1')
  return { __html: html }
}

export class GraphNodeShapeUtil extends BaseBoxShapeUtil<any> {
  static override type = 'graph-node' as const
  static override props = graphNodeProps

  getDefaultProps() {
    return { w: 200, h: 56, label: '', kind: 'state' }
  }

  override canEdit = () => false
  override canResize = () => true
  override canBind = () => true
  override isAspectRatioLocked = () => false

  component(shape: any) {
    const kind = shape.props.kind as string
    const isObj = kind === 'object'
    const isRoadmap = kind === 'roadmap'
    return (
      <HTMLContainer style={{ width: '100%', height: '100%', pointerEvents: 'all' }}>
        <div
          style={{
            width: '100%', height: '100%', boxSizing: 'border-box',
            display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center',
            padding: '6px 10px', borderRadius: isRoadmap ? 4 : 8,
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
            fontSize: isRoadmap ? 12 : 13, lineHeight: 1.25,
            fontStyle: isRoadmap ? 'italic' : 'normal',
            background: isRoadmap ? 'transparent' : isObj ? `${ACCENT}14` : 'rgba(127,127,127,0.07)',
            border: isRoadmap ? 'none' : `1.5px solid ${isObj ? `${ACCENT}77` : 'rgba(127,127,127,0.35)'}`,
            color: isRoadmap ? 'rgba(127,127,127,0.8)' : 'var(--text,#1a1a1a)',
          }}
        >
          <span dangerouslySetInnerHTML={renderLabel(shape.props.label)} />
        </div>
      </HTMLContainer>
    )
  }

  indicator(shape: any) {
    return <rect width={shape.props.w} height={shape.props.h} rx={8} ry={8} />
  }
}
