import { useState, useEffect, Component, type ReactNode } from 'react'
import { loadPdf } from './PdfPicker'
import type { Pdf } from './PdfPicker'
import { PdfEditor } from './PdfEditor'
import { SvgDocumentEditor, loadSvgDocument } from './SvgDocument'
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
}

type SvgDoc = Awaited<ReturnType<typeof loadSvgDocument>>

type State =
  | { phase: 'canvas'; roomId: string }
  | { phase: 'loading'; message: string; roomId: string }
  | { phase: 'pdf'; pdf: Pdf; roomId: string }
  | { phase: 'svg'; document: SvgDoc; roomId: string }

function generateRoomId(): string {
  return `room-${Math.random().toString(36).slice(2, 10)}`
}

// Fetch document manifest at runtime
async function fetchManifest(): Promise<Record<string, DocConfig>> {
  try {
    const resp = await fetch('/docs/manifest.json')
    if (!resp.ok) return {}
    const data = await resp.json()
    return data.documents || {}
  } catch {
    return {}
  }
}

function App() {
  console.log('[App] Render start')
  const [state, setState] = useState<State | null>(null)
  console.log('[App] State:', state?.phase || 'null')

  useEffect(() => {
    return () => console.log('[App] UNMOUNTING!')
  }, [])

  useEffect(() => {
    console.log('[App] useEffect running')
    const params = new URLSearchParams(window.location.search)
    const pdfUrl = params.get('pdf')
    const docName = params.get('doc')
    const roomId = params.get('room') || generateRoomId()

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
      setState({ phase: 'canvas', roomId })
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
      const urls = Array.from({ length: config.pages }, (_, i) => {
        const pageNum = String(i + 1).padStart(2, '0')
        return `${config.basePath}page-${pageNum}.svg`
      })

      const document = await loadSvgDocument(config.name, urls)
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
    console.log('[App] Rendering: initial loading')
    return <div className="App loading">Loading...</div>
  }

  console.log('[App] Rendering phase:', state.phase)

  switch (state.phase) {
    case 'canvas':
      console.log('[App] Rendering Canvas')
      return (
        <div className="App">
          <Canvas roomId={state.roomId} onLoadPdf={handleLoadPdf} />
        </div>
      )
    case 'loading':
      console.log('[App] Rendering loading screen')
      return (
        <div className="App">
          <div className="LoadingScreen">
            <p>{state.message}</p>
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
