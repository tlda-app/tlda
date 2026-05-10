/**
 * fleet-data-adapter.ts — React hooks wrapping fleet-data.mjs
 *
 * Lazy-inits on first use. Each hook subscribes via fleet-data's
 * subscribe() and re-renders on updates. One SSE connection shared
 * across all fleet shapes.
 */
import { useState, useEffect, useCallback } from 'react'
import {
  init,
  subscribe,
  getEvents,
  getAgents,
  getTasks,
  getUnreadCountsForHuman,
  getHumanId,
  getHumanName,
  needsIdentity as _needsIdentity,
  login as _login,
  registerHuman as _registerHuman,
  sendMessage as _sendMessage,
  fetchHistory,
  loadBefore,
  matchesFilter,
  respawnAgent as _respawnAgent,
  killSession as _killSession,
  spawnAgent as _spawnAgent,
  isConnected as _isConnected,
  injectOptimisticEvent as _injectOptimisticEvent,
  updateOptimisticEvent as _updateOptimisticEvent,
  reconcileOptimistic as _reconcileOptimistic,
  fleetWS as _fleetWS,
  // @ts-ignore — vanilla JS module
} from './fleet/fleet-data.mjs'
import {
  getPlaybackData,
  subscribePlayback,
  getPlaybackChatEvents,
  getPlaybackAgents,
} from './playback-context'

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


const INBOX_API = 'http://localhost:5176'

export function useTaskInbox(): { items: any[], refresh: () => void, act: (taskId: string, action: string, reason?: string) => Promise<any> } {
  const [items, setItems] = useState<any[]>([])

  const fetchInbox = useCallback(() => {
    fetch(`${INBOX_API}/api/inbox`)
      .then(r => r.json())
      .then(data => { if (Array.isArray(data)) setItems(data) })
      .catch(() => {})
  }, [])

  useEffect(() => {
    fetchInbox()
    let unsub: (() => void) | null = null
    let cancelled = false
    ensureInit().then(() => {
      if (cancelled) return
      unsub = subscribe('tasks', null, fetchInbox)
    })
    return () => { cancelled = true; unsub?.() }
  }, [fetchInbox])

  const act = useCallback(async (taskId: string, action: string, reason?: string) => {
    const res = await fetch(`${INBOX_API}/api/inbox/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_id: taskId, action, reason }),
    })
    const data = await res.json()
    fetchInbox()
    return data
  }, [fetchInbox])

  return { items, refresh: fetchInbox, act }
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
const MAX_LOCAL_EVENTS = 500

export function useFleetEvents(dnfFilter?: [string, string][][] | null, frameId?: string): any[] {
  const [events, setEvents] = useState<any[]>([])
  const filterKey = dnfFilter ? JSON.stringify(dnfFilter) : ''

  // Single effect handles both playback and live modes.
  // If frameId is a shape ID: subscribe to the playback registry first.
  // When registry data arrives, switch to playback events.
  // If no registry data, fall through to live SSE.
  useEffect(() => {
    let liveUnsub: (() => void) | null = null
    let playbackUnsub: (() => void) | null = null
    let liveUnsync: (() => void) | null = null
    let cancelled = false
    let isPlaybackMode = false
    const filter = dnfFilter && dnfFilter.length > 0 ? dnfFilter : null

    function setupLive() {
      if (cancelled) return
      ensureInit().then(() => {
        // If playback data arrived while we were waiting for init, don't start live
        if (cancelled || isPlaybackMode) return
        const all = getEvents()
        const filtered = filter
          ? all.filter((e: any) => matchesFilter(filter, e))
          : [...all]
        setEvents(filtered.slice(-MAX_LOCAL_EVENTS))

        const refreshEvents = () => {
          if (!cancelled) {
            const all = getEvents()
            const filtered = filter ? all.filter((e: any) => matchesFilter(filter, e)) : [...all]
            setEvents(filtered.slice(-MAX_LOCAL_EVENTS))
          }
        }
        const [, cleanupGate] = visibilityGate(() => {}, refreshEvents)

        // Batch incoming events within a 16ms window (one animation frame).
        // WS messages arrive as separate macrotasks, so without batching each
        // message triggers its own React render. This coalesces bursts into one.
        let pendingBatch: any[] = []
        let batchTimer: ReturnType<typeof setTimeout> | null = null
        const flushBatch = () => {
          batchTimer = null
          if (pendingBatch.length === 0) return
          const batch = pendingBatch.splice(0)
          setEvents(prev => {
            const next = [...prev, ...batch]
            return next.length > MAX_LOCAL_EVENTS ? next.slice(-MAX_LOCAL_EVENTS) : next
          })
        }

        const rawUnsub = subscribe('messages', filter, (event: any) => {
          if (!_tabVisible) return  // skip render; refreshEvents will run on tab restore
          if (!event) {
            // Full refresh from _events — clear pending batch since refreshEvents
            // already includes everything. Without this, flushBatch appends events
            // that refreshEvents already loaded, causing duplicates.
            pendingBatch.length = 0
            if (batchTimer !== null) { clearTimeout(batchTimer); batchTimer = null }
            refreshEvents()
          } else {
            pendingBatch.push(event)
            if (!batchTimer) batchTimer = setTimeout(flushBatch, 16)
          }
        })
        liveUnsub = () => {
          rawUnsub()
          cleanupGate()
          if (batchTimer !== null) { clearTimeout(batchTimer); batchTimer = null }
          if (pendingBatch.length > 0) flushBatch()
        }
      })
    }

    function setupPlayback(pb: ReturnType<typeof getPlaybackData>) {
      if (!pb) return false
      isPlaybackMode = true
      // Tear down live subscription if it was running
      liveUnsub?.()
      liveUnsub = null
      setEvents(getPlaybackChatEvents(pb, filter))
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
          setEvents(getPlaybackChatEvents(pb, filter))
          isPlaybackMode = true
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
  }, [frameId, filterKey])

  return events
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
    let unsubMessages: (() => void) | null = null
    let unsubStatus: (() => void) | null = null
    let unsubSync: (() => void) | null = null
    let cancelled = false
    const filter = dnfFilter && dnfFilter.length > 0 ? dnfFilter : null
    const pendingRemoval = new Set<string>()
    const fallbackTimers = new Map<string, ReturnType<typeof setTimeout>>()

    ensureInit().then(() => {
      if (cancelled) return

      // null filter = all agents; non-null = only agents matching the current chat filter
      function inFilter(agentId: string): boolean {
        if (!filter) return true
        return matchesFilter(filter, { agent: agentId, from: agentId })
      }

      unsubThinking = subscribe('thinking', null, (data: any) => {
        if (!inFilter(data.agent)) return
        if (data.thinking) {
          pendingRemoval.delete(data.agent)
          const ft = fallbackTimers.get(data.agent)
          if (ft) { clearTimeout(ft); fallbackTimers.delete(data.agent) }
          setThinking(prev => {
            const next = new Map(prev)
            next.set(data.agent, Date.now())
            return next
          })
        } else {
          // Don't remove yet — wait for the message to arrive (fallback: 3s)
          pendingRemoval.add(data.agent)
          fallbackTimers.set(data.agent, setTimeout(() => {
            fallbackTimers.delete(data.agent)
            pendingRemoval.delete(data.agent)
            setThinking(prev => {
              const next = new Map(prev)
              next.delete(data.agent)
              return next
            })
          }, 3000))
        }
      })

      // When a message arrives from an agent with pending removal, clear their thinking indicator
      function clearPending(agentId: string) {
        pendingRemoval.delete(agentId)
        const ft = fallbackTimers.get(agentId)
        if (ft) { clearTimeout(ft); fallbackTimers.delete(agentId) }
        setThinking(prev => {
          const next = new Map(prev)
          next.delete(agentId)
          return next
        })
      }
      unsubMessages = subscribe('messages', null, (event: any) => {
        if (!event) return
        const from = event.from || event.agent
        if (from && pendingRemoval.has(from)) clearPending(from)
      })

      // Status events: only 'idle' should clear thinking. 'tool_call' happens mid-thought.
      unsubStatus = subscribe('status', null, (data: any) => {
        if (!inFilter(data.agent)) return
        if (data.state === 'thinking') {
          pendingRemoval.delete(data.agent)
          const ft = fallbackTimers.get(data.agent)
          if (ft) { clearTimeout(ft); fallbackTimers.delete(data.agent) }
          setThinking(prev => {
            const next = new Map(prev)
            if (!next.has(data.agent)) next.set(data.agent, Date.now())
            return next
          })
        } else if (data.state === 'idle') {
          pendingRemoval.add(data.agent)
          fallbackTimers.set(data.agent, setTimeout(() => {
            fallbackTimers.delete(data.agent)
            pendingRemoval.delete(data.agent)
            setThinking(prev => {
              const next = new Map(prev)
              next.delete(data.agent)
              return next
            })
          }, 3000))
        }
        // 'tool_call' — agent is working, don't touch thinking state
      })

      // Server state sync — clear agents not in the server's authoritative set
      unsubSync = subscribe('thinking-sync', null, (serverSet: Set<string>) => {
        setThinking(prev => {
          let changed = false
          const next = new Map(prev)
          for (const id of next.keys()) {
            if (!serverSet.has(id)) {
              next.delete(id)
              pendingRemoval.delete(id)
              const ft = fallbackTimers.get(id)
              if (ft) { clearTimeout(ft); fallbackTimers.delete(id) }
              changed = true
            }
          }
          return changed ? next : prev
        })
      })

    })

    return () => {
      cancelled = true
      unsubThinking?.()
      unsubMessages?.()
      unsubStatus?.()
      unsubSync?.()
      for (const t of fallbackTimers.values()) clearTimeout(t)
      fallbackTimers.clear()
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

// --- Search API ---

const DASHBOARD_URL = 'http://localhost:5176'

export async function searchFleet(query: string, limit = 50): Promise<any[]> {
  await ensureInit()
  try {
    const data = await _fleetWS('fleet-search', { query, limit })
    return data?.results || []
  } catch { return [] }
}

export async function fetchSharedDocs(): Promise<Array<{ doc: string; title: string; path: string; agent: string; agent_name: string; shared_at: string }>> {
  try {
    const res = await fetch(`${DASHBOARD_URL}/api/shared-docs`)
    if (!res.ok) return []
    return await res.json()
  } catch {
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

export function useFleetIdentity(): { id: string | null, name: string | null, needsIdentity: boolean, login: (name: string) => Promise<any>, register: (name: string) => Promise<any> } {
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
export const spawnAgent = _spawnAgent
export const injectOptimisticEvent = _injectOptimisticEvent
export const updateOptimisticEvent = _updateOptimisticEvent
export const reconcileOptimistic = _reconcileOptimistic
export const fleetWS = _fleetWS
export { loadBefore, fetchHistory }
