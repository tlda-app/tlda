import {
  BaseBoxShapeUtil,
  HTMLContainer,
  T,
  stopEventPropagation,
} from 'tldraw'
import { appendToken } from '../authToken'

export class InlineDocShapeUtil extends BaseBoxShapeUtil<any> {
  static override type = 'inline-doc' as const
  static override props = {
    w: T.number,
    h: T.number,
    url: T.string,
    title: T.string,
  }

  getDefaultProps() {
    return { w: 800, h: 1000, url: '', title: '' }
  }

  override canEdit = () => false
  override canResize = () => true
  override hideRotateHandle = () => true
  override canBind = () => false

  component(shape: any) {
    return <InlineDocComponent shape={shape} />
  }

  getIndicatorPath(shape: any) {
    const path = new Path2D()
    path.rect(0, 0, shape.props.w, shape.props.h)
    return path
  }

  indicator(shape: any) {
    return <rect width={shape.props.w} height={shape.props.h} rx={2} ry={2} />
  }
}

function InlineDocComponent({ shape }: { shape: any }) {
  const { w, h, url, title } = shape.props
  const hasTitle = !!title
  const titleBarHeight = hasTitle ? 20 : 0
  const iframeH = h - titleBarHeight

  const srcUrl = url ? appendToken(url) : ''

  return (
    <HTMLContainer>
      <div
        style={{ width: w, height: h, position: 'relative', overflow: 'hidden' }}
        onPointerDown={stopEventPropagation}
        onPointerMove={stopEventPropagation}
        onPointerUp={stopEventPropagation}
      >
        {hasTitle && (
          <div style={{
            height: titleBarHeight,
            lineHeight: `${titleBarHeight}px`,
            background: 'rgba(0,0,0,0.06)',
            fontSize: 11,
            padding: '0 8px',
            overflow: 'hidden',
            whiteSpace: 'nowrap',
            textOverflow: 'ellipsis',
            userSelect: 'none',
          }}>
            {title}
          </div>
        )}
        {srcUrl ? (
          <iframe
            src={srcUrl}
            style={{
              width: '100%',
              height: iframeH,
              border: 'none',
              display: 'block',
              pointerEvents: 'all',
            }}
            sandbox="allow-scripts allow-same-origin allow-forms allow-pointer-lock"
          />
        ) : (
          <div style={{
            width: '100%',
            height: iframeH,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'rgba(0,0,0,0.2)',
            fontSize: 14,
          }} />
        )}
      </div>
    </HTMLContainer>
  )
}
