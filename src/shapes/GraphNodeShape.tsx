/**
 * GraphNodeShape — one proof step on the argument spine, as a readable CARD.
 *
 * A card holds real text: the step's CLAIM (bold) and, for derived steps, its
 * JUSTIFICATION prose below it — KaTeX throughout, wrapped, sized to content.
 * Leaf assumptions are just the given claim; the goal is the final result.
 * Native bound arrows connect cards (the "depends-on" spine); the justification
 * lives in the card it justifies, never crammed onto an arrow. canBind=true so
 * arrows attach to the card outline.
 */
import { BaseBoxShapeUtil, HTMLContainer, T } from 'tldraw'
import { renderMarkdownMath } from './MathNoteShape'

const ACCENT = '#7c3aed'

export const graphNodeProps = {
  w: T.number,
  h: T.number,
  claim: T.string,
  justification: T.string,
  kind: T.string, // 'assumption' | 'step' | 'goal'
}

function mathHtml(s: string): { __html: string } {
  return { __html: renderMarkdownMath(String(s ?? '')) }
}

export class GraphNodeShapeUtil extends BaseBoxShapeUtil<any> {
  static override type = 'graph-node' as const
  static override props = graphNodeProps

  getDefaultProps() {
    return { w: 360, h: 96, claim: '', justification: '', kind: 'step' }
  }

  override canEdit = () => false
  override canResize = () => true
  override canBind = () => true
  override isAspectRatioLocked = () => false

  component(shape: any) {
    const kind = shape.props.kind as string
    const isAssump = kind === 'assumption'
    const isGoal = kind === 'goal'
    const accent = isGoal ? '#1f9d6b' : isAssump ? '#2f6fb0' : ACCENT
    const bg = isGoal ? 'rgba(31,157,107,0.06)' : isAssump ? 'rgba(47,111,176,0.05)' : 'var(--note-bg,#fbfbfa)'
    return (
      <HTMLContainer style={{ width: '100%', height: '100%', pointerEvents: 'all' }}>
        <div
          style={{
            width: '100%', height: '100%', boxSizing: 'border-box', overflow: 'hidden',
            display: 'flex', flexDirection: 'column', gap: 5, padding: '9px 12px',
            borderRadius: 9, background: bg,
            border: `1.5px solid ${accent}${isAssump || isGoal ? '99' : '55'}`,
            borderLeft: `4px solid ${accent}`,
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
            color: 'var(--text,#1a1a1a)',
          }}
        >
          {isAssump && <div style={{ fontSize: 9, letterSpacing: 0.5, fontWeight: 700, color: accent, opacity: 0.85 }}>ASSUMPTION</div>}
          {isGoal && <div style={{ fontSize: 9, letterSpacing: 0.5, fontWeight: 700, color: accent, opacity: 0.85 }}>RESULT</div>}
          <div style={{ fontSize: 14, lineHeight: 1.3, fontWeight: 600 }} dangerouslySetInnerHTML={mathHtml(shape.props.claim)} />
          {shape.props.justification && (
            <div style={{ fontSize: 12, lineHeight: 1.4, color: 'rgba(90,90,90,0.95)' }} dangerouslySetInnerHTML={mathHtml(shape.props.justification)} />
          )}
        </div>
      </HTMLContainer>
    )
  }

  indicator(shape: any) {
    return <rect width={shape.props.w} height={shape.props.h} rx={9} ry={9} />
  }
}
