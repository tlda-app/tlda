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

import { useState, useEffect } from 'react'
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
      position: 'fixed', bottom: 16, right: 16, zIndex: 9999,
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
          <input type="range" min={1.5} max={8} step={0.1} value={sensitivity}
            style={{ width: '100%' }}
            onChange={e => {
              const v = parseFloat(e.target.value)
              setSensitivity(v)
              clickDetector.setTriggerRatio(v)
            }} />
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
