import type { LiveStore, LiveView } from '../../shared/live-store.ts'
import { createLiveStore } from '../../shared/live-store.ts'
import { labelsForAgent } from '../../shared/fleet-labels.mjs'
// @ts-ignore - shared JS module
import { isRuntimeAwake } from '../../shared/fleet-runtime-status.mjs'
import { setLiveStoreObserver } from '../../shared/live-store.ts'
import { noteBufferDrop, noteDisposedViewTouched, noteViewRef, startFreezeCensus } from './chat-freeze-probe.mjs'
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
    }
    eventBuffers.set(bufferKey, buffer)
    seedEventBuffer(buffer)
    return buffer
  }
  buffer.filter = filter
  buffer.matchesFilter = matchesFilter
  reconcileEventBuffer(buffer)
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

function fanoutEventToBuffers(event: FleetEvent): void {
  for (const [bufferKey, buffer] of eventBuffers) {
    if (buffer.matchesFilter(buffer.filter, event)) {
      buffer.store.upsert(event)
      if (buffer.pinned) trimEventBuffer(buffer)
    } else {
      buffer.store.remove(event.id)
      noteBufferDrop(bufferKey, getLastEventId())
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

export function upsertFleetEvents(events: readonly Record<string, unknown>[]): void {
  eventStore.bulk(() => {
    for (const event of events) upsertFleetEvent(event)
  })
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
  return eventBuffer(opts.bufferKey, filter, opts.matchesFilter)
    .store.all()
    .filter((event) => opts.matchesFilter(filter, event))
    .sort(compareFleetEvents)
}

export function viewFleetEvents(
  filter: FleetEventFilter | null,
  opts: { key: string; matchesFilter: FleetEventMatcher; bufferKey?: string | null }
): LiveView<FleetEvent> {
  const predicate = (event: FleetEvent) => opts.matchesFilter(filter, event)
  if (!opts.bufferKey) return eventStore.view(predicate, { key: opts.key, compare: compareFleetEvents })
  return eventBuffer(opts.bufferKey, filter, opts.matchesFilter).store.view(predicate, {
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
