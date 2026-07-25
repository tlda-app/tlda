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
 */
export function subscribeChat(filter, window, onEvents) {
  const subId = `sub${_nextSubId++}`
  // filter and window are retained so a reconnect can re-send the subscription
  // without the caller having to remember it — resubscribeAll needs them.
  _subs.set(subId, { filter, window, onEvents })
  if (_send) {
    try {
      _send('chat-subscribe', { subId, filter, window })
    } catch (e) {
      // Surfaced, never swallowed: a subscribe that silently fails is a panel
      // that shows nothing forever, which is the failure mode we are removing.
      log.metric(NS, 'chat-subscribe send failed', { subId, error: String(e) })
    }
  } else {
    log.metric(NS, 'chat-subscribe before transport was set', { subId })
  }
  return () => {
    _subs.delete(subId)
    if (_send) {
      try { _send('chat-unsubscribe', { subId }) } catch { /* socket already gone */ }
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
export function dispatchChatEvents(data) {
  if (!data || !data.subId) return false
  const sub = _subs.get(data.subId)
  if (!sub) {
    log.metric(NS, 'events for an unknown subscription', {
      subId: data.subId, count: Array.isArray(data.events) ? data.events.length : null,
    })
    return false
  }
  const events = Array.isArray(data.events) ? data.events : []
  sub.onEvents(events, { subId: data.subId, reason: data.reason || 'live', hasMore: !!data.hasMore })
  return true
}

/** Re-send every live subscription. For use after a reconnect. */
export function resubscribeAll() {
  if (!_send) return 0
  let n = 0
  for (const [subId, sub] of _subs) {
    try { _send('chat-subscribe', { subId, filter: sub.filter, window: sub.window }); n++ }
    catch (e) { log.metric(NS, 'resubscribe failed', { subId, error: String(e) }) }
  }
  return n
}

/** Diagnostics only. */
export function chatSubscriptionCount() { return _subs.size }
