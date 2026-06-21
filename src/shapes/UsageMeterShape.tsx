/**
 * UsageMeterShape — a glanceable canvas card showing provider/account usage
 * (phi-hour window, weekly window, spend) so the user can read remaining
 * capacity at a glance without opening claude.ai / chatgpt.com.
 *
 * Data source: GET /api/usage-status, which returns the sanitized
 * normalizeUsageStatus(loadConfig()) — manual/static or explicit API-fed
 * status only. No provider scraping; no tokens. Mirrors the `usage_status`
 * MCP tool's data exactly (shared/usage-status.mjs).
 *
 * Standalone custom box shape (not fleet-scoped) — created via UsageMeterTool,
 * placed once and persisted in the room via Yjs. The volatile usage numbers are
 * fetched client-side (polled), not synced through shape props.
 */
import { BaseBoxShapeUtil, HTMLContainer, T, useEditor, useValue } from 'tldraw'
import { useEffect, useRef, useState } from 'react'

const DEFAULT_W = 280
const DEFAULT_H = 200
const POLL_MS = 60_000

interface UsageWindow {
  label: string
  resetsAt: string | null
  used: number | null
  limit: number | null
  remaining: number | null
  remainingPct: number | null
}
interface UsageSpend {
  currency: string
  used: number | null
  limit: number | null
  remaining: number | null
}
interface UsageAccount {
  id: string
  provider: string
  label: string
  source: string
  asOf: string | null
  confidence: string
  windows: UsageWindow[]
  spend: UsageSpend | null
  notes: string | null
}
interface UsageStatus {
  asOf: string | null
  accounts: UsageAccount[]
}

export class UsageMeterShapeUtil extends BaseBoxShapeUtil<any> {
  static override type = 'usage-meter' as const
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

  component(shape: any) {
    return <UsageMeterComponent shape={shape} />
  }

  getIndicatorPath() {
    return undefined
  }

  indicator() {
    return null
  }
}

// Color a remaining-% bar: plenty left = green, depleting = warmer, near-empty = red.
function remainingColor(pct: number): string {
  if (pct >= 50) return 'var(--green, #7ab8a0)'
  if (pct >= 25) return 'var(--yellow, #c8b060)'
  if (pct >= 10) return 'var(--orange, #c8956a)'
  return '#e55'
}

function UsageMeterComponent({ shape }: { shape: any }) {
  const editor = useEditor()
  const [status, setStatus] = useState<UsageStatus | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const res = await fetch('/api/usage-status')
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()
        if (!cancelled) { setStatus(data); setError(null) }
      } catch (e: any) {
        if (!cancelled) setError(e?.message || 'fetch failed')
      }
    }
    load()
    const t = setInterval(load, POLL_MS)
    return () => { cancelled = true; clearInterval(t) }
  }, [])

  // Capture-phase pointerdown so the × button and scroll work without tldraw
  // hijacking the pointer (mirrors ReaperShape / FleetSearchShape).
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

  const accounts = status?.accounts ?? []

  return (
    <HTMLContainer style={{ width: shape.props.w, height: shape.props.h, pointerEvents: 'all', overflow: 'visible' }}>
      <div
        ref={containerRef}
        className="fleet-shape fleet-chat-shape"
        data-shape-type="usage-meter"
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          fontFamily: 'var(--tl-font-sans, system-ui)',
          userSelect: 'none',
          position: 'relative',
        }}
      >
        {/* Close button — matches other fleet shapes */}
        <div className="fleet-btn-group" onPointerDown={(e) => e.stopPropagation()}>
          <button
            className="fleet-close-btn"
            onPointerUp={(e) => { e.stopPropagation(); editor.deleteShapes([shape.id]) }}
          >
            ×
          </button>
        </div>

        {/* Header */}
        <div style={{
          padding: '6px 10px',
          borderBottom: '1px solid var(--glass-3)',
          display: 'flex',
          alignItems: 'baseline',
          gap: 8,
          flexShrink: 0,
        }}>
          <span style={{ fontWeight: 600, color: 'var(--text-bright)', fontSize: 13 }}>Usage</span>
          {status?.asOf && (
            <span style={{ color: 'var(--text-dim)', fontSize: 10 }}>as of {status.asOf}</span>
          )}
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '6px 10px 8px' }}>
          {error && (
            <div style={{ color: '#e55', fontSize: 11 }}>usage unavailable: {error}</div>
          )}
          {!error && accounts.length === 0 && (
            <div style={{ color: 'var(--text-dim)', fontSize: 11, lineHeight: 1.4 }}>
              No accounts configured. Add <code>usageStatus.accounts</code> to the tlda config.
            </div>
          )}
          {accounts.map((acct) => (
            <div key={acct.id} style={{ marginBottom: 10 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 3 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-bright)' }}>{acct.label}</span>
                <span style={{ fontSize: 10, color: 'var(--text-dim)' }}>{acct.provider}</span>
              </div>
              {acct.windows.length === 0 && (
                <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>no windows</div>
              )}
              {acct.windows.map((w, i) => (
                <UsageBar key={i} window={w} />
              ))}
              {acct.spend && (acct.spend.used !== null || acct.spend.remaining !== null) && (
                <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 2 }}>
                  spend{' '}
                  {acct.spend.used !== null && acct.spend.limit !== null
                    ? `${acct.spend.used}/${acct.spend.limit} ${acct.spend.currency}`
                    : `${acct.spend.remaining} ${acct.spend.currency} left`}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </HTMLContainer>
  )
}

function UsageBar({ window: w }: { window: UsageWindow }) {
  const pct = w.remainingPct
  const hasPct = pct !== null
  const fill = hasPct ? Math.max(0, Math.min(100, pct)) : 0
  const color = hasPct ? remainingColor(pct) : 'var(--glass-3)'
  // Right-aligned readout: prefer "% remaining", else used/limit.
  const readout = hasPct
    ? `${pct.toFixed(0)}%`
    : (w.used !== null && w.limit !== null ? `${w.used}/${w.limit}` : '—')
  return (
    <div style={{ marginBottom: 4 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: 10, color: 'var(--text-dim)' }}>
        <span>{w.label}</span>
        <span>{readout}{w.resetsAt ? ` · ${w.resetsAt}` : ''}</span>
      </div>
      <div style={{
        height: 5,
        borderRadius: 3,
        background: 'var(--glass-3)',
        overflow: 'hidden',
        marginTop: 2,
      }}>
        <div style={{ width: `${fill}%`, height: '100%', background: color, borderRadius: 3 }} />
      </div>
    </div>
  )
}
