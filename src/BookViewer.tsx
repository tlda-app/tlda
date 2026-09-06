/**
 * BookViewer — renders a collection of existing docs as a tabbed book.
 *
 * Each member doc keeps its own sync room and annotations.
 * The viewer mounts one SvgDocumentEditor at a time; switching tabs
 * unmounts the current editor and mounts the new one.
 */
import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { Tldraw } from 'tldraw'
import { SvgDocumentEditor } from './SvgDocument'
import { STORE_HTTP } from './activeConfig'
import { createHtmlDocumentFromPageInfo, createSvgDocumentLayout, loadHtmlDocument, loadSlidesDocument } from './svgDocumentLoader'
import { clearDocumentStores } from './stores'
import { BookContext, type BookMember, type BookContextValue } from './BookContext'
import { LayersContext } from './classroom/layersContext'
import { useDocumentLayers } from './classroom/useDocumentLayers'
import { findBookMemberIndex } from './bookMemberNavigation'
import { ClassroomIdentityBadge } from './classroom/ClassroomIdentityBadge'
import { isClassroomSurface } from './classroom/classroomSurface'
import type { SvgDocument } from './loaders/types'
import { HTML_PAGE_FORMATS, viewFormat } from '../shared/document-formats.mjs'
import type { Editor } from 'tldraw'
import { cacheProjectsForOffline } from './airplaneMode'
import type { AirplaneState } from './BookContext'

interface BookViewerProps {
  bookName: string
  members: BookMember[]
  onEditorMount?: (editor: Editor | null) => void
}

export function BookViewer({ bookName, members, onEditorMount }: BookViewerProps) {
  const [activeIndex, setActiveIndex] = useState(0)
  const [activeVariant, setActiveVariant] = useState<'slides' | null>(null)
  const [document, setDocument] = useState<SvgDocument | null>(null)
  const [loading, setLoading] = useState(true)
  const [bookEditor, setBookEditor] = useState<Editor | null>(null)
  // Why a member failed to load. Without it a refused member renders as a book
  // with nothing in it, which is indistinguishable from a member that is empty.
  const [loadError, setLoadError] = useState('')
  const [airplaneState, setAirplaneState] = useState<AirplaneState>('off')
  const [airplaneProgress, setAirplaneProgress] = useState({ complete: 0, total: 0 })
  const [airplaneError, setAirplaneError] = useState('')
  // Pending cross-member anchor navigation: set before switchTo, consumed after load
  const pendingAnchor = useRef<string | null>(null)

  const loadMember = useCallback(async (member: BookMember, variant: 'slides' | null) => {
    setLoading(true)
    setLoadError('')
    clearDocumentStores()

    try {
      let doc: SvgDocument
      // Skip, 2026-08-27: "yes i want lecture decs to be like, added as like
      // accessories to the book", and "think of like classrooom as an overlay?
      // ... can apply to books, talks, etc."
      //
      // So a deck reaches the reader as a member, and the member is viewed by
      // the same question App.tsx asks of a standalone document. Before this,
      // a deck member fell past the HTML branch into createSvgDocumentLayout,
      // which wants LaTeX targets a deck has never had and throws without them
      // — and a document from that path carries no `format`, so nothing
      // downstream could tell it was a deck.
      //
      // Ordered before the HTML test on purpose: `qmd` is in HTML_PAGE_FORMATS,
      // and a qmd that rendered to a deck is exactly the case that has to reach
      // the slides loader rather than the scrolling one.
      const shownAs = variant || viewFormat(member)
      if (shownAs === 'slides') {
        doc = await loadSlidesDocument(member.key, member.basePath)
      } else if (HTML_PAGE_FORMATS.has(member.format || '')) {
        const compareDoc = new URLSearchParams(window.location.search).get('compareDoc')
        if (compareDoc) {
          const compareBasePath = `/docs/${encodeURIComponent(compareDoc)}/`
          const [studentPages, solutionPages] = await Promise.all([
            fetch(`${member.basePath}page-info.json`).then(response => {
              if (!response.ok) throw new Error(`${member.key} is not readable (${response.status})`)
              return response.json()
            }),
            fetch(`${compareBasePath}page-info.json`).then(response => {
              if (!response.ok) throw new Error(`Comparison document ${compareDoc} is not ready`)
              return response.json()
            }),
          ])
          if (!studentPages[0] || !solutionPages[0]) throw new Error('Marked exercise documents need a rendered HTML page')
          const pair = [
            { ...studentPages[0], group: 'marked-exercise', url: member.basePath + studentPages[0].file },
            { ...solutionPages[0], group: 'marked-exercise', url: compareBasePath + solutionPages[0].file },
          ]
          doc = createHtmlDocumentFromPageInfo(member.key, member.basePath, pair)
        } else {
          doc = await loadHtmlDocument(member.key, member.basePath)
        }
      } else {
        // SVG: create layout immediately, pages fetched async after editor mounts.
        //
        // The member's targets are fetched rather than invented. A page's
        // filename is keyed on the TEX BASE, which a book member record does not
        // carry — it has key, pages, basePath and format. This used to pass no
        // targets at all and the layout filled the gap by naming the target after
        // the project, which produces a URL that 404s for every project whose
        // name is not its document's base name.
        const info = await fetch(`${STORE_HTTP}/api/projects/${encodeURIComponent(member.key)}`)
          .then(r => (r.ok ? r.json() : null))
          .catch(() => null)
        const targets = info?.targets?.map((t: { texBase: string; pages: number }) => ({
          name: t.texBase,
          title: t.texBase.replace(/_/g, ' '),
          pages: t.pages,
          basePath: member.basePath,
        }))
        doc = createSvgDocumentLayout(member.key, member.basePath, targets)
        // Same stamping as the standalone path in App.tsx, and it has to be
        // here too or the two disagree: a PDF opened on its own would know it
        // has no synctex while the same PDF as a book member would not, and
        // every annotation on it would take the LaTeX anchoring path. A gap
        // like that is invisible until someone puts a PDF in a book.
        doc.format = shownAs === 'pdf' ? 'pdf' : 'svg'
      }
      setDocument(doc)
    } catch (e) {
      console.error(`Failed to load member "${member.key}":`, e)
      setDocument(null)
      setLoadError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const member = members[activeIndex]
    if (member) loadMember(member, activeVariant)
  }, [activeIndex, activeVariant, members, loadMember])

  const switchTo = useCallback((index: number, variant?: 'slides') => {
    if (index < 0 || index >= members.length) return
    setActiveVariant(variant || null)
    if (index !== activeIndex) setActiveIndex(index)
  }, [members.length, activeIndex])

  const toggleAirplaneMode = useCallback(() => {
    if (airplaneState === 'loading') return
    if (airplaneState === 'ready') {
      setAirplaneState('off')
      return
    }
    setAirplaneState('loading')
    setAirplaneError('')
    void cacheProjectsForOffline(members.map(member => ({
      projectName: member.key,
      basePath: member.basePath,
      format: member.renderedFormat || member.format,
      pages: member.pages,
    })), setAirplaneProgress)
      .then(() => setAirplaneState('ready'))
      .catch(error => {
        setAirplaneError(error instanceof Error ? error.message : String(error))
        setAirplaneState('error')
      })
  }, [airplaneState, members])

  // Cross-member navigation: intercept tlda-navigate when targetFile is a different member
  useEffect(() => {
    function handleMessage(e: MessageEvent) {
      if (e.data?.type !== 'tlda-navigate') return
      if (e.data.__bookRouted) return  // already dispatched by BookViewer
      const targetFile = e.data.targetFile as string | null
      if (!targetFile) return
      const targetIdx = findBookMemberIndex(members, targetFile, e.data.targetPath)
      if (targetIdx === -1) return
      const variant = e.data.variant === 'slides' ? 'slides' : undefined
      if (targetIdx === activeIndex) {
        if ((activeVariant || undefined) !== variant) {
          pendingAnchor.current = e.data.anchor || null
          switchTo(targetIdx, variant)
          return
        }
        // Same member: forward anchor navigation to HtmlPageShape
        if (e.data.anchor) {
          const activeMember = members[activeIndex]
          window.postMessage({ type: 'tlda-navigate', anchor: e.data.anchor, shapeId: null, targetFile: activeMember?.key || null, __bookRouted: true }, '*')
        }
        return
      }
      // Store anchor to navigate after member loads
      pendingAnchor.current = e.data.anchor || null
      switchTo(targetIdx, variant)
    }
    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [members, activeIndex, activeVariant, switchTo])

  // Handle fleet-open-doc events: add member to book and switch to it
  useEffect(() => {
    function handleOpenDoc(e: Event) {
      const { docName, book } = (e as CustomEvent).detail
      if (book && book !== bookName) return // wrong book — let it open in new tab
      e.preventDefault() // signal we handled it
      const idx = members.findIndex(m => m.key === docName || m.name === docName)
      if (idx !== -1) {
        switchTo(idx)
      } else {
        // New member — add via API, then reload members (App.tsx watches manifest)
        fetch(`/api/projects/${encodeURIComponent(bookName)}/members`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ add: docName }),
        }).then(() => {
          // Trigger manifest reload by updating URL hash
          window.location.hash = docName
        }).catch(console.error)
      }
    }
    window.addEventListener('fleet-open-doc', handleOpenDoc)
    return () => window.removeEventListener('fleet-open-doc', handleOpenDoc)
  }, [bookName, members, switchTo])

  // After a cross-member switch completes, navigate to pending anchor
  useEffect(() => {
    if (loading || !pendingAnchor.current) return
    const anchor = pendingAnchor.current
    pendingAnchor.current = null
    // Include targetFile so HtmlPageShape can find the shape by URL
    const activeMember = members[activeIndex]
    window.postMessage({ type: 'tlda-navigate', anchor, shapeId: null, targetFile: activeMember?.key || null, __bookRouted: true }, '*')
  }, [loading, members, activeIndex])



  const activeMember = members[activeIndex]
  const roomId = activeMember ? `doc-${activeMember.key}` : ''

  // The reader's layers over the member being shown. Lifted out whole so the
  // document surface can have them too — see `useDocumentLayers`. Keyed on the
  // active member, so switching chapters closes one document's overlay rooms and
  // opens the next one's rather than carrying them across.
  const { layersValue, annotationsHidden, overlays, identity } = useDocumentLayers({
    roomId,
    documentEditor: bookEditor,
    resetKey: activeMember?.key ?? '',
  })








  // The layer state and the two selections over it, handed to the surface that
  // draws the ordinary controls. Nothing here is conditional on who is reading:
  // one layer means the control has nothing to offer and does not appear, which
  // is the same rule for every reader.

  const ctx = useMemo<BookContextValue>(() => ({
    bookName,
    members,
    activeIndex,
    switchTo,
    airplaneState,
    airplaneProgress,
    airplaneError,
    toggleAirplaneMode,
  }), [bookName, members, activeIndex, switchTo, airplaneState, airplaneProgress, airplaneError, toggleAirplaneMode])

  // The book's editor, kept so the overlay above it can follow its camera and
  // its tool selection. Passed on to the original caller unchanged.
  const handleEditorMount = useCallback((editor: Editor | null) => {
    setBookEditor(editor)
    onEditorMount?.(editor)
  }, [onEditorMount])

  // Empty book (no resolvable members): show blank canvas
  if (members.length === 0) {
    return (
      <div className="book-viewer" style={{ position: 'fixed', inset: 0 }}>
        <Tldraw />
      </div>
    )
  }

  return (
    <BookContext.Provider value={ctx}>
      <LayersContext.Provider value={layersValue}>
      <div className="book-viewer">
        {/* Who is reading, said once, where the course cannot be confused with
            it. `identity` is already the answer from the enrolment token; the
            badge only renders it. Off the classroom this is an ordinary book
            and nobody is logged in to a course. */}
        {isClassroomSurface() && <ClassroomIdentityBadge identity={identity} />}
        {loading && <div className="book-loading">Loading {activeMember?.name}...</div>}
        {!loading && loadError && (
          <div className="book-load-error" role="alert">
            Could not open {activeMember?.name}: {loadError}
          </div>
        )}
        {!loading && document && (
          <SvgDocumentEditor
            key={`${activeMember.key}:${activeVariant || 'chapter'}`}
            document={document}
            roomId={roomId}
            annotationsHidden={annotationsHidden}
            onEditorMount={handleEditorMount}
          />
        )}
        {!loading && document && overlays}
      </div>
      </LayersContext.Provider>
    </BookContext.Provider>
  )
}
