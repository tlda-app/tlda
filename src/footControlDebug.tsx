/**
 * footControlDebug.tsx — Foot control panel.
 *
 * Collapsible control surface: mic start/stop, sensitivity, response curve.
 * Also shows gamepad/mic status and heading compass.
 * Collapses to a small pill when minimized.
 */

import { useState, useEffect, useRef, useCallback, useSyncExternalStore } from 'react'
import type { FootController, FootControlState } from './footControl'
import type { ClickDetector } from './clickDetect'
import { subscribeInputModes, getInputMode, toggleInputMode, type InputMode } from './inputModes'

interface Props {
  footController: FootController | null
  clickDetector: ClickDetector | null
  visible?: boolean
}

const INPUT_MODES: { id: InputMode; label: string; color: string }[] = [
  { id: 'foot', label: 'pedals', color: '#a78bfa' },
  { id: 'clicks', label: 'clicks', color: '#60a5fa' },
  { id: 'whistle', label: 'whistle', color: '#34d399' },
  { id: 'hiss', label: 'hiss', color: '#fbbf24' },
  { id: 'voice', label: 'voice', color: '#f472b6' },
]

let _cachedSnapshot: boolean[] = INPUT_MODES.map(m => getInputMode(m.id))
const getModeSnapshot = () => {
  const next = INPUT_MODES.map(m => getInputMode(m.id))
  if (next.every((v, i) => v === _cachedSnapshot[i])) return _cachedSnapshot
  _cachedSnapshot = next
  return next
}

export function FootControlDebug({ footController, clickDetector, visible = true }: Props) {
  const modeStates = useSyncExternalStore(subscribeInputModes, getModeSnapshot)
  const anyActive = modeStates.some(Boolean)

  const [state, setState] = useState<FootControlState | null>(null)
  const [sensitivity, setSensitivity] = useState(3.0)
  const [micActive, setMicActive] = useState(false)
  const [micError, setMicError] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(true)
  const [debugOpen, setDebugOpen] = useState(false)
  const [events, setEvents] = useState<string[]>([])
  const [simRudder, setSimRudder] = useState(0)
  const [simCursor, setSimCursor] = useState(0)
  const [simPan, setSimPan] = useState(0)

  useEffect(() => {
    if (!footController) return
    return footController.onStateChange(s => setState(s))
  }, [footController])

  useEffect(() => {
    if (!clickDetector) return
    setSensitivity(clickDetector.getTriggerRatio())
    const addEvent = (label: string) => () => {
      setEvents(prev => [`${new Date().toLocaleTimeString()}: ${label}`, ...prev.slice(0, 19)])
    }
    const off1 = clickDetector.on('click', addEvent('click'))
    const off2 = clickDetector.on('dblclick', addEvent('dblclick'))
    return () => { off1(); off2() }
  }, [clickDetector])

  const startMic = useCallback(async () => {
    if (!clickDetector) return
    setMicError(null)
    try {
      await clickDetector.start()
      setMicActive(true)
    } catch (e) {
      setMicError(e instanceof Error ? e.message : String(e))
    }
  }, [clickDetector])

  const stopMic = useCallback(() => {
    clickDetector?.stop()
    setMicActive(false)
  }, [clickDetector])

  if (!visible) return null

  const heading = state?.heading ?? -Math.PI / 2
  const gamepadOk = !!state?.gamepadConnected

  const activeCount = modeStates.filter(Boolean).length

  // ── Collapsed pill ────────────────────────────────────────────────────────
  if (collapsed) {
    return (
      <div style={{
        position: 'fixed', top: 16, left: 16, zIndex: 9999,
        background: 'rgba(0,0,0,0.82)', color: '#e5e7eb',
        padding: '6px 12px', borderRadius: 20, fontSize: 12,
        fontFamily: 'monospace', display: 'flex', alignItems: 'center', gap: 8,
        boxShadow: '0 2px 12px rgba(0,0,0,0.4)', cursor: 'pointer', userSelect: 'none',
        border: '1px solid #1f2937',
        opacity: anyActive ? 0.85 : 0.1,
        transition: 'opacity 0.3s ease',
      }} onClick={() => setCollapsed(false)}
         onMouseEnter={e => (e.currentTarget.style.opacity = '0.85')}
         onMouseLeave={e => (e.currentTarget.style.opacity = anyActive ? '0.85' : '0.1')}>
        <span style={{ color: anyActive ? '#a78bfa' : '#6b7280' }}>⬡</span>
        <span style={{ color: '#6b7280', fontSize: 10 }}>
          {activeCount > 0 ? `${activeCount} on` : 'input'}
        </span>
      </div>
    )
  }

  // ── Expanded panel ────────────────────────────────────────────────────────
  return (
    <div style={{
      position: 'fixed', top: 16, left: 16, zIndex: 9999,
      background: 'rgba(0,0,0,0.88)', color: '#e5e7eb',
      padding: '10px 14px', borderRadius: 10, fontSize: 12,
      fontFamily: 'monospace', width: 272,
      boxShadow: '0 4px 24px rgba(0,0,0,0.5)',
    }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <span style={{ fontWeight: 700, color: '#a78bfa', letterSpacing: '0.05em' }}>input modes</span>
        <button onClick={() => setCollapsed(true)} style={{
          background: 'none', border: 'none', color: '#6b7280', cursor: 'pointer',
          fontSize: 14, lineHeight: 1, padding: '0 2px',
        }}>−</button>
      </div>

      {/* Input mode toggles */}
      <div style={{ marginBottom: 10 }}>
        {INPUT_MODES.map((mode, i) => (
          <div key={mode.id} style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '3px 0',
          }}>
            <span style={{ color: modeStates[i] ? mode.color : '#4b5563', fontSize: 11 }}>
              {mode.label}
            </span>
            <button onClick={() => toggleInputMode(mode.id)} style={{
              width: 32, height: 16, borderRadius: 8, border: 'none', cursor: 'pointer',
              background: modeStates[i] ? mode.color : '#374151',
              position: 'relative', transition: 'background 0.2s',
            }}>
              <span style={{
                position: 'absolute', top: 2, width: 12, height: 12, borderRadius: 6,
                background: '#fff', transition: 'left 0.2s',
                left: modeStates[i] ? 18 : 2,
              }} />
            </button>
          </div>
        ))}
      </div>

      {/* Status row (only when foot/clicks active) */}
      {anyActive && <div style={{ display: 'flex', gap: 12, marginBottom: 10, alignItems: 'center' }}>
        <span style={{ color: gamepadOk ? '#4ade80' : '#6b7280', fontSize: 11 }}>
          {gamepadOk ? '⬡ pedals' : '○ no pedals'}
        </span>
        <span style={{ color: micActive ? '#4ade80' : '#6b7280', fontSize: 11 }}>
          {micActive ? '◎ mic on' : '◎ mic off'}
        </span>
      </div>}

      {/* Mic control (shown when any mic-based mode is on) */}
      {clickDetector && anyActive && (
        <div style={{ marginBottom: 10 }}>
          {!micActive ? (
            <button onClick={startMic} style={{
              width: '100%', padding: '6px', borderRadius: 6, border: 'none',
              background: '#1d4ed8', color: '#fff', cursor: 'pointer', fontSize: 12,
              fontFamily: 'monospace',
            }}>start mic</button>
          ) : (
            <button onClick={stopMic} style={{
              width: '100%', padding: '6px', borderRadius: 6, border: 'none',
              background: '#374151', color: '#9ca3af', cursor: 'pointer', fontSize: 12,
              fontFamily: 'monospace',
            }}>stop mic</button>
          )}
          {micError && <div style={{ color: '#f87171', fontSize: 10, marginTop: 4 }}>{micError}</div>}
        </div>
      )}

      {/* Sensitivity */}
      {clickDetector && anyActive && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ color: '#9ca3af', marginBottom: 3, fontSize: 11 }}>
            click sensitivity — {sensitivity.toFixed(1)}×
            {sensitivity > 20 && <span style={{ color: '#6b7280', marginLeft: 6 }}>off</span>}
          </div>
          <input type="range" min={1.5} max={50} step={0.5} value={sensitivity}
            style={{ width: '100%' }}
            onChange={e => {
              const v = parseFloat(e.target.value)
              setSensitivity(v)
              clickDetector.setTriggerRatio(v)
            }} />
        </div>
      )}

      {/* Response curve (foot mode only) */}
      {footController && modeStates[0] && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ color: '#9ca3af', marginBottom: 3, fontSize: 11 }}>response curve</div>
          <CurveEditor footController={footController} />
        </div>
      )}

      {/* Compass (foot mode only) */}
      {modeStates[0] && <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: '#6b7280', fontSize: 11 }}>
        <svg width={36} height={36} style={{ flexShrink: 0 }}>
          <circle cx={18} cy={18} r={14} fill="none" stroke="#1f2937" strokeWidth={1.5} />
          <line x1={18} y1={18} x2={18 + Math.cos(heading)*12} y2={18 + Math.sin(heading)*12}
            stroke="#a78bfa" strokeWidth={1.5} strokeLinecap="round" />
          <circle cx={18} cy={18} r={1.5} fill="#4b5563" />
        </svg>
        <div>
          <div>{((heading * 180 / Math.PI + 360) % 360).toFixed(0)}°</div>
          <div style={{ color: '#4b5563' }}>
            {state?.cursorX.toFixed(0)}, {state?.cursorY.toFixed(0)}
          </div>
        </div>
      </div>}

      {/* Debug section (collapsed by default, foot mode only) */}
      {modeStates[0] && <div style={{ marginTop: 8, borderTop: '1px solid #1f2937', paddingTop: 6 }}>
        <button onClick={() => setDebugOpen(o => !o)} style={{
          background: 'none', border: 'none', color: '#4b5563', cursor: 'pointer',
          fontSize: 11, fontFamily: 'monospace', padding: 0,
        }}>
          {debugOpen ? '▾ debug' : '▸ debug'}
        </button>
        {debugOpen && (
          <div style={{ marginTop: 8 }}>
            {/* Axis sliders */}
            <div style={{ marginBottom: 8 }}>
              <div style={{ color: '#4b5563', marginBottom: 3, fontSize: 11 }}>simulate axes:</div>
              <SliderRow label="rudder" value={simRudder} min={-1} max={1}
                onChange={v => { setSimRudder(v); footController?.setHeading(footController.state.heading) }} />
              <SliderRow label="cursor" value={simCursor} min={0} max={1} onChange={setSimCursor} />
              <SliderRow label="pan" value={simPan} min={0} max={1} onChange={setSimPan} />
            </div>
            {/* Event log */}
            <div style={{ color: '#4b5563', marginBottom: 3, fontSize: 11 }}>click log:</div>
            <div style={{ maxHeight: 80, overflowY: 'auto', color: '#4ade80', fontSize: 11 }}>
              {events.length === 0
                ? <span style={{ color: '#374151' }}>none</span>
                : events.map((e, i) => <div key={i}>{e}</div>)}
            </div>
          </div>
        )}
      </div>}
    </div>
  )
}

// ── Curve editor ─────────────────────────────────────────────────────────────

const CW = 244, CH = 90
const YMIN = -0.45, YMAX = 1.1
const YRANGE = YMAX - YMIN
const PAD = 6

function toCanvas(ax: number, ay: number): [number, number] {
  return [
    PAD + ax * (CW - PAD * 2),
    CH - PAD - ((ay - YMIN) / YRANGE) * (CH - PAD * 2),
  ]
}
function fromCanvas(cx: number, cy: number): [number, number] {
  return [
    Math.max(0.05, Math.min(0.95, (cx - PAD) / (CW - PAD * 2))),
    Math.max(YMIN, Math.min(YMAX, YMIN + (1 - (cy - PAD) / (CH - PAD * 2)) * YRANGE)),
  ]
}

function catmullRom(t: number, p0: number, p1: number, p2: number, p3: number): number {
  return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2*p0 - 5*p1 + 4*p2 - p3) * t*t + (-p0 + 3*p1 - 3*p2 + p3) * t*t*t)
}

function buildLookup(h1: {x:number,y:number}, h2: {x:number,y:number}): (x: number) => number {
  const pts = [{x:0,y:0}, h1, h2, {x:1,y:1}]
  const N = 200
  const samples: [number,number][] = []
  for (let i = 0; i <= N/2; i++) {
    const t = i / (N/2)
    samples.push([
      Math.max(0, Math.min(1, catmullRom(t, pts[0].x, pts[0].x, pts[1].x, pts[2].x))),
      catmullRom(t, pts[0].y, pts[0].y, pts[1].y, pts[2].y),
    ])
  }
  for (let i = 0; i <= N/2; i++) {
    const t = i / (N/2)
    samples.push([
      Math.max(0, Math.min(1, catmullRom(t, pts[0].x, pts[1].x, pts[2].x, pts[3].x))),
      catmullRom(t, pts[0].y, pts[1].y, pts[2].y, pts[3].y),
    ])
  }
  for (let i = 0; i <= N/2; i++) {
    const t = i / (N/2)
    samples.push([
      Math.max(0, Math.min(1, catmullRom(t, pts[1].x, pts[2].x, pts[3].x, pts[3].x))),
      catmullRom(t, pts[1].y, pts[2].y, pts[3].y, pts[3].y),
    ])
  }
  samples.sort((a, b) => a[0] - b[0])
  return (x: number) => {
    if (x <= 0) return samples[0]?.[1] ?? 0
    if (x >= 1) return samples[samples.length-1]?.[1] ?? 1
    let lo = 0, hi = samples.length - 1
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (samples[mid][0] < x) lo = mid; else hi = mid }
    const [x0, y0] = samples[lo], [x1, y1] = samples[hi]
    return y0 + (x1 > x0 ? (x - x0) / (x1 - x0) : 0) * (y1 - y0)
  }
}

function drawCurve(ctx: CanvasRenderingContext2D, h1: {x:number,y:number}, h2: {x:number,y:number}) {
  ctx.clearRect(0, 0, CW, CH)
  ctx.fillStyle = 'rgba(0,0,0,0.5)'
  ctx.fillRect(0, 0, CW, CH)

  const [, zy] = toCanvas(0, 0)
  ctx.strokeStyle = '#1f2937'
  ctx.lineWidth = 1
  ctx.setLineDash([3, 3])
  ctx.beginPath(); ctx.moveTo(PAD, zy); ctx.lineTo(CW - PAD, zy); ctx.stroke()
  ctx.setLineDash([])

  const fn = buildLookup(h1, h2)
  ctx.strokeStyle = '#a78bfa'
  ctx.lineWidth = 1.5
  ctx.beginPath()
  for (let i = 0; i <= CW - PAD*2; i++) {
    const ax = i / (CW - PAD*2)
    const [cx, cy] = toCanvas(ax, fn(ax))
    i === 0 ? ctx.moveTo(cx, cy) : ctx.lineTo(cx, cy)
  }
  ctx.stroke()

  for (const [h, color] of [[h1, '#60a5fa'], [h2, '#f97316']] as const) {
    const [hx, hy] = toCanvas(h.x, h.y)
    ctx.fillStyle = color
    ctx.beginPath(); ctx.arc(hx, hy, 5, 0, Math.PI*2); ctx.fill()
    ctx.strokeStyle = 'rgba(255,255,255,0.6)'
    ctx.lineWidth = 1
    ctx.beginPath(); ctx.arc(hx, hy, 5, 0, Math.PI*2); ctx.stroke()
  }
}

function CurveEditor({ footController }: { footController: NonNullable<Props['footController']> }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [h1, setH1] = useState({ x: 0.25, y: -0.15 })
  const [h2, setH2] = useState({ x: 0.65, y: 0.75 })
  const dragRef = useRef<'h1'|'h2'|null>(null)
  const h1Ref = useRef(h1); h1Ref.current = h1
  const h2Ref = useRef(h2); h2Ref.current = h2

  useEffect(() => {
    const ctx = canvasRef.current?.getContext('2d')
    if (!ctx) return
    drawCurve(ctx, h1, h2)
    footController.setCurveMap(buildLookup(h1, h2))
  }, [h1, h2, footController])

  const onMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect()
    const mx = (e.clientX - rect.left) * (CW / rect.width)
    const my = (e.clientY - rect.top) * (CH / rect.height)
    const [h1x, h1y] = toCanvas(h1Ref.current.x, h1Ref.current.y)
    const [h2x, h2y] = toCanvas(h2Ref.current.x, h2Ref.current.y)
    const d1 = Math.hypot(mx - h1x, my - h1y)
    const d2 = Math.hypot(mx - h2x, my - h2y)
    dragRef.current = d1 < d2 && d1 < 14 ? 'h1' : d2 < 14 ? 'h2' : null
  }, [])

  const onMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!dragRef.current) return
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect()
    const mx = (e.clientX - rect.left) * (CW / rect.width)
    const my = (e.clientY - rect.top) * (CH / rect.height)
    const [ax, ay] = fromCanvas(mx, my)
    if (dragRef.current === 'h1') setH1({ x: ax, y: ay })
    else setH2({ x: ax, y: ay })
  }, [])

  const onMouseUp = useCallback(() => { dragRef.current = null }, [])

  return (
    <canvas ref={canvasRef} width={CW} height={CH}
      style={{ display: 'block', borderRadius: 4, cursor: 'crosshair', width: '100%' }}
      onMouseDown={onMouseDown} onMouseMove={onMouseMove}
      onMouseUp={onMouseUp} onMouseLeave={onMouseUp}
    />
  )
}

function SliderRow({ label, value, min, max, onChange }: {
  label: string; value: number; min: number; max: number; onChange: (v: number) => void
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
      <span style={{ width: 44, color: '#6b7280', fontSize: 11 }}>{label}</span>
      <input type="range" min={min} max={max} step={0.01} value={value}
        style={{ flex: 1 }} onChange={e => onChange(parseFloat(e.target.value))} />
      <span style={{ width: 30, textAlign: 'right', color: '#4b5563', fontSize: 11 }}>{value.toFixed(2)}</span>
    </div>
  )
}
