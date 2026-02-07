import { useState, useEffect, Component, type ReactNode } from 'react'
import { loadPdf } from './PdfPicker'
import type { Pdf } from './PdfPicker'
import { PdfEditor } from './PdfEditor'
import { SvgDocumentEditor } from './SvgDocument'
import { loadSvgDocument, loadImageDocument, loadHtmlDocument } from './svgDocumentLoader'
import { Canvas } from './Canvas'
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
  format?: 'svg' | 'png' | 'html'
}

type SvgDoc = Awaited<ReturnType<typeof loadSvgDocument>>

type State =
  | { phase: 'canvas'; roomId: string }
  | { phase: 'loading'; message: string; roomId: string }
  | { phase: 'picker'; manifest: Record<string, DocConfig>; roomId: string }
  | { phase: 'pdf'; pdf: Pdf; roomId: string }
  | { phase: 'svg'; document: SvgDoc; roomId: string }

function generateRoomId(): string {
  return `room-${Math.random().toString(36).slice(2, 10)}`
}

// Fetch document manifest at runtime
async function fetchManifest(): Promise<Record<string, DocConfig>> {
  try {
    const base = import.meta.env.BASE_URL || '/'
    const resp = await fetch(`${base}docs/manifest.json`)
    if (!resp.ok) return {}
    const data = await resp.json()
    return data.documents || {}
  } catch {
    return {}
  }
}

function App() {
  const [state, setState] = useState<State | null>(null)

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const pdfUrl = params.get('pdf')
    const docName = params.get('doc')
    // Use doc name as room ID for persistence, or explicit room param, or random
    const roomId = params.get('room') || (docName ? `doc-${docName}` : generateRoomId())

    if (!params.get('room')) {
      const newUrl = new URL(window.location.href)
      newUrl.searchParams.set('room', roomId)
      window.history.replaceState({}, '', newUrl.toString())
    }

    if (docName) {
      setState({ phase: 'loading', message: 'Loading document...', roomId })
      loadDocument(docName, roomId)
    } else if (pdfUrl) {
      setState({ phase: 'loading', message: 'Loading PDF...', roomId })
      loadPdfFromUrl(pdfUrl, roomId)
    } else {
      // No doc specified — show document picker
      setState({ phase: 'loading', message: 'Loading...', roomId })
      fetchManifest().then(manifest => {
        const docs = Object.keys(manifest)
        if (docs.length === 1) {
          // Only one doc — just load it
          const name = docs[0]
          const newUrl = new URL(window.location.href)
          newUrl.searchParams.set('doc', name)
          newUrl.searchParams.set('room', `doc-${name}`)
          window.history.replaceState({}, '', newUrl.toString())
          loadDocument(name, `doc-${name}`)
        } else if (docs.length > 1) {
          setState({ phase: 'picker', manifest, roomId })
        } else {
          setState({ phase: 'canvas', roomId })
        }
      })
    }
  }, [])

  async function loadDocument(docName: string, roomId: string) {
    const manifest = await fetchManifest()
    const config = manifest[docName]

    if (!config) {
      console.error(`Document "${docName}" not found in manifest`)
      setState({ phase: 'canvas', roomId })
      return
    }

    setState(s => s ? { ...s, message: `Loading ${config.name}...` } : s)

    try {
      const base = import.meta.env.BASE_URL || '/'
      const basePath = config.basePath.startsWith('/') ? config.basePath.slice(1) : config.basePath
      const fullBasePath = `${base}${basePath}`

      let document
      if (config.format === 'html') {
        document = await loadHtmlDocument(config.name, fullBasePath)
      } else {
        const ext = config.format === 'png' ? 'png' : 'svg'
        const urls = Array.from({ length: config.pages }, (_, i) => {
          const pageNum = String(i + 1).padStart(2, '0')
          return `${fullBasePath}page-${pageNum}.${ext}`
        })
        document = config.format === 'png'
          ? await loadImageDocument(config.name, urls, fullBasePath)
          : await loadSvgDocument(config.name, urls)
      }
      setState({ phase: 'svg', document, roomId })
    } catch (e) {
      console.error('Failed to load document:', e)
      setState({ phase: 'canvas', roomId })
    }
  }

  async function loadPdfFromUrl(url: string, roomId: string) {
    try {
      const response = await fetch(url)
      if (!response.ok) throw new Error(`Failed to fetch: ${response.status}`)
      const buffer = await response.arrayBuffer()
      const name = url.split('/').pop() || 'document.pdf'
      const pdf = await loadPdf(name, buffer)
      setState({ phase: 'pdf', pdf, roomId })
    } catch (e) {
      console.error('Failed to load PDF:', e)
      setState({ phase: 'canvas', roomId })
    }
  }

  function handleLoadPdf() {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'application/pdf'
    input.addEventListener('change', async (e) => {
      const fileList = (e.target as HTMLInputElement).files
      if (!fileList || fileList.length === 0) return
      const file = fileList[0]

      const roomId = state?.roomId || generateRoomId()
      try {
        const pdf = await loadPdf(file.name, await file.arrayBuffer())

        const newUrl = new URL(window.location.href)
        newUrl.searchParams.set('room', roomId)
        window.history.replaceState({}, '', newUrl.toString())

        setState({ phase: 'pdf', pdf, roomId })
      } catch (e) {
        console.error('Failed to load PDF:', e)
      }
    })
    input.click()
  }

  if (!state) {
    return <div className="App loading">Loading...</div>
  }

  switch (state.phase) {
    case 'canvas':
      return (
        <div className="App">
          <Canvas roomId={state.roomId} onLoadPdf={handleLoadPdf} />
        </div>
      )
    case 'loading':
      return (
        <div className="App">
          <div className="LoadingScreen">
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
                    newUrl.searchParams.set('room', `doc-${key}`)
                    window.history.replaceState({}, '', newUrl.toString())
                    setState({ phase: 'loading', message: `Loading ${config.name}...`, roomId: `doc-${key}` })
                    loadDocument(key, `doc-${key}`)
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
    case 'pdf':
      return (
        <div className="App">
          <PdfEditor pdf={state.pdf} roomId={state.roomId} />
        </div>
      )
    case 'svg':
      return (
        <div className="App">
          <ErrorBoundary>
            <SvgDocumentEditor document={state.document} roomId={state.roomId} />
          </ErrorBoundary>
        </div>
      )
  }
}

export default App
