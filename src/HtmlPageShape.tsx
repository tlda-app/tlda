import {
  BaseBoxShapeUtil,
  HTMLContainer,
  T,
  useEditor,
  useValue,
} from 'tldraw'

export class HtmlPageShapeUtil extends BaseBoxShapeUtil<any> {
  static override type = 'html-page' as const
  static override props = {
    w: T.number,
    h: T.number,
    url: T.string,
  }

  getDefaultProps() {
    return { w: 800, h: 1000, url: '' }
  }

  override canEdit = () => false
  override canResize = () => false
  override isAspectRatioLocked = () => true
  override hideRotateHandle = () => true
  override canBind = () => false

  component(shape: any) {
    return <HtmlPageComponent shape={shape} />
  }

  indicator(shape: any) {
    return <rect width={shape.props.w} height={shape.props.h} />
  }
}

function HtmlPageComponent({ shape }: { shape: any }) {
  const editor = useEditor()
  const isDark = useValue('isDarkMode', () => editor.user.getIsDarkMode(), [editor])

  return (
    <HTMLContainer>
      <div style={{
        width: shape.props.w,
        height: shape.props.h,
        background: isDark ? '#0f0f1a' : 'white',
        overflow: 'hidden',
      }}>
        <iframe
          src={shape.props.url}
          style={{
            width: '100%',
            height: '100%',
            border: 'none',
            pointerEvents: 'none',
            filter: isDark ? 'invert(0.88) hue-rotate(180deg)' : 'none',
            display: 'block',
          }}
          scrolling="no"
        />
      </div>
    </HTMLContainer>
  )
}
