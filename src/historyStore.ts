/**
 * Frontend client for the shadow history API.
 */

import { getPageFilename } from './stores/pageUrlStore'

// API base: in dev mode (Vite on 5173), proxy goes to 5176
// In production, API is on same origin
const serverBase = ''  // relative URLs work because Vite proxies /api

/**
 * Shadow version entry — one build commit in the shadow repo.
 */
export interface ShadowVersion {
  hash: string
  timestamp: number
  message?: string
}

/**
 * Time bounds for the shadow repo — oldest and newest build timestamps.
 */
export interface ShadowTimeBounds {
  oldest: ShadowVersion
  newest: ShadowVersion
}

/**
 * Fetch the build active at a given timestamp (nearest build at or before that time).
 */
export async function versionAtTime(projectName: string, timestamp: number): Promise<ShadowVersion | null> {
  try {
    const res = await fetch(
      `${serverBase}/api/projects/${projectName}/history/shadow/at?time=${timestamp}`
    )
    if (!res.ok) return null
    const data = await res.json()
    return data.version ?? null
  } catch {
    return null
  }
}

/**
 * Fetch the time bounds (oldest + newest build) for the shadow repo.
 */
export async function fetchShadowTimeBounds(projectName: string): Promise<ShadowTimeBounds | null> {
  try {
    const res = await fetch(`${serverBase}/api/projects/${projectName}/history/shadow/bounds`)
    if (!res.ok) return null
    const data = await res.json()
    if (!data.oldest || !data.newest) return null
    return data as ShadowTimeBounds
  } catch {
    return null
  }
}

/**
 * Get the build immediately adjacent to a known hash.
 */
export async function fetchAdjacentShadowVersion(
  projectName: string,
  hash: string,
  dir: 'older' | 'newer',
): Promise<ShadowVersion | null> {
  try {
    const res = await fetch(
      `${serverBase}/api/projects/${projectName}/history/shadow/adjacent?hash=${encodeURIComponent(hash)}&dir=${dir}`
    )
    if (!res.ok) return null
    const data = await res.json()
    return data.version ?? null
  } catch {
    return null
  }
}

/**
 * Fetch shadow repo versions for a project. Returns newest-first.
 */
export async function fetchShadowVersions(projectName: string, limit = 9999): Promise<ShadowVersion[]> {
  try {
    const res = await fetch(`${serverBase}/api/projects/${projectName}/history/shadow?limit=${limit}`)
    if (!res.ok) return []
    const data = await res.json()
    return data.versions || []
  } catch {
    return []
  }
}

/**
 * Get the URL for a shadow snapshot's SVG page (page is 1-based).
 */
export function shadowSnapshotPageUrl(projectName: string, hash: string, page: number): string {
  const filename = getPageFilename(page - 1) ?? `page-${page}.svg`
  return `${serverBase}/docs/${projectName}/history/shadow-${hash.slice(0, 7)}/${filename}`
}

/**
 * Fetch the space-time changelog: per-commit page-level changes.
 * Returns { commits, totalPages } for the SpaceTimeDots overlay.
 */
export async function fetchShadowChangelog(
  projectName: string,
  limit = 200,
): Promise<{ commits: Array<{ hash: string; timestamp: number; changedPages: number[] }>; totalPages: number } | null> {
  try {
    const res = await fetch(`${serverBase}/api/projects/${projectName}/history/shadow/changelog?limit=${limit}`)
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

/**
 * Fetch page count for a shadow version.
 * Returns null if not yet compiled.
 */
export async function fetchShadowMeta(projectName: string, hash: string): Promise<{ pages: number | null }> {
  try {
    const hash7 = hash.slice(0, 7)
    const res = await fetch(`${serverBase}/api/projects/${projectName}/history/shadow/${hash7}/meta`)
    if (!res.ok) return { pages: null }
    return await res.json()
  } catch {
    return { pages: null }
  }
}

export interface RibbonStaleResult { stale: boolean; reason?: string }

/**
 * Ask the server which approved ribbon segments went stale since they were vetted.
 * Returns results in the same order as `segments`, or null if the call failed.
 */
export async function checkRibbonStale(
  projectName: string,
  segments: Array<{ file: string; startLine: number; endLine: number; approvedAtCommit: string }>,
  currentCommit: string,
): Promise<RibbonStaleResult[] | null> {
  try {
    const res = await fetch(`${serverBase}/api/projects/${projectName}/history/ribbon-stale`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ segments, currentCommit }),
    })
    if (!res.ok) return null
    const data = await res.json()
    return Array.isArray(data.results) ? data.results : null
  } catch {
    return null
  }
}
