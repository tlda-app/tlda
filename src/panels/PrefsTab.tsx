import { useState, useCallback, useEffect } from 'react'
import { getPref, setPref, subscribePref } from '../preferences'
import { setBackend as setVoiceBackend } from '../voice.mjs'
import { NOTE_COLORS } from '../shapes/MathNoteShape'
import { CurveEditor } from '../components/CurveEditor'
import { SchemeToggle, ThemeFamilyToggle, VimModeToggle } from './TocTab'
import { useFleetIdentity } from '../fleet-data-adapter'

// Identity switcher — touch devices can't edit localStorage, so this is the only
// way to change who you are on a server that auto-assigned a wrong/cached id
// (e.g. the no-auth local copy that used to log everyone in as "dev").
function IdentitySection() {
  const { name, login, register } = useFleetIdentity()
  const [val, setVal] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const switchTo = useCallback(async () => {
    const n = val.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '')
    if (!n) { setErr('Enter a name (letters, numbers, dashes)'); return }
    setBusy(true); setErr(null)
    try {
      await login(n)
      setVal('')
    } catch (e) {
      // Not a known human yet → create it, so a first-time name still works.
      try { await register(n); setVal('') }
      catch (e2) { setErr((e2 as Error).message) }
    } finally {
      setBusy(false)
    }
  }, [val, login, register])

  return (
    <div className="prefs-section">
      <div className="prefs-section-label">Identity</div>
      <div style={{ fontSize: 11, marginBottom: 4 }}>
        You are <strong>{name || '(none)'}</strong>
      </div>
      <div className="prefs-num-row">
        <input
          className="prefs-num"
          style={{ width: 120, textAlign: 'left' }}
          placeholder="switch to…"
          value={val}
          onChange={e => setVal(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') switchTo() }}
        />
        <button className="prefs-btn" onClick={switchTo} disabled={busy}>
          {busy ? '…' : 'Switch'}
        </button>
      </div>
      {err && <div style={{ fontSize: 10, color: '#b91c1c', marginTop: 2 }}>{err}</div>}
    </div>
  )
}

const ALL_SOURCES = ['ref', 'proof', 'errors', 'shared'] as const

const COLOR_OPTIONS = Object.keys(NOTE_COLORS)

function readAll() {
  return {
    sources: getPref('docview-sources'),
    voiceColor: getPref('voice-note-color'),
    mathColor: getPref('math-note-color'),
    curve: getPref('response-curve'),
    spawnMode: getPref('spawn-mode'),
    voiceBackend: getPref('voice-backend'),
    voiceSubmitWords: getPref('voice-submit-words'),
    voiceSinkShapeTypes: getPref('voice-sink-shape-types'),
    fontSize: getPref('fleet-font-size'),
    heightFrac: getPref('layout-height-frac'),
    railWidth: getPref('layout-rail-width'),
    chatWidth: getPref('layout-chat-width'),
    marginGap: getPref('layout-margin-gap'),
    chromeOpacity: getPref('fleet-chrome-opacity'),
    contentOpacity: getPref('fleet-content-opacity'),
    ageFade: getPref('fleet-age-fade'),
    foldBash: getPref('fold-bash-lines'),
    foldWrite: getPref('fold-write-lines'),
    foldMd: getPref('fold-md-lines'),
    foldDiff: getPref('fold-diff-lines'),
    hlZone: getPref('hl-zone-enabled'),
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
      <IdentitySection />

      <div className="prefs-section">
        <div className="prefs-section-label">Theme</div>
        <SchemeToggle />
        <ThemeFamilyToggle />
      </div>

      <div className="prefs-section">
        <div className="prefs-section-label">Fleet readability</div>

        <div className="prefs-num-row">
          <span className="prefs-num-label">Font size</span>
          <input
            type="number"
            min={8}
            max={24}
            step={1}
            value={prefs.fontSize}
            onChange={e => setPref('fleet-font-size', Number(e.target.value))}
            className="prefs-num"
          />
          <span className="prefs-num-unit">px</span>
        </div>

        <div className="prefs-num-row">
          <span className="prefs-num-label">Chrome opacity</span>
          <input
            type="number"
            min={0}
            max={150}
            step={5}
            value={Math.round(prefs.chromeOpacity * 100)}
            onChange={e => setPref('fleet-chrome-opacity', Number(e.target.value) / 100)}
            className="prefs-num"
          />
          <span className="prefs-num-unit">%</span>
        </div>

        <div className="prefs-num-row">
          <span className="prefs-num-label">Content opacity</span>
          <input
            type="number"
            min={0}
            max={100}
            step={5}
            value={Math.round(prefs.contentOpacity * 100)}
            onChange={e => setPref('fleet-content-opacity', Number(e.target.value) / 100)}
            className="prefs-num"
          />
          <span className="prefs-num-unit">%</span>
        </div>

        <label className="prefs-check">
          <input
            type="checkbox"
            checked={prefs.ageFade}
            onChange={e => setPref('fleet-age-fade', e.target.checked)}
          />
          <span>Age fade</span>
        </label>
      </div>

      <div className="prefs-section">
        <div className="prefs-section-label">Default layout size</div>
        <div style={{ fontSize: 10, color: '#6b7280', marginBottom: 4 }}>
          Applied when you pick a layout preset. Re-pick a layout to apply changes.
        </div>
        <div className="prefs-num-row">
          <span className="prefs-num-label">Height</span>
          <input
            type="number"
            min={10}
            max={100}
            step={5}
            value={Math.round(prefs.heightFrac * 100)}
            onChange={e => setPref('layout-height-frac', Number(e.target.value) / 100)}
            className="prefs-num"
          />
          <span className="prefs-num-unit">% of view</span>
        </div>
        <div className="prefs-num-row">
          <span className="prefs-num-label">Rail width</span>
          <input
            type="number"
            min={200}
            max={800}
            step={5}
            value={prefs.railWidth}
            onChange={e => setPref('layout-rail-width', Number(e.target.value))}
            className="prefs-num"
          />
          <span className="prefs-num-unit">px</span>
        </div>
        <div className="prefs-num-row">
          <span className="prefs-num-label">Chat width</span>
          <input
            type="number"
            min={200}
            max={1000}
            step={5}
            value={prefs.chatWidth}
            onChange={e => setPref('layout-chat-width', Number(e.target.value))}
            className="prefs-num"
          />
          <span className="prefs-num-unit">px</span>
        </div>
        <div className="prefs-num-row">
          <span className="prefs-num-label">Margin gap</span>
          <input
            type="number"
            min={0}
            max={300}
            step={5}
            value={prefs.marginGap}
            onChange={e => setPref('layout-margin-gap', Number(e.target.value))}
            className="prefs-num"
          />
          <span className="prefs-num-unit">px</span>
        </div>
      </div>

      <div className="prefs-section">
        <div className="prefs-section-label">Fold tool output</div>
        <div style={{ fontSize: 10, color: '#6b7280', marginBottom: 4 }}>
          Collapse long tool/monitoring output past N lines (0 = never fold). Messages and images are never folded.
        </div>
        {([
          ['Bash', 'fold-bash-lines', prefs.foldBash],
          ['File writes', 'fold-write-lines', prefs.foldWrite],
          ['Markdown writes', 'fold-md-lines', prefs.foldMd],
          ['Edit diffs', 'fold-diff-lines', prefs.foldDiff],
        ] as const).map(([label, key, val]) => (
          <div className="prefs-num-row" key={key}>
            <span className="prefs-num-label">{label}</span>
            <input
              type="number"
              min={0}
              step={1}
              value={val}
              onChange={e => setPref(key, Number(e.target.value))}
              className="prefs-num"
            />
            <span className="prefs-num-unit">{val === 0 ? 'off' : 'lines'}</span>
          </div>
        ))}
      </div>

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
        <div className="prefs-section-label">Voice backend</div>
        <select value={prefs.voiceBackend} onChange={e => { setPref('voice-backend', e.target.value); setVoiceBackend(e.target.value) }} className="prefs-select">
          <option value="">Off</option>
          <option value="chrome">Chrome Web Speech</option>
          <option value="deepgram">Deepgram</option>
          <option value="whisper">Whisper</option>
        </select>
        <div style={{ fontSize: 10, color: '#6b7280', marginTop: 2 }}>
          Defaults to Deepgram. No fallback — the chosen backend is the only one that ever runs; Chrome (can beep) is opt-in only.
        </div>
      </div>

      <div className="prefs-section">
        <div className="prefs-section-label">Voice commands</div>
        <div className="prefs-num-row">
          <span className="prefs-color-label">Submit</span>
          <input
            className="prefs-num"
            style={{ width: 170, textAlign: 'left' }}
            value={prefs.voiceSubmitWords}
            onChange={e => setPref('voice-submit-words', e.target.value)}
            placeholder="send, send it"
          />
        </div>
        <div className="prefs-num-row">
          <span className="prefs-color-label">&lt;nowhere&gt; shapes</span>
          <input
            className="prefs-num"
            style={{ width: 170, textAlign: 'left' }}
            value={prefs.voiceSinkShapeTypes}
            onChange={e => setPref('voice-sink-shape-types', e.target.value)}
            placeholder="fleet-agents"
          />
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
        <div className="prefs-section-label">Highlighter</div>
        <label className="prefs-check">
          <input
            type="checkbox"
            checked={prefs.hlZone}
            onChange={e => setPref('hl-zone-enabled', e.target.checked)}
          />
          <span>Edge zone</span>
        </label>
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
