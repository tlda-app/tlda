/**
 * fleet-data-adapter.ts — React hooks wrapping fleet-data.mjs
 *
 * Lazy-inits on first use. Each hook subscribes via fleet-data's
 * subscribe() and re-renders on updates. One SSE connection shared
 * across all fleet shapes.
 */
import { useMemo, useState, useEffect, useCallback, useRef, useSyncExternalStore } from 'react'
import {
  init,
  subscribe,
  getAgents,
  getAgentTotals,
  getTasks,
  getItems,
  getUnreadCountsForHuman,
  getHumanId,
  getHumanName,
  loadNextAgentsPage,
  hydrateFleetAgentsForFilter,
  needsIdentity as _needsIdentity,
  login as _login,
  registerHuman as _registerHuman,
  sendMessage as _sendMessage,
  fetchHistory,
  loadBefore,
  receiveFilterEvents,
  matchesFilter,
  resolveFilter,
  respawnAgent as _respawnAgent,
  killSession as _killSession,
  hibernateSession as _hibernateSession,
  spawnAgent as _spawnAgent,
  isConnected as _isConnected,
  injectOptimisticEvent as _injectOptimisticEvent,
  updateOptimisticEvent as _updateOptimisticEvent,
  removeOptimisticEvent as _removeOptimisticEvent,
  reconcileOptimistic as _reconcileOptimistic,
  fleetEphemeral as _fleetEphemeral,
  fleetDurable as _fleetDurable,
  dismissItem as _dismissItem,
  // @ts-ignore — vanilla JS module
} from './fleet/fleet-data.mjs'
import {
  fleetFilterHasMatchingAgent,
  getAwakeFleetAgentCount,
  getFleetAgents,
  getFilteredFleetEvents,
  getResolvedFleetAgentIdsForLabel,
  getResolvedFleetAgentIds,
  subscribeFleetAgents,
  upsertFleetEvents,
  viewFleetEvents,
  type FleetEvent,
} from './fleet/fleet-data.ts'
import { resolveFleetFilter } from '../shared/filter-semantics.mjs'
import {
  getPlaybackData,
  subscribePlayback,
  getPlaybackChatEvents,
  getPlaybackAgents,
} from './playback-context'
import { log } from './logger'
import { noteSnapshot, forgetSnapshot } from './fleet/chat-freeze-probe.mjs'
import { getLastEventId } from './fleet/fleet-data.mjs'
import { loadPrefs } from './preferences'
import { chatAgentSignature } from './fleet/chat-agent-signature'

// Load prefs whenever the user's fleet identity is established
subscribe('identity', null, (ev: any) => {
  const userId = ev.id || getHumanId()
  if (userId) loadPrefs(userId)
})

// --- Lazy initialization ---

let initPromise: Promise<void> | null = null

function ensureInit(): Promise<void> {
  if (!initPromise) {
    initPromise = init()
  }
  return initPromise!
}

// --- Page Visibility gating ---
//
// When a browser tab is hidden, fleet SSE events still arrive and React state
// setters fire, causing re-renders in all mounted shapes even though nothing
// is visible. This wastes CPU, especially when playwright has a second tab
// open to the same doc.
//
// Strategy: skip state updates while hidden. On tab restore, all registered
// refresh functions run once to bring hooks back to current state.

let _tabVisible = typeof document !== 'undefined' ? !document.hidden : true
const _refreshRegistry = new Set<() => void>()

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    _tabVisible = !document.hidden
    if (_tabVisible) {
      for (const fn of _refreshRegistry) fn()
    }
  })
}

/**
 * Wraps a state-setter so it only fires when the tab is visible.
 * Pass `refresh` — a function that re-reads current state — to be called
 * on tab restore. The returned cleanup removes the refresh registration.
 */
function visibilityGate(update: () => void, refresh: () => void): [() => void, () => void] {
  _refreshRegistry.add(refresh)
  const gated = () => { if (_tabVisible) update() }
  const cleanup = () => _refreshRegistry.delete(refresh)
  return [gated, cleanup]
}

/**
 * Returns a debounced version of `fn` that waits 16ms (one frame) before
 * calling. Multiple calls within the window coalesce into one.
 * Returns a cleanup that cancels any pending timer.
 */
function debounce16(fn: () => void): [() => void, () => void] {
  let timer: ReturnType<typeof setTimeout> | null = null
  const debounced = () => {
    if (!timer) timer = setTimeout(() => { timer = null; fn() }, 16)
  }
  const cancel = () => { if (timer !== null) { clearTimeout(timer); timer = null } }
  return [debounced, cancel]
}

// --- Hooks ---

export function useFleetAgents(frameId?: string): any[] {
  const [agents, setAgents] = useState<any[]>([])

  useEffect(() => {
    let liveUnsub: (() => void) | null = null
    let playbackUnsub: (() => void) | null = null
    let cancelled = false
    let isPlaybackMode = false

    function setupLive() {
      if (cancelled) return
      ensureInit().then(() => {
        if (cancelled || isPlaybackMode) return
        setAgents([...getAgents()])
        const refresh = () => { if (!cancelled) setAgents([...getAgents()]) }
        const [debounced, cancelDebounce] = debounce16(refresh)
        const [gated, cleanupGate] = visibilityGate(debounced, refresh)
        const rawUnsub = subscribe('agents', null, gated)
        liveUnsub = () => { rawUnsub(); cleanupGate(); cancelDebounce() }
      })
    }

    if (frameId && frameId.startsWith('shape:')) {
      const pb = getPlaybackData(frameId)
      if (pb) {
        isPlaybackMode = true
        setAgents(getPlaybackAgents(pb))
      } else {
        setupLive()
      }

      playbackUnsub = subscribePlayback(frameId, () => {
        const pb = getPlaybackData(frameId)
        if (pb) {
          isPlaybackMode = true
          liveUnsub?.()
          liveUnsub = null
          setAgents(getPlaybackAgents(pb))
        }
      })
    } else {
      setupLive()
    }

    return () => {
      cancelled = true
      liveUnsub?.()
      playbackUnsub?.()
    }
  }, [frameId])

  return agents
}

export function useFleetAgentTotals(frameId?: string): { awake: number; hibernating: number; total: number } {
  const [totals, setTotals] = useState(getAgentTotals)

  useEffect(() => {
    if (frameId?.startsWith('shape:')) return
    let cancelled = false
    void ensureInit().then(() => {
      if (cancelled) return
      setTotals(getAgentTotals())
    })
    return subscribe('agents', null, () => {
      if (!cancelled) setTotals(getAgentTotals())
    })
  }, [frameId])

  return totals
}

export { loadNextAgentsPage }

export function useFleetChatAgents(frameId?: string): any[] {
  const [agents, setAgents] = useState<any[]>([])
  const signatureRef = useRef('')

  useEffect(() => {
    let liveUnsub: (() => void) | null = null
    let playbackUnsub: (() => void) | null = null
    let cancelled = false
    let isPlaybackMode = false

    const publish = (nextAgents: any[]) => {
      const nextSignature = chatAgentSignature(nextAgents)
      if (signatureRef.current === nextSignature) return
      signatureRef.current = nextSignature
      setAgents(nextAgents)
    }

    function setupLive() {
      if (cancelled) return
      ensureInit().then(() => {
        if (cancelled || isPlaybackMode) return
        publish([...getAgents()])
        const refresh = () => { if (!cancelled) publish([...getAgents()]) }
        const [debounced, cancelDebounce] = debounce16(refresh)
        const [gated, cleanupGate] = visibilityGate(debounced, refresh)
        const rawUnsub = subscribe('agents', null, gated)
        liveUnsub = () => { rawUnsub(); cleanupGate(); cancelDebounce() }
      })
    }

    if (frameId && frameId.startsWith('shape:')) {
      const pb = getPlaybackData(frameId)
      if (pb) {
        isPlaybackMode = true
        publish(getPlaybackAgents(pb))
      } else {
        setupLive()
      }

      playbackUnsub = subscribePlayback(frameId, () => {
        const pb = getPlaybackData(frameId)
        if (pb) {
          isPlaybackMode = true
          liveUnsub?.()
          liveUnsub = null
          publish(getPlaybackAgents(pb))
        }
      })
    } else {
      setupLive()
    }

    return () => {
      cancelled = true
      liveUnsub?.()
      playbackUnsub?.()
    }
  }, [frameId])

  return agents
}

export function useFleetRosterTruth(): any | null {
  const [truth, setTruth] = useState<any | null>(null)

  useEffect(() => {
    let cancelled = false
    const refresh = () => {
      _fleetEphemeral('fleet-roster-truth', { limit: 1 })
        .then((data: any) => { if (!cancelled) setTruth(data) })
        .catch(() => { if (!cancelled) setTruth(null) })
    }
    refresh()
    const timer = setInterval(refresh, 30000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  return truth
}


export function useFleetTasks(frameId?: string): any[] {
  const [tasks, setTasks] = useState<any[]>([])

  useEffect(() => {
    // Playback mode: no task data (tasks not in recording)
    if (frameId && getPlaybackData(frameId)) return

    let unsub: (() => void) | null = null
    let cancelled = false

    ensureInit().then(() => {
      if (cancelled) return
      setTasks([...getTasks()])
      const refresh = () => { if (!cancelled) setTasks([...getTasks()]) }
      const [debounced, cancelDebounce] = debounce16(refresh)
      const [gated, cleanupGate] = visibilityGate(debounced, refresh)
      const rawUnsub = subscribe('tasks', null, gated)
      unsub = () => { rawUnsub(); cleanupGate(); cancelDebounce() }
    })

    return () => {
      cancelled = true
      unsub?.()
    }
  }, [frameId])

  return tasks
}

/**
 * Subscribe to fleet chat events, optionally filtered.
 * Accepts a DNF filter: string[][] (OR of ANDs), or null for all.
 */

export function useFleetEvents(dnfFilter?: [string, string][][] | null, frameId?: string, bufferKey?: string | null): any[] {
  const [playbackEvents, setPlaybackEvents] = useState<any[]>([])
  const [isPlaybackMode, setIsPlaybackMode] = useState(false)
  const filterKey = dnfFilter ? JSON.stringify(dnfFilter) : ''
  const eventViewKey = `${filterKey}\n${bufferKey || ''}`
  const filter = useMemo(() => dnfFilter && dnfFilter.length > 0 ? dnfFilter : null, [filterKey])
  const liveSnapshotRef = useRef<{ key: string; list: readonly FleetEvent[] } | null>(null)
  const liveMatcher = useCallback(
    (f: unknown, ev: FleetEvent) => matchesFilter(f as [string, string][][] | null, ev),
    [],
  )
  const getLiveSnapshot = useCallback(() => {
    const cached = liveSnapshotRef.current
    if (cached?.key === eventViewKey) return cached.list
    const list = getFilteredFleetEvents(filter, { matchesFilter: liveMatcher, bufferKey })
    liveSnapshotRef.current = { key: eventViewKey, list }
    // A recompute that yields the reference-identical array is React being handed
    // "nothing changed" — a frozen panel, at the React boundary. Only reported
    // when the transport has moved on meanwhile; see chat-freeze-probe.mjs.
    noteSnapshot(eventViewKey, list, getLastEventId(), 'recompute')
    return list
  }, [filter, eventViewKey, liveMatcher, bufferKey])
  const subscribeLive = useCallback((onStoreChange: () => void) => {
    const liveView = viewFleetEvents(filter, {
      key: eventViewKey || 'all',
      matchesFilter: liveMatcher,
      bufferKey,
    })
    liveSnapshotRef.current = { key: eventViewKey, list: liveView.get() }
    const unsubscribe = liveView.subscribe((list) => {
      liveSnapshotRef.current = { key: eventViewKey, list }
      onStoreChange()
    })
    const unsubscribeAgents = subscribe('agents', null, () => {
      liveSnapshotRef.current = null
      onStoreChange()
    })
    return () => {
      unsubscribe()
      unsubscribeAgents()
      liveView.dispose()
      forgetSnapshot(eventViewKey)
      if (liveSnapshotRef.current?.key === eventViewKey) liveSnapshotRef.current = null
    }
  }, [filter, eventViewKey, liveMatcher, bufferKey])
  const liveEvents = useSyncExternalStore(subscribeLive, getLiveSnapshot, getLiveSnapshot)

  // Single effect handles both playback and live modes.
  // If frameId is a shape ID: subscribe to the playback registry first.
  // When registry data arrives, switch to playback events.
  // If no registry data, fall through to live SSE.
  useEffect(() => {
    let liveUnsub: (() => void) | null = null
    let playbackUnsub: (() => void) | null = null
    let liveUnsync: (() => void) | null = null
    let cancelled = false

    // Clear stale state from previous filter immediately
    setPlaybackEvents([])
    setIsPlaybackMode(false)

    function setupLive() {
      if (cancelled) return
      ensureInit().then(() => {
        if (cancelled) return
        setIsPlaybackMode(false)
        void hydrateFleetAgentsForFilter(filter)
      })
    }

    function setupPlayback(pb: ReturnType<typeof getPlaybackData>) {
      if (!pb) return false
      setIsPlaybackMode(true)
      // Tear down live subscription if it was running
      liveUnsub?.()
      liveUnsub = null
      setPlaybackEvents(getPlaybackChatEvents(pb, filter))
      return true
    }

    // If frameId looks like a shape (not a page), check the playback registry
    if (frameId && frameId.startsWith('shape:')) {
      // Try to use playback data immediately if already registered
      const pb = getPlaybackData(frameId)
      if (!setupPlayback(pb)) {
        // Not registered yet — start live while waiting
        setupLive()
      }

      // Subscribe to registry: when PlaybackFrame loads, switch sources
      playbackUnsub = subscribePlayback(frameId, () => {
        const pb = getPlaybackData(frameId)
        if (pb) {
          // Cancel live, switch to playback
          liveUnsub?.()
          liveUnsub = null
          liveUnsync?.()
          liveUnsync = null
          setPlaybackEvents(getPlaybackChatEvents(pb, filter))
          setIsPlaybackMode(true)
        }
      })
    } else {
      setupLive()
    }

    return () => {
      cancelled = true
      liveUnsub?.()
      liveUnsync?.()
      playbackUnsub?.()
    }
  }, [frameId, filter, filterKey])

  return isPlaybackMode ? playbackEvents : [...liveEvents]
}

export async function loadFleetHistoryForAgents(agentIds: string[], limit = 300): Promise<number> {
  await ensureInit()
  const events = await fetchHistory(agentIds, limit)
  upsertFleetEvents(events)
  return events.length
}

type FleetStatusTargets = {
  statusTargetIds: Set<string> | null
  hibernatingAgents: Set<string>
}

const EMPTY_STATUS_TARGETS: FleetStatusTargets = {
  statusTargetIds: null,
  hibernatingAgents: new Set<string>(),
}

function statusTargetKey(targetIds: readonly string[], hibernatingIds: readonly string[]): string {
  return `${[...targetIds].sort().join(',')}\n${[...hibernatingIds].sort().join(',')}`
}

function makeStatusTargets(targetIds: readonly string[], hibernatingIds: readonly string[]): FleetStatusTargets {
  return {
    statusTargetIds: new Set(targetIds),
    hibernatingAgents: new Set(hibernatingIds),
  }
}

export function useFleetStatusTargets(dnfFilter?: [string, string][][] | null, frameId?: string): FleetStatusTargets {
  const filterKey = dnfFilter ? JSON.stringify(dnfFilter) : ''
  const filter = useMemo(() => dnfFilter && dnfFilter.length > 0 ? dnfFilter : null, [filterKey])
  const snapshotRef = useRef<{ key: string; value: FleetStatusTargets } | null>(null)

  const computeSnapshot = useCallback((): FleetStatusTargets => {
    if (!filter) return EMPTY_STATUS_TARGETS
    const playback = frameId && frameId.startsWith('shape:') ? getPlaybackData(frameId) : null
    const playbackAgents = playback ? (getPlaybackAgents(playback) as any[]) : null
    const targetIds: readonly string[] = playbackAgents
      ? [...((resolveFleetFilter as any)(filter, { agents: playbackAgents, humanId: getHumanId(), humanName: getHumanName() }) as Set<string>)]
      : getResolvedFleetAgentIds(filter)
    const hibernatingIds: readonly string[] = playbackAgents
      ? targetIds.filter((id) => playbackAgents.some((agent: any) => agent.id === id && agent.runtime_status?.status === 'hibernating'))
      : getResolvedFleetAgentIds(filter, { status: 'hibernating' })
    const key = `${filterKey}\n${statusTargetKey(targetIds, hibernatingIds)}`
    const cached = snapshotRef.current
    if (cached?.key === key) return cached.value
    const value = makeStatusTargets(targetIds, hibernatingIds)
    snapshotRef.current = { key, value }
    return value
  }, [filter, filterKey, frameId])

  const subscribeTargets = useCallback((onStoreChange: () => void) => {
    if (!filter) return () => {}
    const playbackFrame = frameId && frameId.startsWith('shape:') ? frameId : null
    if (playbackFrame && getPlaybackData(playbackFrame)) {
      return subscribePlayback(playbackFrame, () => {
        snapshotRef.current = null
        onStoreChange()
      })
    }
    void ensureInit()
    return subscribeFleetAgents(() => {
      const before = snapshotRef.current?.key ?? ''
      computeSnapshot()
      const after = snapshotRef.current?.key ?? ''
      if (before !== after) onStoreChange()
    })
  }, [computeSnapshot, filter, frameId])

  useEffect(() => {
    if (filter) void ensureInit()
  }, [filter])

  return useSyncExternalStore(subscribeTargets, computeSnapshot, computeSnapshot)
}

export function resolveFleetAgentLabelIds(label: string): string[] {
  if (!label) return []
  if (label.startsWith('fleet:')) return [label]
  return [...getResolvedFleetAgentIdsForLabel(label)]
}

export function useFleetFilterHasMatchingAgent(dnfFilter?: [string, string][][] | null, frameId?: string): boolean {
  const filterKey = dnfFilter ? JSON.stringify(dnfFilter) : ''
  const filter = useMemo(() => dnfFilter && dnfFilter.length > 0 ? dnfFilter : null, [filterKey])
  const snapshotRef = useRef<{ key: string; value: boolean } | null>(null)

  const computeSnapshot = useCallback((): boolean => {
    if (!filter) return true
    const playback = frameId && frameId.startsWith('shape:') ? getPlaybackData(frameId) : null
    if (playback) {
      return (resolveFleetFilter as any)(filter, {
        agents: getPlaybackAgents(playback),
        humanId: getHumanId(),
        humanName: getHumanName(),
      }).size > 0
    }
    const value = fleetFilterHasMatchingAgent(filter, { id: getHumanId(), name: getHumanName() })
    const key = `${filterKey}\n${value ? '1' : '0'}`
    const cached = snapshotRef.current
    if (cached?.key === key) return cached.value
    snapshotRef.current = { key, value }
    return value
  }, [filter, filterKey, frameId])

  const subscribeMatches = useCallback((onStoreChange: () => void) => {
    if (!filter) return () => {}
    const playbackFrame = frameId && frameId.startsWith('shape:') ? frameId : null
    if (playbackFrame && getPlaybackData(playbackFrame)) {
      return subscribePlayback(playbackFrame, () => {
        snapshotRef.current = null
        onStoreChange()
      })
    }
    void ensureInit()
    return subscribeFleetAgents(() => {
      const before = snapshotRef.current?.key ?? ''
      computeSnapshot()
      const after = snapshotRef.current?.key ?? ''
      if (before !== after) onStoreChange()
    })
  }, [computeSnapshot, filter, frameId])

  useEffect(() => {
    if (filter) void ensureInit()
  }, [filter])

  return useSyncExternalStore(subscribeMatches, computeSnapshot, computeSnapshot)
}

export function currentFleetAgents(): any[] {
  return [...getFleetAgents()]
}

export function useAwakeFleetAgentCount(frameId?: string): number {
  const snapshotRef = useRef<{ key: string; value: number } | null>(null)

  const computeSnapshot = useCallback((): number => {
    const playback = frameId && frameId.startsWith('shape:') ? getPlaybackData(frameId) : null
    if (playback) return getPlaybackAgents(playback).filter((agent: any) => !agent.dead && !agent.human && agent.runtime_status?.status === 'awake').length
    const value = getAwakeFleetAgentCount()
    const key = String(value)
    const cached = snapshotRef.current
    if (cached?.key === key) return cached.value
    snapshotRef.current = { key, value }
    return value
  }, [frameId])

  const subscribeCount = useCallback((onStoreChange: () => void) => {
    const playbackFrame = frameId && frameId.startsWith('shape:') ? frameId : null
    if (playbackFrame && getPlaybackData(playbackFrame)) {
      return subscribePlayback(playbackFrame, () => {
        snapshotRef.current = null
        onStoreChange()
      })
    }
    void ensureInit()
    return subscribeFleetAgents(() => {
      const before = snapshotRef.current?.key ?? ''
      computeSnapshot()
      const after = snapshotRef.current?.key ?? ''
      if (before !== after) onStoreChange()
    })
  }, [computeSnapshot, frameId])

  useEffect(() => {
    void ensureInit()
  }, [])

  return useSyncExternalStore(subscribeCount, computeSnapshot, computeSnapshot)
}


/**
 * Subscribe to thinking/status events for agents matching the filter.
 * Returns a Map of agentId → timestamp when thinking started (ms).
 */
export function useFleetThinking(dnfFilter?: string[][] | [string,string][][] | null, frameId?: string): Map<string, number> {
  const [thinking, setThinking] = useState<Map<string, number>>(new Map())
  const filterKey = dnfFilter ? JSON.stringify(dnfFilter) : ''

  useEffect(() => {
    // Playback mode: no live thinking indicators
    if (frameId && getPlaybackData(frameId)) return

    let unsubThinking: (() => void) | null = null
    let unsubSync: (() => void) | null = null
    let cancelled = false
    const filter = dnfFilter && dnfFilter.length > 0 ? dnfFilter : null

    ensureInit().then(() => {
      if (cancelled) return

      // null filter = all agents; non-null = only agents matching the current chat filter
      function inFilter(agentId: string): boolean {
        if (!filter) return true
        return matchesFilter(filter, { agent: agentId, from: agentId })
      }

      // The DAEMON owns the thinking transition: it reads the spinner and applies
      // the idle hysteresis, then emits ONE clean edge. The client just reflects
      // it — true shows, false stops showing. No client-side hold and no
      // reconstruction from message/status events; that hold was papering over the
      // old unreliable producer and was exactly why turn-end looked stuck.
      unsubThinking = subscribe('thinking', null, (data: any) => {
        if (!inFilter(data.agent)) return
        setThinking(prev => {
          const has = prev.has(data.agent)
          if (data.thinking) {
            if (has) return prev
            const next = new Map(prev)
            next.set(data.agent, data.startTs || data.ts || Date.now())
            log.info('thinking-line', 'edge true', { agent: data.agent })
            return next
          }
          if (!has) return prev
          const next = new Map(prev)
          next.delete(data.agent)
          log.info('thinking-line', 'edge false', { agent: data.agent })
          return next
        })
      })

      // Server's authoritative set — reconciles a late join or any missed edge.
      // The daemon edge is fire-and-forget, so a client that was disconnected when
      // an edge fired converges here.
      unsubSync = subscribe('thinking-sync', null, (serverSet: Set<string>) => {
        setThinking(prev => {
          let changed = false
          const next = new Map(prev)
          for (const id of next.keys()) {
            if (!serverSet.has(id)) { next.delete(id); changed = true }
          }
          return changed ? next : prev
        })
      })
    })

    return () => {
      cancelled = true
      unsubThinking?.()
      unsubSync?.()
      setThinking(new Map())
    }
  }, [filterKey])

  return thinking
}

/**
 * Subscribe to compacting events for agents matching the filter.
 * Returns a Map of agentId → timestamp when compacting started (ms).
 */
export function useFleetCompacting(dnfFilter?: string[][] | [string,string][][] | null, frameId?: string): Map<string, number> {
  const [compacting, setCompacting] = useState<Map<string, number>>(new Map())
  const filterKey = dnfFilter ? JSON.stringify(dnfFilter) : ''

  useEffect(() => {
    // Playback mode: no live compacting indicators
    if (frameId && getPlaybackData(frameId)) return

    let unsub: (() => void) | null = null
    let unsubSync: (() => void) | null = null
    let cancelled = false
    const filter = dnfFilter && dnfFilter.length > 0 ? dnfFilter : null

    ensureInit().then(() => {
      if (cancelled || !filter) return

      function inFilter(agentId: string): boolean {
        return matchesFilter(filter, { agent: agentId, from: agentId })
      }

      unsub = subscribe('compacting', null, (data: any) => {
        if (!inFilter(data.agent)) return
        setCompacting(prev => {
          const next = new Map(prev)
          if (data.compacting) next.set(data.agent, Date.now())
          else next.delete(data.agent)
          return next
        })
      })

      // Server state sync — clear agents not in the server's authoritative set
      unsubSync = subscribe('compacting-sync', null, (serverSet: Set<string>) => {
        setCompacting(prev => {
          let changed = false
          const next = new Map(prev)
          for (const id of next.keys()) {
            if (!serverSet.has(id)) { next.delete(id); changed = true }
          }
          return changed ? next : prev
        })
      })
    })

    return () => {
      cancelled = true
      unsub?.()
      unsubSync?.()
      setCompacting(new Map())
    }
  }, [filterKey])

  return compacting
}

export type PresentConfig = {
  chat: true
  hud?: boolean
  list?: boolean
}

export type ItemAction = {
  label: string
  command?: string
  target?: string
  clientAction?: string
}

export type Item = {
  id: string
  kind: 'bounce' | 'modal' | 'status' | 'task' | 'suggest' | 'info' | string
  from?: string
  title: string
  body?: string
  actions?: ItemAction[]
  payload?: any
  present: PresentConfig
  dropTarget?: 'doc' | 'chat' | 'any' | string
  ttl?: number
  priority?: 'low' | 'normal' | 'high' | string
  ts: number
  targetId?: string
  label?: string
  text?: string
  command?: string | null
  group?: string
  messageId?: string | number | null
}

// A suggestion chip any agent can push to the bottom of the chat. Suggestion is
// now an additive narrowing of Item; the live /api/suggestions route remains the
// write/clear path for replace-semantics.
export type Suggestion = Item & { kind: 'suggest', label: string, targetId?: string, from?: string, text: string, command?: string | null, group?: string, messageId?: string | number | null, msgCount?: number }

export function useItems(role: 'hud' | 'list' | 'chat' | 'suggest' = 'chat'): Item[] {
  const [items, setItems] = useState<Item[]>([])

  useEffect(() => {
    let unsub: (() => void) | null = null
    let cancelled = false

    ensureInit().then(() => {
      if (cancelled) return
      setItems(getItems())
      const humanId = getHumanId()
      _fleetEphemeral('items', humanId ? { userId: humanId } : {})
        .then((j: any) => { if (!cancelled) setItems(j.items || []) })
        .catch(() => {})
      unsub = subscribe('items', null, (data: any) => {
        setItems(data.items || getItems())
      })
    })

    return () => { cancelled = true; unsub?.() }
  }, [])

  return items.filter((item: Item) => {
    if (role === 'chat') return item.present?.chat
    if (role === 'suggest') return item.kind === 'suggest'
    return !!item.present?.[role]
  })
}

export function useSuggestions(): Suggestion[] {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])

  useEffect(() => {
    let unsub: (() => void) | null = null
    let cancelled = false

    ensureInit().then(() => {
      if (cancelled) return
      _fleetEphemeral('suggestions-get')
        .then((j: any) => { if (!cancelled) setSuggestions(j.suggestions || []) })
        .catch(() => {})
      unsub = subscribe('suggestions', null, (data: any) => {
        setSuggestions(data.suggestions || [])
      })
    })

    return () => { cancelled = true; unsub?.() }
  }, [])

  return suggestions.map((s: Suggestion) => ({
    ...s,
    kind: 'suggest',
    label: s.label,
    text: s.text || '',
    command: s.command ?? null,
    targetId: s.targetId || s.from,
  })) as Suggestion[]
}

export const dismissItem = _dismissItem

// Taking an option (click) or dismissing (✕) resolves ONE group. Clear just that
// group by re-posting the agent's set minus the group's options (replace-
// semantics — no dedicated endpoint). Other groups from the same agent stay.
// A group is the shared `group` tag, or a lone suggestion's own id.
export async function clearGroup(agentId: string, groupKey: string) {
  try {
    const j = await _fleetEphemeral('suggestions-get')
    const remaining = (j.suggestions || []).filter((s: Suggestion) =>
      suggestionOwnerId(s) === agentId && suggestionGroupKey(s) !== groupKey)
    await _fleetDurable('suggestions-set', { agentId, suggestions: remaining })
  } catch (e) {
    console.warn('clearGroup failed', e)
  }
}

function suggestionGroupKey(s: Suggestion) {
  return `${s.messageId || ''}::${s.group || String(s.id)}`
}

function suggestionOwnerId(s?: Suggestion) {
  return s?.from || s?.targetId || ''
}

/**
 * Subscribe to context-percent events for agents matching the filter.
 * Returns a Map of agentId → percent remaining (0–100).
 */
export function useFleetContext(dnfFilter?: string[][] | [string,string][][] | null, frameId?: string): Map<string, number> {
  const [context, setContext] = useState<Map<string, number>>(new Map())
  const filterKey = dnfFilter ? JSON.stringify(dnfFilter) : ''

  useEffect(() => {
    if (frameId && getPlaybackData(frameId)) return

    let unsub: (() => void) | null = null
    let cancelled = false
    const filter = dnfFilter && dnfFilter.length > 0 ? dnfFilter : null

    ensureInit().then(() => {
      if (cancelled) return

      function inFilter(agentId: string): boolean {
        if (!filter) return true
        return matchesFilter(filter, { agent: agentId, from: agentId })
      }

      unsub = subscribe('context', null, (data: any) => {
        if (!inFilter(data.agent)) return
        setContext(prev => {
          const next = new Map(prev)
          next.set(data.agent, data.percent)
          return next
        })
      })
    })

    return () => {
      cancelled = true
      unsub?.()
      setContext(new Map())
    }
  }, [filterKey])

  return context
}

// --- Search API ---

const DASHBOARD_URL = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:5176'

export interface FleetSearchFilters {
  agent?: string       // explicit fleet id (or array) — exact match
  me?: string          // current syntax user; resolves `me` in message filters
  agentQuery?: string  // typed name fragment — server resolves to ids (substring, dawn-aware)
  naturalAgentQuery?: string // bare term also resolved as involved-agent union
  naturalAgentQueries?: string[]
  naturalTextQuery?: string
  fromOnly?: boolean   // agentQuery refers to the SENDER only (from:)
  role?: string
  since?: string
  before?: string
  filterExpression?: string
  eventType?: string
  cwd?: string
  project?: string
}

export async function searchFleet(query: string, limit = 50, filters: FleetSearchFilters = {}): Promise<any[]> {
  await ensureInit()
  try {
    const payload: Record<string, any> = { query, limit }
    const me = filters.me || getHumanId()
    if (me) payload.me = me
    if (filters.agent) payload.agent = filters.agent
    if (filters.agentQuery) payload.agentQuery = filters.agentQuery
    if (filters.naturalAgentQuery) payload.naturalAgentQuery = filters.naturalAgentQuery
    if (filters.naturalAgentQueries?.length) payload.naturalAgentQueries = filters.naturalAgentQueries
    if (filters.naturalTextQuery) payload.naturalTextQuery = filters.naturalTextQuery
    if (filters.fromOnly) payload.fromOnly = true
    if (filters.role) payload.role = filters.role
    if (filters.since) payload.since = filters.since
    if (filters.before) payload.before = filters.before
    if (filters.filterExpression) payload.filterExpression = filters.filterExpression
    if (filters.eventType) payload.eventType = filters.eventType
    if (filters.cwd) payload.cwd = filters.cwd
    if (filters.project) payload.project = filters.project
    const data = await _fleetEphemeral('fleet-search', payload)
    return data?.results || []
  } catch (e) { console.warn('[fleet] search failed:', (e as Error).message); return [] }
}

export async function fetchSharedDocs(): Promise<Array<{ doc: string; title: string; path: string; agent: string; agent_name: string; shared_at: string }>> {
  try {
    const res = await fetch(`${DASHBOARD_URL}/api/shared-docs`)
    if (!res.ok) return []
    return await res.json()
  } catch (e) {
    console.warn('[fleet] fetchSharedDocs failed:', (e as Error).message)
    return []
  }
}

/**
 * Returns a map of agentId → unread count for messages from that agent to the human.
 * Updates live when messages arrive or read receipts come in.
 */
export function useFleetUnreadCounts(): Record<string, number> {
  const [counts, setCounts] = useState<Record<string, number>>({})

  useEffect(() => {
    let unsub: (() => void) | null = null
    let cancelled = false

    ensureInit().then(() => {
      if (cancelled) return
      setCounts(getUnreadCountsForHuman() as Record<string, number>)
      unsub = subscribe('messages', null, () => {
        setCounts(getUnreadCountsForHuman() as Record<string, number>)
      })
    })

    return () => {
      cancelled = true
      unsub?.()
    }
  }, [])

  return counts
}

// --- Projects hook ---

/**
 * Returns the sorted list of project names, kept live. The server broadcasts a
 * `projects-updated` fleet event whenever a project is created or its sourceDir
 * changes; this re-fetches `/api/projects` on that event so the spawn form's
 * project list updates without a manual reload.
 */
export function useFleetProjects(): string[] {
  const [projects, setProjects] = useState<string[]>([])

  const refetch = useCallback(() => {
    fetch('/api/projects')
      .then(r => r.ok ? r.json() : { projects: [] })
      .then((data: any) => {
        const list = Array.isArray(data) ? data : (data.projects || [])
        setProjects(list.map((p: any) => p.name).sort())
      })
      .catch(e => console.warn('[fleet] projects fetch failed:', e.message))
  }, [])

  useEffect(() => {
    refetch()
    let unsub: (() => void) | null = null
    let cancelled = false
    ensureInit().then(() => {
      if (cancelled) return
      unsub = subscribe('projects', null, refetch)
    })
    return () => { cancelled = true; unsub?.() }
  }, [refetch])

  return projects
}

// --- Connection state hook ---

export function useFleetConnection(): boolean {
  const [connected, setConnected] = useState(true)

  useEffect(() => {
    let unsub: (() => void) | null = null
    let cancelled = false

    ensureInit().then(() => {
      if (cancelled) return
      setConnected(_isConnected())
      unsub = subscribe('connection', null, (ev: any) => {
        setConnected(ev.connected)
      })
    })

    return () => {
      cancelled = true
      unsub?.()
    }
  }, [])

  return connected
}

// --- Identity hook ---

export function useFleetIdentity(): { id: string | null, name: string | null, needsIdentity: boolean, login: (name: string, options?: { persist?: boolean }) => Promise<any>, register: (name: string, options?: { persist?: boolean }) => Promise<any> } {
  const [identity, setIdentity] = useState({ id: getHumanId(), name: getHumanName(), needsIdentity: _needsIdentity() })

  useEffect(() => {
    let unsub: (() => void) | null = null
    let cancelled = false

    ensureInit().then(() => {
      if (cancelled) return
      setIdentity({ id: getHumanId(), name: getHumanName(), needsIdentity: _needsIdentity() })
      unsub = subscribe('identity', null, (ev: any) => {
        setIdentity({ id: ev.id || getHumanId(), name: ev.name || getHumanName(), needsIdentity: !!ev.needsIdentity })
      })
    })

    return () => {
      cancelled = true
      unsub?.()
    }
  }, [])

  return { ...identity, login: _login, register: _registerHuman }
}

// --- Write API (re-exported) ---

export const sendMessage = _sendMessage
export const respawnAgent = _respawnAgent
export const killSession = _killSession
export const hibernateSession = _hibernateSession
export const spawnAgent = _spawnAgent
export const injectOptimisticEvent = _injectOptimisticEvent
export const updateOptimisticEvent = _updateOptimisticEvent
export const removeOptimisticEvent = _removeOptimisticEvent
export const reconcileOptimistic = _reconcileOptimistic
export const fleetEphemeral = _fleetEphemeral
export { loadBefore, receiveFilterEvents, fetchHistory, resolveFilter }
