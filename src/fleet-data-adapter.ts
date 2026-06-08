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
  getEvents,
  matchesFilter,
  resolveFilter,
  respawnAgent as _respawnAgent,
  killSession as _killSession,
  hibernateSession as _hibernateSession,
  spawnAgent as _spawnAgent,
  isConnected as _isConnected,
  getReaperStatus,
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
import { log } from './logger'
import { loadPrefs } from './preferences'

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


const INBOX_API = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:5176'

export function useTaskInbox(): { items: any[], refresh: () => void, act: (taskId: string, action: string, reason?: string) => Promise<any> } {
  const [items, setItems] = useState<any[]>([])

  const fetchInbox = useCallback(() => {
    fetch(`${INBOX_API}/api/inbox`)
      .then(r => r.json())
      .then(data => { if (Array.isArray(data)) setItems(data) })
      .catch(e => console.warn('[fleet] inbox fetch failed:', e.message))
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

    // Clear stale state from previous filter immediately
    setEvents([])

    function setupLive() {
      if (cancelled) return
      ensureInit().then(() => {
        if (cancelled || isPlaybackMode) return

        // Thin filtered VIEW over the single store (fleet-data holds live +
        // history in one id-keyed buffer). On any 'messages' change we re-derive
        // the filtered slice from the store rather than accumulating our own
        // array — so there's no second list to drift from the store, and the
        // backfilled history (upserted into the store) shows up immediately.
        let refreshTimer: ReturnType<typeof setTimeout> | null = null
        const refresh = () => {
          refreshTimer = null
          if (cancelled) return
          setEvents(getEvents().filter((ev: any) => matchesFilter(filter, ev)))
        }
        refresh() // initial paint from the store (uncapped — has history + live)

        const rawUnsub = subscribe('messages', filter, () => {
          if (_tabVisible) { if (!refreshTimer) refreshTimer = setTimeout(refresh, 16) }
        })
        // On tab re-show, drop any pending debounce and refresh now.
        const [, cleanupGate] = visibilityGate(() => {}, () => {
          if (refreshTimer !== null) { clearTimeout(refreshTimer); refreshTimer = null }
          refresh()
        })
        liveUnsub = () => {
          rawUnsub()
          cleanupGate()
          if (refreshTimer !== null) { clearTimeout(refreshTimer); refreshTimer = null }
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

    // A "messages" event surrenders the held thinking slot only if it renders a
    // visible chat row. Fired timers and compacting pings carry a `from` but
    // draw nothing; 📬/<channel infrastructure text renders to an empty string.
    // Releasing on those leaves the slot empty with nothing to fill it.
    function producesRow(ev: any): boolean {
      if (ev._timer || ev._compacting) return false
      const text = ev.text || ''
      if (text.startsWith('📬') || text.startsWith('<channel') || text.includes('[Request interrupted by user]')) return false
      return true
    }

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
          const ts = data.startTs || data.ts || Date.now()
          setThinking(prev => {
            if (prev.has(data.agent)) return prev
            const next = new Map(prev)
            next.set(data.agent, ts)
            log.info('thinking-line', 'add (thinking:true)', { agent: data.agent, keys: [...next.keys()] })
            return next
          })
        } else {
          log.info('thinking-line', 'hold (thinking:false) — pendingRemoval', { agent: data.agent })
          // Don't remove yet — hold "thinking…" until either a row that actually
          // renders lands for this agent (clearPending below) or the server's
          // authoritative thinking-sync drops it (which, on an agent going quiet,
          // arrives in the same agents-delta that marks it hibernating — so the
          // footer swaps "thinking…" → "is hibernating" in one commit instead of
          // blanking). No bare timer: a timer-driven drop is exactly the early
          // vanish the status line must never do.
          pendingRemoval.add(data.agent)
        }
      })

      // A message clears the held "thinking…" — but only when it's a row that
      // actually renders in the chat. No-op events (fired timers, compacting
      // pings, channel/📬 infrastructure noise) render nothing, so surrendering
      // the slot for them leaves it empty and bounces the stack.
      function clearPending(agentId: string, reason: string) {
        pendingRemoval.delete(agentId)
        setThinking(prev => {
          if (!prev.has(agentId)) return prev
          const next = new Map(prev)
          next.delete(agentId)
          log.info('thinking-line', `remove (${reason})`, { agent: agentId, keys: [...next.keys()] })
          return next
        })
      }
      unsubMessages = subscribe('messages', null, (event: any) => {
        if (!event) return
        const from = event.from || event.agent
        if (from && pendingRemoval.has(from)) {
          const rowy = producesRow(event)
          log.info('thinking-line', 'message from held agent', { agent: from, producesRow: rowy, type: event.type || event._evType, text: (event.text || '').slice(0, 40) })
          if (rowy) clearPending(from, 'message-row')
        }
      })

      // Status events: only 'idle' should clear thinking. 'tool_call' happens mid-thought.
      unsubStatus = subscribe('status', null, (data: any) => {
        if (!inFilter(data.agent)) return
        if (data.state === 'thinking') {
          pendingRemoval.delete(data.agent)
          setThinking(prev => {
            const next = new Map(prev)
            if (!next.has(data.agent)) next.set(data.agent, data.startTs || data.ts || Date.now())
            return next
          })
        } else if (data.state === 'idle') {
          // Hold, same as thinking:false — release on a rendered row or the
          // authoritative thinking-sync, never on a bare timer.
          log.info('thinking-line', 'hold (status:idle) — pendingRemoval', { agent: data.agent })
          pendingRemoval.add(data.agent)
        }
        // 'tool_call' — agent is working, don't touch thinking state
      })

      // Server state sync — reconcile with server's authoritative set
      unsubSync = subscribe('thinking-sync', null, (serverSet: Set<string>) => {
        setThinking(prev => {
          let changed = false
          const next = new Map(prev)
          const dropped: string[] = []
          for (const id of next.keys()) {
            if (!serverSet.has(id)) {
              next.delete(id)
              pendingRemoval.delete(id)
              dropped.push(id)
              changed = true
            }
          }
          if (changed) log.info('thinking-line', 'thinking-sync drop', { dropped, serverSet: [...serverSet], keys: [...next.keys()] })
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

// A suggestion chip any agent can push to the bottom of the chat (see the
// server's /api/suggestions channel + the `suggest` MCP tool). `from` is the
// posting agent; `command`, if set, is sent as a chat when the chip is clicked.
export type Suggestion = { id: string | number, label: string, targetId?: string, from?: string, text: string, kind?: string, command?: string | null, ts: number, msgCount?: number }

export function useSuggestions(): Suggestion[] {
  const [pending, setPending] = useState<Suggestion[]>([])

  useEffect(() => {
    let unsub: (() => void) | null = null
    let cancelled = false

    ensureInit().then(() => {
      if (cancelled) return
      unsub = subscribe('suggestions', null, (data: any) => {
        setPending(data.suggestions || [])
      })
    })

    return () => { cancelled = true; unsub?.() }
  }, [])

  return pending
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
  agent?: string
  role?: string
  since?: string
  before?: string
}

export async function searchFleet(query: string, limit = 50, filters: FleetSearchFilters = {}): Promise<any[]> {
  await ensureInit()
  try {
    const payload: Record<string, any> = { query, limit }
    if (filters.agent) payload.agent = filters.agent
    if (filters.role) payload.role = filters.role
    if (filters.since) payload.since = filters.since
    if (filters.before) payload.before = filters.before
    const data = await _fleetWS('fleet-search', payload)
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

// --- Reaper status hook ---

export function useReaperStatus(): any {
  const [status, setStatus] = useState<any>(getReaperStatus())

  useEffect(() => {
    let unsub: (() => void) | null = null
    let cancelled = false

    ensureInit().then(() => {
      if (cancelled) return
      setStatus(getReaperStatus())
      unsub = subscribe('reaper', null, (data: any) => {
        setStatus(data)
      })
    })

    return () => {
      cancelled = true
      unsub?.()
    }
  }, [])

  return status
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
export const hibernateSession = _hibernateSession
export const spawnAgent = _spawnAgent
export const injectOptimisticEvent = _injectOptimisticEvent
export const updateOptimisticEvent = _updateOptimisticEvent
export const reconcileOptimistic = _reconcileOptimistic
export const fleetWS = _fleetWS
export { loadBefore, fetchHistory, resolveFilter }
