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
// The one piece of client-side routing that legitimately remains is an
// optimistic send: a row the server has never seen goes into the buffer of the
// chat that sent it, keyed by that chat's own id. That is not a filter
// decision, and it must never become one.

import { log } from '../logger'
import { noteServerDelivery } from './filter-equivalence.mjs'

const NS = 'chat-subscription'

/** @type {Map<string, {filter: unknown, window: number, onEvents: (events: readonly object[], meta: {subId: string, reason: string, browserReceivedAtMs?: number, hasMore?: boolean, nextCursor?: string|null, truncated?: boolean, error?: string|null}) => void, humanId: string|null, humanName: string|null, correlationKey: string|null, filterKey: string, nextCursor: string|null, hasMore: boolean, historyPending: boolean}>} */
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
 * @param {(events: readonly object[], meta: {subId: string, reason: string, browserReceivedAtMs?: number, hasMore?: boolean, nextCursor?: string|null, truncated?: boolean, error?: string|null}) => void} onEvents
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
  // filterKey is stored because dispatchFilterEvent read sub.filterKey and it
  // was never set — every disagreement record came out with filterKey: null,
  // which is the field you need to know WHICH panel disagreed.
  _subs.set(subId, {
    filter, window, onEvents, humanId, humanName, correlationKey,
    filterKey: JSON.stringify(filter ?? null),
    nextCursor: null,
    hasMore: true,
    historyPending: true,
  })
  if (_send) {
    try {
      _send('subscribe-filter', { subId, filter, humanId, humanName, window })
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
  const browserReceivedAtMs = Date.now()
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
  sub.onEvents([event], {
    subId: data.subId,
    reason: data.reason || 'live',
    browserReceivedAtMs,
  })
  return true
}

/**
 * Dispatch the initial window the server queried for a subscription.
 *
 * Same shape as a live push, one call with many events and `reason: 'history'`,
 * so a panel has exactly one intake path and cannot render a message one way
 * because it arrived live and another because it arrived from history. That
 * divergence is the bug this whole design removes.
 */
export function dispatchFilterEvents(data) {
  if (!data || !data.subId) return false
  const sub = _subs.get(data.subId)
  if (!sub) {
    log.metric(NS, 'filter-events for an unknown subscription', { subId: data.subId })
    return false
  }
  if (data.error) {
    // A panel that silently shows nothing is the failure mode being removed, so
    // a failed history query is recorded rather than left as an empty panel.
    log.metric(NS, 'history query failed for a subscription', { subId: data.subId, error: data.error, filterKey: sub.filterKey })
  }
  const events = Array.isArray(data.events) ? data.events : []
  sub.historyPending = false
  // A reconnect or identity refresh replays the newest page. Preserve the
  // deepest cursor already reached; only an explicitly older page advances it.
  if (!data.error && (data.requestBefore != null || sub.nextCursor == null)) {
    sub.nextCursor = data.nextCursor ?? null
    sub.hasMore = !!data.hasMore
  }
  for (const event of events) noteServerDelivery(sub.correlationKey || data.subId, event.id ?? event._dbId, sub.filterKey)
  sub.onEvents(events, {
    subId: data.subId,
    reason: data.reason || 'history',
    hasMore: !!data.hasMore,
    nextCursor: data.nextCursor ?? null,
    truncated: !!data.truncated,
    error: data.error || null,
  })
  return true
}

/**
 * Ask the existing subscription for its next older page.
 *
 * Pagination stays on the subscription wire: same filter, same subId, same
 * server predicate, same event intake. There is no direct history query.
 */
export function requestEarlierChatHistory(correlationKey) {
  if (!correlationKey || !_send) return false
  const found = [..._subs.entries()].find(([, sub]) => sub.correlationKey === correlationKey)
  if (!found) return false
  const [subId, sub] = found
  if (sub.historyPending || !sub.hasMore || !sub.nextCursor) return false
  sub.historyPending = true
  try {
    _send('subscribe-filter', {
      subId,
      filter: sub.filter,
      humanId: sub.humanId,
      humanName: sub.humanName,
      window: sub.window,
      before: sub.nextCursor,
    })
    return true
  } catch (e) {
    sub.historyPending = false
    log.metric(NS, 'older history request failed', { subId, error: String(e) })
    return false
  }
}

/**
 * Re-send subscriptions whose identity has changed.
 *
 * Identity resolves ASYNCHRONOUSLY. A panel that subscribes before it lands
 * sends humanId: null, and `dm:` filters can then never match, because
 * isDmWithTarget requires knowing which participant is the human. Nothing
 * re-read identity afterwards, so that subscription stayed dead for the life of
 * the tab.
 *
 * This is the same defect as getShapeVisibility capturing getHumanId() once —
 * diagnosed earlier tonight, then reproduced here. Async identity read at setup
 * and never revisited is apparently the standing trap in this codebase.
 */
export function refreshChatSubscriptionIdentity(humanId, humanName) {
  let n = 0
  for (const [subId, sub] of _subs) {
    if (sub.humanId === humanId && sub.humanName === humanName) continue
    sub.humanId = humanId
    sub.humanName = humanName
    if (!_send) continue
    try {
      sub.historyPending = true
      _send('subscribe-filter', { subId, filter: sub.filter, humanId, humanName, window: sub.window })
      n++
    } catch (e) {
      sub.historyPending = false
      log.metric(NS, 'identity re-subscribe failed', { subId, error: String(e) })
    }
  }
  if (n) log.metric(NS, 're-subscribed after identity changed', { count: n, humanId })
  return n
}

/** Re-send every live subscription. For use after a reconnect. */
export function resubscribeAll() {
  if (!_send) return 0
  let n = 0
  for (const [subId, sub] of _subs) {
    try {
      sub.historyPending = true
      _send('subscribe-filter', { subId, filter: sub.filter, humanId: sub.humanId, humanName: sub.humanName, window: sub.window })
      n++
    }
    catch (e) {
      sub.historyPending = false
      log.metric(NS, 'resubscribe failed', { subId, error: String(e) })
    }
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
