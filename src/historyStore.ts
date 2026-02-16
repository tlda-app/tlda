/**
 * Frontend client for the server-side history API.
 *
 * Replaces localStorage-based snapshots with server-backed history
 * that includes both in-session build snapshots and git commits.
 */

export interface HistoryEntry {
  id: string
  type: 'build' | 'git'
  timestamp: number
  pages?: number
  commitHash?: string
  commitMessage?: string
  built?: boolean  // for git entries: whether SVGs are cached
}

export interface LineRegion {
  y: number
  height: number
  x: number
  width: number
}

export interface ChangeItem {
  id: string        // "page-index" e.g. "3-0"
  page: number
  y: number
  height: number
  x?: number
  width?: number
  oldText?: string | null
  newText?: string | null
  newLines?: LineRegion[]
  oldLines?: LineRegion[]
}

export interface PageDiff {
  page: number
  status: 'changed' | 'added' | 'removed'
  regions?: Array<{ y: number; height: number; x?: number; width?: number }>
  changes?: ChangeItem[]
}

/** Flatten PageDiff[] into a flat list of ChangeItems for triage UI. */
export function flattenChanges(pages: PageDiff[]): ChangeItem[] {
  const items: ChangeItem[] = []
  for (const p of pages) {
    if (p.changes && p.changes.length > 0) {
      for (const c of p.changes) {
        items.push({ ...c, page: c.page || p.page })
      }
    } else if (p.status === 'added') {
      items.push({ id: `${p.page}-add`, page: p.page, y: 0, height: 0, newText: '(new page)' })
    } else if (p.status === 'removed') {
      items.push({ id: `${p.page}-rm`, page: p.page, y: 0, height: 0, oldText: '(removed page)' })
    }
  }
  return items
}

// API base: in dev mode (Vite on 5173), proxy goes to 5176
// In production, API is on same origin
const serverBase = ''  // relative URLs work because Vite proxies /api

/**
 * Fetch the unified timeline for a project.
 */
export async function fetchHistory(docName: string): Promise<HistoryEntry[]> {
  try {
    const res = await fetch(`${serverBase}/api/projects/${docName}/history`)
    if (!res.ok) return []
    const data = await res.json()
    return data.entries || []
  } catch {
    return []
  }
}

/**
 * Fetch text-based diff between a snapshot and current output.
 */
export async function fetchDiff(docName: string, snapshotId: string): Promise<PageDiff[]> {
  try {
    const res = await fetch(`${serverBase}/api/projects/${docName}/history/${snapshotId}/diff`)
    if (!res.ok) return []
    const data = await res.json()
    return data.pages || []
  } catch {
    return []
  }
}

/**
 * Trigger a git build for a commit hash. Returns immediately.
 */
export async function triggerGitBuild(docName: string, commitHash: string): Promise<'building' | 'cached' | 'error'> {
  try {
    const res = await fetch(`${serverBase}/api/projects/${docName}/history/git/${commitHash}/build`, {
      method: 'POST',
    })
    const data = await res.json()
    return data.status || 'error'
  } catch {
    return 'error'
  }
}

/**
 * Poll git build status until cached or timeout.
 */
export async function waitForGitBuild(
  docName: string,
  commitHash: string,
  onProgress?: () => void,
  timeoutMs = 300000,
): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${serverBase}/api/projects/${docName}/history/git/${commitHash}/status`)
      const data = await res.json()
      if (data.status === 'cached') return true
      if (data.status !== 'building') return false
    } catch {
      return false
    }
    onProgress?.()
    await new Promise(r => setTimeout(r, 2000))
  }
  return false
}

/**
 * Get the URL for a snapshot's SVG page.
 */
export function snapshotPageUrl(docName: string, snapshotId: string, page: number): string {
  return `${serverBase}/docs/${docName}/history/${snapshotId}/page-${page}.svg`
}
