/**
 * fleet-data-adapter.ts — React hooks wrapping fleet-data.mjs
 *
 * Lazy-inits on first use. Each hook subscribes via fleet-data's
 * subscribe() and re-renders on updates. One SSE connection shared
 * across all fleet shapes.
 */
import { useState, useEffect, useCallback, useRef } from 'react'
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
let initDone = false

function ensureInit(): Promise<void> {
  if (!initPromise) {
    initPromise = init().then(() => { initDone = true })
  }
  return initPromise
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
 * Subscribe to fleet chat events, optionally filtered by agent ID.
 * Returns events sorted by timestamp.
 */
export function useFleetEvents(agentFilter?: string): any[] {
  const [events, setEvents] = useState<any[]>([])

  useEffect(() => {
    let unsub: (() => void) | null = null
    let cancelled = false
    const dnfFilter = agentFilter ? [[agentFilter]] : null

    ensureInit().then(() => {
      if (cancelled) return
      // Seed with initial events from the store
      const all = getEvents()
      const filtered = dnfFilter
        ? all.filter((e: any) => matchesFilter(dnfFilter, e))
        : [...all]
      setEvents(filtered)

      // Subscribe for live updates
      unsub = subscribe('messages', dnfFilter, (event: any) => {
        setEvents(prev => [...prev, event])
      })
    })

    return () => {
      cancelled = true
      unsub?.()
    }
  }, [agentFilter])

  return events
}

/**
 * Subscribe to fleet activity events, optionally filtered by agent ID.
 * Activity events are tool calls / text blocks from agent sessions.
 */
export function useFleetActivity(agentFilter?: string): any[] {
  const [events, setEvents] = useState<any[]>([])

  useEffect(() => {
    let unsub: (() => void) | null = null
    let cancelled = false
    const dnfFilter = agentFilter ? [[agentFilter]] : null

    ensureInit().then(() => {
      if (cancelled) return
      // No initial seed — activity events are live-only (same as dashboard chat.mjs)
      if (!dnfFilter) return // activity requires a filter

      unsub = subscribe('activity', dnfFilter, (event: any) => {
        setEvents(prev => [...prev, event])
      })
    })

    return () => {
      cancelled = true
      unsub?.()
    }
  }, [agentFilter])

  return events
}

// --- Write API (re-exported) ---

export const sendMessage = _sendMessage
export { loadBefore, fetchHistory }
