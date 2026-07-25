// filter-equivalence — does the server's membership decision agree with the
// client's, on real traffic, continuously?
//
// This is the gate before anything is deleted. The server half is tested but
// unproven: 27 green tests demonstrate a defect in a unit test and have never
// once caught it happening to Skip. Deleting the client's spool on the strength
// of that would be replacing a path that works badly with a path that is
// untried.
//
// The comparison costs nothing extra, because during the additive phase the
// client receives BOTH streams for the same events:
//
//   fleet-event   — every event, unconditionally (the old path)
//   filter-event  — only events the server matched to a subscription (the new)
//
// So for each (subscription, event) there are two independent verdicts. They
// must agree. A disagreement is a real finding in one direction or the other,
// and until now nothing in the system could tell you which:
//
//   client says belongs, no filter-event  → the server missed it (would be a
//                                           message the new path silently drops)
//   filter-event, client says not         → the client missed it (which is
//                                           tonight's bug, caught in the act)
//
// Deliberately NOT a unit test. Skip: "a test you can apply to any data in real
// time as, like, a just running test." It watches production and stays quiet
// when the two agree.

import { log } from '../logger'

const NS = 'filter-equivalence'

// How long to wait for the other stream before calling it a disagreement. The
// two arrive on the same socket microseconds apart, but a slow frame or a
// batched flush can separate them, and a false disagreement here would be worth
// less than nothing — we have spent a night on metrics that cried wolf.
const GRACE_MS = 5000
// Cap on outstanding comparisons, so a stalled sweep can't grow without bound.
const MAX_PENDING = 2000
// The two directions are NOT equally throttled, and the asymmetry is the point.
//
// client-missed — a filter-event arrived and the client said no. This is the
//   EXPECTED direction and tonight's bug caught in the act: the client's roster
//   was partial. One systematic occurrence would flood, so it's throttled.
//
// server-missed — the client said belongs and no filter-event came. Every
//   fleet-event was verified to route through the server's hook, so there is no
//   benign explanation left: the server's evaluation is wrong. Rarer and more
//   serious, so it is reported EVERY time. Throttling both the same buries the
//   one that matters under the one that doesn't.
const REPORT_EVERY_MS = 30_000
const REPORT_EVERY_MS_SERVER_MISSED = 0

// Counters, because SILENCE IS AMBIGUOUS and the deletion is gated on it.
//
// A quiet comparator and a comparator that never compared anything look
// identical from the outside, and three of the four ways to get silence are
// failures: only one branch deployed so no filter-event ever arrives; a
// bufferKey/correlationKey mismatch so hasChatSubscription() suppresses every
// comparison; a subscribe frame erroring server-side unnoticed. Deleting the
// spool on the strength of silence that meant "not looking" is worse than the
// bug, because the spool is what currently makes chat work.
//
// So the heartbeat below always reports, INCLUDING zeros, and the four cases
// are distinguishable:
//   comparisons > 0, disagreements 0      → the two agree. The proof.
//   clientVerdicts > 0, serverDeliveries 0 → the server is not answering.
//   clientVerdicts 0                       → the guard is suppressing everything.
//   both 0                                 → nothing is running at all.
const _stats = {
  clientVerdicts: 0,
  serverDeliveries: 0,
  comparisons: 0,
  // Join accounting. The comparator's whole function is joining two streams on
  // (subId, eventId) — so the one thing that must be true is that the join
  // sometimes SUCCEEDS. It never did: the two sides carried different id shapes,
  // and every touch() created a fresh entry instead of finding its partner.
  //
  // agreedBelongs: 0 was structurally impossible to escape, and nothing said so.
  // These two counters make the join itself observable, so a future id-shape
  // divergence is a loud record within a minute rather than a result somebody
  // reports as a finding.
  joinPaired: 0,
  joinCreated: 0,
  // Agreement is split by POLARITY, because agreed-negative is not proof.
  //
  // The comparator detects disagreement. The one failure it cannot see by
  // disagreeing is both sides being wrong the same way: if the server's roster
  // is also partial, neither side resolves the name, both say "does not belong",
  // and that registers as agreement. markdown-check's rosterSize field catches it
  // from the server end; this catches it from here.
  //
  // agreedBelongs 0 over a live session, with comparisons high, means no panel
  // ever matched anything — which is what a globally-broken filter looks like
  // from the inside, and it is indistinguishable from a quiet fleet unless the
  // two polarities are counted apart.
  agreedBelongs: 0,
  agreedNotBelongs: 0,
  serverMissed: 0,
  clientMissed: 0,
}
const HEARTBEAT_MS = 60_000
let _lastHeartbeat = 0

/** @type {Map<string, {client: boolean, server: boolean, t: number, filterKey?: string}>} */
const _pending = new Map()
const _lastReport = new Map()
let _sweep = null

// The two sides arrive with DIFFERENT id shapes, and until 2026-07-25 13:12 this
// silently guaranteed that no comparison could ever agree:
//
//   client verdict  — event.id from asFleetEvent/keyOfEvent  ->  "db:1831211" (string)
//   server delivery — the raw fleet-store event's id          ->   1831211    (number)
//
// So every client verdict aged out unmatched as serverMissed, every server
// delivery aged out unmatched as clientMissed, and agreedBelongs could not be
// non-zero BY CONSTRUCTION. The tell was clientMissed === serverDeliveries
// exactly, and the two record types printing "db:1831211" and "1831430".
//
// agreedBelongs: 0 was this bug, not a client that matches nothing.
function normEventId(eventId) {
  if (eventId == null) return null
  const s = String(eventId)
  return s.startsWith('db:') || s.startsWith('tmp:') ? s : `db:${s}`
}

function keyOf(subId, eventId) { return `${subId}|${normEventId(eventId)}` }

// Started at module load, NOT on first comparison. An earlier version started it
// from touch(), which meant the case "the guard suppressed every comparison"
// produced no heartbeat either — the fix for an ambiguous silence, silent in one
// of the cases it exists to distinguish. Same failure as the drop probe that was
// quiet under the bug it tested.
function ensureSweep() {
  if (_sweep || typeof window === 'undefined') return
  _sweep = setInterval(() => {
    const now = Date.now()
    for (const [k, v] of _pending) {
      if (now - v.t < GRACE_MS) continue
      _pending.delete(k)
      _stats.comparisons++
      if (v.client === v.server) {
        if (v.client) _stats.agreedBelongs++; else _stats.agreedNotBelongs++
        continue
      }
      if (v.client) _stats.serverMissed++; else _stats.clientMissed++
      const [subId, eventId] = k.split('|')
      const direction = v.client ? 'server-missed' : 'client-missed'
      const throttle = direction === 'server-missed' ? REPORT_EVERY_MS_SERVER_MISSED : REPORT_EVERY_MS
      const rk = `${subId}|${direction}`
      const last = _lastReport.get(rk) || 0
      if (throttle > 0 && now - last < throttle) continue
      _lastReport.set(rk, now)
      log.metric(NS, direction === 'server-missed'
        ? 'DISAGREEMENT: server did not deliver an event the client matched'
        : 'DISAGREEMENT: server delivered an event the client did not match', {
        subId, eventId: normEventId(eventId), direction,
        clientSaysBelongs: v.client,
        serverSentIt: v.server,
        filterKey: v.filterKey || null,
      })
    }
    // Always reports, zeros included. A heartbeat that goes quiet when there is
    // nothing to say would reproduce the exact ambiguity it exists to remove.
    if (now - _lastHeartbeat >= HEARTBEAT_MS) {
      _lastHeartbeat = now
      log.metric(NS, 'equivalence heartbeat', { ..._stats, pending: _pending.size })
      // The join never succeeding, while both sides are active, means the two
      // streams are keyed differently and NO comparison can ever agree. That is
      // not a finding about the client; it is the comparator being broken. Say
      // so, rather than letting agreedBelongs: 0 be read as a result.
      if (_stats.joinPaired === 0 && _stats.clientVerdicts > 20 && _stats.serverDeliveries > 20) {
        log.metric(NS, 'COMPARATOR BROKEN — the two streams never join; check event id shapes', {
          clientVerdicts: _stats.clientVerdicts,
          serverDeliveries: _stats.serverDeliveries,
          joinPaired: _stats.joinPaired,
          joinCreated: _stats.joinCreated,
        })
      }
    }
  }, 1000)
}

function touch(subId, eventId, patch, filterKey) {
  if (!subId || eventId == null) return
  ensureSweep()
  const k = keyOf(subId, eventId)
  let v = _pending.get(k)
  if (!v) {
    if (_pending.size >= MAX_PENDING) return
    _stats.joinCreated++
    v = { client: false, server: false, t: Date.now(), filterKey }
    _pending.set(k, v)
  } else {
    _stats.joinPaired++
  }
  Object.assign(v, patch)
  if (filterKey && !v.filterKey) v.filterKey = filterKey
}

/**
 * The client's own verdict for this subscription, from the path it uses today.
 * @param {string} subId
 * @param {string|number} eventId
 * @param {boolean} belongs
 * @param {string} [filterKey] for reading the record later
 */
export function noteClientVerdict(subId, eventId, belongs, filterKey) {
  _stats.clientVerdicts++
  touch(subId, eventId, { client: !!belongs }, filterKey)
}

/** The server sent this event for this subscription, so the server matched it. */
export function noteServerDelivery(subId, eventId, filterKey) {
  _stats.serverDeliveries++
  touch(subId, eventId, { server: true }, filterKey)
}

// Start the heartbeat now, so a session that never records a single verdict still
// says so once a minute.
ensureSweep()

/** Diagnostics only. */
export function equivalencePendingCount() { return _pending.size }
export function equivalenceStats() { return { ..._stats, pending: _pending.size } }
