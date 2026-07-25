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
// Report at most this often per (subId, direction), so one systematic
// disagreement produces a finding rather than a flood.
const REPORT_EVERY_MS = 30_000

/** @type {Map<string, {client: boolean, server: boolean, t: number, filterKey?: string}>} */
const _pending = new Map()
const _lastReport = new Map()
let _sweep = null

function keyOf(subId, eventId) { return `${subId}|${eventId}` }

function ensureSweep() {
  if (_sweep || typeof window === 'undefined') return
  _sweep = setInterval(() => {
    const now = Date.now()
    for (const [k, v] of _pending) {
      if (now - v.t < GRACE_MS) continue
      _pending.delete(k)
      if (v.client === v.server) continue
      const [subId, eventId] = k.split('|')
      const direction = v.client ? 'server-missed' : 'client-missed'
      const rk = `${subId}|${direction}`
      const last = _lastReport.get(rk) || 0
      if (now - last < REPORT_EVERY_MS) continue
      _lastReport.set(rk, now)
      log.metric(NS, 'DISAGREEMENT between server and client membership', {
        subId, eventId, direction,
        clientSaysBelongs: v.client,
        serverSentIt: v.server,
        filterKey: v.filterKey || null,
      })
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
    v = { client: false, server: false, t: Date.now(), filterKey }
    _pending.set(k, v)
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
  touch(subId, eventId, { client: !!belongs }, filterKey)
}

/** The server sent this event for this subscription, so the server matched it. */
export function noteServerDelivery(subId, eventId, filterKey) {
  touch(subId, eventId, { server: true }, filterKey)
}

/** Diagnostics only. */
export function equivalencePendingCount() { return _pending.size }
