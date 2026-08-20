/**
 * User preferences — configurable defaults for things that have no other UI.
 *
 * NOT for settings that already have direct-manipulation controls
 * (zone width slider, warm mode button, layout toggles, etc.)
 *
 * Backed by server-side fleet_prefs table (per fleet user ID).
 * Local cache makes getPref() synchronous; loadPrefs() populates it async.
 */

import type { CurveHandles } from './curveEditor.ts'
import { DEFAULT_CURVE } from './curveEditor.ts'
import { DEFAULT_READABILITY_PROFILES, migrateReadabilityProfiles, type ReadabilityProfiles } from './readabilityDefaults.ts'
import { fleetDurable, fleetEphemeral } from './fleet/fleet-data.mjs'

export const DEFAULT_RADIO_SUBTITLE_DWELL_SEC = 15
export const MIN_RADIO_SUBTITLE_DWELL_SEC = 3
export const MAX_RADIO_SUBTITLE_DWELL_SEC = 120

export function normalizeRadioSubtitleDwellSec(value: unknown): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return DEFAULT_RADIO_SUBTITLE_DWELL_SEC
  return Math.min(MAX_RADIO_SUBTITLE_DWELL_SEC, Math.max(MIN_RADIO_SUBTITLE_DWELL_SEC, parsed))
}

const DEFAULTS = {
  'voice-note-color': 'yellow' as string,
  'response-curve': DEFAULT_CURVE as CurveHandles,
  'known-devices': {} as Record<string, { lastSeen: string }>,
  'device-names': {} as Record<string, string>,
  // Where you were reading in each document, as a distance in page units from
  // the document's top edge. Per person, because a reading position is one
  // reader's place and not a property of the document. Here rather than in its
  // own table because opening a document must not wait on a round trip: prefs
  // are already in memory by then, and a camera that arrives and then corrects
  // itself is two jumps. See src/readingPosition.ts.
  'reading-positions': {} as Record<string, number>,
  // Default OFF (Skip, 2026-06-21): voice is opt-in, so a fresh/anonymous client
  // (incl. automated/Playwright tabs) never opens the paid Deepgram path on
  // defaults — that default was the source of the Deepgram cost. The user selects
  // a backend in Preferences; until then voice is silent. There is NO fallback:
  // a selected backend that's unreachable goes quiet, it never switches.
  'voice-backend': '' as string,
  'voice-hud-meter': 'background' as string,
  'voice-submit-words': 'send, send it, sent' as string,
  'voice-pcm-backlog-mb': 64 as number,
  'radio-subtitles-enabled': true as boolean,
  'radio-subtitle-dwell-sec': DEFAULT_RADIO_SUBTITLE_DWELL_SEC as number,
  // Voice→Deepgram conservation feel (sent to the bridge on connect). Idle cutoff
  // = ms of no speech before the upstream session is torn down (stays warm across
  // a thinking pause, closes an abandoned one). Pre-roll = ms of audio buffered
  // while paused so resume never clips the first words. Resume RMS = energy a
  // frame must exceed to count as speech (vs a silent-but-live mic) and reconnect.
  'voice-idle-cutoff-ms': 30000 as number,
  'voice-preroll-ms': 300 as number,
  'voice-resume-rms': 250 as number,
  // Deepgram recognition window (applied via the bridge's voiceParams hook).
  // endpointing = ms of silence before Deepgram finalizes an utterance;
  // utterance_end_ms = ms before it emits UtteranceEnd. Raise both if Deepgram
  // keeps cutting off the tail of a sentence.
  'voice-endpointing': 300 as number,
  'voice-utterance-end-ms': 1000 as number,
  // Enter waits for the dictated tail to finalize before it sends, so the message
  // carries Deepgram's revision rather than the provisional interim that was on
  // screen. These two bound that wait; neither is a pacing knob.
  // carry-backstop = the bridge's own forward-release of a carried epoch.
  // finalize-wait = how long Enter holds before sending what he has anyway. It sits
  // above the bridge's backstop on purpose, so the bridge releases first and this is
  // a last resort. Enter ALWAYS sends when it elapses — it never swallows a send.
  'voice-carry-backstop-ms': 800 as number,
  'voice-finalize-wait-ms': 1500 as number,
  'readability-profiles': DEFAULT_READABILITY_PROFILES as ReadabilityProfiles,
  'fleet-font-size': 11 as number,
  // Default fleet layout sizing (used by createFleetLayout). margin-gap is the
  // distance from each document edge to the near edge of the fleet shapes in
  // that margin; everything else stacks outward from there. Height is a fraction
  // of the raw viewport; the rest are px (HUD renders at z=1, so page == screen
  // px). These only shape how layouts are CREATED — never HUD position (anchor).
  'layout-height-frac': 0.7 as number,
  'layout-rail-width': 375 as number,
  'layout-chat-width': 460 as number,
  'layout-margin-gap': 40 as number,
  'fleet-chrome-opacity': 1.0 as number,
  'fleet-content-opacity': 1.0 as number,
  // Per-tool fold heights for monitoring/tool-call content (lines). 0 = never fold.
  // Communication (messages, images) is never folded and has no pref here.
  'fold-bash-lines': 10 as number,
  'fold-write-lines': 10 as number,
  'fold-md-lines': 0 as number,
  'fold-diff-lines': 0 as number,
  'fold-thread-lines': 16 as number,
  // The thread card's range view, in messages. Skip: "it can't be five
  // messages, it's gotta be like three, two", and on the unit: "not the message
  // scale, like, the thing scale" -- a row, whether it's a message or an
  // activity entry. Not lines: the card shows a range, and a line count would
  // cut a message in half to hit it.
  'thread-front-messages': 3 as number,
  'thread-tail-messages': 2 as number,
  'semantic-operation-page-size': 40 as number,
  // Stingy mode fetches only displayed document pages. Default off: normal
  // reading prefetches pages so they are already browser-local; stingy exists
  // so the Fly server does not render pages nobody opens.
  'document-stingy-mode': false as boolean,
  // Highlighter edge-zone (the HighlighterSlider). Toggled from the prefs menu.
  'hl-zone-enabled': true as boolean,
  // Document panel hover trigger width. This is the same value the old ToC
  // bottom thumb adjusted. Skip, 2026-08-18: "make th eTOC hover region as wide
  // as possile" / "shit as visible as possible" — so the default is the widest
  // the zone goes, which is the panel itself (ZONE_WIDTH_MAX in TocTab.tsx).
  // This is THE default: getPref falls back to it, so a constant raised in
  // TocTab alone would never have reached anyone.
  'toc-hover-zone-width': 250 as number,
  // Provenance/cascade surfacing mode. off = no surfacing (also hides the ribbon
  // hover tooltip). hover = ephemeral tooltip; panel = docked side panel; inline =
  // click-to-pin card. Default hover preserves today's behavior; off/panel/inline opt in.
  'provenance-display-mode': 'hover' as string,
  // Todd's optional automatic turn-end introspection poke. Read live over
  // /api/fleet/prefs. Default off: the routine automatic watchdog is task-kick
  // for genuinely idle active tasks; this poke is available manually unless
  // explicitly enabled here.
  'todd-self-check-auto-enabled': false as boolean,
  'todd-self-check-countdown-sec': 30 as number,
  'bot-self-check-enabled': {} as Record<string, boolean>,
  'bot-self-check-countdown-sec': {} as Record<string, number>,
  // Source editor writes are checkpoints, not a stream — see AGENTS.md
  // "Project as world". A write commits when you click out or leave insert
  // mode; this is the third boundary, for when you stop without doing either.
  // Seconds of no typing before the editor commits on its own.
  'source-write-idle-sec': 4 as number,
  // Preferences panel disclosure state. Kept server-backed so touch-only
  // devices don't need localStorage access to recover usable panel space.
  'prefs-open-sections': ['account', 'appearance', 'voice', 'radio'] as string[],
}

export type PrefKey = keyof typeof DEFAULTS

const _cache: Partial<typeof DEFAULTS> = {}
const _listeners = new Set<() => void>()
let _userId: string | null = null
let _loadError: string | null = null

let _loadedResolve: (() => void) | null = null
const _loaded = new Promise<void>(r => { _loadedResolve = r })

/** Resolves after the first loadPrefs() completes (or fails). Callers that
 * read prefs at startup should await this to avoid racing against the
 * async fetch — otherwise getPref() returns DEFAULTS even when the user
 * has a saved value. */
export function whenPrefsLoaded(): Promise<void> { return _loaded }

export function parseCsvPref(value: unknown): string[] {
  return String(value || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
}

function _notify() { _listeners.forEach(cb => cb()) }

export function subscribePref(cb: () => void): () => void {
  _listeners.add(cb)
  return () => _listeners.delete(cb)
}

export function getPrefsLoadError(): string | null { return _loadError }

export function getPref<K extends PrefKey>(key: K): (typeof DEFAULTS)[K] {
  return (key in _cache ? _cache[key] : DEFAULTS[key]) as (typeof DEFAULTS)[K]
}

export function setPref<K extends PrefKey>(key: K, value: (typeof DEFAULTS)[K]) {
  _cache[key] = value
  _notify()
  if (_userId) {
    fleetDurable('prefs-set', { user: _userId, key, value })
      .catch((e: Error) => console.warn('[prefs] save failed:', e.message))
  }
}

export function getAllPrefs(): typeof DEFAULTS {
  return { ...DEFAULTS, ..._cache }
}

/** Fetch all prefs for a user and populate the local cache. Call after login. */
export async function loadPrefs(userId: string): Promise<void> {
  _userId = userId
  let loaded = false
  try {
    const data = await fleetEphemeral('prefs-get-all', { user: userId })
    const readability = migrateReadabilityProfiles(data['readability-profiles'])
    Object.assign(_cache, { ...data, 'readability-profiles': readability.profiles })
    if (readability.migrated) {
      fleetDurable('prefs-set', { user: userId, key: 'readability-profiles', value: readability.profiles })
        .catch((e: Error) => console.warn('[prefs] readability migration save failed:', e.message))
    }
    _loadError = null
    _notify()
    loaded = true
  } catch (e) {
    _loadError = e instanceof Error ? e.message : String(e)
    _notify()
    console.warn('[prefs] load failed; using defaults until preferences reconnect:', e)
  }
  finally {
    if ((loaded || _loadError) && _loadedResolve) { _loadedResolve(); _loadedResolve = null }
  }
}

export { DEFAULTS }
