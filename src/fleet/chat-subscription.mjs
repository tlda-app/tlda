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

import { log } from '../logger.ts'
import { noteServerDelivery } from './filter-equivalence.mjs'

const NS = 'chat-subscription'

/** @type {Map<string, {filter: unknown, window: number, onEvents: (events: readonly object[], meta: {subId: string, reason: string, browserReceivedAtMs?: number, hasMore?: boolean, nextCursor?: string|null, truncated?: boolean, error?: string|null}) => void, humanId: string|null, humanName: string|null, correlationKey: string|null, filterKey: string, nextCursor: string|null, hasMore: boolean}>} */
const _subs = new Map()
let _nextSubId = 1

/** Wire the transport that carries subscribe/unsubscribe. Set once at init. */
let _send = null
export function setChatSubscriptionTransport(send) { _send = send }

/**
 * Send one subscription message and record what ACTUALLY happened to it.
 *
 * Every call site here used to wrap `_send` in its own `try/catch`. All four
 * were dead code: `_send` is `browserFleetTransport.ephemeral`, whose adapter
 * (`sendBrowserRequestAttempt`) is `async`, so it returns a pending promise and
 * throws nothing a synchronous `catch` can see. The catches had never fired
 * once. On 2026-08-12 three real `subscribe-filter` failures occurred in two of
 * Skip's tabs — `WS request idle timeout after 45000ms`, each paired with an
 * `unsubscribe-filter` failure a millisecond earlier, so a refilter — and the
 * branch that exists to say `subscribe-filter send failed` said nothing.
 *
 * `async` here is load-bearing rather than decorative: it funnels BOTH modes
 * into one catch. `_send` can still throw synchronously (the transport rejects
 * an unknown operation or a missing mode before the adapter runs), and awaiting
 * turns that into the same rejection as a lost acknowledgement.
 *
 * The record names the `subId` and the `filterKey`. That is the whole point: the
 * truth was already in `client.log` as a `fleet-transport` terminal error, and
 * it could not be joined to a panel because the only record that named the
 * subscription was the one that overstated it.
 *
 * ACKNOWLEDGED, never DELIVERED. The server registers the subscription before it
 * replies (`unified-server.mjs`, `subscribe()` then `reply()`), so a lost reply
 * is not a lost subscription — on 2026-08-12 a panel kept receiving for forty
 * minutes after its own subscribe "failed". Resolving false means the server
 * never answered, and nothing stronger.
 *
 * Never rejects, so callers may collect these with `Promise.all` without adding
 * an unhandled rejection of their own.
 *
 * @param {'subscribe-filter'|'unsubscribe-filter'} operation
 * @param {Record<string, unknown>} payload
 * @param {{subId: string, filterKey?: string|null, site: string}} meta
 * @returns {Promise<boolean>} true if the server acknowledged.
 */
async function sendSubscription(operation, payload, { subId, filterKey = null, site }) {
  try {
    await _send(operation, payload)
    return true
  } catch (e) {
    log.metric(NS, `${operation} NOT acknowledged`, {
      subId, filterKey, site, error: String(e?.message || e),
    })
    return false
  }
}

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
  })
  if (_send) {
    // Surfaced, never swallowed: a subscribe that silently fails is a panel that
    // shows nothing forever, which is the failure mode we are removing. This is
    // the site the 2026-08-12 failures were on.
    void sendSubscription(
      'subscribe-filter',
      { subId, filter, humanId, humanName, window },
      { subId, filterKey: JSON.stringify(filter ?? null), site: 'subscribe' },
    )
  } else {
    log.metric(NS, 'subscribe-filter before transport was set', { subId })
  }
  return () => {
    _subs.delete(subId)
    // A failed unsubscribe leaves a subscription the server drops on close, so
    // it is not urgent — but it is recorded, because the pairing of a failed
    // unsubscribe with a failed subscribe one millisecond later is what
    // identified a refilter as the site of the 2026-08-12 failures.
    if (_send) void sendSubscription('unsubscribe-filter', { subId }, { subId, site: 'dispose' })
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
  // An updateOnly push is a re-send of a row that changed, not the arrival of a
  // new event, and it rides the envelope rather than the row so the stored event
  // is unchanged.
  const updateOnly = !!data.updateOnly
  // DELIBERATE HOLE IN THIS DENOMINATOR, and whoever reads the comparator later
  // needs to know it is here. noteServerDelivery feeds the live-vs-client
  // equivalence check, whose disagreements gate deleting the old client path. A
  // re-fire is not a delivery of a new event, so counting it would inflate the
  // server side — and once the panel deliberately declines to insert a row it
  // does not hold, the comparator would read that as the client LOSING an event
  // and manufacture exactly the disagreement it exists to detect. Excluded here,
  // at the one place that can tell the two apart.
  if (!updateOnly) {
    noteServerDelivery(sub.correlationKey || data.subId, event.id ?? event._dbId, sub.filterKey)
  }
  sub.onEvents([event], {
    subId: data.subId,
    reason: updateOnly ? 'update' : (data.reason || 'live'),
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
  // Guarded on the cursor alone. A request that is never answered leaves the
  // cursor where it was, so the next startReached asks for the same page again
  // and the panel recovers by itself.
  if (!sub.hasMore || !sub.nextCursor) return false
  // The boolean says the request was ISSUED, which is all its one caller uses it
  // for. Whether it was answered arrives later, on the record above.
  void sendSubscription(
    'subscribe-filter',
    {
      subId,
      filter: sub.filter,
      humanId: sub.humanId,
      humanName: sub.humanName,
      window: sub.window,
      before: sub.nextCursor,
    },
    { subId, filterKey: sub.filterKey, site: 'older-history' },
  )
  return true
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
  const attempts = []
  for (const [subId, sub] of _subs) {
    if (sub.humanId === humanId && sub.humanName === humanName) continue
    sub.humanId = humanId
    sub.humanName = humanName
    if (!_send) continue
    attempts.push(attempt(subId, sub, { humanId, humanName }, 'identity'))
  }
  if (!attempts.length) return Promise.resolve(null)
  return settle(attempts).then(tally => {
    log.metric(NS, 'identity resubscribe settled', { ...tally, humanId })
    return tally
  })
}

/** One `subscribe-filter` for an existing subscription, tagged with its outcome. */
function attempt(subId, sub, { humanId = sub.humanId, humanName = sub.humanName } = {}, site) {
  return sendSubscription(
    'subscribe-filter',
    { subId, filter: sub.filter, humanId, humanName, window: sub.window },
    { subId, filterKey: sub.filterKey, site },
  ).then(ok => ({ subId, ok }))
}

/**
 * Wait for a batch of subscribes to be answered and count what happened.
 *
 * The tally is emitted when the ANSWER is known, not when the question is asked,
 * so it lands up to one request-idle timeout after the reconnect. That lateness
 * is the point. Until now this batch reported `count: N` the instant the sends
 * were issued — a number that could not be wrong, because it counted intentions.
 * On 2026-08-12 a tab logged its optimistic count and the three `fleet-transport`
 * timeouts that contradicted it arrived 45 seconds later in a different
 * namespace, carrying no subId, with nothing to join them by.
 *
 * A tally is kept at all — rather than only recording failures — because this
 * codebase has already paid for the alternative. `chat-freeze-probe.mjs` added
 * its census because transition-only telemetry "is indistinguishable from an
 * instrument that isn't running", and on 2026-08-12 a probe whose high-water
 * mark had read 0 since July was read as evidence for eleven minutes.
 */
function settle(attempts) {
  return Promise.all(attempts).then(results => {
    const failed = results.filter(r => !r.ok)
    return {
      attempted: results.length,
      acknowledged: results.length - failed.length,
      failed: failed.length,
      failedSubIds: failed.map(r => r.subId),
    }
  })
}

/**
 * Re-send every live subscription. For use after a reconnect.
 *
 * Resolves to the settled tally, or null if there was nothing to send. The
 * caller logs it; see settle() for why it is worth waiting for.
 */
export function resubscribeAll() {
  if (!_send) return Promise.resolve(null)
  const attempts = []
  for (const [subId, sub] of _subs) attempts.push(attempt(subId, sub, {}, 'reconnect'))
  if (!attempts.length) return Promise.resolve(null)
  return settle(attempts)
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
