/**
 * footControlDebug.tsx — Debug overlay for foot control.
 *
 * Shows:
 *   - Current heading angle (visual compass)
 *   - Axis sliders (simulate pedals when no gamepad connected)
 *   - Detected click events log
 *   - Gamepad connection status
 *
 * Mount anywhere for testing. Hidden in production builds via the `debug` prop.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import type { FootController, FootControlState } from './footControl'
import type { ClickDetector } from './clickDetect'

interface Props {
  footController: FootController | null
  clickDetector: ClickDetector | null
  visible?: boolean
}

export function FootControlDebug({ footController, clickDetector, visible = true }: Props) {
  const [state, setState] = useState<FootControlState | null>(null)
  const [events, setEvents] = useState<string[]>([])
  const [simRudder, setSimRudder] = useState(0)
  const [simCursor, setSimCursor] = useState(0)
  const [simPan, setSimPan] = useState(0)
  const [sensitivity, setSensitivity] = useState(3.0)  // triggerRatio

  // Listen for state updates from foot controller
  useEffect(() => {
    if (!footController) return
    return footController.onStateChange(s => setState(s))
  }, [footController])

  // Sync initial sensitivity from detector
  useEffect(() => {
    if (!clickDetector) return
    setSensitivity(clickDetector.getTriggerRatio())
  }, [clickDetector])

  // Listen for click events
  useEffect(() => {
    if (!clickDetector) return
    const addEvent = (label: string) => () =>
      setEvents(prev => [`${new Date().toLocaleTimeString()}: ${label}`, ...prev.slice(0, 19)])
    const off1 = clickDetector.on('click', addEvent('click'))
    const off2 = clickDetector.on('dblclick', addEvent('dblclick'))
    return () => { off1(); off2() }
  }, [clickDetector])

  if (!visible) return null

  const heading = state?.heading ?? -Math.PI / 2
  const compassX = 24 + Math.cos(heading) * 20
  const compassY = 24 + Math.sin(heading) * 20

  return (
    <div style={{
      position: 'fixed', top: 16, left: 16, zIndex: 9999,
      background: 'rgba(0,0,0,0.85)', color: '#e5e7eb',
      padding: '12px 16px', borderRadius: 8, fontSize: 12,
      fontFamily: 'monospace', width: 280,
      boxShadow: '0 4px 24px rgba(0,0,0,0.4)',
    }}>
      <div style={{ fontWeight: 700, marginBottom: 8, color: '#a78bfa' }}>foot control debug</div>

      {/* Gamepad status */}
      <div style={{ marginBottom: 8 }}>
        <span style={{ color: state?.gamepadConnected ? '#4ade80' : '#f87171' }}>
          {state?.gamepadConnected ? '● gamepad connected' : '○ no gamepad — use sliders'}
        </span>
      </div>

      {/* Compass */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
        <svg width={48} height={48} style={{ flexShrink: 0 }}>
          <circle cx={24} cy={24} r={20} fill="none" stroke="#374151" strokeWidth={1.5} />
          <line x1={24} y1={24} x2={compassX} y2={compassY} stroke="#a78bfa" strokeWidth={2} strokeLinecap="round" />
          <circle cx={24} cy={24} r={2} fill="#6b7280" />
          <text x={24} y={8} fill="#6b7280" fontSize={7} textAnchor="middle">N</text>
        </svg>
        <div>
          <div>heading: {((heading * 180 / Math.PI + 360) % 360).toFixed(0)}°</div>
          <div>cursor: ({state?.cursorX.toFixed(0)}, {state?.cursorY.toFixed(0)})</div>
        </div>
      </div>

      {/* Simulation sliders (only useful when no gamepad) */}
      <div style={{ marginBottom: 10 }}>
        <div style={{ color: '#9ca3af', marginBottom: 4 }}>simulate axes:</div>
        <SliderRow label="rudder" value={simRudder} min={-1} max={1}
          onChange={v => { setSimRudder(v); footController?.setHeading(footController.state.heading) }} />
        <SliderRow label="cursor throttle" value={simCursor} min={0} max={1} onChange={setSimCursor} />
        <SliderRow label="pan throttle" value={simPan} min={0} max={1} onChange={setSimPan} />
      </div>

      {/* Click sensitivity slider */}
      {clickDetector && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ color: '#9ca3af', marginBottom: 4 }}>
            click sensitivity (trigger ratio: {sensitivity.toFixed(1)}×)
            <span style={{ color: '#4b5563', marginLeft: 6 }}>← loose · tight →</span>
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

      {/* Response curve editor */}
      {footController && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ color: '#9ca3af', marginBottom: 4 }}>response curve (drag handles):</div>
          <CurveEditor footController={footController} />
        </div>
      )}

      {/* Event log */}
      <div>
        <div style={{ color: '#9ca3af', marginBottom: 4 }}>click events:</div>
        <div style={{ maxHeight: 100, overflowY: 'auto', color: '#86efac' }}>
          {events.length === 0 ? <span style={{ color: '#4b5563' }}>none yet</span> : events.map((e, i) => (
            <div key={i}>{e}</div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Curve editor ────────────────────────────────────────────────────────────

const CW = 248, CH = 90  // canvas dimensions
const YMIN = -0.45, YMAX = 1.1  // Y axis range
const YRANGE = YMAX - YMIN
const PAD = 6  // px padding around plot area

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

// Catmull-Rom spline through 4 points: P0, P1, P2, P3
function catmullRom(t: number, p0: number, p1: number, p2: number, p3: number): number {
  return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2*p0 - 5*p1 + 4*p2 - p3) * t*t + (-p0 + 3*p1 - 3*p2 + p3) * t*t*t)
}

// Build lookup table for curve: input [0,1] → output
function buildLookup(h1: {x:number,y:number}, h2: {x:number,y:number}): (x: number) => number {
  const pts = [{x:0,y:0}, h1, h2, {x:1,y:1}]
  // Sample the Catmull-Rom curve at N points
  const N = 200
  const samples: [number,number][] = []
  // Segment 1: P0→P1 (use P0 as phantom start)
  for (let i = 0; i <= N/2; i++) {
    const t = i / (N/2)
    const x = catmullRom(t, pts[0].x, pts[0].x, pts[1].x, pts[2].x)
    const y = catmullRom(t, pts[0].y, pts[0].y, pts[1].y, pts[2].y)
    samples.push([Math.max(0, Math.min(1, x)), y])
  }
  // Segment 2: P1→P2
  for (let i = 0; i <= N/2; i++) {
    const t = i / (N/2)
    const x = catmullRom(t, pts[0].x, pts[1].x, pts[2].x, pts[3].x)
    const y = catmullRom(t, pts[0].y, pts[1].y, pts[2].y, pts[3].y)
    samples.push([Math.max(0, Math.min(1, x)), y])
  }
  // Segment 3: P2→P3
  for (let i = 0; i <= N/2; i++) {
    const t = i / (N/2)
    const x = catmullRom(t, pts[1].x, pts[2].x, pts[3].x, pts[3].x)
    const y = catmullRom(t, pts[1].y, pts[2].y, pts[3].y, pts[3].y)
    samples.push([Math.max(0, Math.min(1, x)), y])
  }
  samples.sort((a, b) => a[0] - b[0])
  return (x: number) => {
    if (x <= 0) return samples[0]?.[1] ?? 0
    if (x >= 1) return samples[samples.length-1]?.[1] ?? 1
    let lo = 0, hi = samples.length - 1
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (samples[mid][0] < x) lo = mid; else hi = mid
    }
    const [x0, y0] = samples[lo], [x1, y1] = samples[hi]
    const frac = x1 > x0 ? (x - x0) / (x1 - x0) : 0
    return y0 + frac * (y1 - y0)
  }
}

function drawCurve(ctx: CanvasRenderingContext2D, h1: {x:number,y:number}, h2: {x:number,y:number}) {
  ctx.clearRect(0, 0, CW, CH)

  // Background
  ctx.fillStyle = 'rgba(0,0,0,0.6)'
  ctx.fillRect(0, 0, CW, CH)

  // Zero line (y=0)
  const [, zy] = toCanvas(0, 0)
  ctx.strokeStyle = '#374151'
  ctx.lineWidth = 1
  ctx.setLineDash([3, 3])
  ctx.beginPath(); ctx.moveTo(PAD, zy); ctx.lineTo(CW - PAD, zy); ctx.stroke()
  ctx.setLineDash([])

  // Curve
  const fn = buildLookup(h1, h2)
  ctx.strokeStyle = '#a78bfa'
  ctx.lineWidth = 1.5
  ctx.beginPath()
  for (let i = 0; i <= CW - PAD*2; i++) {
    const ax = i / (CW - PAD*2)
    const ay = fn(ax)
    const [cx, cy] = toCanvas(ax, ay)
    i === 0 ? ctx.moveTo(cx, cy) : ctx.lineTo(cx, cy)
  }
  ctx.stroke()

  // Handles
  for (const [h, color] of [[h1, '#60a5fa'], [h2, '#f97316']] as const) {
    const [hx, hy] = toCanvas(h.x, h.y)
    ctx.fillStyle = color
    ctx.beginPath(); ctx.arc(hx, hy, 5, 0, Math.PI*2); ctx.fill()
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = 1
    ctx.beginPath(); ctx.arc(hx, hy, 5, 0, Math.PI*2); ctx.stroke()
  }

  // Axis labels
  ctx.fillStyle = '#6b7280'
  ctx.font = '9px monospace'
  ctx.fillText('0', PAD + 1, zy - 2)
  ctx.fillText('1', toCanvas(1, 0)[0] - 6, CH - 1)
}

function CurveEditor({ footController }: { footController: NonNullable<Props['footController']> }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [h1, setH1] = useState({ x: 0.25, y: -0.15 })
  const [h2, setH2] = useState({ x: 0.65, y: 0.75 })
  const dragRef = useRef<'h1'|'h2'|null>(null)
  const h1Ref = useRef(h1)
  const h2Ref = useRef(h2)
  h1Ref.current = h1; h2Ref.current = h2

  // Redraw whenever handles change
  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
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
    dragRef.current = d1 < d2 && d1 < 12 ? 'h1' : d2 < 12 ? 'h2' : null
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
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
      <span style={{ width: 100, color: '#d1d5db' }}>{label}</span>
      <input type="range" min={min} max={max} step={0.01} value={value}
        style={{ flex: 1 }}
        onChange={e => onChange(parseFloat(e.target.value))} />
      <span style={{ width: 36, textAlign: 'right', color: '#9ca3af' }}>{value.toFixed(2)}</span>
    </div>
  )
}
