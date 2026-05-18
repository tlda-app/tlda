import { useState, useCallback, useEffect } from 'react'
import { getPref, setPref, subscribePref } from '../preferences'
import { NOTE_COLORS } from '../shapes/MathNoteShape'
import { CurveEditor } from '../components/CurveEditor'
import { DarkModeToggle, VimModeToggle } from './TocTab'

const ALL_SOURCES = ['ref', 'proof', 'errors', 'shared'] as const

const COLOR_OPTIONS = Object.keys(NOTE_COLORS)

function readAll() {
  return {
    sources: getPref('docview-sources'),
    voiceColor: getPref('voice-note-color'),
    mathColor: getPref('math-note-color'),
    curve: getPref('response-curve'),
    spawnMode: getPref('spawn-mode'),
  }
}

export function PrefsTab() {
  const [prefs, setPrefs] = useState(readAll)

  useEffect(() => subscribePref(() => setPrefs(readAll())), [])

  const toggleSource = useCallback((src: string) => {
    const next = prefs.sources.includes(src)
      ? prefs.sources.filter(s => s !== src)
      : [...prefs.sources, src]
    setPref('docview-sources', next)
  }, [prefs.sources])

  const handleVoiceColor = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    setPref('voice-note-color', e.target.value)
  }, [])

  const handleMathColor = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    setPref('math-note-color', e.target.value)
  }, [])

  const handleSpawnMode = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setPref('spawn-mode', e.target.checked ? 'plan' : '')
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
                checked={prefs.sources.includes(src)}
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
          <select value={prefs.voiceColor} onChange={handleVoiceColor} className="prefs-select">
            {COLOR_OPTIONS.map(c => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          <span className="prefs-color-swatch" style={{ background: NOTE_COLORS[prefs.voiceColor] }} />
        </div>
        <div className="prefs-color-row">
          <span className="prefs-color-label">Math</span>
          <select value={prefs.mathColor} onChange={handleMathColor} className="prefs-select">
            {COLOR_OPTIONS.map(c => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          <span className="prefs-color-swatch" style={{ background: NOTE_COLORS[prefs.mathColor] }} />
        </div>
      </div>

      <div className="prefs-section">
        <div className="prefs-section-label">Spawn</div>
        <label className="prefs-check">
          <input
            type="checkbox"
            checked={prefs.spawnMode === 'plan'}
            onChange={handleSpawnMode}
          />
          <span>Spawn in plan mode</span>
        </label>
      </div>

      <div className="prefs-section">
        <div className="prefs-section-label">Theme</div>
        <DarkModeToggle />
      </div>

      <div className="prefs-section">
        <div className="prefs-section-label">Editor</div>
        <VimModeToggle />
      </div>

      <div className="prefs-section">
        <div className="prefs-section-label">Edge-zone response curve</div>
        <div style={{ fontSize: 10, color: '#6b7280', marginBottom: 4 }}>
          Drag handles to shape scroll/pan velocity near viewport edges
        </div>
        <CurveEditor value={prefs.curve} onChange={h => setPref('response-curve', h)} />
      </div>
    </div>
  )
}
