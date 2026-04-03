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
  sendMessage as _sendMessage,
  fetchHistory,
  loadBefore,
  matchesFilter,
  // @ts-ignore — vanilla JS module
} from 'fleet-dashboard/js/fleet-data.mjs'

// --- Lazy initialization ---

let initPromise: Promise<void> | null = null

function ensureInit(): Promise<void> {
  if (!initPromise) {
    initPromise = init()
  }
  return initPromise!
}

// --- Hooks ---

export function useFleetAgents(): any[] {
  const [agents, setAgents] = useState<any[]>([])

  useEffect(() => {
    let unsub: (() => void) | null = null
    let cancelled = false

    ensureInit().then(() => {
      if (cancelled) return
      setAgents([...getAgents()])
      unsub = subscribe('agents', null, () => {
        setAgents([...getAgents()])
      })
    })

    return () => {
      cancelled = true
      unsub?.()
    }
  }, [])

  return agents
}


export function useFleetTasks(): any[] {
  const [tasks, setTasks] = useState<any[]>([])

  useEffect(() => {
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
  }, [])

  return tasks
}

/**
 * Subscribe to fleet chat events, optionally filtered.
 * Accepts a DNF filter: string[][] (OR of ANDs), or null for all.
 */
const MAX_LOCAL_EVENTS = 500

export function useFleetEvents(dnfFilter?: string[][] | null): any[] {
  const [events, setEvents] = useState<any[]>([])
  const filterKey = dnfFilter ? JSON.stringify(dnfFilter) : ''

  useEffect(() => {
    let unsub: (() => void) | null = null
    let cancelled = false
    const filter = dnfFilter && dnfFilter.length > 0 ? dnfFilter : null

    ensureInit().then(() => {
      if (cancelled) return
      // Seed with initial events from the store
      const all = getEvents()
      const filtered = filter
        ? all.filter((e: any) => matchesFilter(filter, e))
        : [...all]
      setEvents(filtered.slice(-MAX_LOCAL_EVENTS))

      // Subscribe for live updates
      unsub = subscribe('messages', filter, (event: any) => {
        if (!event) {
          // null event = re-read (e.g. read-receipt updated existing messages)
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

    return () => {
      cancelled = true
      unsub?.()
    }
  }, [filterKey])

  return events
}


/**
 * Subscribe to thinking/status events for agents matching the filter.
 * Returns a Map of agentId → timestamp when thinking started (ms).
 */
export function useFleetThinking(dnfFilter?: string[][] | null): Map<string, number> {
  const [thinking, setThinking] = useState<Map<string, number>>(new Map())
  const filterKey = dnfFilter ? JSON.stringify(dnfFilter) : ''

  useEffect(() => {
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
export function useFleetCompacting(dnfFilter?: string[][] | null): Map<string, number> {
  const [compacting, setCompacting] = useState<Map<string, number>>(new Map())
  const filterKey = dnfFilter ? JSON.stringify(dnfFilter) : ''

  useEffect(() => {
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

// --- Write API (re-exported) ---

export const sendMessage = _sendMessage
export { loadBefore, fetchHistory }
