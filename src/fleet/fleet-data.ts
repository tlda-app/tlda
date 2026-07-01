import type { LiveStore, LiveView } from '../../shared/live-store.ts'
import { createLiveStore } from '../../shared/live-store.ts'
import { labelsForAgent } from '../../shared/fleet-labels.mjs'

export type FleetEvent = Record<string, unknown> & {
  id: string
  _dbId?: string | number
  _tempId?: string
}

export type FleetEventFilter = unknown
export type FleetEventMatcher = (filter: FleetEventFilter | null, event: FleetEvent) => boolean

const eventIds = new WeakMap<object, string>()

let eventStore: LiveStore<FleetEvent> = createLiveStore<FleetEvent>()

export type FleetAgent = Record<string, unknown> & {
  id: string
  friendly_name?: string
  status?: string
  labels?: string[]
  dead?: boolean
}

export type FleetAgentFilter = [string, string][][] | null

let agentStore: LiveStore<FleetAgent> = createLiveStore<FleetAgent>()
let agentLabelIndex = agentStore.index<string>('labels', (agent) => labelsForAgent(agent))

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
  if (previousId && previousId !== id) eventStore.remove(previousId)
  eventIds.set(event, id)
  Object.defineProperty(event, 'id', {
    value: id,
    enumerable: false,
    configurable: true,
    writable: true,
  })
  return event as FleetEvent
}

export function upsertFleetEvent(event: Record<string, unknown> | null | undefined): void {
  if (!event) return
  eventStore.upsert(asFleetEvent(event))
}

export function upsertFleetEvents(events: readonly Record<string, unknown>[]): void {
  eventStore.bulk(() => {
    for (const event of events) upsertFleetEvent(event)
  })
}

export function removeFleetEvent(event: Record<string, unknown> | null | undefined): void {
  if (!event) return
  const id = eventIds.get(event) ?? keyOfEvent(event)
  eventStore.remove(id)
  eventIds.delete(event)
}

export function replaceFleetEvents(events: readonly Record<string, unknown>[]): void {
  eventStore.bulk((store) => {
    for (const event of store.all()) store.remove(event.id)
    for (const event of events) store.upsert(asFleetEvent(event))
  })
}

export function getFleetEvents(): readonly FleetEvent[] {
  return eventStore.all()
}

export function getFilteredFleetEvents(
  filter: FleetEventFilter | null,
  opts: { matchesFilter: FleetEventMatcher }
): readonly FleetEvent[] {
  return eventStore.all().filter((event) => opts.matchesFilter(filter, event))
}

export function viewFleetEvents(
  filter: FleetEventFilter | null,
  opts: { key: string; matchesFilter: FleetEventMatcher }
): LiveView<FleetEvent> {
  const predicate = (event: FleetEvent) => opts.matchesFilter(filter, event)
  return eventStore.view(predicate, { key: opts.key })
}

export function resetFleetEventStoreForTest(events: readonly Record<string, unknown>[] = []): void {
  eventStore.dispose()
  eventStore = createLiveStore<FleetEvent>()
  replaceFleetEvents(events)
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
  if (label.startsWith('fleet:') && (!opts.status || agentStore.get(label)?.status === opts.status)) {
    ids.add(label)
  }
  const bucket = agentLabelIndex.get(label)
  const hasLiveHolder = bucket.some((agent) => !agent.dead)
  for (const agent of bucket) {
    if (agent.dead && hasLiveHolder) continue
    if (opts.status && agent.status !== opts.status) continue
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

export function resetFleetAgentStoreForTest(agents: readonly Record<string, unknown>[] = []): void {
  agentStore.dispose()
  agentStore = createLiveStore<FleetAgent>()
  agentLabelIndex = agentStore.index<string>('labels', (agent) => labelsForAgent(agent))
  replaceFleetAgents(agents)
}
