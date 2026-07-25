import type { LiveStore, LiveView } from '../../shared/live-store.ts'
import { createLiveStore } from '../../shared/live-store.ts'
import { labelsForAgent } from '../../shared/fleet-labels.mjs'
// @ts-ignore - shared JS module
import { isRuntimeAwake } from '../../shared/fleet-runtime-status.mjs'
import { setLiveStoreObserver } from '../../shared/live-store.ts'
import { noteBufferDrop, noteDisposedViewTouched, noteViewRef, startFreezeCensus, filterNameIds, noteBufferMatch, isRenderableInPanel } from './chat-freeze-probe.mjs'
import { noteClientVerdict } from './filter-equivalence.mjs'
import { hasChatSubscription } from './chat-subscription.mjs'
import { getLastEventId } from './fleet-data.mjs'

startFreezeCensus(getLastEventId)

// Browser-side sink for the live-store's otherwise-silent diagnostics. `shared/`
// can't import the browser logger (the server imports it too), so it exposes a
// hook and we fill it in here — the one place that is browser-only and already
// owns the fleet event store.
setLiveStoreObserver({
  onDisposedViewTouched: (key, op) => noteDisposedViewTouched(key, op),
  onViewRef: (key, how, refCount) => noteViewRef(key, how, refCount),
})

export type FleetEvent = Record<string, unknown> & {
  id: string
  _dbId?: string | number
  _tempId?: string
}

export type FleetEventFilter = unknown
export type FleetEventMatcher = (filter: FleetEventFilter | null, event: FleetEvent) => boolean

const eventIds = new WeakMap<object, string>()

let eventStore: LiveStore<FleetEvent> = createLiveStore<FleetEvent>()
type EventBuffer = {
  store: LiveStore<FleetEvent>
  filter: FleetEventFilter | null
  matchesFilter: FleetEventMatcher
  pinned: boolean
  maxEvents: number
  // A server-fed buffer takes its rows from its own filter subscription and
  // NOTHING else — not the global store, not the client-side matcher. That is
  // the whole change: the panel's data source is the query for its filter,
  // answered by the server against the full roster, instead of a client-side
  // predicate run over a bounded local copy of everything.
  //
  // It is the local copy that was the bug. The browser holds a live-biased PAGE
  // of a 7,000-agent fleet, so a filter naming an agent that had fallen off the
  // page silently matched nothing while the same filter matched fine on the
  // server. The panel then sat there, scrollable and composable, taking no new
  // messages — which is exactly what a stuck chat looks like.
  serverFed: boolean
}
const eventBuffers = new Map<string, EventBuffer>()
const DEFAULT_BUFFER_MAX_EVENTS = 500

export type FleetAgent = Record<string, unknown> & {
  id: string
  friendly_name?: string
  pretty_name?: string | Array<string | { kind: 'glyph'; id?: string; glyph?: string }>
  runtime_status?: { status?: string }
  labels?: string[]
  dead?: boolean
}

export type FleetAgentFilter = [string, string][][] | null

let agentStore: LiveStore<FleetAgent> = createLiveStore<FleetAgent>()
let agentLabelIndex = agentStore.index<string>('labels', (agent) => labelsForAgent(agent))
let awakeAgentIndex = agentStore.index<boolean>('awake-agent', (agent) =>
  !agent.dead && !agent.human && isRuntimeAwake(agent)
)

function keyOfEvent(event: Record<string, unknown>): string {
  const dbId = event._dbId
  if (dbId != null) return `db:${String(dbId)}`
  const tempId = event._tempId
  if (typeof tempId === 'string' && tempId) return `tmp:${tempId}`
  const timestamp = typeof event.timestamp === 'string' ? event.timestamp : ''
  const type = typeof event.type === 'string' ? event.type : ''
  const from = typeof event.from === 'string' ? event.from : ''
  const text = typeof event.text === 'string' ? event.text : ''
  return `anon:${type}:${timestamp}:${from}:${text}`
}

function asFleetEvent(event: Record<string, unknown>): FleetEvent {
  const id = keyOfEvent(event)
  const previousId = eventIds.get(event)
  if (previousId && previousId !== id) removeEventIdFromStores(previousId)
  eventIds.set(event, id)
  Object.defineProperty(event, 'id', {
    value: id,
    enumerable: false,
    configurable: true,
    writable: true,
  })
  return event as FleetEvent
}

function eventTimestamp(event: FleetEvent): number {
  const raw = typeof event.timestamp === 'string' ? event.timestamp : ''
  const ts = raw ? Date.parse(raw) : NaN
  return Number.isNaN(ts) ? Number.MAX_SAFE_INTEGER : ts
}

function compareFleetEvents(a: FleetEvent, b: FleetEvent): number {
  const byTs = eventTimestamp(a) - eventTimestamp(b)
  if (byTs !== 0) return byTs
  return String(a.id).localeCompare(String(b.id))
}

function removeEventIdFromStores(id: string): void {
  eventStore.remove(id)
  for (const buffer of eventBuffers.values()) buffer.store.remove(id)
}

// A chat panel's buffer is server-fed. Every other buffer keeps the old
// client-matched behaviour until its owner is moved the same way.
function isServerFedBufferKey(bufferKey: string): boolean {
  return bufferKey.startsWith('chat:')
}

function eventBuffer(
  bufferKey: string,
  filter: FleetEventFilter | null,
  matchesFilter: FleetEventMatcher
): EventBuffer {
  let buffer = eventBuffers.get(bufferKey)
  if (!buffer) {
    buffer = {
      store: createLiveStore<FleetEvent>(),
      filter,
      matchesFilter,
      pinned: true,
      maxEvents: DEFAULT_BUFFER_MAX_EVENTS,
      serverFed: isServerFedBufferKey(bufferKey),
    }
    eventBuffers.set(bufferKey, buffer)
    // A server-fed buffer is seeded by its subscription's history page, which
    // the server is already querying. Seeding it from the local store here
    // would put back exactly the client-decided rows this change removes.
    if (!buffer.serverFed) seedEventBuffer(buffer)
    return buffer
  }
  // A server-fed buffer is emptied when its FILTER changes and at no other time.
  // The server is about to answer a different question, so rows belonging to the
  // old filter must go or the panel shows a mix of two.
  //
  // It must NOT be emptied on a reconnect. That is the same filter being
  // re-answered, and clearing it makes the list empty and refill, which drops
  // the reader wherever the scroller lands — Skip was at the bottom of his chat
  // and got thrown to the top by a reconnect. Merging by id leaves his position
  // alone and converges to the same contents.
  const filterChanged = JSON.stringify(buffer.filter ?? null) !== JSON.stringify(filter ?? null)
  buffer.filter = filter
  buffer.matchesFilter = matchesFilter
  if (!buffer.serverFed) reconcileEventBuffer(buffer)
  else if (filterChanged) buffer.store.bulk(store => { for (const e of store.all()) store.remove(e.id) })
  return buffer
}

function seedEventBuffer(buffer: EventBuffer): void {
  buffer.store.bulk((store) => {
    for (const event of eventStore.all()) {
      if (buffer.matchesFilter(buffer.filter, event)) store.upsert(event)
    }
  })
}

function reconcileEventBuffer(buffer: EventBuffer): void {
  buffer.store.bulk((store) => {
    for (const event of store.all()) {
      if (!buffer.matchesFilter(buffer.filter, event)) store.remove(event.id)
    }
    for (const event of eventStore.all()) {
      if (buffer.matchesFilter(buffer.filter, event)) store.upsert(event)
    }
  })
}

/**
 * Put the events a subscription delivered into that panel's buffer.
 *
 * The ONLY way rows enter a server-fed buffer. `bufferKey` is the
 * subscription's correlationKey, which is the panel's own buffer key — the two
 * were already the same string, because the comparator needed them to line up.
 *
 * Always MERGES by id, never replaces. A reconnect re-sends the same
 * subscription and gets the same history back, so replacing emptied and refilled
 * the list under a reader who had asked for nothing — and threw them to the top
 * of their chat. Clearing on a genuine filter change happens in eventBuffer(),
 * which is the only place that knows the filter actually changed.
 */
export function applyFilterEvents(
  bufferKey: string,
  events: readonly Record<string, unknown>[],
): number {
  const buffer = eventBuffers.get(bufferKey)
  if (!buffer || !buffer.serverFed) return 0
  let added = 0
  buffer.store.bulk((store) => {
    for (const raw of events) {
      const event = asFleetEvent(raw)
      if (!store.get(event.id)) added++
      store.upsert(event)
    }
  })
  if (buffer.pinned) trimEventBuffer(buffer)
  return added
}

// Is this drop the unhydrated-participant case? Returns a diagnostic payload
// when the buffer's filter names an agent BY NAME and one of the event's
// participants is a fleet: id absent from the roster — the exact condition
// under which labelSetForParticipant (filter-semantics.mjs:9) answers only to
// the raw id, so a name term cannot match. Returns null for ordinary drops
// (every panel correctly rejects most traffic).
//
// Cheap by construction: only runs on the reject branch, and only for chat.
function unresolvedParticipantDrop(buffer: EventBuffer, event: FleetEvent): Record<string, unknown> | null {
  if (event.type !== 'chat') return null
  const filter = buffer.filter as unknown[] | null
  if (!Array.isArray(filter) || filter.length === 0) return null

  const namesInFilter: string[] = []
  for (const clause of filter) {
    if (!Array.isArray(clause)) continue
    for (const term of clause) {
      const label = Array.isArray(term) ? term[1] : term
      if (typeof label === 'string' && label && !label.startsWith('fleet:')) namesInFilter.push(label)
    }
  }
  if (namesInFilter.length === 0) return null

  const roster = getFleetAgents()
  const participants = [event.from, event.to].filter(
    (p): p is string => typeof p === 'string' && p.startsWith('fleet:')
  )
  const unresolved = participants.filter((id) => !roster.some((a: FleetAgent) => a.id === id))
  if (unresolved.length === 0) return null

  // EXACTNESS GATE. An unresolved participant is not enough — a panel filtered
  // `dm:todd` correctly rejects traffic between two unrelated agents even when
  // one of them is unhydrated, and flagging that would be noise dressed as the
  // bug. Only report when the unresolved participant IS an id one of this
  // panel's own filter names resolves to: then resolving would have flipped the
  // verdict, and this panel should have shown this message.
  const culprits: { id: string; name: string }[] = []
  for (const name of namesInFilter) {
    const ids = filterNameIds(name)
    if (!ids) continue
    for (const id of unresolved) if (ids.has(id)) culprits.push({ id, name })
  }
  if (culprits.length === 0) return null

  return {
    eventDbId: event._dbId ?? null,
    from: event.from ?? null,
    to: event.to ?? null,
    culprits,
    namesInFilter,
    rosterSize: roster.length,
  }
}

function fanoutEventToBuffers(event: FleetEvent): void {
  for (const [bufferKey, buffer] of eventBuffers) {
    // A server-fed buffer is not fed from here. Its rows arrive through
    // applyFilterEvents, from the subscription that asked for them.
    if (buffer.serverFed) continue
    const belongs = buffer.matchesFilter(buffer.filter, event)
    // The client's own membership verdict, recorded for comparison against the
    // server's. This IS the decision we intend to delete — recording it while it
    // still runs is the only way to prove the replacement agrees before the old
    // path goes. Keyed by bufferKey, which the subscription carries as its
    // correlationKey so the two verdicts line up on one event.
    // Only compare when a subscription is actually live for this panel. A
    // viewport-culled panel has no subscription, so recording its verdict would
    // fabricate a server-missed disagreement for every event while it is
    // off-screen — and that direction is unthrottled because it is supposed to
    // have no benign explanation.
    // Live deliveries only, and only while a subscription exists. Either gate
    // missing turns server-missed — the direction reported unthrottled because
    // it has no benign explanation — into noise with two.
    if (_liveDeliveryDepth > 0 && event.type === 'chat' && hasChatSubscription(bufferKey)) {
      noteClientVerdict(bufferKey, event.id, belongs, JSON.stringify(buffer.filter ?? null))
    }
    if (belongs) {
      // Count LIVE deliveries the panel would actually RENDER — see the
      // _bulkIngestDepth note above for history, and isRenderableInPanel for the
      // types the buffer accepts but chatMessages drops.
      if (_bulkIngestDepth === 0 && isRenderableInPanel(event)) noteBufferMatch(bufferKey)
      buffer.store.upsert(event)
      if (buffer.pinned) trimEventBuffer(buffer)
    } else {
      buffer.store.remove(event.id)
      noteBufferDrop(bufferKey, getLastEventId(), unresolvedParticipantDrop(buffer, event))
    }
  }
}

function trimEventBuffer(buffer: EventBuffer): void {
  const overflow = buffer.store.size - buffer.maxEvents
  if (overflow <= 0) return
  const oldest = [...buffer.store.all()]
    .sort(compareFleetEvents)
    .slice(0, overflow)
  buffer.store.bulk((store) => {
    for (const event of oldest) store.remove(event.id)
  })
}

export function setFleetEventBufferPinned(bufferKey: string | null | undefined, pinned: boolean): void {
  if (!bufferKey) return
  const buffer = eventBuffers.get(bufferKey)
  if (!buffer) return
  buffer.pinned = !!pinned
  if (buffer.pinned) trimEventBuffer(buffer)
}

export function clearFleetEventBuffer(bufferKey: string | null | undefined): void {
  if (!bufferKey) return
  const buffer = eventBuffers.get(bufferKey)
  if (!buffer) return
  buffer.store.dispose()
  eventBuffers.delete(bufferKey)
}

export function upsertFleetEvent(event: Record<string, unknown> | null | undefined): void {
  if (!event) return
  const fleetEvent = asFleetEvent(event)
  eventStore.upsert(fleetEvent)
  fanoutEventToBuffers(fleetEvent)
}

// Bulk ingest is history, not delivery. It reaches fanoutEventToBuffers through
// upsertFleetEvent exactly like a live event does, so without this depth guard a
// mid-session history load (loadFleetHistoryForAgents, the scrollback path)
// inflates every buffer's matched-event count by hundreds of OLD messages — and
// the stall check then reports a panel as behind when nothing new ever arrived.
// That is what produced matchGap frozen at 218 across three reports on
// 2026-07-25; those records are inflated and are not evidence of anything.
let _bulkIngestDepth = 0

// Only the WS fleet-event handler is a LIVE delivery. Reconnect backfill and
// scrollback reach fanoutEventToBuffers through the same functions, with
// _bulkIngestDepth at 0 — so depth alone cannot tell them apart, and a
// backfilled event recorded as a client verdict is a server-missed disagreement
// the server was never going to answer. chief3 caught exactly that: six records
// for event ids ~15,000 behind the head, all in one second.
let _liveDeliveryDepth = 0
export function inLiveDelivery<T>(fn: () => T): T {
  _liveDeliveryDepth += 1
  try { return fn() } finally { _liveDeliveryDepth -= 1 }
}

export function upsertFleetEvents(events: readonly Record<string, unknown>[]): void {
  _bulkIngestDepth += 1
  try {
    eventStore.bulk(() => {
      for (const event of events) upsertFleetEvent(event)
    })
  } finally {
    _bulkIngestDepth -= 1
  }
}

export function upsertFleetEventsForBuffer(
  bufferKey: string | null | undefined,
  events: readonly Record<string, unknown>[],
  opts: { beforeNotify?: (added: number) => void } = {}
): number {
  if (!bufferKey) {
    upsertFleetEvents(events)
    return events.length
  }
  const buffer = eventBuffers.get(bufferKey)
  const store = buffer?.store ?? createLiveStore<FleetEvent>()
  if (!buffer) {
    eventBuffers.set(bufferKey, {
      store,
      filter: null,
      matchesFilter: () => true,
      pinned: true,
      maxEvents: DEFAULT_BUFFER_MAX_EVENTS,
      serverFed: isServerFedBufferKey(bufferKey),
    })
  }
  const fleetEvents = events.map(asFleetEvent)
  let added = 0
  for (const event of fleetEvents) {
    if (!store.has(event.id)) added++
  }
  if (added && opts.beforeNotify) opts.beforeNotify(added)
  store.bulk(() => {
    for (const event of fleetEvents) store.upsert(event)
  })
  return added
}

export function removeFleetEvent(event: Record<string, unknown> | null | undefined): void {
  if (!event) return
  const id = eventIds.get(event) ?? keyOfEvent(event)
  removeEventIdFromStores(id)
  eventIds.delete(event)
}

export function replaceFleetEvents(events: readonly Record<string, unknown>[]): void {
  eventStore.bulk((store) => {
    for (const event of store.all()) store.remove(event.id)
    for (const event of events) store.upsert(asFleetEvent(event))
  })
  for (const buffer of eventBuffers.values()) reconcileEventBuffer(buffer)
}

export function getFleetEvents(): readonly FleetEvent[] {
  return eventStore.all()
}

export function getFilteredFleetEvents(
  filter: FleetEventFilter | null,
  opts: { matchesFilter: FleetEventMatcher; bufferKey?: string | null }
): readonly FleetEvent[] {
  if (!opts.bufferKey) {
    return eventStore.all()
      .filter((event) => opts.matchesFilter(filter, event))
      .sort(compareFleetEvents)
  }
  const buffer = eventBuffer(opts.bufferKey, filter, opts.matchesFilter)
  // A server-fed buffer contains exactly what the server said belongs. Running
  // the client predicate over it again would reinstate the decision this change
  // removes — and would silently hide any row the browser's partial roster
  // can't resolve, which is the original bug wearing a read-side hat.
  if (buffer.serverFed) return buffer.store.all().slice().sort(compareFleetEvents)
  return buffer.store.all()
    .filter((event) => opts.matchesFilter(filter, event))
    .sort(compareFleetEvents)
}

export function viewFleetEvents(
  filter: FleetEventFilter | null,
  opts: { key: string; matchesFilter: FleetEventMatcher; bufferKey?: string | null }
): LiveView<FleetEvent> {
  const predicate = (event: FleetEvent) => opts.matchesFilter(filter, event)
  if (!opts.bufferKey) return eventStore.view(predicate, { key: opts.key, compare: compareFleetEvents })
  const buffer = eventBuffer(opts.bufferKey, filter, opts.matchesFilter)
  // Same rule as getFilteredFleetEvents: a server-fed buffer holds only rows the
  // server said belong, so the view takes all of them.
  const view = buffer.serverFed ? () => true : predicate
  return buffer.store.view(view, {
    key: `${opts.key}:buffer:${opts.bufferKey}`,
    compare: compareFleetEvents,
  })
}

function asFleetAgent(agent: Record<string, unknown>): FleetAgent | null {
  if (typeof agent.id !== 'string' || !agent.id) return null
  return agent as FleetAgent
}

export function replaceFleetAgents(agents: readonly Record<string, unknown>[]): void {
  agentStore.bulk((store) => {
    for (const agent of store.all()) store.remove(agent.id)
    for (const agent of agents) {
      const rec = asFleetAgent(agent)
      if (rec) store.upsert(rec)
    }
  })
}

export function upsertFleetAgents(agents: readonly Record<string, unknown>[] | null | undefined): void {
  if (!agents?.length) return
  agentStore.bulk((store) => {
    for (const agent of agents) {
      const rec = asFleetAgent(agent)
      if (rec) store.upsert(rec)
    }
  })
}

export function removeFleetAgents(ids: readonly string[] | null | undefined): void {
  if (!ids?.length) return
  agentStore.bulk((store) => {
    for (const id of ids) store.remove(id)
  })
}

export function getFleetAgents(): readonly FleetAgent[] {
  return agentStore.all()
}

export function getAwakeFleetAgentCount(): number {
  return awakeAgentIndex.get(true).length
}

function termLabel(term: unknown): string {
  return Array.isArray(term) ? String(term[1] || '') : String(term || '')
}

function filterLabels(filter: FleetAgentFilter): Set<string> {
  const labels = new Set<string>()
  if (!filter) return labels
  for (const clause of filter) {
    if (!Array.isArray(clause)) continue
    for (const term of clause) {
      const label = termLabel(term)
      if (label) labels.add(label)
    }
  }
  return labels
}

function agentIdsForLabel(label: string, opts: { status?: string } = {}): Set<string> {
  const ids = new Set<string>()
  if (!label) return ids
  const direct = agentStore.get(label)
  if (label.startsWith('fleet:') && (!opts.status || (direct && direct.runtime_status?.status === opts.status))) {
    ids.add(label)
  }
  const bucket = agentLabelIndex.get(label)
  const hasLiveHolder = bucket.some((agent) => !agent.dead)
  for (const agent of bucket) {
    if (agent.dead && hasLiveHolder) continue
    if (opts.status && agent.runtime_status?.status !== opts.status) continue
    ids.add(agent.id)
  }
  return ids
}

export function getResolvedFleetAgentIdsForLabel(
  label: string,
  opts: { status?: string } = {}
): readonly string[] {
  return [...agentIdsForLabel(label, opts)]
}

export function getResolvedFleetAgentIds(
  filter: FleetAgentFilter,
  opts: { status?: string } = {}
): readonly string[] {
  if (!filter || filter.length === 0) return []
  const ids = new Set<string>()
  for (const label of filterLabels(filter)) {
    for (const id of agentIdsForLabel(label, opts)) ids.add(id)
  }
  return [...ids]
}

function idsForClauseLabel(label: string, human: { id?: string | null; name?: string | null } = {}): Set<string> {
  const ids = agentIdsForLabel(label)
  if (human.id && (label === human.id || label === (human.name || 'user'))) ids.add(human.id)
  return ids
}

function intersects(a: Set<string>, b: Set<string>): Set<string> {
  const next = new Set<string>()
  for (const value of a) {
    if (b.has(value)) next.add(value)
  }
  return next
}

export function fleetFilterHasMatchingAgent(
  filter: FleetAgentFilter,
  human: { id?: string | null; name?: string | null } = {}
): boolean {
  if (!filter || filter.length === 0) return true
  for (const clause of filter) {
    if (!Array.isArray(clause) || clause.length === 0) continue
    let possible: Set<string> | null = null
    for (const term of clause) {
      const label = termLabel(term)
      if (!label) continue
      const ids = idsForClauseLabel(label, human)
      possible = possible ? intersects(possible, ids) : ids
      if (possible.size === 0) break
    }
    if (possible && possible.size > 0) return true
  }
  return false
}

export function subscribeFleetAgents(cb: () => void): () => void {
  return agentStore.listen(() => cb())
}
