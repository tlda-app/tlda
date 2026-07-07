import type { ReactNode } from 'react'
import type { Editor, TLShape } from 'tldraw'
import { selectFleetShapeForLayout } from './fleet-utils'

type FleetPanelButtonGroupProps = {
  editor: Editor
  shape: TLShape
  children?: ReactNode
  className?: string
  basePosition?: 'first' | 'last'
}

function stopPanelEvent(e: { stopPropagation: () => void }) {
  e.stopPropagation()
}

function FleetPanelBaseButtons({ editor, shape }: { editor: Editor; shape: TLShape }) {
  return (
    <>
      <button
        className="fleet-close-btn"
        onPointerUp={(e) => {
          stopPanelEvent(e)
          editor.deleteShapes([shape.id])
        }}
        title="Close"
      >
        ×
      </button>
      <button
        className="fleet-layout-btn"
        onPointerUp={(e) => {
          stopPanelEvent(e)
          selectFleetShapeForLayout(editor, shape)
        }}
        title="Resize / move"
      >
        ⊞
      </button>
    </>
  )
}

export function FleetPanelButtonGroup({
  editor,
  shape,
  children,
  className = '',
  basePosition = 'first',
}: FleetPanelButtonGroupProps) {
  const base = <FleetPanelBaseButtons editor={editor} shape={shape} />
  return (
    <div
      className={`fleet-btn-group${className ? ` ${className}` : ''}`}
      onPointerDown={stopPanelEvent}
    >
      {basePosition === 'first' && base}
      {children}
      {basePosition === 'last' && base}
    </div>
  )
}
