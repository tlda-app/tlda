import { useMemo } from 'react'
import { Tldraw } from 'tldraw'
import type { TLComponents } from 'tldraw'
import 'tldraw/tldraw.css'

const LICENSE_KEY = 'tldraw-2027-01-19/WyJhUGMwcWRBayIsWyIqLnF0bTI4NS5naXRodWIuaW8iXSw5LCIyMDI3LTAxLTE5Il0.Hq9z1V8oTLsZKgpB0pI3o/RXCoLOsh5Go7Co53YGqHNmtEO9Lv/iuyBPzwQwlxQoREjwkkFbpflOOPmQMwvQSQ'

interface CanvasProps {
  roomId: string
  onLoadPdf: () => void
}

export function Canvas({ roomId, onLoadPdf }: CanvasProps) {
  const components = useMemo<TLComponents>(
    () => ({
      SharePanel: () => (
        <div className="CanvasControls">
          <button onClick={onLoadPdf} className="load-pdf-btn">
            Load PDF
          </button>
          <span className="room-id">Room: {roomId}</span>
        </div>
      ),
    }),
    [roomId, onLoadPdf]
  )

  return <Tldraw licenseKey={LICENSE_KEY} components={components} />
}
