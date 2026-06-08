/**
 * GraphNodeShape — one claim on the skeleton (a resting state).
 *
 * The surface shows ONLY the clean claim — no justification prose. The "why"
 * lives on the edges (the inferences) and surfaces in a side panel on hover.
 * Compact, KaTeX, kind-tinted (assumption / step / goal). canBind=true so
 * arrows attach to its outline.
 */
import { BaseBoxShapeUtil, HTMLContainer } from 'tldraw'
import { renderMarkdownMath } from './MathNoteShape'
import { graphNodeProps } from '../../shared/shapes/graph-node-schema.mjs'

function mathHtml(s: string): { __html: string } {
  return { __html: renderMarkdownMath(String(s ?? '')).replace(/^<p>([\s\S]*?)<\/p>\s*$/, '$1') }
}

export class GraphNodeShapeUtil extends BaseBoxShapeUtil<any> {
  static override type = 'graph-node' as const
  static override props = graphNodeProps

  getDefaultProps() {
    return { w: 230, h: 50, claim: '', kind: 'step' }
  }

  override canEdit = () => false
  override canResize = () => true
  override canBind = () => true
  override isAspectRatioLocked = () => false

  component(shape: any) {
    const kind = shape.props.kind as string
    const isAssump = kind === 'assumption'
    const isGoal = kind === 'goal'
    const accent = isGoal ? '#1f9d6b' : isAssump ? '#2f6fb0' : '#7c3aed'
    // Opaque light tints (not alpha over canvas) so dark text stays legible in any theme.
    const bg = isGoal ? '#eaf7f1' : isAssump ? '#eef4fb' : '#fbfbfa'
    return (
      <HTMLContainer style={{ width: '100%', height: '100%', pointerEvents: 'all' }}>
        <div
          style={{
            position: 'relative',
            width: '100%', height: '100%', boxSizing: 'border-box', overflow: 'hidden',
            display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center',
            padding: '6px 11px', borderRadius: 8, background: bg,
            border: `1.5px solid ${accent}${isAssump || isGoal ? '88' : '55'}`,
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
            fontSize: 13, lineHeight: 1.25, color: '#1a1a1a',
          }}
        >
          {/* discoverable type word — faint, learn the color mapping and you stop needing it */}
          <span
            style={{
              position: 'absolute', top: 3, left: 7,
              fontSize: 8, letterSpacing: 0.5, fontWeight: 700, textTransform: 'uppercase',
              color: accent, opacity: 0.55, pointerEvents: 'none',
            }}
          >
            {kind}
          </span>
          <span dangerouslySetInnerHTML={mathHtml(shape.props.claim)} />
        </div>
      </HTMLContainer>
    )
  }

  indicator(shape: any) {
    return <rect width={shape.props.w} height={shape.props.h} rx={8} ry={8} />
  }
}
