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
import { buildLookup } from './curveEditor'
import { CurveEditor } from './components/CurveEditor'
import { getPref, setPref, subscribePref } from './preferences'

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
  const [curve, setCurve] = useState(() => getPref('response-curve'))

  useEffect(() => {
    if (!footController) return
    return footController.onStateChange(s => setState(s))
  }, [footController])

  useEffect(() => {
    if (!footController) return
    footController.setCurveMap(buildLookup(curve.h1, curve.h2))
  }, [curve, footController])

  useEffect(() => {
    return subscribePref(() => {
      setCurve(getPref('response-curve'))
    })
  }, [])

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
        position: 'fixed', top: 6, left: 120, zIndex: 9999,
        background: 'rgba(0,0,0,0.82)', color: '#e5e7eb',
        padding: '6px 12px', borderRadius: 20, fontSize: 12,
        fontFamily: 'monospace', display: 'flex', alignItems: 'center', gap: 8,
        boxShadow: '0 2px 12px rgba(0,0,0,0.4)', cursor: 'pointer', userSelect: 'none',
        border: '1px solid #1f2937',
        opacity: anyActive ? 0.85 : 0.35,
        transition: 'opacity 0.3s ease',
      }} onClick={() => setCollapsed(false)}
         onMouseEnter={e => (e.currentTarget.style.opacity = '0.85')}
         onMouseLeave={e => (e.currentTarget.style.opacity = anyActive ? '0.85' : '0.35')}>
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
      position: 'fixed', top: 6, left: 120, zIndex: 9999,
      background: 'rgba(0,0,0,0.88)', color: '#e5e7eb',
      padding: '10px 14px', borderRadius: 10, fontSize: 12,
      fontFamily: 'monospace', width: 272,
      boxShadow: '0 4px 24px rgba(0,0,0,0.5)',
      opacity: 0.15,
      transition: 'opacity 0.3s ease',
    }}
    onMouseEnter={e => (e.currentTarget.style.opacity = '1')}
    onMouseLeave={e => (e.currentTarget.style.opacity = '0.15')}>

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
          <CurveEditor value={curve} onChange={h => {
            setCurve(h)
            setPref('response-curve', h)
          }} />
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
