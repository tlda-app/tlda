/**
 * fleet-data-adapter.ts — React hooks wrapping fleet-data.mjs
 *
 * Lazy-inits on first use. Each hook subscribes via fleet-data's
 * subscribe() and re-renders on updates. One SSE connection shared
 * across all fleet shapes.
 */
import { useState, useEffect } from 'react'
import {
  init,
  subscribe,
  getEvents,
  getAgents,
  getTasks,
  getUnreadCountsForHuman,
  sendMessage as _sendMessage,
  fetchHistory,
  loadBefore,
  matchesFilter,
  respawnAgent as _respawnAgent,
  spawnAgent as _spawnAgent,
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
        liveUnsub = subscribe('agents', null, () => {
          setAgents([...getAgents()])
        })
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
      unsub = subscribe('tasks', null, () => {
        setTasks([...getTasks()])
      })
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

        liveUnsub = subscribe('messages', filter, (event: any) => {
          if (!event) {
            const all = getEvents()
            const filtered = filter
              ? all.filter((e: any) => matchesFilter(filter, e))
              : [...all]
            setEvents(filtered.slice(-MAX_LOCAL_EVENTS))
          } else {
            setEvents(prev => {
              const next = [...prev, event]
              return next.length > MAX_LOCAL_EVENTS ? next.slice(-MAX_LOCAL_EVENTS) : next
            })
          }
        })
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
export function useFleetThinking(dnfFilter?: string[][] | null, frameId?: string): Map<string, number> {
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
      if (cancelled || !filter) return

      function inFilter(agentId: string): boolean {
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
export function useFleetCompacting(dnfFilter?: string[][] | null, frameId?: string): Map<string, number> {
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

const DASHBOARD_URL = 'http://localhost:5199'

export async function searchFleet(query: string, limit = 50): Promise<any[]> {
  await ensureInit()
  const res = await fetch(`${DASHBOARD_URL}/api/logs/search?q=${encodeURIComponent(query)}&limit=${limit}`)
  if (!res.ok) return []
  const data = await res.json()
  return data.results || data || []
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
      setCounts(getUnreadCountsForHuman())
      unsub = subscribe('messages', null, () => {
        setCounts(getUnreadCountsForHuman())
      })
    })

    return () => {
      cancelled = true
      unsub?.()
    }
  }, [])

  return counts
}

// --- Write API (re-exported) ---

export const sendMessage = _sendMessage
export const respawnAgent = _respawnAgent
export const spawnAgent = _spawnAgent
export { loadBefore, fetchHistory }
