import { useSyncExternalStore } from 'react'
import {
  BaseBoxShapeUtil,
  HTMLContainer,
  T,
  useEditor,
  type TLPropsMigrations,
} from 'tldraw'
import { getLiveVideoTiles, subscribeLiveVideoTiles, type LiveVideoTile } from '../livekit/liveVideoRegistry'
import { isMyFleetShape } from './fleet-utils'
import { FleetPanelButtonGroup } from './FleetPanelChrome'
import './fleet-video.css'

export class FleetVideoShapeUtil extends BaseBoxShapeUtil<any> {
  static override type = 'fleet-video' as const
  static override props = {
    w: T.number,
    h: T.number,
    tileKeys: T.string,
    userId: T.optional(T.string),
    deviceId: T.optional(T.string),
  }
  static override migrations: TLPropsMigrations = {
    sequence: [
      {
        id: 'com.tldraw.shape.fleet-video/1',
        up: (props: any) => {
          const { title: _title, ...rest } = props
          return rest
        },
        down: 'none' as const,
      },
    ],
  }

  getDefaultProps() {
    return { w: 260, h: 172, tileKeys: '[]', userId: undefined, deviceId: undefined }
  }

  override canEdit = () => false
  override canBind = () => false
  override hideRotateHandle = () => true

  component(shape: any) {
    return (
      <HTMLContainer style={{ pointerEvents: 'all' }}>
        <FleetVideoComponent shape={shape} />
      </HTMLContainer>
    )
  }

  getIndicatorPath(shape: any) {
    const path = new Path2D()
    path.rect(0, 0, shape.props.w, shape.props.h)
    return path
  }

  indicator(shape: any) {
    return <rect width={shape.props.w} height={shape.props.h} />
  }
}

function parseTileKeys(value: string): string[] {
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

function FleetVideoComponent({ shape }: { shape: any }) {
  const editor = useEditor()
  const allTiles = useSyncExternalStore(subscribeLiveVideoTiles, getLiveVideoTiles, getLiveVideoTiles)
  const isOwnPanel = isMyFleetShape(shape)

  const keys = parseTileKeys(shape.props.tileKeys)
  const keySet = new Set(keys)
  const tiles = isOwnPanel ? allTiles : allTiles.filter((tile): tile is LiveVideoTile => {
    if (!keySet.has(tile.key)) return false
    return !tile.local
  })
  if (!isOwnPanel && tiles.length === 0) return null

  const { w, h } = shape.props

  return (
    <div
      className="fleet-shape fleet-video-shape"
      style={{ width: w, height: h }}
    >
      <FleetPanelButtonGroup editor={editor} shape={shape} />
      <div className="fleet-video-shape__grid">
        {tiles.length === 0 ? (
          <div className="fleet-video-shape__empty">waiting for video</div>
        ) : tiles.slice(0, 4).map(tile => (
          <div key={tile.key} className="fleet-video-shape__tile">
            <LiveVideoElement tile={tile} />
            <div className="fleet-video-shape__label">{tile.name || tile.identity}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

function LiveVideoElement({ tile }: { tile: { stream: MediaStream } }) {
  return (
    <video
      className="fleet-video-shape__media"
      autoPlay
      muted
      playsInline
      ref={(el) => {
        if (!el) return
        if (el.srcObject !== tile.stream) el.srcObject = tile.stream
        void el.play().catch(() => {})
      }}
    />
  )
}
