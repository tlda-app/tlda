import { useState, useEffect, useMemo, useRef, Component, type FormEvent, type ReactNode } from 'react'
import { SvgDocumentEditor } from './SvgDocument'
import { createSvgDocumentLayout, loadSvgDocument, loadImageDocument, loadHtmlDocument, loadDiffDocument, loadSlidesDocument } from './svgDocumentLoader'
import { clearDocumentStores } from './stores'
import { initToken, fetchAuthLevel } from './authToken'
import { BookViewer } from './BookViewer'
import { IdentityPicker } from './IdentityPicker'
import { sendMessage, useFleetAgents, useFleetEvents, useFleetIdentity } from './fleet-data-adapter'
import { STORE_HTTP } from './activeConfig'
import type { BookMember } from './BookContext'
import { LOG_AGE_CURVE, SpaceTimeDots, type ChangelogCommit } from './overlays/SpaceTimeDots'
import { useFleetTheme } from './hooks/useFleetTheme'
import { ChatComposer } from './shapes/ChatComposer'
import {
  getFleetAgentDirectoryRows,
  sortFleetAgentDirectoryRowsByRecency,
  type FleetAgentDirectoryRowModel,
} from './shapes/FleetAgentDirectoryModel'
import { isUsableIdentityName, sanitizeIdentityName } from './fleet/identity-persistence.mjs'
import './App.css'
import './themes.css'

// Initialize auth token from URL query param — patches fetch() to inject Authorization header
initToken()
// Fetch auth level (presenter permission) — fire and forget, UI updates reactively
fetchAuthLevel()

// Error boundary to prevent blank screen on errors
class ErrorBoundary extends Component<
  { children: ReactNode; onError?: () => void },
  { hasError: boolean; error: Error | null }
> {
  constructor(props: { children: ReactNode; onError?: () => void }) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('ErrorBoundary caught:', error, errorInfo)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="ErrorScreen">
          <h2>Something went wrong</h2>
          <p>{this.state.error?.message}</p>
          <button onClick={() => window.location.reload()}>Reload</button>
        </div>
      )
    }
    return this.props.children
  }
}

interface DocConfig {
  name: string
  pages: number
  basePath: string
  format?: 'svg' | 'png' | 'html' | 'diff' | 'book' | 'slides' | 'markdown'
  sourceDoc?: string
  members?: string[]
  buildStatus?: string
  autoSync?: boolean
  starred?: boolean
  lastBuild?: string
  createdAt?: string
  targets?: { texBase: string; mainFile: string; pages: number }[]
}

type SvgDoc = Awaited<ReturnType<typeof loadSvgDocument>>

interface DiffConfig {
  basePath: string
  buildStatus?: string
}

interface FleetConfigResponse {
  telemetryUrl?: unknown
  projectIndexDefaultSearch?: unknown
}

type ErrorType = 'not-found' | 'auth' | 'generic'

const HISTORY_INDEX_BATCH_SIZE = 500
const HISTORY_CHANGELOG_BATCH_SIZE = 50


type State =
  | { phase: 'loading'; message: string; roomId: string }
  | { phase: 'error'; message: string; errorType?: ErrorType }
  | { phase: 'picker'; manifest: Record<string, DocConfig> }
  | { phase: 'svg'; document: SvgDoc; roomId: string; diffConfig?: DiffConfig }
  | { phase: 'book'; bookName: string; members: BookMember[] }

// Doc assets come from the active config's STORE (http), injected by the server.
const ASSET_BASE = STORE_HTTP

// Fetch a single document config from the API — fast path for ?project=X
async function fetchDocConfig(projectName: string): Promise<DocConfig | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 8000)
  try {
    const url = `${ASSET_BASE}/api/projects/${projectName}`
    const resp = await fetch(url, { signal: controller.signal })
    if (resp.status === 401 || resp.status === 403) {
      throw new Error('Authentication required. Add ?token=TOKEN to the URL.')
    }
    if (resp.status === 404) return null
    if (!resp.ok) return null
    const data = await resp.json()
    data.basePath = `${ASSET_BASE}/docs/${projectName}/`
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
async function fetchManifest(bustCache = false): Promise<Record<string, DocConfig>> {
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
      config.basePath = `${ASSET_BASE}/docs/${key}/`
    }
    return docs
  } catch (e) {
    if (e instanceof Error && e.message.includes('Authentication')) throw e
    return {}
  }
}

// Generation counter + abort controller for document loading — prevents stale async completions
let loadGeneration = 0
let loadAbort: AbortController | null = null

// Parse initial camera from URL params (?cx=...&cy=...&cz=...&page=...)
function parseInitialCamera(): { x: number; y: number; z: number; page?: string } | undefined {
  const params = new URLSearchParams(window.location.search)
  const cx = params.get('cx'), cy = params.get('cy'), cz = params.get('cz')
  if (cx == null && cy == null && cz == null) return undefined
  return {
    x: cx ? parseFloat(cx) : 0,
    y: cy ? parseFloat(cy) : 0,
    z: cz ? parseFloat(cz) : 1,
    page: params.get('page') || undefined,
  }
}

function App() {
  const [state, setState] = useState<State | null>(null)
  const [initialCamera] = useState(parseInitialCamera)
  const isDark = useFleetTheme()

  // The browser's back button does not drive this app — see AGENTS.md
  // "Project as world". It used to reload the whole viewer on popstate, which
  // meant back had unknowable scope: it could rewind an in-document link you
  // had forgotten making, or throw away the entire session. In-app forward and
  // back are the controls with knowable scope.
  //
  // HtmlPageShape still owns same-document column navigation and restores
  // page/camera in place from its own history states; that is untouched.

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const projectName = params.get('project')

    if (projectName) {
      const roomId = `doc-${projectName}`
      setState({ phase: 'loading', message: 'Loading document...', roomId })
      loadDocument(projectName, roomId)
    } else {
      // No doc specified — show document picker or auto-load single doc
      setState({ phase: 'loading', message: 'Loading...', roomId: '' })
      // Retry manifest fetch a few times — server may still be initializing projects
      const tryManifest = async (attempts = 4) => {
        for (let i = 0; i < attempts; i++) {
          let manifest: Record<string, DocConfig>
          try {
            manifest = await fetchManifest()
          } catch (e) {
            const msg = (e as Error).message
            setState({ phase: 'error', message: msg, errorType: msg.includes('Authentication') ? 'auth' : 'generic' })
            return
          }
          const docs = Object.keys(manifest)
          if (docs.length > 0) {
            if (docs.length === 1) {
              const name = docs[0]
              const newUrl = new URL(window.location.href)
              newUrl.searchParams.set('project', name)
              window.history.replaceState({}, '', newUrl.toString())
              const roomId = `doc-${name}`
              setState({ phase: 'loading', message: `Loading ${name}...`, roomId })
              loadDocument(name, roomId)
            } else {
              setState({ phase: 'picker', manifest })
            }
            return
          }
          if (i < attempts - 1) await new Promise(r => setTimeout(r, 1000))
        }
        setState({ phase: 'error', message: 'No documents found. Use `tlda create` to add a project.' })
      }
      tryManifest()
    }
  }, [])

  async function loadDocument(projectName: string, roomId: string) {
    // Bump generation and abort any in-flight load
    const gen = ++loadGeneration
    loadAbort?.abort()
    const abort = loadAbort = new AbortController()
    const { signal } = abort

    // Fast path: fetch single doc config instead of full manifest
    let config: DocConfig | null
    try {
      config = await fetchDocConfig(projectName)
    } catch (e) {
      const msg = (e as Error).message
      setState({ phase: 'error', message: msg, errorType: msg.includes('Authentication') ? 'auth' : 'generic' })
      return
    }
    if (gen !== loadGeneration) return  // superseded

    // Book format: needs full manifest to resolve member docs
    if (config?.format === 'book' && config.members) {
      let manifest: Record<string, DocConfig>
      try {
        manifest = await fetchManifest()
      } catch (e) {
        const msg = (e as Error).message
        setState({ phase: 'error', message: msg, errorType: msg.includes('Authentication') ? 'auth' : 'generic' })
        return
      }
      if (gen !== loadGeneration) return
      const members: BookMember[] = config.members
        .map(key => {
          const memberConfig = manifest[key]
          if (!memberConfig) return null
          return {
            key,
            name: memberConfig.name || key,
            format: memberConfig.format,
            pages: memberConfig.pages,
            basePath: memberConfig.basePath,
            ...((memberConfig as any).sessionAt && { sessionAt: (memberConfig as any).sessionAt }),
          }
        })
        .filter((m): m is BookMember => m !== null)

      setState({ phase: 'book', bookName: projectName, members })
      return
    }

    // If project is missing, still building, or has no pages yet, poll until ready
    if (!config || config.buildStatus === 'building' || config.pages === 0) {
      if (!config) {
        setState({ phase: 'error', message: `Document "${projectName}" not found.`, errorType: 'not-found' })
        return
      }
      const label = config.name || projectName
      setState({ phase: 'loading', message: config.buildStatus === 'building' ? `Building ${label}...` : `Waiting for ${label}...`, roomId })
      const waitForBuild = async () => {
        while (gen === loadGeneration) {
          await new Promise(r => setTimeout(r, 2000))
          if (gen !== loadGeneration) return
          try {
            const c = await fetchDocConfig(projectName)
            if (c && c.pages > 0 && c.buildStatus !== 'building') break
          } catch (e) {
            if (e instanceof Error && e.message.includes('Authentication')) {
              setState({ phase: 'error', message: e.message })
              return
            }
          }
        }
        if (gen === loadGeneration) loadDocument(projectName, roomId)
      }
      waitForBuild()
      return
    }

    setState(s => s ? { ...s, message: `Loading ${config.name}...` } : s)

    // Clear stale stores from any previous document before loading new one
    clearDocumentStores()

    try {
      // When basePath is already absolute (cross-origin asset server), use it directly.
      // Otherwise prepend BASE_URL for same-origin relative paths.
      const isAbsolute = config.basePath.startsWith('http://') || config.basePath.startsWith('https://')
      const fullBasePath = isAbsolute
        ? config.basePath
        : `${import.meta.env.BASE_URL || '/'}${config.basePath.startsWith('/') ? config.basePath.slice(1) : config.basePath}`

      let document
      if (config.format === 'diff') {
        document = await loadDiffDocument(projectName, fullBasePath)
      } else if (config.format === 'html' || config.format === 'markdown') {
        document = await loadHtmlDocument(config.name, fullBasePath)
      } else if (config.format === 'slides') {
        document = await loadSlidesDocument(config.name, fullBasePath)
      } else if (config.format === 'png') {
        const makeUrl = (n: number) => `${fullBasePath}page-${n}.png`
        // Probe beyond manifest hint to discover extra pages (handles stale page counts)
        let pageCount = config.pages
        while (true) {
          if (signal.aborted) return
          const resp = await fetch(makeUrl(pageCount + 1), { method: 'HEAD', signal })
          if (!resp.ok || !resp.headers.get('content-type')?.includes('image/png')) break
          pageCount++
        }
        const urls = Array.from({ length: pageCount }, (_, i) => makeUrl(i + 1))
        document = await loadImageDocument(config.name, urls, fullBasePath)
      } else {
        // SVG: create layout immediately, pages fetched async after editor mounts.
        // targets[] always present from API; map to TargetInfo for the layout.
        const targets = config.targets?.map(t => ({
          name: t.texBase,
          title: t.texBase.replace(/_/g, ' '),
          pages: t.pages,
          basePath: fullBasePath,
        }))
        document = createSvgDocumentLayout(projectName, config.pages, fullBasePath, targets)
      }

      if (gen !== loadGeneration) return  // superseded during fetch

      // For non-diff docs, check if a matching diff doc exists (lazy manifest fetch — not on critical path)
      let diffConfig: DiffConfig | undefined
      if (config.format !== 'diff') {
        try {
          const manifest = await fetchManifest()
          const diffEntry = Object.values(manifest).find(
            c => c.format === 'diff' && c.sourceDoc === projectName
          )
          if (diffEntry) {
            const diffBasePath = diffEntry.basePath.startsWith('/')
              ? diffEntry.basePath.slice(1)
              : diffEntry.basePath
            diffConfig = { basePath: `${import.meta.env.BASE_URL || '/'}${diffBasePath}` }
          }
        } catch { /* diff lookup is optional — don't block on it */ }
      }

      setState({ phase: 'svg', document, roomId, diffConfig })
    } catch (e) {
      if (signal.aborted) return  // expected abort, don't show error
      console.error('Failed to load document:', e)

      // Check if a build is in progress — if so, wait and retry
      try {
        const statusResp = await fetch(`/api/projects/${projectName}/build/status`)
        if (statusResp.ok) {
          const status = await statusResp.json()
          if (status.status === 'building') {
            setState({ phase: 'loading', message: `Building ${projectName}...`, roomId })
            // Poll until build completes, then retry
            const pollBuild = async () => {
              while (gen === loadGeneration) {
                await new Promise(r => setTimeout(r, 2000))
                if (gen !== loadGeneration) return
                try {
                  const r = await fetch(`/api/projects/${projectName}/build/status`)
                  if (!r.ok) break
                  const s = await r.json()
                  if (s.status !== 'building') break
                } catch { break }
              }
              if (gen === loadGeneration) loadDocument(projectName, roomId)
            }
            pollBuild()
            return
          }
        }
      } catch { /* ignore status check failure */ }

      const msg = (e as Error).message
      const isAuth = msg.includes('401') || msg.includes('403') || msg.includes('Unauthorized') || msg.includes('Forbidden') || msg.includes('Authentication')
      setState({
        phase: 'error',
        message: isAuth ? 'Authentication required. Add ?token=TOKEN to the URL.' : `Failed to load "${projectName}": ${msg}`,
        errorType: isAuth ? 'auth' : 'generic',
      })
    }
  }

  if (!state) {
    return <><IdentityPicker /><div className="App loading">Loading...</div></>
  }

  switch (state.phase) {
    case 'loading':
      return (
        <div className="App">
          <div className="LoadingScreen">
            <p>{state.message}</p>
          </div>
        </div>
      )
    case 'error':
      return (
        <div className="App">
          <div className="ErrorScreen">
            <div className="error-icon">
              {state.errorType === 'not-found' ? '404' : state.errorType === 'auth' ? '🔒' : '⚠'}
            </div>
            <h2 className="error-title">
              {state.errorType === 'not-found' ? 'Document not found'
                : state.errorType === 'auth' ? 'Authentication required'
                : 'Something went wrong'}
            </h2>
            <p className="error-message">{state.message}</p>
            <a className="error-home-link" href="/">← All documents</a>
          </div>
        </div>
      )
    case 'picker':
      return (
        <div className="App">
          <IdentityPicker />
          <DocumentPicker isDark={isDark} manifest={state.manifest} onSelect={(key, config) => {
            const newUrl = new URL(window.location.href)
            newUrl.searchParams.set('project', key)
            // replaceState, not pushState: the address bar keeps naming the
            // document you are in, so ?project= links, bookmarks and agent probes
            // keep working — but choosing a document does not put an entry on
            // the browser's stack, because back is not an in-app control.
            window.history.replaceState({}, '', newUrl.toString())
            const roomId = `doc-${key}`
            setState({ phase: 'loading', message: `Loading ${config.name}...`, roomId })
            loadDocument(key, roomId)
          }} />
        </div>
      )
    case 'book':
      return (
        <div className="App">
          <ErrorBoundary>
            <BookViewer bookName={state.bookName} members={state.members} />
          </ErrorBoundary>
        </div>
      )
    case 'svg':
      return (
        <div className="App">
          <IdentityPicker />
          <ErrorBoundary>
            <SvgDocumentEditor document={state.document} roomId={state.roomId} diffConfig={state.diffConfig} initialCamera={initialCamera} />
          </ErrorBoundary>
        </div>
      )
  }
}

type ProjectMeta = Record<string, { lastBuild?: string; lastAnnotated?: string }>
type ProjectHistoryIndex = {
  projects: Record<string, { commitCount: number; oldest: { hash: string; timestamp: number } }>
  oldest: number | null
}
type ProjectChangelog = { commits: ChangelogCommit[]; totalPages: number; error?: string }
type CommitCountFilter = { min?: number; max?: number }
type CreatedAgeFilter = { minAgeMs?: number; maxAgeMs?: number }
type ProjectSearchClause = { text: string; commitFilters: CommitCountFilter[]; createdAgeFilters: CreatedAgeFilter[] }
type ProjectSearchQuery = { clauses: ProjectSearchClause[] }

function commitRange(min?: number, max?: number): CommitCountFilter {
  return {
    ...(min !== undefined && { min }),
    ...(max !== undefined && { max }),
  }
}

function createdAgeRange(minAgeMs?: number, maxAgeMs?: number): CreatedAgeFilter {
  return {
    ...(minAgeMs !== undefined && { minAgeMs }),
    ...(maxAgeMs !== undefined && { maxAgeMs }),
  }
}

function parseDurationMs(raw: string | undefined) {
  if (!raw) return undefined
  const match = raw.match(/^(\d+)(ms|s|m|h|d|w)?$/i)
  if (!match) return undefined
  const value = Number(match[1])
  if (!Number.isFinite(value)) return undefined
  const unit = (match[2] || 'ms').toLowerCase()
  const multiplier = unit === 'w' ? 7 * 24 * 60 * 60 * 1000
    : unit === 'd' ? 24 * 60 * 60 * 1000
      : unit === 'h' ? 60 * 60 * 1000
        : unit === 'm' ? 60 * 1000
          : unit === 's' ? 1000
            : 1
  return value * multiplier
}

function parseProjectSearchQuery(raw: string): ProjectSearchQuery {
  const clauses = raw.split(/\s+or\s+/i).map(part => parseProjectSearchClause(part)).filter(clause =>
    clause.text || clause.commitFilters.length > 0 || clause.createdAgeFilters.length > 0
  )
  return { clauses }
}

function parseProjectSearchClause(raw: string): ProjectSearchClause {
  const commitFilters: CommitCountFilter[] = []
  const createdAgeFilters: CreatedAgeFilter[] = []
  let text = raw.replace(/\bcommits:(?:(\d*)\.\.(\d*)|(>=|<=|>|<)?(\d+))(?=\s|$)/gi, (match, rangeMin, rangeMax, op, value) => {
    if (rangeMin !== undefined || rangeMax !== undefined) {
      const min = rangeMin ? Number(rangeMin) : undefined
      const max = rangeMax ? Number(rangeMax) : undefined
      if ((min === undefined && max === undefined) || Number.isNaN(min) || Number.isNaN(max)) return match
      commitFilters.push(commitRange(min, max))
      return ' '
    }

    const lhs = value === undefined ? undefined : Number(value)
    if (lhs === undefined || Number.isNaN(lhs)) return match
    if (op === '>=') {
      commitFilters.push({ min: lhs })
    } else if (op === '>') {
      commitFilters.push({ min: lhs + 1 })
    } else if (op === '<=') {
      commitFilters.push({ max: lhs })
    } else if (op === '<') {
      commitFilters.push({ max: lhs - 1 })
    } else if (lhs !== undefined) {
      commitFilters.push({ min: lhs, max: lhs })
    } else {
      return match
    }
    return ' '
  })
  text = text.replace(/\bcreated:(?:(\d+(?:ms|s|m|h|d|w)?)?\.\.(\d+(?:ms|s|m|h|d|w)?)?|(?:<=|<)?(\d+(?:ms|s|m|h|d|w)?))(?=\s|$)/gi, (match, rangeMin, rangeMax, value) => {
    if (rangeMin !== undefined || rangeMax !== undefined) {
      const minAgeMs = parseDurationMs(rangeMin)
      const maxAgeMs = parseDurationMs(rangeMax)
      if ((minAgeMs === undefined && maxAgeMs === undefined) || Number.isNaN(minAgeMs) || Number.isNaN(maxAgeMs)) return match
      createdAgeFilters.push(createdAgeRange(minAgeMs, maxAgeMs))
      return ' '
    }
    const maxAgeMs = parseDurationMs(value)
    if (maxAgeMs === undefined || Number.isNaN(maxAgeMs)) return match
    createdAgeFilters.push({ maxAgeMs })
    return ' '
  })
  return { text: text.toLowerCase().trim().replace(/\s+/g, ' '), commitFilters, createdAgeFilters }
}

function matchesCommitFilters(info: ProjectHistoryIndex['projects'][string] | undefined, filters: CommitCountFilter[]) {
  if (filters.length === 0) return true
  if (!info) return false
  return filters.every(filter => {
    const count = info.commitCount
    return (filter.min === undefined || count >= filter.min)
      && (filter.max === undefined || count <= filter.max)
  })
}

function matchesCreatedAgeFilters(createdAt: string | undefined, filters: CreatedAgeFilter[]) {
  if (filters.length === 0) return true
  if (!createdAt) return false
  const createdMs = new Date(createdAt).getTime()
  if (!Number.isFinite(createdMs)) return false
  const ageMs = Date.now() - createdMs
  return filters.every(filter =>
    (filter.minAgeMs === undefined || ageMs >= filter.minAgeMs)
    && (filter.maxAgeMs === undefined || ageMs <= filter.maxAgeMs)
  )
}

function matchesProjectSearchText(key: string, name: string | undefined, text: string) {
  if (!text) return true
  const haystack = `${name || ''} ${key}`.toLowerCase()
  return text.split(/\s+/).every(term => haystack.includes(term))
}

function matchesProjectSearchQuery(
  key: string,
  config: DocConfig,
  info: ProjectHistoryIndex['projects'][string] | undefined,
  query: ProjectSearchQuery,
) {
  if (query.clauses.length === 0) return true
  return query.clauses.some(clause =>
    matchesCommitFilters(info, clause.commitFilters)
    && matchesCreatedAgeFilters(config.createdAt, clause.createdAgeFilters)
    && matchesProjectSearchText(key, config.name, clause.text)
  )
}

function relativeTime(iso: string | undefined): string {
  if (!iso) return '—'
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 30) return `${days}d ago`
  return `${Math.floor(days / 30)}mo ago`
}

interface ArchivedProject { name: string; title?: string; starred?: boolean }

type ProjectAction = 'star' | 'archive'
type PointerStart = { key: string; x: number; y: number; archived: boolean; dx: number; action: ProjectAction | null }
type FleetChatFilter = [string, string][][]

function fleetEventTimestamp(event: any) {
  const ts = event?.timestamp || event?.ts || ''
  const parsed = ts ? new Date(ts).getTime() : 0
  return Number.isFinite(parsed) ? parsed : 0
}

function fleetEventText(event: any) {
  return String(event?.text || event?.message || event?.metadata?.message || '')
}

function projectLabelMatches(row: FleetAgentDirectoryRowModel, project: string) {
  if (!project) return false
  if (row.project === project) return true
  return row.labels.some(label => label === project || label === `project:${project}` || label.endsWith(`/${project}`))
}

function fleetChatFilterForAgent(row: FleetAgentDirectoryRowModel | null): FleetChatFilter | null {
  if (!row?.exactName) return null
  return [[['from', row.exactName]], [['to', row.exactName]]]
}

function DocumentPicker({ isDark, manifest, onSelect }: {
  isDark: boolean
  manifest: Record<string, DocConfig>
  onSelect: (key: string, config: DocConfig) => void
}) {
  const identity = useFleetIdentity()
  const agents = useFleetAgents()
  const agentRows = useMemo(() => sortFleetAgentDirectoryRowsByRecency(getFleetAgentDirectoryRows(agents)), [agents])
  const [meta, setMeta] = useState<ProjectMeta>({})
  const [telemetryUrl, setTelemetryUrl] = useState<string | null>(null)
  const [defaultSearch, setDefaultSearch] = useState('')
  const [hiddenKeys, setHiddenKeys] = useState<Set<string>>(new Set())
  const [starredKeys, setStarredKeys] = useState<Set<string>>(new Set(
    Object.entries(manifest).filter(([, config]) => config.starred).map(([key]) => key)
  ))
  const [search, setSearch] = useState('')
  const [archived, setArchived] = useState<ArchivedProject[]>([])
  const [restoredKeys, setRestoredKeys] = useState<Set<string>>(new Set())
  const [restoredProjects, setRestoredProjects] = useState<Record<string, DocConfig>>({})
  const [docHealth, setDocHealth] = useState<Record<string, { ok: boolean; error?: string }>>({})
  const [historyIndex, setHistoryIndex] = useState<ProjectHistoryIndex | null>(null)
  const [changelogs, setChangelogs] = useState<Record<string, ProjectChangelog>>({})
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [timeAxisNow] = useState(() => Date.now())
  const [identityDraft, setIdentityDraft] = useState(identity.name || '')
  const [identityMessage, setIdentityMessage] = useState('')
  const [identitySaving, setIdentitySaving] = useState(false)
  const [activeChromeProject, setActiveChromeProject] = useState('')
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
  const [chatSendError, setChatSendError] = useState('')
  const pointerStart = useRef<PointerStart | null>(null)
  const pointerSwiped = useRef(false)
  const requestedHistoriesRef = useRef(new Set<string>())
  const [dragPreview, setDragPreview] = useState<{ key: string; action: ProjectAction; dx: number } | null>(null)
  const parsedSearch = useMemo(() => parseProjectSearchQuery(search), [search])
  const parsedDefaultSearch = useMemo(() => parseProjectSearchQuery(defaultSearch), [defaultSearch])

  useEffect(() => {
    fetch(`${ASSET_BASE}/api/projects/meta`)
      .then(r => r.ok ? r.json() : {})
      .then(setMeta)
      .catch(e => console.warn('[app] projects/meta fetch failed:', e.message))
    // Fetch sync health for all docs
    fetch(`${ASSET_BASE}/api/projects/health`)
      .then(r => r.ok ? r.json() : {})
      .then(setDocHealth)
      .catch(e => console.warn('[app] projects/health fetch failed:', e.message))
    fetch(`${ASSET_BASE}/api/fleet-config`)
      .then(r => r.ok ? r.json() as Promise<FleetConfigResponse> : Promise.resolve<FleetConfigResponse>({}))
      .then(data => {
        setTelemetryUrl(typeof data.telemetryUrl === 'string' ? data.telemetryUrl : null)
        setDefaultSearch(typeof data.projectIndexDefaultSearch === 'string' ? data.projectIndexDefaultSearch.trim() : '')
      })
      .catch(e => console.warn('[app] fleet-config fetch failed:', e.message))
  }, [])

  // Fetch archived list when search is non-empty
  useEffect(() => {
    const needsArchived = parsedSearch.clauses.some(clause => clause.text)
    if (!needsArchived) { setArchived([]); return }
    fetch(`${ASSET_BASE}/api/projects/archived`)
      .then(r => r.ok ? r.json() : { projects: [] })
      .then(data => setArchived(data.projects || []))
      .catch(e => console.warn('[app] archived fetch failed:', e.message))
  }, [parsedSearch])

  const bookMembers = new Set<string>()
  for (const config of Object.values(manifest)) {
    if (config.format === 'book' && config.members) {
      for (const m of config.members) bookMembers.add(m)
    }
  }

  const indexProjectKey = Object.keys(manifest)
    .filter(key => !bookMembers.has(key))
    .sort()
    .join('\n')

  useEffect(() => {
    if (!indexProjectKey) return
    const controller = new AbortController()
    const projectNames = indexProjectKey.split('\n')
    async function fetchHistoryIndex() {
      const batches: string[][] = []
      for (let i = 0; i < projectNames.length; i += HISTORY_INDEX_BATCH_SIZE) {
        batches.push(projectNames.slice(i, i + HISTORY_INDEX_BATCH_SIZE))
      }
      const parts = await Promise.all(batches.map(async batch => {
        const response = await fetch(`${ASSET_BASE}/api/projects/history/shadow/index`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projects: batch }),
          signal: controller.signal,
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response.json()
      }))
      return parts.reduce((acc, data) => {
        const oldest = Number.isFinite(data.oldest) ? data.oldest : null
        return {
          projects: { ...acc.projects, ...(data.projects || {}) },
          oldest: oldest == null ? acc.oldest : (acc.oldest == null ? oldest : Math.min(acc.oldest, oldest)),
        }
      }, { projects: {}, oldest: null } as ProjectHistoryIndex)
    }
    fetchHistoryIndex()
      .then(data => {
        setHistoryError(null)
        setHistoryIndex(data)
      })
      .catch(error => {
        // Best effort: keep the index usable if history indexing is unavailable.
        if (error.name !== 'AbortError') {
          setHistoryError('Project history unavailable')
          console.warn('[app] project history index fetch failed:', error.message)
        }
      })
    return () => controller.abort()
  }, [indexProjectKey])

  const entries = Object.entries({ ...manifest, ...restoredProjects })
    .filter(([key]) => !bookMembers.has(key) && !hiddenKeys.has(key))
    .filter(([key, config]) => matchesProjectSearchQuery(key, config, historyIndex?.projects[key], parsedDefaultSearch))
    .filter(([key, config]) => matchesProjectSearchQuery(key, config, historyIndex?.projects[key], parsedSearch))
    .sort(([keyA, configA], [keyB, configB]) => {
      const starA = starredKeys.has(keyA) || !!configA.starred
      const starB = starredKeys.has(keyB) || !!configB.starred
      if (starA !== starB) return starA ? -1 : 1
      return String(meta[keyB]?.lastBuild || configB.lastBuild || '')
        .localeCompare(String(meta[keyA]?.lastBuild || configA.lastBuild || ''))
    })

  const visibleEntries = entries
  const visibleProjectNames = visibleEntries.map(([key]) => key)
  const visibleProjectKey = visibleProjectNames.join('\n')
  const chromeProject = activeChromeProject && visibleProjectNames.includes(activeChromeProject)
    ? activeChromeProject
    : visibleProjectNames[0] || ''
  const projectAgentRows = useMemo(() => {
    if (!chromeProject) return []
    return agentRows.filter(row => projectLabelMatches(row, chromeProject))
  }, [agentRows, chromeProject])
  const chromeAgentRows = projectAgentRows.length > 0 ? projectAgentRows : agentRows.slice(0, 12)
  const selectedAgent = useMemo(() => {
    if (!selectedAgentId) return null
    return agentRows.find(row => row.id === selectedAgentId || row.exactName === selectedAgentId) || null
  }, [agentRows, selectedAgentId])
  const selectedAgentFilter = useMemo(() => fleetChatFilterForAgent(selectedAgent), [selectedAgent])
  const chromeChatFilter = selectedAgentFilter || [[['from', '__tlda-index-no-agent__']]] as FleetChatFilter
  const selectedChatEvents = useFleetEvents(chromeChatFilter, undefined, selectedAgent?.id ? `index:${selectedAgent.id}` : 'index:no-agent')
  const selectedChatRows = useMemo(() => {
    if (!selectedAgent) return []
    return selectedChatEvents
      .filter(event => fleetEventText(event))
      .sort((a, b) => fleetEventTimestamp(a) - fleetEventTimestamp(b))
      .slice(-24)
  }, [selectedAgent, selectedChatEvents])
  const composerAgentNames = useMemo(() => (
    selectedAgent ? { [selectedAgent.exactName]: selectedAgent.displayName, [selectedAgent.id]: selectedAgent.displayName } : {}
  ), [selectedAgent])
  const sendTargets = selectedAgent?.exactName ? [selectedAgent.exactName] : []

  useEffect(() => {
    setIdentityDraft(identity.name || '')
  }, [identity.name])

  useEffect(() => {
    const projectNames = (visibleProjectKey ? visibleProjectKey.split('\n') : [])
      .filter(name => !requestedHistoriesRef.current.has(name))
    if (projectNames.length === 0) return
    for (const name of projectNames) requestedHistoriesRef.current.add(name)
    async function fetchChangelogs() {
      const batches: string[][] = []
      for (let i = 0; i < projectNames.length; i += HISTORY_CHANGELOG_BATCH_SIZE) {
        batches.push(projectNames.slice(i, i + HISTORY_CHANGELOG_BATCH_SIZE))
      }
      const parts = await Promise.all(batches.map(async batch => {
        const response = await fetch(`${ASSET_BASE}/api/projects/history/shadow/changelog/batch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projects: batch }),
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response.json()
      }))
      return parts.reduce((projects, data) => ({ ...projects, ...(data.projects || {}) }), {} as Record<string, ProjectChangelog>)
    }
    fetchChangelogs()
      .then(data => {
        setHistoryError(null)
        setChangelogs(current => ({ ...current, ...data }))
      })
      .catch(error => {
        for (const name of projectNames) requestedHistoriesRef.current.delete(name)
        setHistoryError('History unavailable')
        console.warn('[app] project history batch fetch failed:', error.message)
      })
  }, [visibleProjectKey])

  const timeRange = historyIndex?.oldest
    ? { oldest: historyIndex.oldest, newest: timeAxisNow }
    : null

  const dateTicks = timeRange
    ? Array.from({ length: 5 }, (_, index) => {
        const xProgress = index / 4
        const ageFraction = Math.expm1((1 - xProgress) * Math.log1p(LOG_AGE_CURVE)) / LOG_AGE_CURVE
        const timestamp = timeRange.newest - ageFraction * (timeRange.newest - timeRange.oldest)
        return {
          timestamp,
          left: `${(index / 4) * 100}%`,
          label: new Date(timestamp).toLocaleDateString(undefined, {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
          }),
        }
      })
    : []

  const archivedFiltered = archived
    .filter(p => !restoredKeys.has(p.name))
    .filter(p => parsedSearch.clauses.some(clause => matchesProjectSearchText(p.name, p.title || p.name, clause.text)))

  const archiveProject = (key: string, e?: React.MouseEvent | React.PointerEvent) => {
    e?.stopPropagation()
    pointerSwiped.current = true
    setDragPreview(null)
    setHiddenKeys(prev => new Set(prev).add(key))
    setRestoredKeys(prev => {
      if (!prev.has(key)) return prev
      const next = new Set(prev)
      next.delete(key)
      return next
    })
    setArchived(prev => (
      prev.some(p => p.name === key)
        ? prev
        : [...prev, {
          name: key,
          title: manifest[key]?.name || restoredProjects[key]?.name || key,
          starred: starredKeys.has(key) || !!manifest[key]?.starred || !!restoredProjects[key]?.starred,
        }]
    ))
    setRestoredProjects(prev => {
      if (!prev[key]) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
    fetch(`${ASSET_BASE}/api/projects/${key}/archive`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ archived: true }),
    }).catch(() => {
      setHiddenKeys(prev => { const next = new Set(prev); next.delete(key); return next })
    })
  }

  const restoreProject = (key: string, e?: React.MouseEvent | React.PointerEvent) => {
    e?.stopPropagation()
    pointerSwiped.current = true
    setDragPreview(null)
    setHiddenKeys(prev => { const next = new Set(prev); next.delete(key); return next })
    setRestoredKeys(prev => new Set(prev).add(key))
    const archivedProject = archived.find(p => p.name === key)
    if (archivedProject) {
      setRestoredProjects(prev => ({
        ...prev,
        [key]: {
          name: archivedProject.title || archivedProject.name,
          pages: 1,
          basePath: `${ASSET_BASE}/docs/${key}/`,
          mainFile: 'notes.md',
          format: 'markdown',
          starred: archivedProject.starred,
        },
      }))
    }
    fetch(`${ASSET_BASE}/api/projects/${key}/archive`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ archived: false }),
    }).catch(() => {
      setRestoredKeys(prev => { const next = new Set(prev); next.delete(key); return next })
      setRestoredProjects(prev => {
        if (!prev[key]) return prev
        const next = { ...prev }
        delete next[key]
        return next
      })
    })
  }

  const starProject = (key: string, archivedRow: boolean, e?: React.MouseEvent | React.PointerEvent) => {
    e?.stopPropagation()
    pointerSwiped.current = true
    setDragPreview(null)
    const wasStarred = starredKeys.has(key) || !!manifest[key]?.starred
    const nextStarred = archivedRow ? true : !wasStarred
    setStarredKeys(prev => {
      const next = new Set(prev)
      if (nextStarred) next.add(key)
      else next.delete(key)
      return next
    })
    if (archivedRow) {
      setRestoredKeys(prev => new Set(prev).add(key))
      const archivedProject = archived.find(p => p.name === key)
      if (archivedProject) {
        setRestoredProjects(prev => ({
          ...prev,
          [key]: {
            name: archivedProject.title || archivedProject.name,
            pages: 1,
            basePath: `${ASSET_BASE}/docs/${key}/`,
            mainFile: 'notes.md',
            format: 'markdown',
            starred: true,
          },
        }))
      }
    }
    fetch(`${ASSET_BASE}/api/projects/${key}/star`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ starred: nextStarred }),
    }).catch(() => {
      setStarredKeys(prev => {
        const next = new Set(prev)
        if (wasStarred) next.add(key)
        else next.delete(key)
        return next
      })
      if (archivedRow) {
        setRestoredKeys(prev => { const next = new Set(prev); next.delete(key); return next })
        setRestoredProjects(prev => {
          if (!prev[key]) return prev
          const next = { ...prev }
          delete next[key]
          return next
        })
      }
    })
  }

  const onRowPointerDown = (key: string, archivedRow: boolean, e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    pointerSwiped.current = false
    pointerStart.current = { key, x: e.clientX, y: e.clientY, archived: archivedRow, dx: 0, action: null }
  }

  const onRowPointerMove = (key: string, e: React.PointerEvent) => {
    const start = pointerStart.current
    if (!start || start.key !== key) return
    const dx = e.clientX - start.x
    const dy = e.clientY - start.y
    if (Math.abs(dx) < 18 || Math.abs(dx) < Math.abs(dy) * 1.4) {
      pointerStart.current = { ...start, dx, action: null }
      if (dragPreview?.key === key) setDragPreview(null)
      return
    }
    const action = dx > 0 ? 'star' : 'archive'
    pointerStart.current = { ...start, dx, action }
    setDragPreview({ key, action, dx: Math.max(-96, Math.min(96, dx)) })
  }

  const onRowPointerEnd = (key: string, e: React.PointerEvent) => {
    const start = pointerStart.current
    pointerStart.current = null
    setDragPreview(null)
    if (!start || start.key !== key || !start.action || Math.abs(start.dx) < 72) return
    pointerSwiped.current = true
    if (start.action === 'star') {
      starProject(key, start.archived, e)
    } else if (start.archived) {
      restoreProject(key, e)
    } else {
      archiveProject(key, e)
    }
  }

  const onRowClick = (key: string, config: DocConfig) => {
    if (pointerSwiped.current) {
      pointerSwiped.current = false
      return
    }
    onSelect(key, config)
  }

  const openHistoryPoint = (project: string, commit: ChangelogCommit, page: number) => {
    const url = new URL(window.location.href)
    url.searchParams.set('project', project)
    url.searchParams.set('history', commit.hash)
    url.searchParams.set('historyTime', String(commit.timestamp))
    url.searchParams.set('page', String(page))
    window.location.assign(url.toString())
  }

  const saveIdentityName = async (event: FormEvent) => {
    event.preventDefault()
    const candidate = sanitizeIdentityName(identityDraft)
    if (!isUsableIdentityName(candidate)) {
      setIdentityMessage('Enter a name.')
      return
    }
    setIdentitySaving(true)
    setIdentityMessage('')
    try {
      await identity.login(candidate)
      setIdentityMessage(`Signed in as ${candidate}.`)
    } catch {
      await identity.register(candidate)
      setIdentityMessage(`Signed in as ${candidate}.`)
    } finally {
      setIdentitySaving(false)
    }
  }

  const sendChromeChat = (text: string, targets: string[]) => {
    setChatSendError('')
    void Promise.all(targets.map(target => sendMessage(target, text)))
      .then(results => {
        if (!results.every(result => result.ok || result.queued)) {
          setChatSendError('Message was not sent.')
        }
      })
      .catch(error => setChatSendError(error instanceof Error ? error.message : 'Message was not sent.'))
  }

  return (
    <div className={`PickerScreen${isDark ? ' tl-theme__dark' : ''}`}>
      <div className="picker-layout">
        <main className="picker-main">
          <div className="project-index">
            <div className="project-index-axis" aria-hidden="true">
              <span className="project-index-axis-label">Project</span>
              <div className="project-index-axis-ticks">
                {dateTicks.map(tick => (
                  <span key={tick.timestamp} style={{ left: tick.left }}>{tick.label}</span>
                ))}
              </div>
              <span className="project-index-axis-spacer" />
            </div>
            <div className="project-index-rows">
              {visibleEntries.map(([key, config]) => {
                const health = docHealth[key]
                const isBroken = health && !health.ok
                const isStarred = starredKeys.has(key) || !!config.starred
                const preview = dragPreview?.key === key ? dragPreview : null
                const changelog = changelogs[key]
                const hasPageEdits = changelog?.commits.some(commit => commit.changedPages.length > 0)
                return (
                  <div
                    key={key}
                    className={`project-index-row${isBroken ? ' picker-row-broken' : ''}${isStarred ? ' project-index-row-starred' : ''}${preview ? ` is-swiping is-swiping-${preview.action}` : ''}`}
                    style={preview ? { transform: `translateX(${preview.dx}px)` } : undefined}
                    onPointerDown={(e) => onRowPointerDown(key, false, e)}
                    onPointerMove={(e) => onRowPointerMove(key, e)}
                    onPointerUp={(e) => onRowPointerEnd(key, e)}
                    onPointerCancel={() => { pointerStart.current = null; setDragPreview(null) }}
                    onClick={() => onRowClick(key, config)}
                  >
                    <div className="project-index-name">
                      {isBroken && <span className="picker-health-dot" title={health.error || 'Sync error'} />}
                      <a href={`?project=${key}`} onClick={e => e.preventDefault()}>{config.name || key}</a>
                      <span className="picker-date">{relativeTime(meta[key]?.lastBuild || config.lastBuild)}</span>
                      {isBroken && <span className="picker-error-hint">{health.error?.substring(0, 60)}</span>}
                    </div>
                    <div className="project-index-history">
                      {!changelog && !historyError && (
                        <span className="project-index-history-loading">Loading history...</span>
                      )}
                      {changelog && !hasPageEdits && (
                        <span className="project-index-history-loading">No page edits</span>
                      )}
                      {changelog && hasPageEdits && timeRange && (
                        <SpaceTimeDots
                          changelog={changelog}
                          timeRange={timeRange}
                          timeScale="log-age"
                          showPageLabels={false}
                          className="project-index-spacetime"
                          onSelect={(commit, page) => openHistoryPoint(key, commit, page)}
                        />
                      )}
                      {(historyError || changelog?.error) && (
                        <span className="project-index-history-status">
                          {changelog?.error || historyError}
                        </span>
                      )}
                    </div>
                    <div className="project-row-actions" onPointerDown={e => e.stopPropagation()}>
                      <button
                        className={`project-row-action project-row-star${isStarred ? ' is-active' : ''}`}
                        title={isStarred ? 'Unstar' : 'Star'}
                        aria-label={isStarred ? 'Unstar project' : 'Star project'}
                        onClick={(e) => starProject(key, false, e)}
                      >★</button>
                      <button
                        className="project-row-action project-row-archive"
                        title="Archive"
                        aria-label="Archive project"
                        onClick={(e) => archiveProject(key, e)}
                      >×</button>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </main>
        <aside className="page-chrome" aria-label="Page chrome chat and project agents">
          <section className="page-chrome-section page-chrome-chat">
            <div className="page-chrome-section-title">
              <span>Chat</span>
              {selectedAgent && <button type="button" onClick={() => setSelectedAgentId(null)}>All</button>}
            </div>
            <div className="page-chrome-chat-target">
              {selectedAgent ? selectedAgent.displayName : 'Choose an agent'}
            </div>
            <div className="page-chrome-chat-log" aria-live="polite">
              {selectedAgent && selectedChatRows.length === 0 && (
                <div className="page-chrome-empty">No recent messages</div>
              )}
              {!selectedAgent && (
                <div className="page-chrome-empty">Select an agent below for one-on-one chat.</div>
              )}
              {selectedChatRows.map((event, index) => {
                const from = event.from_id || event.from || ''
                const isHuman = identity.id && from === identity.id
                const author = isHuman ? (identity.name || 'You') : selectedAgent?.displayName || String(from).replace(/^fleet:/, '')
                return (
                  <div key={event.id || event._tempId || `${event.timestamp}-${index}`} className="page-chrome-chat-row">
                    <span className="page-chrome-chat-meta">{author}</span>
                    <span className="page-chrome-chat-text">{fleetEventText(event)}</span>
                  </div>
                )
              })}
            </div>
            <ChatComposer
              className="page-chrome-composer"
              sendTargets={sendTargets}
              agentNames={composerAgentNames}
              onSend={sendChromeChat}
              placeholder={selectedAgent ? `Message ${selectedAgent.displayName}` : ''}
            />
            {chatSendError && <div className="page-chrome-error">{chatSendError}</div>}
          </section>
          <section className="page-chrome-section">
            <div className="page-chrome-section-title"><span>Search</span></div>
            <input
              className="picker-search"
              type="text"
              placeholder={defaultSearch || 'Search projects...'}
              value={search}
              onChange={e => setSearch(e.target.value)}
              autoFocus
            />
          </section>
          <section className="page-chrome-section">
            <div className="page-chrome-section-title"><span>Projects</span></div>
            <div className="page-chrome-projects">
              {visibleProjectNames.slice(0, 12).map(project => (
                <button
                  key={project}
                  type="button"
                  className={project === chromeProject ? 'active' : ''}
                  onClick={() => setActiveChromeProject(project)}
                >
                  {manifest[project]?.name || restoredProjects[project]?.name || project}
                </button>
              ))}
            </div>
            <div className="page-chrome-project-agents">
              <div className="page-chrome-section-title">
                <span>{projectAgentRows.length > 0 ? 'Agents' : 'Recent contributions'}</span>
              </div>
              <div className="page-chrome-agents">
                {chromeAgentRows.length === 0 && <div className="page-chrome-empty">No agents</div>}
                {chromeAgentRows.map(row => (
                  <button
                    key={row.id || row.exactName}
                    type="button"
                    className={selectedAgent?.id === row.id ? 'active' : ''}
                    onClick={() => setSelectedAgentId(row.id || row.exactName)}
                    title={row.hoverTitle}
                  >
                    <span className="page-chrome-agent-name" style={{ color: row.color }}>{row.displayName}</span>
                    <span className="page-chrome-agent-meta">{row.project || row.cwdLabel || row.ago}</span>
                  </button>
                ))}
              </div>
            </div>
          </section>
          <section className="page-chrome-section page-chrome-identity">
            <div className="page-chrome-section-title"><span>Identity</span></div>
            <form onSubmit={saveIdentityName}>
              <input
                type="text"
                value={identityDraft}
                onChange={e => setIdentityDraft(e.target.value)}
                placeholder="Your name"
                aria-label="Your name"
              />
              <button type="submit" disabled={identitySaving}>Save</button>
            </form>
            {(identityMessage || identity.name) && (
              <div className="page-chrome-identity-status">{identityMessage || `Signed in as ${identity.name}`}</div>
            )}
          </section>
        </aside>
      </div>
      {(identity.name || telemetryUrl) && (
        <div className="project-index-tools">
          {identity.name && <span>Signed in as {identity.name}</span>}
          {telemetryUrl && <a href={telemetryUrl} target="_blank" rel="noreferrer">Open telemetry dashboard ↗</a>}
        </div>
      )}
      {archivedFiltered.length > 0 && (
        <>
          <div className="picker-archived-header">Archived</div>
          <div className="project-index project-index-archived">
            <div className="project-index-rows">
              {archivedFiltered.map(p => {
                const preview = dragPreview?.key === p.name ? dragPreview : null
                const isStarred = starredKeys.has(p.name) || !!p.starred
                return (
                  <div
                    key={p.name}
                    className={`project-index-row project-index-row-archived${isStarred ? ' project-index-row-starred' : ''}${preview ? ` is-swiping is-swiping-${preview.action}` : ''}`}
                    style={preview ? { transform: `translateX(${preview.dx}px)` } : undefined}
                    onPointerDown={(e) => onRowPointerDown(p.name, true, e)}
                    onPointerMove={(e) => onRowPointerMove(p.name, e)}
                    onPointerUp={(e) => onRowPointerEnd(p.name, e)}
                    onPointerCancel={() => { pointerStart.current = null; setDragPreview(null) }}
                  >
                    <div className="project-index-name">
                      <span className="picker-archived-name">{p.title || p.name}</span>
                      <span className="picker-date">Archived</span>
                    </div>
                    <div className="project-index-history" />
                    <div className="project-row-actions" onPointerDown={e => e.stopPropagation()}>
                      <button
                        className={`project-row-action project-row-star${isStarred ? ' is-active' : ''}`}
                        title="Star and unarchive"
                        aria-label="Star and unarchive project"
                        onClick={(e) => starProject(p.name, true, e)}
                      >★</button>
                      <button
                        className="project-row-action project-row-archive"
                        title="Unarchive"
                        aria-label="Unarchive project"
                        onClick={(e) => restoreProject(p.name, e)}
                      >↩</button>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

export default App
