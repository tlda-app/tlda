import { useState, useCallback } from 'react'
import { getPref, setPref } from '../preferences'
import { NOTE_COLORS } from '../shapes/MathNoteShape'
import { CurveEditor } from '../components/CurveEditor'

const ALL_SOURCES = ['ref', 'proof', 'errors', 'shared'] as const

const COLOR_OPTIONS = Object.keys(NOTE_COLORS)

export function PrefsTab() {
  const [sources, setSources] = useState(() => getPref('docview-sources'))
  const [voiceColor, setVoiceColor] = useState(() => getPref('voice-note-color'))
  const [mathColor, setMathColor] = useState(() => getPref('math-note-color'))
  const [curve, setCurve] = useState(() => getPref('response-curve'))

  const toggleSource = useCallback((src: string) => {
    const next = sources.includes(src)
      ? sources.filter(s => s !== src)
      : [...sources, src]
    setSources(next)
    setPref('docview-sources', next)
  }, [sources])

  const handleVoiceColor = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    setVoiceColor(e.target.value)
    setPref('voice-note-color', e.target.value)
  }, [])

  const handleMathColor = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    setMathColor(e.target.value)
    setPref('math-note-color', e.target.value)
  }, [])

  return (
    <div className="prefs-tab">
      <div className="prefs-section">
        <div className="prefs-section-label">Doc viewer sources</div>
        <div className="prefs-source-checks">
          {ALL_SOURCES.map(src => (
            <label key={src} className="prefs-check">
              <input
                type="checkbox"
                checked={sources.includes(src)}
                onChange={() => toggleSource(src)}
              />
              <span>{src}</span>
            </label>
          ))}
        </div>
      </div>

      <div className="prefs-section">
        <div className="prefs-section-label">Note colors</div>
        <div className="prefs-color-row">
          <span className="prefs-color-label">Voice</span>
          <select value={voiceColor} onChange={handleVoiceColor} className="prefs-select">
            {COLOR_OPTIONS.map(c => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          <span className="prefs-color-swatch" style={{ background: NOTE_COLORS[voiceColor] }} />
        </div>
        <div className="prefs-color-row">
          <span className="prefs-color-label">Math</span>
          <select value={mathColor} onChange={handleMathColor} className="prefs-select">
            {COLOR_OPTIONS.map(c => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          <span className="prefs-color-swatch" style={{ background: NOTE_COLORS[mathColor] }} />
        </div>
      </div>
      <div className="prefs-section">
        <div className="prefs-section-label">Edge-zone response curve</div>
        <div style={{ fontSize: 10, color: '#6b7280', marginBottom: 4 }}>
          Drag handles to shape scroll/pan velocity near viewport edges
        </div>
        <CurveEditor value={curve} onChange={h => {
          setCurve(h)
          setPref('response-curve', h)
        }} />
      </div>
    </div>
  )
}
