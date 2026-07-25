// chat-subscription — a chat is a filter and a window, and the server answers it.
//
// This is the client side of the one-path design. A panel says "here is my
// filter and how much I can show"; the server decides membership and sends the
// matching events. The client does NOT decide membership: no roster lookup, no
// name resolution, no per-panel buffer, no local predicate. That is the whole
// point — a client-side predicate that agrees with the server's is still two
// implementations, and two implementations drift. Tonight's bug was exactly
// that drift: the live path re-resolved names per event against a paged roster
// while the history path used a resolved id set, so a panel could be empty and
// stuck at the same time.
//
// ADDITIVE, DELIBERATELY. Nothing here deletes the existing spool/buffer path.
// The order has to be: server wiring → subscribe alongside → verify equivalence
// on real traffic → then delete. Deleting first would break chat with no way to
// prove the replacement works, and deploys are stopped.
//
// The one piece of client-side routing that legitimately remains is an
// optimistic send: a row the server has never seen goes into the buffer of the
// chat that sent it, keyed by that chat's own id. That is not a filter
// decision, and it must never become one.

import { log } from '../logger'
import { noteServerDelivery } from './filter-equivalence.mjs'

const NS = 'chat-subscription'

/** @type {Map<string, {filter: unknown, window: number, onEvents: (events: readonly object[], meta: object) => void}>} */
const _subs = new Map()
let _nextSubId = 1

/** Wire the transport that carries subscribe/unsubscribe. Set once at init. */
let _send = null
export function setChatSubscriptionTransport(send) { _send = send }

/**
 * Subscribe a chat to its filter. Returns a dispose function.
 *
 * @param {unknown} filter DNF filter, exactly as the shape stores it. Sent
 *   verbatim — the client never interprets it.
 * @param {number} window How many messages this chat can show. The shape knows
 *   its own size; there is no magic number here on purpose.
 * @param {(events: readonly object[], meta: object) => void} onEvents
 * @param {{humanId?: string|null, humanName?: string|null, correlationKey?: string|null}} [identity]
 */
export function subscribeChat(filter, window, onEvents, { humanId = null, humanName = null, correlationKey = null } = {}) {
  const subId = `sub${_nextSubId++}`
  // filter and window are retained so a reconnect can re-send the subscription
  // without the caller having to remember it — resubscribeAll needs them.
  // correlationKey ties this subscription to the client-side buffer that holds
  // the same conversation, so the equivalence comparator can line up the two
  // verdicts for one event. Without it the two streams are keyed differently and
  // cannot be compared at all.
  _subs.set(subId, { filter, window, onEvents, humanId, humanName, correlationKey })
  if (_send) {
    try {
      _send('subscribe-filter', { subId, filter, humanId, humanName })
    } catch (e) {
      // Surfaced, never swallowed: a subscribe that silently fails is a panel
      // that shows nothing forever, which is the failure mode we are removing.
      log.metric(NS, 'subscribe-filter send failed', { subId, error: String(e) })
    }
  } else {
    log.metric(NS, 'subscribe-filter before transport was set', { subId })
  }
  return () => {
    _subs.delete(subId)
    if (_send) {
      try { _send('unsubscribe-filter', { subId }) } catch { /* socket already gone */ }
    }
  }
}

/**
 * Dispatch a server push to the subscription that asked for it.
 * Called from the fleet socket's message handler.
 *
 * A push for an unknown subId is reported rather than dropped: it means the
 * server believes in a subscription this client does not, which is the kind of
 * disagreement that goes unnoticed until a panel is mysteriously empty.
 */
export function dispatchFilterEvent(data) {
  if (!data || !data.subId) return false
  const sub = _subs.get(data.subId)
  if (!sub) {
    log.metric(NS, 'filter-event for an unknown subscription', { subId: data.subId })
    return false
  }
  const event = data.event || null
  if (!event) return false
  // Record that the SERVER matched this event for this subscription. The client
  // records its own verdict from the path it already runs; the comparison of the
  // two on real traffic is the gate before the old path is deleted.
  noteServerDelivery(sub.correlationKey || data.subId, event.id ?? event._dbId, sub.filterKey)
  sub.onEvents([event], { subId: data.subId, reason: data.reason || 'live' })
  return true
}

/** Re-send every live subscription. For use after a reconnect. */
export function resubscribeAll() {
  if (!_send) return 0
  let n = 0
  for (const [subId, sub] of _subs) {
    try { _send('subscribe-filter', { subId, filter: sub.filter, humanId: sub.humanId, humanName: sub.humanName }); n++ }
    catch (e) { log.metric(NS, 'resubscribe failed', { subId, error: String(e) }) }
  }
  return n
}

/**
 * Is there a live subscription for this correlation key?
 *
 * The equivalence comparator needs this. While a panel is viewport-culled its
 * subscription is gone but `fanoutEventToBuffers` keeps running, so recording a
 * client verdict would produce a `server-missed` disagreement for every event
 * during every scroll — and `server-missed` is the direction reported
 * unthrottled precisely because it has no benign explanation. Culling would hand
 * it one and make the signal worthless. So: no subscription, no comparison.
 */
export function hasChatSubscription(correlationKey) {
  if (!correlationKey) return false
  for (const sub of _subs.values()) if (sub.correlationKey === correlationKey) return true
  return false
}

/** Diagnostics only. */
export function chatSubscriptionCount() { return _subs.size }
