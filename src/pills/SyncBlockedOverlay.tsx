/**
 * SyncBlockedOverlay — what the reader sees when the live document never
 * arrives. Mounted while useSync is unresolved; renders nothing inside the
 * grace window (tldraw's loader owns the first seconds), reassurance past
 * it, and the blocked state with a reload past the blocked threshold. Unmounts
 * (via the parent's status gate) the moment sync lands.
 */
import { useState, useEffect } from 'react'
import { syncBlockView } from '../syncBlockState'
import './SyncBlockedOverlay.css'

export function SyncBlockedOverlay({ status }: { status: string }) {
  const [start] = useState(() => Date.now())
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])

  const view = syncBlockView(status, now - start)
  if (!view) return null

  return (
    <div className="sync-blocked-overlay" role="status" aria-live="polite">
      {view === 'waiting' ? (
        <span className="sync-blocked-line">Still connecting to the live document…</span>
      ) : (
        <>
          <span className="sync-blocked-head">Can’t reach the live document</span>
          <span className="sync-blocked-sub">
            Your connection may be down, or this copy may need access. Nothing here is lost — reloading is safe.
          </span>
          <button className="sync-blocked-reload" onClick={() => window.location.reload()}>
            Reload
          </button>
        </>
      )}
    </div>
  )
}
