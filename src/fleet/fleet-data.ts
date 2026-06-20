import type { LiveStore, LiveView } from '../../shared/live-store.ts'
import { createLiveStore } from '../../shared/live-store.ts'

export type FleetEvent = Record<string, unknown> & {
  id: string
  _dbId?: string | number
  _tempId?: string
}

export type FleetEventFilter = unknown
export type FleetEventMatcher = (filter: FleetEventFilter | null, event: FleetEvent) => boolean

const eventIds = new WeakMap<object, string>()

let eventStore: LiveStore<FleetEvent> = createLiveStore<FleetEvent>()

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
