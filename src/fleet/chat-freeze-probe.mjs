// chat-freeze-probe — always-on, transition-only telemetry for the one failure
// this exists to catch: "the chat panel stopped showing new messages."
//
// WHY log.metric AND NOT log.debug. The default namespace threshold is `warn`
// (src/logger.ts:31) and `shouldLog` returns *before* enqueue (src/logger.ts:127),
// so a `log.debug` call writes nothing — no console, no POST, no file record —
// unless someone opens the tab with `?log=<ns>:debug`. That is why the 14
// existing `chat-scroll` debug sites in FleetChatShape.tsx produced no record of
// either freeze on 2026-07-25: they were never off, they were never on. The user
// will not be setting a URL param. `log.metric` (src/logger.ts:162) bypasses the
// gate and always reaches ~/.config/tlda/client.log, batched and queue-capped.
//
// WHY EVERY RECORD CARRIES lastEventId. The question is always "did the panel
// stop while the socket kept going?" Answering it from two series joined on
// timestamp is exactly how you get a plausible wrong answer. So the transport's
// high-water mark and the panel-local number ship in the SAME record and the
// divergence falls out by subtraction.
//
// WHY TRANSITIONS ONLY. These sit in a hot path — `chatMessages` recomputes on
// every event, `getLiveSnapshot` runs on every React render. Instrumentation
// that becomes its own performance complaint is a bad trade. Nothing here emits
// on a steady state; a healthy panel is silent.

import { log } from '../logger'

const NS = 'chat-freeze'

// A panel is "stalled" when its own last message id has not moved while the
// transport's high-water mark has advanced past this many events. Sized so an
// ordinary quiet moment (nobody talking) never trips it — only a panel that is
// demonstrably behind a live stream does.
const STALL_EVENT_GAP = 25
// ...and only after this long, so a slow render or a paused React tick is not
// reported as a freeze.
const STALL_MIN_MS = 20_000
// Once stalled, re-report at most this often. The first record is the finding;
// the repeats only establish how long it lasted.
const STALL_REPEAT_MS = 60_000

/** @type {Map<string, {lastDbId: number|null, count: number, eventIdAtLastChange: number, tAtLastChange: number, stalledReportedAt: number, stalled: boolean}>} */
const _panels = new Map()

function panelState(panelId) {
  let s = _panels.get(panelId)
  if (!s) {
    s = { lastDbId: null, count: -1, eventIdAtLastChange: 0, tAtLastChange: Date.now(), stalledReportedAt: 0, stalled: false }
    _panels.set(panelId, s)
  }
  return s
}

/**
 * SEAM 7 — what the panel believes its last message is, versus what the
 * transport has seen. Call once per `chatMessages` recompute.
 *
 * Emits on: the panel's tail advancing (cheap, one line per new message), the
 * panel going stalled, and the panel recovering. Silent otherwise.
 *
 * @param {string} panelId
 * @param {{messageCount: number, lastDbId: number|null, lastEventId: number, filterKey?: string, bufferKey?: string|null}} s
 */
export function notePanelTail(panelId, s) {
  const st = panelState(panelId)
  const now = Date.now()
  const moved = s.lastDbId !== st.lastDbId || s.messageCount !== st.count

  if (moved) {
    const wasStalled = st.stalled
    st.lastDbId = s.lastDbId
    st.count = s.messageCount
    st.eventIdAtLastChange = s.lastEventId
    st.tAtLastChange = now
    st.stalled = false
    st.stalledReportedAt = 0
    if (wasStalled) {
      log.metric(NS, 'panel recovered — tail advanced again', {
        panelId, lastDbId: s.lastDbId, messageCount: s.messageCount,
        lastEventId: s.lastEventId, filterKey: s.filterKey, bufferKey: s.bufferKey,
      })
    }
    return
  }

  // Tail unchanged. Is the transport still moving?
  const eventGap = s.lastEventId - st.eventIdAtLastChange
  const stalledMs = now - st.tAtLastChange
  if (eventGap < STALL_EVENT_GAP || stalledMs < STALL_MIN_MS) return
  if (st.stalledReportedAt && now - st.stalledReportedAt < STALL_REPEAT_MS) return

  st.stalled = true
  st.stalledReportedAt = now
  // THE record. Panel tail frozen, socket still delivering.
  log.metric(NS, 'PANEL STALLED — tail frozen while transport advanced', {
    panelId,
    lastDbId: s.lastDbId,
    messageCount: s.messageCount,
    lastEventId: s.lastEventId,
    eventGap,
    stalledMs,
    filterKey: s.filterKey,
    bufferKey: s.bufferKey,
  })
}

/** Forget a panel's state when its shape unmounts, so a remount starts clean. */
export function forgetPanel(panelId) { _panels.delete(panelId) }

/** @type {Map<string, {list: unknown, lastEventId: number}>} */
const _snapshots = new Map()

/**
 * SEAM 4 — did React get handed the identical array while the stream moved on?
 * That is a frozen panel at the React boundary, and it is the direct signal.
 *
 * `getLiveSnapshot` runs on every render, so this must not log per call. It logs
 * only when a *recompute* returns a reference-identical list AND the transport
 * has advanced since the last time we looked — which fires approximately never
 * in the healthy case.
 *
 * @param {string} viewKey
 * @param {readonly unknown[]} list
 * @param {number} lastEventId
 * @param {'cache-hit'|'recompute'} how
 */
export function noteSnapshot(viewKey, list, lastEventId, how) {
  const prev = _snapshots.get(viewKey)
  _snapshots.set(viewKey, { list, lastEventId })
  if (!prev || how !== 'recompute') return
  if (prev.list !== list) return
  const eventGap = lastEventId - prev.lastEventId
  if (eventGap < STALL_EVENT_GAP) return
  log.metric(NS, 'snapshot recomputed to an IDENTICAL list while transport advanced', {
    viewKey, eventGap, lastEventId, listLength: Array.isArray(list) ? list.length : null,
  })
}

export function forgetSnapshot(viewKey) { _snapshots.delete(viewKey) }

/**
 * SEAM 3 — keyed LiveView sharing. How many panels share one view, and does the
 * refcount drift? Emits only when the sharing count for a key changes.
 * @param {string} key
 * @param {'create'|'retain'|'release'} how
 * @param {number} refCount
 */
const _viewRefs = new Map()
export function noteViewRef(key, how, refCount) {
  if (_viewRefs.get(key) === refCount) return
  _viewRefs.set(key, refCount)
  if (how === 'release' && refCount <= 0) _viewRefs.delete(key)
  log.metric(NS, 'live view refcount changed', { key, how, refCount })
}

/**
 * SEAMS 1 & 2 — a subscriber touched a view that is already disposed. Silent in
 * the code today (`if (this.disposed) return`), so it can only be found here.
 * @param {string} key
 * @param {'notify'|'subscribe'|'retain'} op
 */
export function noteDisposedViewTouched(key, op) {
  log.metric(NS, 'operation on a DISPOSED live view', { key, op })
}

/**
 * SEAM 5 — which branch `projectStoreResult` took. Emits on branch change only;
 * carries the run length of the previous branch so a path that silently stops
 * being taken is visible.
 * @param {'replace'|'upsert'|'dropped'} branch
 * @param {number} lastEventId
 */
let _lastBranch = null
let _branchRun = 0
export function noteProjection(branch, lastEventId) {
  if (branch === _lastBranch) { _branchRun++; return }
  const prev = _lastBranch
  const run = _branchRun
  _lastBranch = branch
  _branchRun = 1
  if (prev === null) return
  log.metric(NS, 'store→view projection branch changed', { from: prev, to: branch, priorRun: run, lastEventId })
}

/**
 * SEAM 6 — a per-panel buffer rejected an event by filter. Throttled hard: this
 * is normal traffic (every panel drops most events), so it is only useful as a
 * rate. Emits a rolled-up count at most once a minute, per buffer.
 * @param {string} bufferKey
 */
const _drops = new Map()
const DROP_ROLLUP_MS = 60_000
/** @param {string} bufferKey @param {number} lastEventId @param {Record<string,unknown>|null} [suspect] */
export function noteBufferDrop(bufferKey, lastEventId, suspect = null) {
  // The self-checking half. A drop is only interesting when the filter names an
  // AGENT BY NAME and a participant's id is absent from the roster — because
  // labelSetForParticipant then answers only to the raw id, the name term
  // cannot match, and the event is removed from this panel permanently while
  // radio (which never runs the filter) still shows it. Caller supplies the
  // verdict; null means an ordinary, correct drop.
  //
  // This is the discriminator between the two live theories: a burst of these
  // at session start that then stops is a hydration race; a permanent stream on
  // one bufferKey is a name that never resolves.
  if (suspect) {
    log.metric(NS, 'DROPPED a chat event whose participant is not in the roster', {
      bufferKey, lastEventId, ...suspect,
    })
    return
  }
  const now = Date.now()
  let d = _drops.get(bufferKey)
  if (!d) { d = { n: 0, since: now }; _drops.set(bufferKey, d) }
  d.n++
  if (now - d.since < DROP_ROLLUP_MS) return
  log.metric(NS, 'buffer filter-drop rate', { bufferKey, drops: d.n, windowMs: now - d.since, lastEventId })
  d.n = 0
  d.since = now
}

/**
 * SEAM 8 — follow-intent transitions, so "rendered but scrolled away" is cleanly
 * separated from "not rendered at all". Already the subject of 14 `chat-scroll`
 * debug calls that never write; this is the always-on subset that matters.
 * @param {string} panelId
 * @param {'follow-off'|'follow-on'|'filter-reset'|'hard-lock'} action
 * @param {object} data
 */
export function noteFollowTransition(panelId, action, data) {
  log.metric(NS, 'follow intent changed', { panelId, action, ...data })
}

// --- Census -----------------------------------------------------------------
//
// Everything above is transition-only, which on 2026-07-25 turned out to be a
// design bug I caught by trying to verify it: with one panel per view key and a
// steady stream, NOTHING above ever fires, so the instrument is indistinguishable
// from an instrument that isn't running. That is the same "a surface asserting
// the opposite of the true state" failure this work exists to diagnose.
//
// So: one slow heartbeat. Once a minute, one record per panel carrying the
// panel's last known tail and the CURRENT transport high-water mark. It gives a
// positive liveness signal, and it makes a freeze readable straight out of
// client.log as a time series — panel tail flat, lastEventId climbing — instead
// of depending on a threshold having tripped.
//
// Volume: ~5 records/minute against a ~26 KB live-perf sample every 10s. Noise
// floor, not a hot path.

const CENSUS_MS = 60_000
let _censusTimer = null
let _getLastEventId = () => 0

export function startFreezeCensus(getLastEventId) {
  if (typeof getLastEventId === 'function') _getLastEventId = getLastEventId
  if (_censusTimer || typeof window === 'undefined') return
  _censusTimer = setInterval(() => {
    if (_panels.size === 0) return
    const lastEventId = _getLastEventId()
    const now = Date.now()
    const panels = []
    for (const [panelId, st] of _panels) {
      panels.push({
        panelId,
        lastDbId: st.lastDbId,
        messageCount: st.count,
        behindBy: lastEventId - st.eventIdAtLastChange,
        staleMs: now - st.tAtLastChange,
        stalled: st.stalled,
      })
    }
    log.metric(NS, 'panel census', { lastEventId, panelCount: panels.length, panels })
  }, CENSUS_MS)
}
