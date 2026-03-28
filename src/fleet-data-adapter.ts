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
 * Subscribe to fleet chat events, optionally filtered.
 * Accepts a DNF filter: string[][] (OR of ANDs), or null for all.
 */
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
      setEvents(filtered)

      // Subscribe for live updates
      unsub = subscribe('messages', filter, (event: any) => {
        setEvents(prev => [...prev, event])
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
 * Subscribe to fleet activity events, optionally filtered.
 * Accepts a DNF filter: string[][] (OR of ANDs), or null for all.
 */
export function useFleetActivity(dnfFilter?: string[][] | null): any[] {
  const [events, setEvents] = useState<any[]>([])
  const filterKey = dnfFilter ? JSON.stringify(dnfFilter) : ''

  useEffect(() => {
    let unsub: (() => void) | null = null
    let cancelled = false
    const filter = dnfFilter && dnfFilter.length > 0 ? dnfFilter : null

    ensureInit().then(() => {
      if (cancelled) return
      // No initial seed — activity events are live-only (same as dashboard chat.mjs)
      if (!filter) return // activity requires a filter

      unsub = subscribe('activity', filter, (event: any) => {
        setEvents(prev => [...prev, event])
      })
    })

    return () => {
      cancelled = true
      unsub?.()
    }
  }, [filterKey])

  return events
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
