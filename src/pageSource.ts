// Where pages come from.
//
// "Get me a page" is three questions — what documents are there, what is this
// one, and where do its bytes live — and until now the app answered all three by
// composing `/docs/…` URLs against the configured store. That works because a
// tlda server is serving the app as well as the pages. A published copy has no
// such server: the pages are files sitting beside the page that is asking for
// them, and the store it syncs marks to is somewhere else entirely.
//
// So the composition lives here rather than in the app, and the app stops
// knowing where pages come from. Today there is one implementation and it is the
// one that was already there; a published build is the second.
//
// NOT everything the app fetches from the store belongs here. Build errors,
// project metadata, health and fleet config are the development environment
// asking its own server about itself, and they stay where they were.
import { STORE_HTTP } from './activeConfig'
import { appendToken, getToken } from './authToken'
import { readClassroomToken } from './classroom/classroomToken'
import type { HtmlPageEntry } from './svgDocumentLoader'

export interface DocConfig {
  name: string
  pages: number
  basePath: string
  format?: 'svg' | 'png' | 'html' | 'book' | 'slides' | 'markdown' | 'qmd' | 'pdf'
  // Set by the qmd builder only — see viewFormat() in shared/document-formats.mjs.
  renderedFormat?: 'html' | 'slides'
  members?: string[]
  buildStatus?: string
  starred?: boolean
  lastBuild?: string
  createdAt?: string
  targets?: { texBase: string; mainFile: string; pages: number }[]
  pageInfo?: HtmlPageEntry[]
}

// Doc assets come from the active config's STORE (http), injected by the server.
const ASSET_BASE = STORE_HTTP

/**
 * Where one document's bytes live.
 *
 * Derived from the name every time rather than read from whatever a payload
 * carried, which is the rule both callers below already followed separately.
 */
export function documentBase(name: string): string {
  return `${ASSET_BASE}/docs/${name}/`
}

// Fetch a single document config from the API — fast path for ?project=X
//
// Both credentials ride the same way the sync socket carries them: the bearer
// via the patched fetch's Authorization header, the classroom token via
// `appendToken` on the URL. A bare fetch reaches a classroom-restricted
// project as nobody and is refused — and the refusal used to prescribe
// `?token=`, which cannot help when the bearer admits but no classroom
// principal resolves. The message names what is actually missing instead.
export async function fetchDocConfig(projectName: string, includePageInfo = false): Promise<DocConfig | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 8000)
  try {
    const url = appendToken(`${ASSET_BASE}/api/projects/${projectName}${includePageInfo ? '?include=page-info' : ''}`)
    const resp = await fetch(url, { signal: controller.signal })
    if (resp.status === 401 || resp.status === 403) {
      if (!getToken()) {
        throw new Error('Authentication required. Add ?token=TOKEN to the URL.')
      }
      if (!readClassroomToken()) {
        throw new Error('This project needs your classroom sign-in for this course — open your Continue link or registration page, then reload.')
      }
      const detail = await resp.json().catch(() => null)
      throw new Error(detail?.error || 'This project is not shared with that classroom sign-in.')
    }
    if (resp.status === 404) return null
    if (!resp.ok) return null
    const data = await resp.json()
    data.basePath = documentBase(projectName)
    return data as DocConfig
  } catch (e) {
    if ((e as Error).name === 'AbortError') {
      throw new Error('Server not responding. Try reloading.')
    }
    throw e
  } finally {
    clearTimeout(timeout)
  }
}

// Fetch document manifest at runtime — derives basePath from key
export async function fetchManifest(bustCache = false): Promise<Record<string, DocConfig>> {
  try {
    const url = `${ASSET_BASE}/docs/manifest.json` + (bustCache ? `?t=${Date.now()}` : '')
    const resp = await fetch(url)
    if (resp.status === 401 || resp.status === 403) {
      throw new Error('Authentication required. Add ?token=TOKEN to the URL.')
    }
    if (!resp.ok) return {}
    const data = await resp.json()
    const docs = data.documents || {}
    // Derive basePath from key — never trust a stored value
    for (const [key, config] of Object.entries(docs) as [string, DocConfig][]) {
      config.basePath = documentBase(key)
    }
    return docs
  } catch (e) {
    if (e instanceof Error && e.message.includes('Authentication')) throw e
    return {}
  }
}
