import { useState, useCallback, useEffect, type ReactNode } from 'react'
import { getPref, setPref, subscribePref } from '../preferences'
import { setBackend as setVoiceBackend } from '../voice.mjs'
import { NOTE_COLORS } from '../shapes/MathNoteShape'
import { CurveEditor } from '../components/CurveEditor'
import { SchemeToggle, ThemeFamilyToggle, VimModeToggle } from './TocTab'
import { useFleetAgents, useFleetIdentity } from '../fleet-data-adapter'
// @ts-ignore — vanilla JS module
import { getDeviceId } from '../fleet/fleet-data.mjs'
import { agentDisplayName } from '../shapes/fleet-utils'
import { useAvailableSpawnModels } from '../fleet/useAvailableSpawnModels'

type DeviceRecord = { lastSeen: string }

const ALL_SOURCES = ['ref', 'proof', 'errors'] as const
const SOURCE_LABELS: Record<(typeof ALL_SOURCES)[number], string> = {
  ref: 'References',
  proof: 'Proofs',
  errors: 'Errors',
}

const COLOR_OPTIONS = Object.keys(NOTE_COLORS)

const FLEET_SHAPE_OPTIONS = [
  ['fleet-agents', 'Agents'],
  ['fleet-chat', 'Chat'],
  ['fleet-search', 'Search'],
  ['fleet-docview', 'Doc view'],
  ['fleet-source-editor', 'Source editor'],
  ['fleet-reaper', 'Reaper'],
  ['fleet-inbox', 'Inbox'],
  ['fleet-touch-inbox', 'Touch inbox'],
  ['fleet-notifications', 'Notifications'],
] as const

type PrefsSectionId = 'account' | 'appearance' | 'voice' | 'input' | 'bots'
type VoiceBackendOption = { value: string; label: string; available: boolean }
type SpeechRecognitionWindow = Window & {
  SpeechRecognition?: unknown
  webkitSpeechRecognition?: unknown
}

function csvToSet(value: string): Set<string> {
  return new Set(value.split(',').map(s => s.trim()).filter(Boolean))
}

function setToCsv(value: Set<string>): string {
  return [...value].join(', ')
}

function labelsFor(agent: any): string[] {
  if (Array.isArray(agent?.labels)) return agent.labels
  if (typeof agent?.labels === 'string') {
    try {
      const parsed = JSON.parse(agent.labels)
      return Array.isArray(parsed) ? parsed : []
    } catch { return [] }
  }
  return []
}

function isRunningBot(agent: any): boolean {
  const status = agent?.status
  return !agent?.dead && labelsFor(agent).includes('bot') && status !== 'dead' && status !== 'hibernating' && status !== 'human-away'
}

function useVoiceBackends(): VoiceBackendOption[] {
  const [backends, setBackends] = useState<VoiceBackendOption[]>([
    { value: '', label: 'Off', available: true },
  ])

  useEffect(() => {
    let cancelled = false
    fetch('/api/voice/backends')
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(data => {
        if (cancelled) return
        let next = (data?.backends || []).filter((b: VoiceBackendOption) => b?.available !== false)
        const speechWindow = window as SpeechRecognitionWindow
        const hasBrowserSpeech = !!(speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition)
        next = next.filter((b: VoiceBackendOption) => b.value !== 'chrome' || hasBrowserSpeech)
        if (!next.some((b: VoiceBackendOption) => b.value === '')) next.unshift({ value: '', label: 'Off', available: true })
        setBackends(next)
      })
      .catch(() => {
        if (!cancelled) setBackends([{ value: '', label: 'Off', available: true }])
      })
    return () => { cancelled = true }
  }, [])

  return backends
}

function formatLastSeen(value?: string): string {
  if (!value) return 'never'
  const t = new Date(value).getTime()
  if (!Number.isFinite(t)) return value
  const sec = Math.max(0, Math.round((Date.now() - t) / 1000))
  if (sec < 60) return 'just now'
  const min = Math.round(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.round(min / 60)
  if (hr < 48) return `${hr}h ago`
  return new Date(value).toLocaleDateString()
}

function PrefSubsection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="prefs-subsection">
      <div className="prefs-subsection-title">{title}</div>
      {children}
    </div>
  )
}

function IdentitySectionBody({
  knownDevices,
  deviceNames,
}: {
  knownDevices: Record<string, DeviceRecord>
  deviceNames: Record<string, string>
}) {
  const { name, login, register } = useFleetIdentity()
  const [val, setVal] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const deviceId = getDeviceId()

  useEffect(() => {
    if (!deviceId) return
    const current = getPref('known-devices') as Record<string, DeviceRecord>
    setPref('known-devices', { ...current, [deviceId]: { lastSeen: new Date().toISOString() } })
  }, [deviceId])

  const switchTo = useCallback(async () => {
    const n = val.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '')
    if (!n) { setErr('Enter a name (letters, numbers, dashes)'); return }
    setBusy(true); setErr(null)
    try {
      await login(n)
      setVal('')
    } catch (e) {
      try { await register(n); setVal('') }
      catch (e2) { setErr((e2 as Error).message) }
    } finally {
      setBusy(false)
    }
  }, [val, login, register])

  const renameDevice = useCallback((id: string, deviceName: string) => {
    const current = getPref('device-names') as Record<string, string>
    const next = { ...current }
    const clean = deviceName.trim()
    if (clean) next[id] = clean
    else delete next[id]
    setPref('device-names', next)
  }, [])

  const devices = Object.entries(knownDevices)
    .sort((a, b) => new Date(b[1]?.lastSeen || 0).getTime() - new Date(a[1]?.lastSeen || 0).getTime())

  return (
    <>
      <PrefSubsection title="User">
        <div style={{ fontSize: 11, marginBottom: 4 }}>
          You are <strong>{name || '(none)'}</strong>
        </div>
        <div className="prefs-num-row">
          <input
            className="prefs-num"
            style={{ width: 120, textAlign: 'left' }}
            placeholder="switch to..."
            value={val}
            onChange={e => setVal(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') switchTo() }}
          />
          <button className="prefs-btn" onClick={switchTo} disabled={busy}>
            {busy ? '...' : 'Switch'}
          </button>
        </div>
        {err && <div style={{ fontSize: 10, color: '#b91c1c', marginTop: 2 }}>{err}</div>}
      </PrefSubsection>

      <PrefSubsection title="Devices">
        {devices.length === 0 && <div style={{ fontSize: 10, color: '#6b7280' }}>No devices seen yet.</div>}
        {devices.map(([id, rec]) => (
          <div className="prefs-device-row" key={id}>
            <div className="prefs-device-meta">
              <span className="prefs-device-id">{id}{id === deviceId ? ' (this device)' : ''}</span>
              <span className="prefs-device-seen">{formatLastSeen(rec?.lastSeen)}</span>
            </div>
            <input
              className="prefs-num prefs-device-name"
              style={{ textAlign: 'left' }}
              value={deviceNames[id] || ''}
              placeholder="device name"
              onChange={e => renameDevice(id, e.target.value)}
            />
          </div>
        ))}
      </PrefSubsection>
    </>
  )
}

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
    curve: getPref('response-curve'),
    knownDevices: getPref('known-devices'),
    deviceNames: getPref('device-names'),
    voiceBackend: getPref('voice-backend'),
    voiceSubmitWords: getPref('voice-submit-words'),
    voiceSinkShapeTypes: getPref('voice-sink-shape-types'),
    voiceIdleCutoffMs: getPref('voice-idle-cutoff-ms'),
    voicePrerollMs: getPref('voice-preroll-ms'),
    voiceResumeRms: getPref('voice-resume-rms'),
    voiceEndpointing: getPref('voice-endpointing'),
    voiceUtteranceEndMs: getPref('voice-utterance-end-ms'),
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
    cornerRail: getPref('corner-rail-enabled'),
    cornerSize: getPref('corner-control-size'),
    slidesNavigationMode: getPref('slides-navigation-mode'),
    provenanceMode: getPref('provenance-display-mode'),
    selfCheckEnabled: getPref('todd-self-check-auto-enabled'),
    selfCheckCountdown: getPref('todd-self-check-countdown-sec'),
    botSelfCheckEnabled: getPref('bot-self-check-enabled'),
    botSelfCheckCountdown: getPref('bot-self-check-countdown-sec'),
    botModel: getPref('bot-model'),
  }
}

export function PrefsTab() {
  const { id: userId } = useFleetIdentity()
  const [prefs, setPrefs] = useState(readAll)
  const agents = useFleetAgents()
  const voiceBackends = useVoiceBackends()
  const availableModels = useAvailableSpawnModels(userId).aliases

  useEffect(() => subscribePref(() => setPrefs(readAll())), [])

  const toggleSource = useCallback((src: string) => {
    const next = prefs.sources.includes(src)
      ? prefs.sources.filter(s => s !== src)
      : [...prefs.sources, src]
    setPref('docview-sources', next)
  }, [prefs.sources])

  const toggleVoiceSink = useCallback((shapeType: string) => {
    const next = csvToSet(prefs.voiceSinkShapeTypes)
    if (next.has(shapeType)) next.delete(shapeType)
    else next.add(shapeType)
    setPref('voice-sink-shape-types', setToCsv(next))
  }, [prefs.voiceSinkShapeTypes])

  const handleVoiceColor = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    setPref('voice-note-color', e.target.value)
  }, [])

  const toggleSection = useCallback((id: PrefsSectionId) => {
    const isOpen = prefs.openSections.includes(id)
    const next = isOpen
      ? prefs.openSections.filter(sectionId => sectionId !== id)
      : [...prefs.openSections, id]
    setPref('prefs-open-sections', next)
  }, [prefs.openSections])

  const sinkShapes = csvToSet(prefs.voiceSinkShapeTypes)
  const runningBots = agents.filter(isRunningBot)
  const selectedVoiceBackend = voiceBackends.some(b => b.value === prefs.voiceBackend) ? prefs.voiceBackend : ''

  const setBotEnabled = useCallback((botId: string, enabled: boolean) => {
    setPref('bot-self-check-enabled', { ...(getPref('bot-self-check-enabled') as Record<string, boolean>), [botId]: enabled })
  }, [])

  const setBotCountdown = useCallback((botId: string, seconds: number) => {
    setPref('bot-self-check-countdown-sec', { ...(getPref('bot-self-check-countdown-sec') as Record<string, number>), [botId]: seconds })
  }, [])

  const setBotModel = useCallback((botId: string, model: string) => {
    const current = getPref('bot-model') as Record<string, string>
    const next = { ...current }
    if (model) next[botId] = model
    else delete next[botId]
    setPref('bot-model', next)
  }, [])

  return (
    <div className="prefs-tab">
      <CollapsiblePrefsSection
        id="account"
        title="Account"
        summary="User and devices"
        open={prefs.openSections.includes('account')}
        onToggle={toggleSection}
      >
        <IdentitySectionBody knownDevices={prefs.knownDevices} deviceNames={prefs.deviceNames} />
      </CollapsiblePrefsSection>

      <CollapsiblePrefsSection
        id="appearance"
        title="Appearance"
        summary={`${prefs.fontSize}px / ${Math.round(prefs.heightFrac * 100)}% layout / ${prefs.provenanceMode}`}
        open={prefs.openSections.includes('appearance')}
        onToggle={toggleSection}
      >
        <PrefSubsection title="Theme">
          <SchemeToggle />
          <ThemeFamilyToggle />
        </PrefSubsection>

        <PrefSubsection title="Readability">
          <div className="prefs-num-row">
            <span className="prefs-num-label">Font size</span>
            <input type="number" min={8} max={24} step={1} value={prefs.fontSize} onChange={e => setPref('fleet-font-size', Number(e.target.value))} className="prefs-num" />
            <span className="prefs-num-unit">px</span>
          </div>
          <div className="prefs-num-row">
            <span className="prefs-num-label">Chrome opacity</span>
            <input type="number" min={0} max={150} step={5} value={Math.round(prefs.chromeOpacity * 100)} onChange={e => setPref('fleet-chrome-opacity', Number(e.target.value) / 100)} className="prefs-num" />
            <span className="prefs-num-unit">%</span>
          </div>
          <div className="prefs-num-row">
            <span className="prefs-num-label">Content opacity</span>
            <input type="number" min={0} max={100} step={5} value={Math.round(prefs.contentOpacity * 100)} onChange={e => setPref('fleet-content-opacity', Number(e.target.value) / 100)} className="prefs-num" />
            <span className="prefs-num-unit">%</span>
          </div>
          <label className="prefs-check">
            <input type="checkbox" checked={prefs.ageFade} onChange={e => setPref('fleet-age-fade', e.target.checked)} />
            <span>Age fade</span>
          </label>
        </PrefSubsection>

        <PrefSubsection title="Default layout size">
          <div style={{ fontSize: 10, color: '#6b7280', marginBottom: 4 }}>
            Applied when you pick a layout preset. Re-pick a layout to apply changes.
          </div>
          <div className="prefs-num-row">
            <span className="prefs-num-label">Height</span>
            <input type="number" min={10} max={100} step={5} value={Math.round(prefs.heightFrac * 100)} onChange={e => setPref('layout-height-frac', Number(e.target.value) / 100)} className="prefs-num" />
            <span className="prefs-num-unit">% of view</span>
          </div>
          <div className="prefs-num-row">
            <span className="prefs-num-label">Rail width</span>
            <input type="number" min={200} max={800} step={5} value={prefs.railWidth} onChange={e => setPref('layout-rail-width', Number(e.target.value))} className="prefs-num" />
            <span className="prefs-num-unit">px</span>
          </div>
          <div className="prefs-num-row">
            <span className="prefs-num-label">Chat width</span>
            <input type="number" min={200} max={1000} step={5} value={prefs.chatWidth} onChange={e => setPref('layout-chat-width', Number(e.target.value))} className="prefs-num" />
            <span className="prefs-num-unit">px</span>
          </div>
          <div className="prefs-num-row">
            <span className="prefs-num-label">Margin gap</span>
            <input type="number" min={0} max={300} step={5} value={prefs.marginGap} onChange={e => setPref('layout-margin-gap', Number(e.target.value))} className="prefs-num" />
            <span className="prefs-num-unit">px</span>
          </div>
        </PrefSubsection>

        <PrefSubsection title="Full tool output">
          <div style={{ fontSize: 10, color: '#6b7280', marginBottom: 4 }}>
            Collapse long tool output past N lines. Use 0 to show full output.
          </div>
          {([
            ['Bash', 'fold-bash-lines', prefs.foldBash],
            ['File writes', 'fold-write-lines', prefs.foldWrite],
            ['Markdown writes', 'fold-md-lines', prefs.foldMd],
            ['Edit diffs', 'fold-diff-lines', prefs.foldDiff],
          ] as const).map(([label, key, val]) => (
            <div className="prefs-num-row" key={key}>
              <span className="prefs-num-label">{label}</span>
              <input type="number" min={0} step={1} value={val} onChange={e => setPref(key, Number(e.target.value))} className="prefs-num" />
              <span className="prefs-num-unit">{val === 0 ? 'full' : 'lines'}</span>
            </div>
          ))}
        </PrefSubsection>

        <PrefSubsection title="Doc viewer sources">
          <div className="prefs-source-checks">
            {ALL_SOURCES.map(src => (
              <label key={src} className="prefs-check">
                <input type="checkbox" checked={prefs.sources.includes(src)} onChange={() => toggleSource(src)} />
                <span>{SOURCE_LABELS[src]}</span>
              </label>
            ))}
          </div>
        </PrefSubsection>

        <PrefSubsection title="Note color">
          <div className="prefs-color-row">
            <span className="prefs-color-label">Voice notes</span>
            <select value={prefs.voiceColor} onChange={handleVoiceColor} className="prefs-select">
              {COLOR_OPTIONS.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <span className="prefs-color-swatch" style={{ background: NOTE_COLORS[prefs.voiceColor] }} />
          </div>
        </PrefSubsection>

        <PrefSubsection title="Ribbon provenance">
          <select className="prefs-select" value={prefs.provenanceMode} onChange={e => setPref('provenance-display-mode', e.target.value)}>
            <option value="off">Off</option>
            <option value="hover">Ribbon hover</option>
            <option value="panel">Side panel</option>
            <option value="inline">Inline pinned card</option>
          </select>
        </PrefSubsection>

        <PrefSubsection title="Slide advance">
          <label className="prefs-row">
            <span>Mode</span>
            <select
              value={prefs.slidesNavigationMode}
              onChange={e => {
                const mode = e.target.value === 'orthogonal-fragments' ? 'orthogonal-fragments' : 'inline-fragments'
                setPref('slides-navigation-mode', mode)
              }}
              className="prefs-select"
            >
              <option value="inline-fragments">Click through fragments</option>
              <option value="orthogonal-fragments">Slides left/right, fragments vertical</option>
            </select>
          </label>
        </PrefSubsection>
      </CollapsiblePrefsSection>

      <CollapsiblePrefsSection
        id="voice"
        title="Voice"
        summary={voiceBackends.find(b => b.value === selectedVoiceBackend)?.label || 'Off'}
        open={prefs.openSections.includes('voice')}
        onToggle={toggleSection}
      >
        <PrefSubsection title="Backend">
          <select value={selectedVoiceBackend} onChange={e => { setPref('voice-backend', e.target.value); setVoiceBackend(e.target.value) }} className="prefs-select">
            {voiceBackends.map(backend => (
              <option key={backend.value || 'off'} value={backend.value}>{backend.label}</option>
            ))}
          </select>
        </PrefSubsection>

        <PrefSubsection title="Submit phrases">
          <div className="prefs-num-row">
            <span className="prefs-color-label">Submit</span>
            <input className="prefs-num" style={{ width: 170, textAlign: 'left' }} value={prefs.voiceSubmitWords} onChange={e => setPref('voice-submit-words', e.target.value)} placeholder="send, send it" />
          </div>
        </PrefSubsection>

        <PrefSubsection title="Voice ignored in">
          <div className="prefs-source-checks">
            {FLEET_SHAPE_OPTIONS.map(([value, label]) => (
              <label key={value} className="prefs-check">
                <input type="checkbox" checked={sinkShapes.has(value)} onChange={() => toggleVoiceSink(value)} />
                <span>{label}</span>
              </label>
            ))}
          </div>
        </PrefSubsection>

        {selectedVoiceBackend === 'deepgram-sdk' && (
          <PrefSubsection title="Deepgram tuning">
            <div style={{ fontSize: 10, color: '#6b7280', marginBottom: 4 }}>
              Applies on the next voice session.
            </div>
            {([
              ['Idle cutoff', 'voice-idle-cutoff-ms', prefs.voiceIdleCutoffMs, 'ms'],
              ['Pre-roll', 'voice-preroll-ms', prefs.voicePrerollMs, 'ms'],
              ['Resume RMS', 'voice-resume-rms', prefs.voiceResumeRms, ''],
              ['Endpointing', 'voice-endpointing', prefs.voiceEndpointing, 'ms'],
              ['Utterance end', 'voice-utterance-end-ms', prefs.voiceUtteranceEndMs, 'ms'],
            ] as const).map(([label, key, val, unit]) => (
              <div className="prefs-num-row" key={key}>
                <span className="prefs-num-label">{label}</span>
                <input type="number" min={0} step={1} value={val} onChange={e => setPref(key, Number(e.target.value))} className="prefs-num" />
                <span className="prefs-num-unit">{unit}</span>
              </div>
            ))}
          </PrefSubsection>
        )}
      </CollapsiblePrefsSection>

      <CollapsiblePrefsSection
        id="input"
        title="Input"
        summary={`${prefs.hlZone ? 'Edge zone on' : 'Edge zone off'} / ${prefs.cornerRail ? `voice slider ${prefs.cornerSize || 'auto'}` : 'classic'}`}
        open={prefs.openSections.includes('input')}
        onToggle={toggleSection}
      >
        <PrefSubsection title="Highlighter">
          <label className="prefs-check">
            <input type="checkbox" checked={prefs.hlZone} onChange={e => setPref('hl-zone-enabled', e.target.checked)} />
            <span>Edge zone</span>
          </label>
        </PrefSubsection>

        <PrefSubsection title="Corner controls">
          <label className="prefs-check">
            <input
              type="checkbox"
              checked={prefs.cornerRail}
              onChange={e => setPref('corner-rail-enabled', e.target.checked)}
            />
            <span>Voice slider</span>
          </label>
          <div className="prefs-num-row">
            <span className="prefs-num-label">Corner size</span>
            <input
              type="number"
              min={0}
              max={88}
              step={4}
              value={prefs.cornerSize}
              onChange={e => setPref('corner-control-size', Number(e.target.value))}
              className="prefs-num"
            />
            <span className="prefs-num-unit">{prefs.cornerSize ? 'px' : 'auto'}</span>
          </div>
        </PrefSubsection>

        <PrefSubsection title="Edge-zone response curve">
          <div style={{ fontSize: 10, color: '#6b7280', marginBottom: 4 }}>
            Drag handles to shape scroll/pan velocity near viewport edges.
          </div>
          <CurveEditor value={prefs.curve} onChange={h => setPref('response-curve', h)} />
        </PrefSubsection>

        <PrefSubsection title="Editor input">
          <VimModeToggle />
        </PrefSubsection>
      </CollapsiblePrefsSection>

      <CollapsiblePrefsSection
        id="bots"
        title="Bots"
        summary={runningBots.length ? `${runningBots.length} running` : 'No running bots'}
        open={prefs.openSections.includes('bots')}
        onToggle={toggleSection}
      >
        {runningBots.length === 0 && <div style={{ fontSize: 10, color: '#6b7280' }}>No running bots.</div>}
        {runningBots.map(bot => {
          const botId = bot.id as string
          const enabled = prefs.botSelfCheckEnabled[botId] ?? prefs.selfCheckEnabled
          const countdown = prefs.botSelfCheckCountdown[botId] ?? prefs.selfCheckCountdown
          const model = availableModels.includes(prefs.botModel[botId]) ? prefs.botModel[botId] : ''
          return (
            <PrefSubsection key={botId} title={agentDisplayName(bot, agents)}>
              <label className="prefs-check">
                <input type="checkbox" checked={enabled} onChange={e => setBotEnabled(botId, e.target.checked)} />
                <span>Turn-end self-check poke</span>
              </label>
              <div className="prefs-num-row">
                <span className="prefs-num-label">Countdown</span>
                <input type="number" min={5} max={300} step={5} value={countdown} onChange={e => setBotCountdown(botId, Number(e.target.value))} className="prefs-num" />
                <span className="prefs-num-unit">sec</span>
              </div>
              <div className="prefs-num-row">
                <span className="prefs-num-label">Model</span>
                <select value={model} onChange={e => setBotModel(botId, e.target.value)} className="prefs-select">
                  <option value="">Default</option>
                  {availableModels.map(alias => <option key={alias} value={alias}>{alias}</option>)}
                </select>
              </div>
            </PrefSubsection>
          )
        })}
      </CollapsiblePrefsSection>
    </div>
  )
}
