import {
  BaseBoxShapeUtil,
  HTMLContainer,
  stopEventPropagation,
  useEditor,
  useValue,
} from 'tldraw'
import { fleetReaperProps } from '../../shared/shapes/fleet-panel-schema.mjs'
import { useState, useCallback, useMemo, useRef, useEffect } from 'react'
import { useReaperStatus } from '../fleet-data-adapter'
import { beginNativeSnapDrag, endNativeSnapDrag } from './fleet-utils'
import { FleetPanelButtonGroup } from './FleetPanelChrome'

const DEFAULT_W = 480
const DEFAULT_H = 400

export class ReaperShapeUtil extends BaseBoxShapeUtil<any> {
  static override type = 'fleet-reaper' as const
  static override props = fleetReaperProps

  getDefaultProps() {
    return { w: DEFAULT_W, h: DEFAULT_H, userId: '', deviceId: '' }
  }

  override canEdit = () => false
  override canResize = () => true
  override canSnap = () => true
  override canBind = () => false
  override hideRotateHandle = () => true
  override onTranslateStart = () => beginNativeSnapDrag(this.editor)
  override onTranslateEnd = () => endNativeSnapDrag(this.editor)
  override onTranslateCancel = () => endNativeSnapDrag(this.editor)

  component(_shape: any) {
    return <ReaperComponent shape={_shape} />
  }

  getIndicatorPath() {
    return undefined
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

type SortKey = 'agent' | 'memory' | 'type'

interface ProcessRow {
  key: string
  agent: string
  type: string
  name: string
  rss: number
  pid?: number
  killable: boolean
}

const PROCESS_TYPES: Record<string, string> = {
  'claude': 'claude',
  'node': 'node',
  'vite': 'vite',
  'R': 'R',
  'Rscript': 'R',
  'rsession': 'R',
  'chromium': 'playwright',
  'chrome': 'playwright',
  'Chromium': 'playwright',
  'playwright': 'playwright',
}

function classifyProcess(name: string): string {
  if (PROCESS_TYPES[name]) return PROCESS_TYPES[name]
  if (/chrom/i.test(name)) return 'playwright'
  if (/^[Rr]$/i.test(name) || /rsession/i.test(name)) return 'R'
  return name
}

function ReaperComponent({ shape }: { shape: any }) {
  const editor = useEditor()
  const [killing, setKilling] = useState<Set<number>>(new Set())
  const [sortKey, setSortKey] = useState<SortKey>('memory')
  const [sortAsc, setSortAsc] = useState(false)
  const status = useReaperStatus()

  // Capture-phase pointerdown so clicks inside the panel (the ×/⊞ buttons, sort
  // headers, kill buttons) aren't hijacked by tldraw's setPointerCapture before
  // they reach the controls. Mirrors FleetInboxShape / FleetSearchShape — bare
  // e.stopPropagation() in React can't cancel tldraw's native capture listener.
  const containerRef = useRef<HTMLDivElement>(null)
  const isSelectedRef = useRef(false)
  isSelectedRef.current = useValue('isSelected', () => editor.getSelectedShapeIds().includes(shape.id), [editor, shape.id])
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    function onPointerDown(e: PointerEvent) {
      const target = e.target as HTMLElement
      if (!el!.contains(target)) return
      if (isSelectedRef.current) return
      editor.markEventAsHandled(e)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [editor])

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
      setSortAsc(key === 'agent' || key === 'type')
      return key
    })
  }, [])

  const rows: ProcessRow[] = useMemo(() => {
    if (!status) return []

    const result: ProcessRow[] = []
    const seen = new Set<string>()

    // Build sets of vite/browser PIDs so we can tag them
    const vitePids = new Map<number, any>()
    for (const v of status.vites || []) vitePids.set(v.pid, v)
    const browserPids = new Map<number, any>()
    for (const b of status.browsers || []) browserPids.set(b.pid, b)

    // Flatten memoryByAgent into process rows
    if (status.memoryByAgent) {
      for (const group of status.memoryByAgent) {
        const agent = group.agent === 'system' ? 'skip' : group.agent
        for (const proc of group.processes || []) {
          const type = classifyProcess(proc.name)
          const key = `${agent}-${proc.name}-${proc.rss}`
          if (seen.has(key)) continue
          seen.add(key)
          result.push({
            key,
            agent,
            type,
            name: proc.name,
            rss: proc.rss,
            killable: false,
          })
        }
      }
    }

    // Add vite processes (may already be in memoryByAgent, but with killable info)
    for (const v of status.vites || []) {
      const agent = v.agent || 'skip'
      const label = `vite${v.ports?.length ? ' :' + v.ports[0] : ''}`
      const key = `vite-${v.pid}`
      if (seen.has(key)) continue
      seen.add(key)
      result.push({
        key,
        agent,
        type: 'vite',
        name: label,
        rss: 0,
        pid: v.pid,
        killable: !v.hasClient,
      })
    }

    // Add playwright browser processes
    for (const b of status.browsers || []) {
      const agent = b.agent || 'skip'
      const key = `pw-${b.pid}`
      if (seen.has(key)) continue
      seen.add(key)
      result.push({
        key,
        agent,
        type: 'playwright',
        name: 'playwright',
        rss: 0,
        pid: b.pid,
        killable: !b.controllerAlive,
      })
    }

    const dir = sortAsc ? 1 : -1
    result.sort((a, b) => {
      if (sortKey === 'agent') return a.agent.localeCompare(b.agent) * dir
      if (sortKey === 'type') return a.type.localeCompare(b.type) * dir
      return (a.rss - b.rss) * dir
    })
    return result
  }, [status, sortKey, sortAsc])

  const pressure = status?.pressure ?? 0
  const pctText = `${(pressure * 100).toFixed(0)}%`
  const trackedMem = rows.reduce((s, r) => s + r.rss, 0)

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
    <HTMLContainer
      style={{
        width: shape.props.w,
        height: shape.props.h,
        pointerEvents: 'all',
        overflow: 'visible',
      }}
    >
      <div
        ref={containerRef}
        className="fleet-shape fleet-reaper-shape fleet-chat-shape"
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'visible',
          fontSize: 12,
          fontFamily: 'var(--tl-font-sans, system-ui)',
          userSelect: 'none',
          position: 'relative',
        }}
      >
        <FleetPanelButtonGroup editor={editor} shape={shape} />

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
            className="fleet-reaper-body"
            style={{ flex: 1, overflow: 'auto', padding: '6px 10px', minHeight: 0 }}
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
                <span>Tracked: {formatBytes(trackedMem)}</span>
                <span>Vite timeout: {formatAge(status.scaledThresholds?.viteMs || 0)}</span>
                <span>PW timeout: {formatAge(status.scaledThresholds?.pwMs || 0)}</span>
              </div>
            </div>

            {/* Process table */}
            {rows.length > 0 ? (
              <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
                <thead>
                  <tr>
                    <th style={{ ...thStyle, width: '30%' }} onClick={() => handleSort('type')}>
                      Process{sortIndicator('type')}
                    </th>
                    <th style={{ ...thStyle, width: '25%' }} onClick={() => handleSort('agent')}>
                      Agent{sortIndicator('agent')}
                    </th>
                    <th style={{ ...thStyle, width: '18%' }} onClick={() => handleSort('memory')}>
                      RSS{sortIndicator('memory')}
                    </th>
                    <th style={{ ...thStyle, width: '12%' }}></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.key} style={{ borderBottom: '1px solid var(--glass-2)' }}>
                      <td style={{ ...tdStyle, maxWidth: 0 }}>
                        <span style={{ color: 'var(--text)', fontWeight: 500 }}>{r.type}</span>
                        {r.name !== r.type && (
                          <span style={{ color: 'var(--text-dim)', fontSize: 10, marginLeft: 4 }}>
                            {r.name}
                          </span>
                        )}
                      </td>
                      <td style={{
                        ...tdStyle,
                        color: r.agent === 'skip' ? 'var(--text-dim)' : 'var(--text)',
                        fontWeight: r.agent === 'skip' ? 400 : 500,
                        maxWidth: 0,
                      }}>
                        {r.agent}
                      </td>
                      <td style={{ ...tdStyle, fontFamily: 'monospace', fontSize: 10 }}>
                        {r.rss > 0 ? formatBytes(r.rss) : '—'}
                      </td>
                      <td style={{ ...tdStyle, textAlign: 'right' }}>
                        {r.killable && r.pid && (
                          <button
                            onPointerDown={stopEventPropagation}
                            onClick={() => handleKill(r.pid!)}
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
