import { useState, useEffect, Component, type ReactNode } from 'react'
import { SvgDocumentEditor } from './SvgDocument'
import { createSvgDocumentLayout, loadSvgDocument, loadImageDocument, loadHtmlDocument, loadDiffDocument, loadSlidesDocument } from './svgDocumentLoader'
import { clearDocumentStores } from './stores'
import { initToken, fetchAuthLevel } from './authToken'
import { BookViewer } from './BookViewer'
import type { BookMember } from './BookContext'
import './App.css'

// Initialize auth token from URL query param — patches fetch() to inject Authorization header
initToken()
// Fetch auth level (presenter privilege) — fire and forget, UI updates reactively
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
}

type SvgDoc = Awaited<ReturnType<typeof loadSvgDocument>>

interface DiffConfig {
  basePath: string
  buildStatus?: string
}

type State =
  | { phase: 'loading'; message: string; roomId: string }
  | { phase: 'error'; message: string }
  | { phase: 'picker'; manifest: Record<string, DocConfig> }
  | { phase: 'svg'; document: SvgDoc; roomId: string; diffConfig?: DiffConfig }
  | { phase: 'book'; bookName: string; members: BookMember[] }

// When the SPA is hosted on a different origin than the sync/asset server
// (e.g. GitHub Pages SPA → Fly.io server), derive the HTTP base from VITE_SYNC_SERVER.
// This converts wss://host → https://host so doc asset fetches go to the right place.
const ASSET_BASE = (() => {
  const ws = import.meta.env.VITE_SYNC_SERVER as string | undefined
  if (!ws) return ''  // same-origin: relative URLs work
  return ws.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace(/\/+$/, '')
})()

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

function App() {
  const [state, setState] = useState<State | null>(null)

  // Handle browser back/forward — reload to cleanly reset TLDraw state
  useEffect(() => {
    const onPopState = () => window.location.reload()
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const docName = params.get('doc')

    if (docName) {
      const roomId = `doc-${docName}`
      setState({ phase: 'loading', message: 'Loading document...', roomId })
      loadDocument(docName, roomId)
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
            setState({ phase: 'error', message: (e as Error).message })
            return
          }
          const docs = Object.keys(manifest)
          if (docs.length > 0) {
            if (docs.length === 1) {
              const name = docs[0]
              const newUrl = new URL(window.location.href)
              newUrl.searchParams.set('doc', name)
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

  async function loadDocument(docName: string, roomId: string) {
    // Bump generation and abort any in-flight load
    const gen = ++loadGeneration
    loadAbort?.abort()
    const abort = loadAbort = new AbortController()
    const { signal } = abort

    let manifest: Record<string, DocConfig>
    try {
      manifest = await fetchManifest()
    } catch (e) {
      setState({ phase: 'error', message: (e as Error).message })
      return
    }
    if (gen !== loadGeneration) return  // superseded

    const config = manifest[docName]

    // Book format: resolve member docs and render BookViewer
    if (config?.format === 'book' && config.members) {
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
            ...(memberConfig.sessionAt && { sessionAt: memberConfig.sessionAt }),
          }
        })
        .filter((m): m is BookMember => m !== null)

      if (members.length === 0) {
        setState({ phase: 'error', message: `Book "${docName}" has no loadable members.` })
        return
      }

      setState({ phase: 'book', bookName: docName, members })
      return
    }

    // If project is missing, still building, or has no pages yet, poll until ready
    if (!config || config.buildStatus === 'building' || config.pages === 0) {
      const label = config?.name || docName
      setState({ phase: 'loading', message: config ? `Building ${label}...` : `Waiting for ${label}...`, roomId })
      const waitForBuild = async () => {
        while (gen === loadGeneration) {
          await new Promise(r => setTimeout(r, 2000))
          if (gen !== loadGeneration) return
          // Re-fetch manifest to check for updated page count / build status
          try {
            const m = await fetchManifest(true)
            const c = m[docName]
            if (c && c.pages > 0 && c.buildStatus !== 'building') break
          } catch (e) {
            if (e instanceof Error && e.message.includes('Authentication')) {
              setState({ phase: 'error', message: e.message })
              return
            }
            /* keep polling for other errors */
          }
        }
        if (gen === loadGeneration) loadDocument(docName, roomId)
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
        document = await loadDiffDocument(docName, fullBasePath)
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
        // SVG: create layout immediately, pages fetched async after editor mounts
        document = createSvgDocumentLayout(docName, config.pages, fullBasePath)
      }

      if (gen !== loadGeneration) return  // superseded during fetch

      // For non-diff docs, check if a matching diff doc exists
      let diffConfig: DiffConfig | undefined
      if (config.format !== 'diff') {
        const diffEntry = Object.values(manifest).find(
          c => c.format === 'diff' && c.sourceDoc === docName
        )
        if (diffEntry) {
          const diffBasePath = diffEntry.basePath.startsWith('/')
            ? diffEntry.basePath.slice(1)
            : diffEntry.basePath
          diffConfig = { basePath: `${base}${diffBasePath}` }
        }
      }

      setState({ phase: 'svg', document, roomId, diffConfig })
    } catch (e) {
      if (signal.aborted) return  // expected abort, don't show error
      console.error('Failed to load document:', e)

      // Check if a build is in progress — if so, wait and retry
      try {
        const statusResp = await fetch(`/api/projects/${docName}/build/status`)
        if (statusResp.ok) {
          const status = await statusResp.json()
          if (status.status === 'building') {
            setState({ phase: 'loading', message: `Building ${docName}...`, roomId })
            // Poll until build completes, then retry
            const pollBuild = async () => {
              while (gen === loadGeneration) {
                await new Promise(r => setTimeout(r, 2000))
                if (gen !== loadGeneration) return
                try {
                  const r = await fetch(`/api/projects/${docName}/build/status`)
                  if (!r.ok) break
                  const s = await r.json()
                  if (s.status !== 'building') break
                } catch { break }
              }
              if (gen === loadGeneration) loadDocument(docName, roomId)
            }
            pollBuild()
            return
          }
        }
      } catch { /* ignore status check failure */ }

      setState({ phase: 'error', message: `Failed to load "${docName}": ${(e as Error).message}` })
    }
  }

  if (!state) {
    return <div className="App loading">Loading...</div>
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
          <div className="LoadingScreen">
            <h2>Error</h2>
            <p>{state.message}</p>
          </div>
        </div>
      )
    case 'picker':
      return (
        <div className="App">
          <DocumentPicker manifest={state.manifest} onSelect={(key, config) => {
            const newUrl = new URL(window.location.href)
            newUrl.searchParams.set('doc', key)
            window.history.pushState({}, '', newUrl.toString())
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
          <ErrorBoundary>
            <SvgDocumentEditor document={state.document} roomId={state.roomId} diffConfig={state.diffConfig} />
          </ErrorBoundary>
        </div>
      )
  }
}

type SortKey = 'name' | 'lastBuild' | 'lastAnnotated'
type ProjectMeta = Record<string, { lastBuild?: string; lastAnnotated?: string }>

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

interface ArchivedProject { name: string; title?: string }

function DocumentPicker({ manifest, onSelect }: {
  manifest: Record<string, DocConfig>
  onSelect: (key: string, config: DocConfig) => void
}) {
  const [meta, setMeta] = useState<ProjectMeta>({})
  const [sortKey, setSortKey] = useState<SortKey>('name')
  const [sortAsc, setSortAsc] = useState(true)
  const [hiddenKeys, setHiddenKeys] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  const [archived, setArchived] = useState<ArchivedProject[]>([])
  const [restoredKeys, setRestoredKeys] = useState<Set<string>>(new Set())

  useEffect(() => {
    fetch(`${ASSET_BASE}/api/projects/meta`)
      .then(r => r.ok ? r.json() : {})
      .then(setMeta)
      .catch(() => {})
  }, [])

  // Fetch archived list when search is non-empty
  useEffect(() => {
    if (!search) { setArchived([]); return }
    fetch(`${ASSET_BASE}/api/projects/archived`)
      .then(r => r.ok ? r.json() : { projects: [] })
      .then(data => setArchived(data.projects || []))
      .catch(() => {})
  }, [search])

  const bookMembers = new Set<string>()
  for (const config of Object.values(manifest)) {
    if (config.format === 'book' && config.members) {
      for (const m of config.members) bookMembers.add(m)
    }
  }

  const q = search.toLowerCase()

  const entries = Object.entries(manifest)
    .filter(([key]) => !bookMembers.has(key) && !hiddenKeys.has(key))
    .filter(([key, config]) => !q || (config.name || key).toLowerCase().includes(q) || key.includes(q))
    .sort(([keyA, a], [keyB, b]) => {
      let cmp = 0
      if (sortKey === 'name') {
        cmp = (a.name || keyA).localeCompare(b.name || keyB)
      } else {
        const metaA = meta[keyA]?.[sortKey] || ''
        const metaB = meta[keyB]?.[sortKey] || ''
        cmp = metaA < metaB ? -1 : metaA > metaB ? 1 : 0
      }
      return sortAsc ? cmp : -cmp
    })

  const archivedFiltered = archived
    .filter(p => !restoredKeys.has(p.name))
    .filter(p => (p.title || p.name).toLowerCase().includes(q) || p.name.includes(q))

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortAsc(!sortAsc)
    else { setSortKey(key); setSortAsc(key === 'name') }
  }

  const sortIndicator = (key: SortKey) =>
    sortKey === key ? (sortAsc ? ' ↑' : ' ↓') : ''

  const archiveProject = (key: string, e: React.MouseEvent) => {
    e.stopPropagation()
    setHiddenKeys(prev => new Set(prev).add(key))
    fetch(`${ASSET_BASE}/api/projects/${key}/archive`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ archived: true }),
    }).catch(() => {
      setHiddenKeys(prev => { const next = new Set(prev); next.delete(key); return next })
    })
  }

  const restoreProject = (key: string) => {
    setRestoredKeys(prev => new Set(prev).add(key))
    fetch(`${ASSET_BASE}/api/projects/${key}/archive`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ archived: false }),
    }).catch(() => {
      setRestoredKeys(prev => { const next = new Set(prev); next.delete(key); return next })
    })
  }

  return (
    <div className="PickerScreen">
      <input
        className="picker-search"
        type="text"
        placeholder="Search documents..."
        value={search}
        onChange={e => setSearch(e.target.value)}
        autoFocus
      />
      <table className="picker-table">
        <thead>
          <tr>
            <th onClick={() => toggleSort('name')}>Document{sortIndicator('name')}</th>
            <th onClick={() => toggleSort('lastBuild')}>Last build{sortIndicator('lastBuild')}</th>
            <th onClick={() => toggleSort('lastAnnotated')}>Last annotated{sortIndicator('lastAnnotated')}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {entries.map(([key, config]) => (
            <tr key={key} onClick={() => onSelect(key, config)}>
              <td><a href={`?doc=${key}`} onClick={e => e.preventDefault()}>{config.name || key}</a></td>
              <td className="picker-date">{relativeTime(meta[key]?.lastBuild)}</td>
              <td className="picker-date">{relativeTime(meta[key]?.lastAnnotated)}</td>
              <td className="picker-archive">
                <button
                  className="archive-btn"
                  title="Archive"
                  onClick={(e) => archiveProject(key, e)}
                >&times;</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {archivedFiltered.length > 0 && (
        <>
          <div className="picker-archived-header">Archived</div>
          <table className="picker-table picker-table-archived">
            <tbody>
              {archivedFiltered.map(p => (
                <tr key={p.name}>
                  <td className="picker-archived-name">{p.title || p.name}</td>
                  <td className="picker-archive">
                    <button
                      className="restore-btn"
                      title="Restore"
                      onClick={() => restoreProject(p.name)}
                    >Restore</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  )
}

export default App
