import { useState, useEffect, Component, type ReactNode } from 'react'
import { SvgDocumentEditor } from './SvgDocument'
import { loadSvgDocument, loadImageDocument, loadHtmlDocument, loadDiffDocument } from './svgDocumentLoader'
import { clearDocumentStores } from './SvgPageShape'
import './App.css'

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
  format?: 'svg' | 'png' | 'html' | 'diff'
  sourceDoc?: string
}

type SvgDoc = Awaited<ReturnType<typeof loadSvgDocument>>

interface DiffConfig {
  basePath: string
}

type State =
  | { phase: 'loading'; message: string; roomId: string }
  | { phase: 'error'; message: string }
  | { phase: 'picker'; manifest: Record<string, DocConfig> }
  | { phase: 'svg'; document: SvgDoc; roomId: string; diffConfig?: DiffConfig }

// Fetch document manifest at runtime — derives basePath from key
async function fetchManifest(): Promise<Record<string, DocConfig>> {
  try {
    const base = import.meta.env.BASE_URL || '/'
    const resp = await fetch(`${base}docs/manifest.json`)
    if (!resp.ok) return {}
    const data = await resp.json()
    const docs = data.documents || {}
    // Derive basePath from key — never trust a stored value
    for (const [key, config] of Object.entries(docs) as [string, DocConfig][]) {
      config.basePath = `/docs/${key}/`
    }
    return docs
  } catch {
    return {}
  }
}

// Generation counter + abort controller for document loading — prevents stale async completions
let loadGeneration = 0
let loadAbort: AbortController | null = null

function App() {
  const [state, setState] = useState<State | null>(null)

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
      fetchManifest().then(manifest => {
        const docs = Object.keys(manifest)
        if (docs.length === 1) {
          const name = docs[0]
          const newUrl = new URL(window.location.href)
          newUrl.searchParams.set('doc', name)
          window.history.replaceState({}, '', newUrl.toString())
          const roomId = `doc-${name}`
          setState({ phase: 'loading', message: `Loading ${name}...`, roomId })
          loadDocument(name, roomId)
        } else if (docs.length > 1) {
          setState({ phase: 'picker', manifest })
        } else {
          setState({ phase: 'error', message: 'No documents found. Use `ctd create` to add a project.' })
        }
      })
    }
  }, [])

  async function loadDocument(docName: string, roomId: string) {
    // Bump generation and abort any in-flight load
    const gen = ++loadGeneration
    loadAbort?.abort()
    const abort = loadAbort = new AbortController()
    const { signal } = abort

    const manifest = await fetchManifest()
    if (gen !== loadGeneration) return  // superseded

    const config = manifest[docName]

    if (!config) {
      console.error(`Document "${docName}" not found in manifest`)
      setState({ phase: 'error', message: `Document "${docName}" not found.` })
      return
    }

    setState(s => s ? { ...s, message: `Loading ${config.name}...` } : s)

    // Clear stale stores from any previous document before loading new one
    clearDocumentStores()

    try {
      const base = import.meta.env.BASE_URL || '/'
      const basePath = config.basePath.startsWith('/') ? config.basePath.slice(1) : config.basePath
      const fullBasePath = `${base}${basePath}`

      let document
      if (config.format === 'diff') {
        document = await loadDiffDocument(docName, fullBasePath)
      } else if (config.format === 'html') {
        document = await loadHtmlDocument(config.name, fullBasePath)
      } else {
        const ext = config.format === 'png' ? 'png' : 'svg'
        // Probe beyond manifest hint to discover extra pages (handles stale page counts)
        let pageCount = config.pages
        const makeUrl = (n: number) => `${fullBasePath}page-${n}.${ext}`
        const expectedType = ext === 'svg' ? 'image/svg+xml' : 'image/png'
        while (true) {
          if (signal.aborted) return  // navigated away during probe
          const resp = await fetch(makeUrl(pageCount + 1), { method: 'HEAD', signal })
          if (!resp.ok || !resp.headers.get('content-type')?.includes(expectedType)) break
          pageCount++
        }
        const urls = Array.from({ length: pageCount }, (_, i) => makeUrl(i + 1))
        document = config.format === 'png'
          ? await loadImageDocument(config.name, urls, fullBasePath)
          : await loadSvgDocument(config.name, urls)
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
          <div className="LoadingScreen">
            <h2>Choose a document</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '16px' }}>
              {Object.entries(state.manifest).map(([key, config]) => (
                <button
                  key={key}
                  onClick={() => {
                    const newUrl = new URL(window.location.href)
                    newUrl.searchParams.set('doc', key)
                    window.history.replaceState({}, '', newUrl.toString())
                    const roomId = `doc-${key}`
                    setState({ phase: 'loading', message: `Loading ${config.name}...`, roomId })
                    loadDocument(key, roomId)
                  }}
                  style={{ padding: '12px 24px', fontSize: '16px', cursor: 'pointer' }}
                >
                  {config.name || key}
                </button>
              ))}
            </div>
          </div>
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

export default App
