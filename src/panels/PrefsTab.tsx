import { useState, useCallback, useEffect, type ReactNode } from 'react'
import { getPref, setPref, subscribePref } from '../preferences'
import { setBackend as setVoiceBackend } from '../voice.mjs'
import { NOTE_COLORS } from '../shapes/MathNoteShape'
import { CurveEditor } from '../components/CurveEditor'
import { SchemeToggle, ThemeFamilyToggle, VimModeToggle } from './TocTab'
import { useFleetIdentity } from '../fleet-data-adapter'

// Identity switcher — touch devices can't edit localStorage, so this is the only
// way to change who you are on a server that auto-assigned a wrong/cached id
// (e.g. the no-auth local copy that used to log everyone in as "dev").
function IdentitySectionBody() {
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
    <>
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
    </>
  )
}

const ALL_SOURCES = ['ref', 'proof', 'errors'] as const

const COLOR_OPTIONS = Object.keys(NOTE_COLORS)

type PrefsSectionId =
  | 'identity'
  | 'theme'
  | 'readability'
  | 'layout'
  | 'folding'
  | 'sources'
  | 'provenance'
  | 'notes'
  | 'voice-backend'
  | 'voice-commands'
  | 'spawn'
  | 'highlighter'
  | 'editor'
  | 'curve'
  | 'bots'

function CollapsiblePrefsSection({
  id,
  title,
  summary,
  open,
  onToggle,
  children,
}: {
  id: PrefsSectionId
  title: string
  summary?: ReactNode
  open: boolean
  onToggle: (id: PrefsSectionId) => void
  children: ReactNode
}) {
  const bodyId = `prefs-section-${id}`

  return (
    <section className={`prefs-section ${open ? 'prefs-section--open' : 'prefs-section--closed'}`}>
      <button
        type="button"
        className="prefs-section-toggle"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => onToggle(id)}
      >
        <span className="prefs-section-chevron" aria-hidden="true">{open ? '▾' : '▸'}</span>
        <span className="prefs-section-heading">
          <span className="prefs-section-label">{title}</span>
          {summary && <span className="prefs-section-summary">{summary}</span>}
        </span>
      </button>
      {open && (
        <div id={bodyId} className="prefs-section-body">
          {children}
        </div>
      )}
    </section>
  )
}

function readAll() {
  return {
    openSections: getPref('prefs-open-sections') as PrefsSectionId[],
    sources: getPref('docview-sources'),
    voiceColor: getPref('voice-note-color'),
    mathColor: getPref('math-note-color'),
    mathOpacity: getPref('math-note-opacity'),
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
    provenanceMode: getPref('provenance-display-mode'),
    selfCheckEnabled: getPref('todd-self-check-auto-enabled'),
    selfCheckCountdown: getPref('todd-self-check-countdown-sec'),
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

  const toggleSection = useCallback((id: PrefsSectionId) => {
    const isOpen = prefs.openSections.includes(id)
    const next = isOpen
      ? prefs.openSections.filter(sectionId => sectionId !== id)
      : [...prefs.openSections, id]
    setPref('prefs-open-sections', next)
  }, [prefs.openSections])

  const foldSummary = [
    `Bash ${prefs.foldBash || 'off'}`,
    `Writes ${prefs.foldWrite || 'off'}`,
    `MD ${prefs.foldMd || 'off'}`,
    `Diff ${prefs.foldDiff || 'off'}`,
  ].join(' / ')

  return (
    <div className="prefs-tab">
      <CollapsiblePrefsSection
        id="identity"
        title="Identity"
        summary="Current user and switcher"
        open={prefs.openSections.includes('identity')}
        onToggle={toggleSection}
      >
        <IdentitySectionBody />
      </CollapsiblePrefsSection>

      <CollapsiblePrefsSection
        id="theme"
        title="Theme"
        summary="Scheme and color family"
        open={prefs.openSections.includes('theme')}
        onToggle={toggleSection}
      >
        <SchemeToggle />
        <ThemeFamilyToggle />
      </CollapsiblePrefsSection>

      <CollapsiblePrefsSection
        id="readability"
        title="Fleet readability"
        summary={`${prefs.fontSize}px / chrome ${Math.round(prefs.chromeOpacity * 100)}% / content ${Math.round(prefs.contentOpacity * 100)}%`}
        open={prefs.openSections.includes('readability')}
        onToggle={toggleSection}
      >
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
      </CollapsiblePrefsSection>

      <CollapsiblePrefsSection
        id="layout"
        title="Default layout size"
        summary={`${Math.round(prefs.heightFrac * 100)}% high / rail ${prefs.railWidth}px / chat ${prefs.chatWidth}px`}
        open={prefs.openSections.includes('layout')}
        onToggle={toggleSection}
      >
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
      </CollapsiblePrefsSection>

      <CollapsiblePrefsSection
        id="folding"
        title="Fold tool output"
        summary={foldSummary}
        open={prefs.openSections.includes('folding')}
        onToggle={toggleSection}
      >
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
      </CollapsiblePrefsSection>

      <CollapsiblePrefsSection
        id="sources"
        title="Doc viewer sources"
        summary={prefs.sources.length ? prefs.sources.join(', ') : 'none'}
        open={prefs.openSections.includes('sources')}
        onToggle={toggleSection}
      >
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
      </CollapsiblePrefsSection>

      <CollapsiblePrefsSection
        id="provenance"
        title="Provenance display"
        summary={prefs.provenanceMode === 'off' ? 'Off' : prefs.provenanceMode}
        open={prefs.openSections.includes('provenance')}
        onToggle={toggleSection}
      >
        <select
          className="prefs-select"
          value={prefs.provenanceMode}
          onChange={e => setPref('provenance-display-mode', e.target.value)}
        >
          <option value="off">Off</option>
          <option value="hover">Hover tooltip (on the ribbon)</option>
          <option value="panel">Side panel (provenance + cascade)</option>
          <option value="inline">Inline pinned card (click a span)</option>
        </select>
        <div style={{ fontSize: 10, color: '#6b7280', marginTop: 2 }}>
          How a vetted span's provenance and its dependency cascade are shown. Switch freely to live in each.
        </div>
      </CollapsiblePrefsSection>

      <CollapsiblePrefsSection
        id="notes"
        title="Note colors"
        summary={`Voice ${prefs.voiceColor} / math ${prefs.mathColor} / ${Math.round(prefs.mathOpacity * 100)}%`}
        open={prefs.openSections.includes('notes')}
        onToggle={toggleSection}
      >
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
        <div className="prefs-num-row">
          <span className="prefs-num-label">Note opacity</span>
          <input
            type="number"
            min={20}
            max={100}
            step={5}
            value={Math.round(prefs.mathOpacity * 100)}
            onChange={e => setPref('math-note-opacity', Number(e.target.value) / 100)}
            className="prefs-num"
          />
          <span className="prefs-num-unit">%</span>
        </div>
      </CollapsiblePrefsSection>

      <CollapsiblePrefsSection
        id="voice-backend"
        title="Voice backend"
        summary={prefs.voiceBackend || 'Off'}
        open={prefs.openSections.includes('voice-backend')}
        onToggle={toggleSection}
      >
        <select value={prefs.voiceBackend} onChange={e => { setPref('voice-backend', e.target.value); setVoiceBackend(e.target.value) }} className="prefs-select">
          <option value="">Off</option>
          <option value="chrome">Chrome Web Speech</option>
          <option value="deepgram-sdk">Deepgram SDK</option>
          <option value="whisper">Whisper</option>
        </select>
        <div style={{ fontSize: 10, color: '#6b7280', marginTop: 2 }}>
          Defaults to Deepgram. No fallback — the chosen backend is the only one that ever runs; Chrome (can beep) is opt-in only.
        </div>
      </CollapsiblePrefsSection>

      <CollapsiblePrefsSection
        id="voice-commands"
        title="Voice commands"
        summary={`Submit: ${prefs.voiceSubmitWords || 'off'}`}
        open={prefs.openSections.includes('voice-commands')}
        onToggle={toggleSection}
      >
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
      </CollapsiblePrefsSection>

      <CollapsiblePrefsSection
        id="spawn"
        title="Spawn"
        summary={prefs.spawnMode === 'plan' ? 'Plan mode' : 'Default mode'}
        open={prefs.openSections.includes('spawn')}
        onToggle={toggleSection}
      >
        <label className="prefs-check">
          <input
            type="checkbox"
            checked={prefs.spawnMode === 'plan'}
            onChange={handleSpawnMode}
          />
          <span>Spawn in plan mode</span>
        </label>
      </CollapsiblePrefsSection>

      <CollapsiblePrefsSection
        id="highlighter"
        title="Highlighter"
        summary={prefs.hlZone ? 'Edge zone on' : 'Edge zone off'}
        open={prefs.openSections.includes('highlighter')}
        onToggle={toggleSection}
      >
        <label className="prefs-check">
          <input
            type="checkbox"
            checked={prefs.hlZone}
            onChange={e => setPref('hl-zone-enabled', e.target.checked)}
          />
          <span>Edge zone</span>
        </label>
      </CollapsiblePrefsSection>

      <CollapsiblePrefsSection
        id="bots"
        title="Bots"
        summary={prefs.selfCheckEnabled ? `Self-check poke ${prefs.selfCheckCountdown}s` : 'Self-check poke off'}
        open={prefs.openSections.includes('bots')}
        onToggle={toggleSection}
      >
        <div style={{ fontSize: 10, color: '#6b7280', marginBottom: 4 }}>
          Optional: when an agent's turn ends and you haven't messaged it, Todd
          can poke it to self-check ("am I actually done?"). The routine watchdog
          is still the longer idle-task check.
        </div>
        <label className="prefs-check">
          <input
            type="checkbox"
            checked={prefs.selfCheckEnabled}
            onChange={e => setPref('todd-self-check-auto-enabled', e.target.checked)}
          />
          <span>Turn-end self-check poke</span>
        </label>
        <div className="prefs-num-row">
          <span className="prefs-num-label">Countdown</span>
          <input
            type="number"
            min={5}
            max={300}
            step={5}
            value={prefs.selfCheckCountdown}
            onChange={e => setPref('todd-self-check-countdown-sec', Number(e.target.value))}
            className="prefs-num"
          />
          <span className="prefs-num-unit">sec</span>
        </div>
      </CollapsiblePrefsSection>

      <CollapsiblePrefsSection
        id="editor"
        title="Editor"
        summary="Vim mode"
        open={prefs.openSections.includes('editor')}
        onToggle={toggleSection}
      >
        <VimModeToggle />
      </CollapsiblePrefsSection>

      <CollapsiblePrefsSection
        id="curve"
        title="Edge-zone response curve"
        summary="Scroll and pan velocity"
        open={prefs.openSections.includes('curve')}
        onToggle={toggleSection}
      >
        <div style={{ fontSize: 10, color: '#6b7280', marginBottom: 4 }}>
          Drag handles to shape scroll/pan velocity near viewport edges
        </div>
        <CurveEditor value={prefs.curve} onChange={h => setPref('response-curve', h)} />
      </CollapsiblePrefsSection>
    </div>
  )
}
