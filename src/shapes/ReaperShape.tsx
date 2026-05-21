import {
  BaseBoxShapeUtil,
  HTMLContainer,
  T,
  stopEventPropagation,
} from 'tldraw'
import { useState, useCallback, useMemo } from 'react'
import { useReaperStatus } from '../fleet-data-adapter'

const DEFAULT_W = 480
const DEFAULT_H = 360

export class ReaperShapeUtil extends BaseBoxShapeUtil<any> {
  static override type = 'fleet-reaper' as const
  static override props = {
    w: T.number,
    h: T.number,
  }

  getDefaultProps() {
    return { w: DEFAULT_W, h: DEFAULT_H }
  }

  override canEdit = () => false
  override canResize = () => true
  override canBind = () => false
  override hideRotateHandle = () => true

  component(_shape: any) {
    return <ReaperComponent shape={_shape} />
  }

  indicator() {
    return null
  }
}

function pressureColor(p: number): string {
  if (p < 0.5) return 'var(--green, #7ab8a0)'
  if (p < 0.7) return 'var(--yellow, #c8b060)'
  if (p < 0.85) return 'var(--orange, #c8956a)'
  return '#e55'
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}K`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)}M`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}G`
}

function formatAge(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`
  if (ms < 3600_000) return `${Math.floor(ms / 60_000)}m`
  return `${Math.floor(ms / 3600_000)}h`
}

type SortKey = 'agent' | 'type' | 'status' | 'idle'

interface ProcessRow {
  pid: number
  agent: string
  type: 'vite' | 'playwright'
  detail: string
  status: string
  statusColor: string
  idleMs: number
  killable: boolean
}

function ReaperComponent({ shape }: { shape: any }) {
  const [killing, setKilling] = useState<Set<number>>(new Set())
  const [sortKey, setSortKey] = useState<SortKey>('agent')
  const [sortAsc, setSortAsc] = useState(true)
  const status = useReaperStatus()

  const handleKill = useCallback(async (pid: number) => {
    setKilling(prev => new Set(prev).add(pid))
    try {
      await fetch('/api/reaper/kill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pid }),
      })
    } catch {}
    setTimeout(() => setKilling(prev => {
      const next = new Set(prev)
      next.delete(pid)
      return next
    }), 3000)
  }, [])

  const handleReapNow = useCallback(async () => {
    try {
      await fetch('/api/reaper/sweep', { method: 'POST' })
    } catch {}
  }, [])

  const handleSort = useCallback((key: SortKey) => {
    setSortKey(prev => {
      if (prev === key) { setSortAsc(a => !a); return key }
      setSortAsc(true)
      return key
    })
  }, [])

  const rows: ProcessRow[] = useMemo(() => {
    if (!status) return []
    const r: ProcessRow[] = []
    for (const v of status.vites || []) {
      r.push({
        pid: v.pid,
        agent: v.agent || '—',
        type: 'vite',
        detail: v.ports?.map((p: number) => `:${p}`).join(',') || '',
        status: v.hasClient ? 'active' : 'idle',
        statusColor: v.hasClient ? 'var(--green)' : 'var(--yellow)',
        idleMs: v.idleMs || 0,
        killable: !v.hasClient,
      })
    }
    for (const b of status.browsers || []) {
      r.push({
        pid: b.pid,
        agent: b.agent || '—',
        type: 'playwright',
        detail: `ppid=${b.ppid}`,
        status: b.controllerAlive ? 'active' : 'orphan',
        statusColor: b.controllerAlive ? 'var(--green)' : 'var(--orange)',
        idleMs: b.idleMs || 0,
        killable: !b.controllerAlive,
      })
    }
    const dir = sortAsc ? 1 : -1
    r.sort((a, b) => {
      let cmp = 0
      if (sortKey === 'agent') cmp = a.agent.localeCompare(b.agent)
      else if (sortKey === 'type') cmp = a.type.localeCompare(b.type)
      else if (sortKey === 'status') cmp = a.status.localeCompare(b.status)
      else if (sortKey === 'idle') cmp = a.idleMs - b.idleMs
      return cmp * dir
    })
    return r
  }, [status, sortKey, sortAsc])

  const pressure = status?.pressure ?? 0
  const pctText = `${(pressure * 100).toFixed(0)}%`

  const thStyle: React.CSSProperties = {
    textAlign: 'left',
    padding: '3px 6px',
    fontSize: 10,
    fontWeight: 600,
    color: 'var(--text-dim)',
    cursor: 'pointer',
    userSelect: 'none',
    whiteSpace: 'nowrap',
    borderBottom: '1px solid var(--glass-3)',
  }

  const tdStyle: React.CSSProperties = {
    padding: '3px 6px',
    fontSize: 11,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  }

  const sortIndicator = (key: SortKey) =>
    sortKey === key ? (sortAsc ? ' ▲' : ' ▼') : ''

  return (
    <HTMLContainer>
      <div
        className="fleet-reaper-shape fleet-chat-shape"
        style={{
          width: shape.props.w,
          height: shape.props.h,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          fontSize: 12,
          fontFamily: 'var(--tl-font-sans, system-ui)',
          userSelect: 'none',
        }}
      >
        {/* Header */}
        <div style={{
          padding: '6px 10px',
          borderBottom: '1px solid var(--glass-3)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexShrink: 0,
        }}>
          <span style={{ fontWeight: 600, color: 'var(--text-bright)', fontSize: 13 }}>
            Reaper
          </span>
          {status && (
            <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>
              sweep #{status.sweepCount}
            </span>
          )}
          <div style={{ flex: 1 }} />
          <button
            onPointerDown={stopEventPropagation}
            onClick={handleReapNow}
            style={{
              background: 'var(--glass-4)',
              border: '1px solid var(--glass-5)',
              borderRadius: 4,
              color: 'var(--text)',
              fontSize: 11,
              padding: '2px 8px',
              cursor: 'pointer',
            }}
          >
            Sweep now
          </button>
        </div>

        {!status ? (
          <div style={{ padding: 12, color: 'var(--text-dim)', textAlign: 'center' }}>
            Waiting for daemon...
          </div>
        ) : (
          <div
            style={{ flex: 1, overflow: 'auto', padding: '6px 10px' }}
            onPointerDown={stopEventPropagation}
            onWheel={stopEventPropagation}
          >
            {/* Memory pressure bar */}
            <div style={{ marginBottom: 8 }}>
              <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                marginBottom: 3,
                fontSize: 11,
              }}>
                <span style={{ color: 'var(--text-dim)' }}>
                  Memory {formatBytes(status.totalMem - status.freeMem)}/{formatBytes(status.totalMem)}
                </span>
                <span style={{ color: pressureColor(pressure), fontWeight: 600 }}>
                  {pctText}
                </span>
              </div>
              <div style={{
                height: 5,
                borderRadius: 3,
                background: 'var(--glass-3)',
                overflow: 'hidden',
              }}>
                <div style={{
                  width: `${pressure * 100}%`,
                  height: '100%',
                  borderRadius: 3,
                  background: pressureColor(pressure),
                  transition: 'width 0.6s ease, background 0.6s ease',
                }} />
              </div>
              <div style={{
                fontSize: 10,
                color: 'var(--text-dim)',
                marginTop: 2,
                display: 'flex',
                gap: 12,
              }}>
                <span>Vite timeout: {formatAge(status.scaledThresholds?.viteMs || 0)}</span>
                <span>PW timeout: {formatAge(status.scaledThresholds?.pwMs || 0)}</span>
                <span style={{ marginLeft: 'auto' }}>
                  {rows.length} process{rows.length !== 1 ? 'es' : ''}
                </span>
              </div>
            </div>

            {/* Top memory consumers */}
            {status.topProcesses?.length > 0 && (
              <div style={{ marginBottom: 8 }}>
                <div style={{
                  fontSize: 10,
                  color: 'var(--text-dim)',
                  marginBottom: 3,
                  fontWeight: 600,
                }}>
                  Top memory
                </div>
                {status.topProcesses.map((p: any, i: number) => (
                  <div key={i} style={{
                    fontSize: 10,
                    color: 'var(--text-dim)',
                    padding: '1px 0',
                    display: 'flex',
                    gap: 6,
                    alignItems: 'baseline',
                  }}>
                    <span style={{
                      color: 'var(--text)',
                      fontWeight: 500,
                      minWidth: 36,
                      textAlign: 'right',
                    }}>
                      {formatBytes(p.rss)}
                    </span>
                    <span style={{
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}>
                      {p.name}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* Process table */}
            {rows.length > 0 ? (
              <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
                <thead>
                  <tr>
                    <th style={{ ...thStyle, width: '30%' }} onClick={() => handleSort('agent')}>
                      Agent{sortIndicator('agent')}
                    </th>
                    <th style={{ ...thStyle, width: '18%' }} onClick={() => handleSort('type')}>
                      Type{sortIndicator('type')}
                    </th>
                    <th style={{ ...thStyle, width: '17%' }} onClick={() => handleSort('status')}>
                      Status{sortIndicator('status')}
                    </th>
                    <th style={{ ...thStyle, width: '12%' }} onClick={() => handleSort('idle')}>
                      Idle{sortIndicator('idle')}
                    </th>
                    <th style={{ ...thStyle, width: '10%' }}></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.pid} style={{ borderBottom: '1px solid var(--glass-2)' }}>
                      <td style={{ ...tdStyle, color: r.agent === '—' ? 'var(--text-dim)' : 'var(--text)', maxWidth: 0 }}>
                        {r.agent}
                      </td>
                      <td style={{ ...tdStyle, color: 'var(--text-dim)' }}>
                        {r.type === 'vite' ? `vite ${r.detail}` : 'pw'}
                      </td>
                      <td style={{ ...tdStyle, color: r.statusColor, fontSize: 10 }}>
                        {r.status}
                      </td>
                      <td style={{ ...tdStyle, color: 'var(--text-dim)', fontSize: 10 }}>
                        {r.idleMs > 0 ? formatAge(r.idleMs) : '—'}
                      </td>
                      <td style={{ ...tdStyle, textAlign: 'right' }}>
                        {r.killable && (
                          <button
                            onPointerDown={stopEventPropagation}
                            onClick={() => handleKill(r.pid)}
                            disabled={killing.has(r.pid)}
                            style={{
                              background: killing.has(r.pid) ? 'var(--glass-3)' : 'rgba(238,85,85,0.15)',
                              border: '1px solid rgba(238,85,85,0.3)',
                              borderRadius: 3,
                              color: killing.has(r.pid) ? 'var(--text-dim)' : '#e55',
                              fontSize: 10,
                              padding: '1px 5px',
                              cursor: killing.has(r.pid) ? 'default' : 'pointer',
                            }}
                          >
                            {killing.has(r.pid) ? '...' : 'kill'}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div style={{ color: 'var(--text-dim)', fontSize: 11, textAlign: 'center', padding: 8 }}>
                No processes found
              </div>
            )}

            {/* Recent kills */}
            {status.lastKills?.length > 0 && (
              <div style={{ marginTop: 8 }}>
                <div style={{
                  fontSize: 10,
                  color: 'var(--text-dim)',
                  marginBottom: 3,
                  fontWeight: 600,
                }}>
                  Recent kills
                </div>
                {status.lastKills.slice(0, 5).map((k: any, i: number) => (
                  <div key={i} style={{
                    fontSize: 10,
                    color: 'var(--text-dim)',
                    padding: '1px 0',
                    display: 'flex',
                    gap: 6,
                  }}>
                    <span style={{ color: '#e55' }}>
                      {k.agent || k.kind}
                    </span>
                    <span>{k.kind === 'manual' ? 'manual kill' : k.reason}</span>
                    <span style={{ marginLeft: 'auto' }}>{formatAge(Date.now() - k.ts)} ago</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </HTMLContainer>
  )
}
