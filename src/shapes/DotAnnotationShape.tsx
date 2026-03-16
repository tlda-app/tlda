/**
 * DotAnnotationShape — small colored dot that expands into a note card on tap.
 *
 * Used by agents to annotate highlights with response text. Collapsed state is
 * a tiny presence indicator; expanded state shows the full response.
 *
 * Props:
 *   - w/h: dimensions (small when collapsed, card-sized when expanded)
 *   - highlightColor: hex color matching the associated highlight
 *   - text: agent response text (markdown-ish, rendered as plain text for now)
 *   - collapsed: whether to show as dot or card
 *   - highlightId: optional ID of the associated highlight shape
 */
import {
  BaseBoxShapeUtil,
  HTMLContainer,
  T,
  stopEventPropagation,
  useEditor,
} from 'tldraw'
import { useCallback } from 'react'

const DOT_SIZE = 10
const CARD_W = 240
const CARD_H = 160

export class DotAnnotationShapeUtil extends BaseBoxShapeUtil<any> {
  static override type = 'dot-annotation' as const
  static override props = {
    w: T.number,
    h: T.number,
    highlightColor: T.string,
    text: T.string,
    collapsed: T.boolean,
    highlightId: T.string,
  }

  getDefaultProps() {
    return {
      w: DOT_SIZE,
      h: DOT_SIZE,
      highlightColor: '#ffc940',
      text: '',
      collapsed: true,
      highlightId: '',
    }
  }

  override canEdit = () => false
  override canResize = () => false
  override canBind = () => false
  override isAspectRatioLocked = () => true
  override hideRotateHandle = () => true
  override hideResizeHandles = () => true
  override hideSelectionBoundsBg = () => true
  override hideSelectionBoundsFg = () => true

  component(shape: any) {
    return <DotAnnotationComponent shape={shape} />
  }

  indicator(shape: any) {
    if (shape.props.collapsed) {
      return <circle cx={DOT_SIZE / 2} cy={DOT_SIZE / 2} r={DOT_SIZE / 2} />
    }
    return <rect width={shape.props.w} height={shape.props.h} rx={6} ry={6} />
  }
}

function DotAnnotationComponent({ shape }: { shape: any }) {
  const editor = useEditor()
  const { highlightColor, text, collapsed } = shape.props

  const handleToggle = useCallback((e: React.PointerEvent) => {
    stopEventPropagation(e)
    const newCollapsed = !collapsed
    editor.store.update(shape.id, (s: any) => ({
      ...s,
      props: {
        ...s.props,
        collapsed: newCollapsed,
        w: newCollapsed ? DOT_SIZE : CARD_W,
        h: newCollapsed ? DOT_SIZE : Math.max(CARD_H, 60),
      },
    }))
  }, [editor, shape.id, collapsed])

  if (collapsed) {
    return (
      <HTMLContainer
        style={{
          width: DOT_SIZE,
          height: DOT_SIZE,
          pointerEvents: 'all',
          cursor: 'pointer',
          overflow: 'visible',
        }}
        onPointerDown={handleToggle}
      >
        <div
          style={{
            width: DOT_SIZE,
            height: DOT_SIZE,
            borderRadius: '50%',
            backgroundColor: highlightColor,
            opacity: 0.7,
            transition: 'opacity 0.2s, transform 0.2s',
            boxShadow: `0 0 0 2px rgba(255,255,255,0.8), 0 1px 3px rgba(0,0,0,0.15)`,
          }}
        />
      </HTMLContainer>
    )
  }

  // Expanded: note card
  return (
    <HTMLContainer
      style={{
        width: shape.props.w,
        height: shape.props.h,
        pointerEvents: 'all',
        overflow: 'visible',
      }}
    >
      <div
        style={{
          width: '100%',
          height: '100%',
          backgroundColor: 'var(--color-background, #fff)',
          border: `2px solid ${highlightColor}`,
          borderRadius: 8,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          boxShadow: '0 2px 12px rgba(0,0,0,0.12)',
        }}
      >
        {/* Header with dot + collapse button */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '6px 8px',
            borderBottom: `1px solid color-mix(in srgb, ${highlightColor} 25%, transparent)`,
            cursor: 'pointer',
          }}
          onPointerDown={handleToggle}
        >
          <div
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              backgroundColor: highlightColor,
              flexShrink: 0,
            }}
          />
          <span style={{
            fontSize: 10,
            color: 'var(--color-text-1, #999)',
            flex: 1,
          }}>
            annotation
          </span>
          <span style={{
            fontSize: 12,
            color: 'var(--color-text-1, #999)',
            cursor: 'pointer',
            lineHeight: 1,
          }}>
            {'\u2715'}
          </span>
        </div>
        {/* Body text */}
        <div
          style={{
            flex: 1,
            padding: '6px 10px',
            fontSize: 13,
            lineHeight: 1.5,
            color: 'var(--color-text, #222)',
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
          onPointerDown={stopEventPropagation}
        >
          {text || '(empty)'}
        </div>
      </div>
    </HTMLContainer>
  )
}
