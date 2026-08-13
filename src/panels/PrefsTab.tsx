import { useState, useCallback, useEffect, useRef, type ReactNode } from 'react'
import {
  MAX_RADIO_SUBTITLE_DWELL_SEC,
  MIN_RADIO_SUBTITLE_DWELL_SEC,
  getPref,
  getPrefsLoadError,
  normalizeRadioSubtitleDwellSec,
  setPref,
  subscribePref,
} from '../preferences'
import { setBackend as setVoiceBackend } from '../voice.mjs'
import { NOTE_COLORS } from '../shapes/MathNoteShape'
import { CurveEditor } from '../components/CurveEditor'
import {
  SchemeToggle,
  ThemeFamilyToggle,
  VimModeToggle,
  ZoneWidthThumbControl,
} from './TocTab'
import { useFleetAgents, useFleetIdentity } from '../fleet-data-adapter'
// @ts-ignore — vanilla JS module
import { getDeviceId } from '../fleet/fleet-data.mjs'
import { agentDisplayLabel } from '../shapes/fleet-utils'
// @ts-ignore - vanilla JS module
import { runtimeStatusName } from '../../shared/fleet-runtime-status.mjs'
import { useAvailableSpawnModels } from '../fleet/useAvailableSpawnModels'
import {
  DEFAULT_READABILITY_PROFILE,
  getCurrentReadabilityDeviceId,
  getReadabilityProfiles,
  type ReadabilityProfile,
} from '../readabilityProfile'

type DeviceRecord = { lastSeen: string }

const ALL_SOURCES = ['ref', 'proof', 'errors'] as const
const SOURCE_LABELS: Record<(typeof ALL_SOURCES)[number], string> = {
  ref: 'References',
  proof: 'Proofs',
  errors: 'Errors',
}

const COLOR_OPTIONS = Object.keys(NOTE_COLORS)

// Sections are named after what a person is trying to change, not after the
// store the value happens to live in. The per-device `readability-profiles`
// blob was the old organising principle, which is how snap strength and fleet
// layout geometry ended up filed under "Readability" — Skip: "that's a fucking
// awful organization". Its fields are now spread across Appearance, Input and
// Panels, and the one device picker at the top of the panel scopes all of them.
type PrefsSectionId = 'account' | 'appearance' | 'reading' | 'input' | 'panels' | 'voice' | 'radio' | 'bots'
const PREFS_SEARCH_TEXT: Record<PrefsSectionId, string> = {
  account: 'account user identity devices switch device name',
  appearance: 'appearance theme colour color scheme dark light system one fog lilac warm power mono blue text font size line height faint opacity chrome content',
  reading: 'reading document toc hover region table of contents stingy doc viewer sources references proofs errors ribbon provenance slide advance fragments note color voice notes',
  input: 'input touch target pointer thumb highlighter edge zone corner controls voice slider response curve editor vim',
  panels: 'panels fleet layout height rail chat margin aspect snap strength nudge tool output fold bash write markdown diff thread card messages',
  voice: 'voice backend meter submit phrases ignored deepgram idle cutoff preroll endpointing',
  radio: 'radio agent subtitles card dwell',
  bots: 'bots self check countdown model',
}
type VoiceBackendOption = { value: string; label: string; available: boolean }
type SpeechRecognitionWindow = Window & {
  SpeechRecognition?: unknown
  webkitSpeechRecognition?: unknown
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
  const status = runtimeStatusName(agent)
  return !agent?.dead && labelsFor(agent).includes('bot') && status !== 'dead' && status !== 'hibernating'
}

// The backend list is only known once the server has answered. Until then, and
// when the request fails, the honest state is "not known yet" — NOT a short
// hardcoded list. A guessed list is indistinguishable from the real answer, so
// a backend that exists reads as a backend that does not exist: nothing to
// click and nothing to read. That is the shape of the bug Skip hit with
// Deepgram. `status` is what lets uncertainty say so instead of disappearing.
function useVoiceBackends(): { backends: VoiceBackendOption[]; status: 'loading' | 'ready' | 'error' } {
  const [backends, setBackends] = useState<VoiceBackendOption[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')

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
        setStatus('ready')
      })
      .catch(() => {
        if (cancelled) return
        setBackends([])
        setStatus('error')
      })
    return () => { cancelled = true }
  }, [])

  return { backends, status }
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
    voiceHudMeter: getPref('voice-hud-meter'),
    voiceSubmitWords: getPref('voice-submit-words'),
    voicePcmBacklogMb: getPref('voice-pcm-backlog-mb'),
    radioSubtitlesEnabled: getPref('radio-subtitles-enabled'),
    radioSubtitleDwellSec: normalizeRadioSubtitleDwellSec(getPref('radio-subtitle-dwell-sec')),
    voiceIdleCutoffMs: getPref('voice-idle-cutoff-ms'),
    voicePrerollMs: getPref('voice-preroll-ms'),
    voiceResumeRms: getPref('voice-resume-rms'),
    voiceEndpointing: getPref('voice-endpointing'),
    voiceUtteranceEndMs: getPref('voice-utterance-end-ms'),
    readabilityDeviceId: getCurrentReadabilityDeviceId(),
    readabilityProfiles: getReadabilityProfiles(),
    fontSize: getPref('fleet-font-size'),
    heightFrac: getPref('layout-height-frac'),
    railWidth: getPref('layout-rail-width'),
    chatWidth: getPref('layout-chat-width'),
    marginGap: getPref('layout-margin-gap'),
    chromeOpacity: getPref('fleet-chrome-opacity'),
    contentOpacity: getPref('fleet-content-opacity'),
    foldBash: getPref('fold-bash-lines'),
    foldThread: getPref('fold-thread-lines'),
    threadFront: getPref('thread-front-messages'),
    threadTail: getPref('thread-tail-messages'),
    foldWrite: getPref('fold-write-lines'),
    foldMd: getPref('fold-md-lines'),
    foldDiff: getPref('fold-diff-lines'),
    semanticOperationPageSize: getPref('semantic-operation-page-size'),
    documentStingyMode: getPref('document-stingy-mode'),
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
    loadError: getPrefsLoadError(),
  }
}

export function PrefsTab({ query = '' }: { query?: string }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const { id: userId } = useFleetIdentity()
  const [prefs, setPrefs] = useState(readAll)
  const agents = useFleetAgents()
  const { backends: voiceBackends, status: voiceBackendsStatus } = useVoiceBackends()
  const availableModels = useAvailableSpawnModels(userId).aliases

  useEffect(() => subscribePref(() => setPrefs(readAll())), [])

  useEffect(() => {
    const root = scrollRef.current
    if (!root) return

    // The canvas takes wheel input before Settings ever sees it, so the panel
    // would not scroll on a touchpad and the Radio control sat below the fold —
    // Skip could not turn off a popup he had asked about four times in nine
    // hours. Capture phase and preventDefault are what keep the gesture here.
    //
    // `.prefs-tab` is the only scroller. It is a `.doc-panel-content`, which
    // carries `overflow-y: auto` (DocumentPanel.css:732), and no `prefs-*`
    // selector anywhere declares overflow, max-height or height — so no
    // subsection can be a scroll container and there is no inner scroller to
    // offer the gesture to first.
    //
    // deltaMode is deliberately not converted. Chrome on a Mac trackpad reports
    // pixels, which is the surface this is for; a mouse wheel reporting
    // DOM_DELTA_LINE would scroll a few pixels per notch instead of a few lines.
    // Written down rather than handled, because nobody has reported it and a
    // speculative unit conversion is a second thing to get wrong.
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      event.stopPropagation()
      root.scrollTop += event.deltaY
    }

    root.addEventListener('wheel', onWheel, { capture: true, passive: false })
    return () => root.removeEventListener('wheel', onWheel, true)
  }, [])

  const toggleSource = useCallback((src: string) => {
    const next = prefs.sources.includes(src)
      ? prefs.sources.filter(s => s !== src)
      : [...prefs.sources, src]
    setPref('docview-sources', next)
  }, [prefs.sources])

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

  const runningBots = agents.filter(isRunningBot)
  // Only demote the stored backend to Off once a real list says it is not
  // there. While the list is unknown, showing "Off" would report a setting he
  // did not make, and one touch of the select would then write that lie back.
  const selectedVoiceBackend = voiceBackendsStatus !== 'ready' || voiceBackends.some(b => b.value === prefs.voiceBackend)
    ? prefs.voiceBackend
    : ''
  // Off and Browser need no server, so they are never gated on one. Skip:
  // "browser + off should always be available… checking is like a state of a
  // disabled option, not the whole feature — err, transiently disabled."
  // A slow server used to put the whole picker into "checking…", which reads as
  // voice being unavailable when two of its three backends were sitting right
  // there working.
  const LOCAL_VOICE_BACKENDS = [
    { value: '', label: 'Off' },
    { value: 'chrome', label: 'Browser' },
  ]
  const serverVoiceBackends = voiceBackendsStatus === 'ready'
    ? voiceBackends.filter(b => !LOCAL_VOICE_BACKENDS.some(l => l.value === b.value))
    : []
  // Only the server-dependent backends carry the not-yet-known state, and they
  // carry it as a disabled option rather than as the picker's whole identity.
  const pendingVoiceBackendLabel = voiceBackendsStatus === 'loading'
    ? 'Deepgram — checking…'
    : 'Deepgram — server unreachable'
  const currentDeviceId = getCurrentReadabilityDeviceId()
  const knownReadabilityDevices = Object.entries(prefs.knownDevices as Record<string, DeviceRecord>)
    .sort((a, b) => new Date(b[1]?.lastSeen || 0).getTime() - new Date(a[1]?.lastSeen || 0).getTime())
    .map(([id]) => id)
  const readabilityDeviceIds = Array.from(new Set([currentDeviceId, ...knownReadabilityDevices].filter(Boolean)))
  const activeReadability = {
    ...DEFAULT_READABILITY_PROFILE,
    ...(prefs.readabilityProfiles[prefs.readabilityDeviceId] ?? {}),
  } as ReadabilityProfile
  const normalizedQuery = query.trim().toLowerCase()
  const sectionVisible = (id: PrefsSectionId) =>
    !normalizedQuery || PREFS_SEARCH_TEXT[id].includes(normalizedQuery)
  // The device picker scopes the readability profile, whose fields now live in
  // three sections. It is a scope selector rather than a setting, so it sits
  // above the sections — and only when one of the sections it scopes is showing.
  const perDeviceVisible = sectionVisible('appearance') || sectionVisible('input') || sectionVisible('panels')

  const setReadabilityDevice = useCallback((deviceId: string) => {
    setPrefs(prev => ({ ...prev, readabilityDeviceId: deviceId }))
  }, [])

  const setReadability = useCallback(<K extends keyof ReadabilityProfile>(key: K, value: ReadabilityProfile[K]) => {
    const profiles = getReadabilityProfiles()
    const deviceId = prefs.readabilityDeviceId || getCurrentReadabilityDeviceId()
    setPref('readability-profiles', {
      ...profiles,
      [deviceId]: {
        ...profiles[deviceId],
        [key]: value,
      },
    })
  }, [prefs.readabilityDeviceId])

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
    <div ref={scrollRef} className="doc-panel-content prefs-tab">
      {prefs.loadError && (
        <div className="prefs-load-error">
          Preferences could not load; defaults are in use until preferences reconnect: {prefs.loadError}
        </div>
      )}
      {sectionVisible('account') && <CollapsiblePrefsSection
        id="account"
        title="Account"
        summary="User and devices"
        open={prefs.openSections.includes('account')}
        onToggle={toggleSection}
      >
        <IdentitySectionBody knownDevices={prefs.knownDevices} deviceNames={prefs.deviceNames} />
      </CollapsiblePrefsSection>}

      {perDeviceVisible && (
        <PrefSubsection title="Settings for">
          <div className="prefs-segment-row">
            {readabilityDeviceIds.map(deviceId => (
              <button
                key={deviceId}
                type="button"
                className={`prefs-segment${prefs.readabilityDeviceId === deviceId ? ' active' : ''}`}
                onClick={() => setReadabilityDevice(deviceId)}
              >
                {prefs.deviceNames[deviceId] || (deviceId === currentDeviceId ? 'this device' : deviceId)}
              </button>
            ))}
          </div>
          <div style={{ fontSize: 10, color: '#6b7280', marginTop: 2 }}>
            Text, touch and panel-layout settings below are stored per device.
          </div>
        </PrefSubsection>
      )}

      {sectionVisible('appearance') && <CollapsiblePrefsSection
        id="appearance"
        title="Appearance"
        summary={`${activeReadability.fontSize}px text`}
        open={prefs.openSections.includes('appearance')}
        onToggle={toggleSection}
      >
        <PrefSubsection title="Theme">
          <SchemeToggle />
          <ThemeFamilyToggle />
        </PrefSubsection>

        <PrefSubsection title="Text">
          <div className="prefs-num-row">
            <span className="prefs-num-label">Font size</span>
            <input type="number" min={8} max={24} step={1} value={activeReadability.fontSize} onChange={e => setReadability('fontSize', Number(e.target.value))} className="prefs-num" />
            <span className="prefs-num-unit">px</span>
          </div>
          <div className="prefs-num-row">
            <span className="prefs-num-label">Line height</span>
            <input type="number" min={1.15} max={1.8} step={0.05} value={activeReadability.lineHeight} onChange={e => setReadability('lineHeight', Number(e.target.value))} className="prefs-num" />
            <span className="prefs-num-unit">x</span>
          </div>
        </PrefSubsection>

        <PrefSubsection title="Panel tone">
          <label className="prefs-toggle-row">
            <input type="checkbox" checked={activeReadability.faint} onChange={e => setReadability('faint', e.target.checked)} />
            <span>Faint</span>
          </label>
          <div className="prefs-num-row">
            <span className="prefs-num-label">Chrome opacity</span>
            <input type="number" min={0} max={150} step={5} value={Math.round(activeReadability.chromeOpacity * 100)} onChange={e => setReadability('chromeOpacity', Number(e.target.value) / 100)} className="prefs-num" />
            <span className="prefs-num-unit">%</span>
          </div>
          <div className="prefs-num-row">
            <span className="prefs-num-label">Content opacity</span>
            <input type="number" min={0} max={100} step={5} value={Math.round(activeReadability.contentOpacity * 100)} onChange={e => setReadability('contentOpacity', Number(e.target.value) / 100)} className="prefs-num" />
            <span className="prefs-num-unit">%</span>
          </div>
        </PrefSubsection>
      </CollapsiblePrefsSection>}

      {sectionVisible('reading') && <CollapsiblePrefsSection
        id="reading"
        title="Reading"
        summary="Document panel, sources, slides"
        open={prefs.openSections.includes('reading')}
        onToggle={toggleSection}
      >
        <PrefSubsection title="Document panel">
          <div className="prefs-num-row">
            <span className="prefs-num-label">ToC hover region</span>
            <ZoneWidthThumbControl className="prefs-zone-width-slider" />
          </div>
        </PrefSubsection>

        <PrefSubsection title="Doc viewer sources">
          <label className="prefs-check">
            <input type="checkbox" checked={prefs.documentStingyMode} onChange={e => setPref('document-stingy-mode', e.target.checked)} />
            <span>Stingy mode</span>
          </label>
          <div className="prefs-source-checks">
            {ALL_SOURCES.map(src => (
              <label key={src} className="prefs-check">
                <input type="checkbox" checked={prefs.sources.includes(src)} onChange={() => toggleSource(src)} />
                <span>{SOURCE_LABELS[src]}</span>
              </label>
            ))}
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

        <PrefSubsection title="Note color">
          <div className="prefs-color-row">
            <span className="prefs-color-label">Voice notes</span>
            <select value={prefs.voiceColor} onChange={handleVoiceColor} className="prefs-select">
              {COLOR_OPTIONS.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <span className="prefs-color-swatch" style={{ background: NOTE_COLORS[prefs.voiceColor] }} />
          </div>
        </PrefSubsection>
      </CollapsiblePrefsSection>}

      {sectionVisible('voice') && <CollapsiblePrefsSection
        id="voice"
        title="Voice"
        summary={(voiceBackendsStatus === 'ready' ? voiceBackends : LOCAL_VOICE_BACKENDS)
          .find(b => b.value === selectedVoiceBackend)?.label || 'Off'}
        open={prefs.openSections.includes('voice')}
        onToggle={toggleSection}
      >
        <PrefSubsection title="Backend">
          <select value={selectedVoiceBackend} onChange={e => { setPref('voice-backend', e.target.value); setVoiceBackend(e.target.value) }} className="prefs-select">
            {/* Off and Browser are always here — they run in the page. The
                server-dependent ones appear once the list is known, and until
                then say which kind of not-knowing this is, disabled, without
                taking the working backends down with them. */}
            {LOCAL_VOICE_BACKENDS.map(backend => (
              <option key={backend.value || 'off'} value={backend.value}>{backend.label}</option>
            ))}
            {serverVoiceBackends.map(backend => (
              <option key={backend.value} value={backend.value}>{backend.label}</option>
            ))}
            {voiceBackendsStatus !== 'ready' && (
              <option value="__pending" disabled>{pendingVoiceBackendLabel}</option>
            )}
          </select>
        </PrefSubsection>

        <PrefSubsection title="Meter">
          <select
            value={prefs.voiceHudMeter}
            onChange={e => setPref('voice-hud-meter', e.target.value)}
            className="prefs-select"
          >
            <option value="background">Background</option>
            <option value="edge">Edge</option>
          </select>
        </PrefSubsection>

        <PrefSubsection title="Submit phrases">
          <div className="prefs-num-row">
            <span className="prefs-color-label">Submit</span>
            <input className="prefs-num" style={{ width: 170, textAlign: 'left' }} value={prefs.voiceSubmitWords} onChange={e => setPref('voice-submit-words', e.target.value)} placeholder="send, send it" />
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
              ['Offline buffer', 'voice-pcm-backlog-mb', prefs.voicePcmBacklogMb, 'MB'],
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
      </CollapsiblePrefsSection>}

      {sectionVisible('radio') && <CollapsiblePrefsSection
        id="radio"
        title="Radio"
        summary={prefs.radioSubtitlesEnabled ? 'Agent subtitles on' : 'Agent subtitles off'}
        open={prefs.openSections.includes('radio')}
        onToggle={toggleSection}
      >
        <PrefSubsection title="Radio">
          <label className="prefs-check">
            <input type="checkbox" checked={prefs.radioSubtitlesEnabled} onChange={e => setPref('radio-subtitles-enabled', e.target.checked)} />
            <span>Agent subtitles</span>
          </label>
          <div className="prefs-num-row">
            <label className="prefs-num-label" htmlFor="radio-subtitle-dwell">Card dwell</label>
            <input
              id="radio-subtitle-dwell"
              type="number"
              min={MIN_RADIO_SUBTITLE_DWELL_SEC}
              max={MAX_RADIO_SUBTITLE_DWELL_SEC}
              step={1}
              value={prefs.radioSubtitleDwellSec}
              onChange={e => setPref('radio-subtitle-dwell-sec', normalizeRadioSubtitleDwellSec(e.target.value))}
              className="prefs-num"
            />
            <span className="prefs-num-unit">sec</span>
          </div>
        </PrefSubsection>
      </CollapsiblePrefsSection>}

      {sectionVisible('input') && <CollapsiblePrefsSection
        id="input"
        title="Input"
        summary={`${activeReadability.touchTarget}px target / ${prefs.hlZone ? 'edge zone on' : 'edge zone off'}`}
        open={prefs.openSections.includes('input')}
        onToggle={toggleSection}
      >
        <PrefSubsection title="Touch">
          <div className="prefs-num-row">
            <span className="prefs-num-label">Touch target</span>
            <input type="number" min={24} max={64} step={2} value={activeReadability.touchTarget} onChange={e => setReadability('touchTarget', Number(e.target.value))} className="prefs-num" />
            <span className="prefs-num-unit">px</span>
          </div>
        </PrefSubsection>

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
      </CollapsiblePrefsSection>}

      {sectionVisible('panels') && <CollapsiblePrefsSection
        id="panels"
        title="Panels"
        summary={`${Math.round(activeReadability.layoutHeightFrac * 100)}% height`}
        open={prefs.openSections.includes('panels')}
        onToggle={toggleSection}
      >
        <PrefSubsection title="Layout">
          <div style={{ fontSize: 10, color: '#6b7280', marginBottom: 4 }}>
            Sizes a fleet layout when it is created. Panels already on the canvas keep their size.
          </div>
          <div className="prefs-num-row">
            <span className="prefs-num-label">Layout height</span>
            <input type="number" min={10} max={100} step={5} value={Math.round(activeReadability.layoutHeightFrac * 100)} onChange={e => setReadability('layoutHeightFrac', Number(e.target.value) / 100)} className="prefs-num" />
            <span className="prefs-num-unit">% of view</span>
          </div>
          <div className="prefs-num-row">
            <span className="prefs-num-label">Rail aspect</span>
            <input type="number" min={0.2} max={2} step={0.05} value={activeReadability.railAspect} onChange={e => setReadability('railAspect', Number(e.target.value))} className="prefs-num" />
            <span className="prefs-num-unit">w/h</span>
          </div>
          <div className="prefs-num-row">
            <span className="prefs-num-label">Chat aspect</span>
            <input type="number" min={0.2} max={2} step={0.05} value={activeReadability.chatAspect} onChange={e => setReadability('chatAspect', Number(e.target.value))} className="prefs-num" />
            <span className="prefs-num-unit">w/h</span>
          </div>
          <div className="prefs-num-row">
            <span className="prefs-num-label">Margin aspect</span>
            <input type="number" min={0} max={0.4} step={0.01} value={activeReadability.marginAspect} onChange={e => setReadability('marginAspect', Number(e.target.value))} className="prefs-num" />
            <span className="prefs-num-unit">gap/h</span>
          </div>
        </PrefSubsection>

        <PrefSubsection title="Snap">
          <div className="prefs-num-row">
            <span className="prefs-num-label">Snap strength</span>
            <input type="number" min={0} max={4} step={0.5} value={activeReadability.nudgeStrength} onChange={e => setReadability('nudgeStrength', Number(e.target.value))} className="prefs-num" />
            <span className="prefs-num-unit">em</span>
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
            ['Threads', 'fold-thread-lines', prefs.foldThread],
          ] as const).map(([label, key, val]) => (
            <div className="prefs-num-row" key={key}>
              <span className="prefs-num-label">{label}</span>
              <input type="number" min={0} step={1} value={val} onChange={e => setPref(key, Number(e.target.value))} className="prefs-num" />
              <span className="prefs-num-unit">{val === 0 ? 'full' : 'lines'}</span>
            </div>
          ))}
        </PrefSubsection>

        <PrefSubsection title="Thread and search cards">
          <div className="prefs-num-row">
            <span className="prefs-num-label">Thread/search cards</span>
            <input type="number" min={5} step={5} value={prefs.semanticOperationPageSize} onChange={e => setPref('semantic-operation-page-size', Number(e.target.value))} className="prefs-num" />
            <span className="prefs-num-unit">items</span>
          </div>
          <div className="prefs-num-row">
            <span className="prefs-num-label">Thread card top</span>
            <input type="number" min={0} step={1} value={prefs.threadFront} onChange={e => setPref('thread-front-messages', Number(e.target.value))} className="prefs-num" />
            <span className="prefs-num-unit">messages</span>
          </div>
          <div className="prefs-num-row">
            <span className="prefs-num-label">Thread card bottom</span>
            <input type="number" min={0} step={1} value={prefs.threadTail} onChange={e => setPref('thread-tail-messages', Number(e.target.value))} className="prefs-num" />
            <span className="prefs-num-unit">messages</span>
          </div>
        </PrefSubsection>
      </CollapsiblePrefsSection>}

      {sectionVisible('bots') && <CollapsiblePrefsSection
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
            <PrefSubsection key={botId} title={agentDisplayLabel(bot, agents)}>
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
      </CollapsiblePrefsSection>}
      {normalizedQuery && (Object.keys(PREFS_SEARCH_TEXT) as PrefsSectionId[]).every(id => !sectionVisible(id)) && (
        <div className="panel-empty">No settings found</div>
      )}
    </div>
  )
}
