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
import { createHtmlDocumentFromPageInfo, createSvgDocumentLayout, loadHtmlDocument } from './svgDocumentLoader'
import { clearDocumentStores } from './stores'
import { BookContext, type BookMember, type BookContextValue } from './BookContext'
import { StudentAnnotationOverlay } from './classroom/StudentAnnotationOverlay'
import { TeacherStudentOverlay } from './classroom/TeacherStudentOverlay'
import { BookLayersControl } from './classroom/BookLayersControl'
import { studentLayers, setLayerVisible, setWriteTarget, type BookLayerState } from './classroom/bookLayers'
import { classroomApi, type ClassroomIdentity } from './classroom/api'
import type { SvgDocument } from './loaders/types'
import { HTML_PAGE_FORMATS } from '../shared/document-formats.mjs'
import type { Editor } from 'tldraw'

interface BookViewerProps {
  bookName: string
  members: BookMember[]
  onEditorMount?: (editor: Editor | null) => void
}

export function BookViewer({ bookName, members, onEditorMount }: BookViewerProps) {
  const [activeIndex, setActiveIndex] = useState(0)
  const [document, setDocument] = useState<SvgDocument | null>(null)
  const [loading, setLoading] = useState(true)
  const [bookEditor, setBookEditor] = useState<Editor | null>(null)
  const [identity, setIdentity] = useState<ClassroomIdentity | null>(null)
  // Which layers are shown, and which one takes the reader's marks. Default
  // target is the book's own layer, so a reader who never touches the control
  // writes where they already would.
  const [layers, setLayers] = useState<BookLayerState>(studentLayers)
  // Pending cross-member anchor navigation: set before switchTo, consumed after load
  const pendingAnchor = useRef<string | null>(null)

  const loadMember = useCallback(async (member: BookMember) => {
    setLoading(true)
    clearDocumentStores()

    try {
      let doc: SvgDocument
      if (HTML_PAGE_FORMATS.has(member.format || '')) {
        const compareDoc = new URLSearchParams(window.location.search).get('compareDoc')
        if (compareDoc) {
          const compareBasePath = `/docs/${encodeURIComponent(compareDoc)}/`
          const [studentPages, solutionPages] = await Promise.all([
            fetch(`${member.basePath}page-info.json`).then(response => response.json()),
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
      }
      setDocument(doc)
    } catch (e) {
      console.error(`Failed to load member "${member.key}":`, e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const member = members[activeIndex]
    if (member) loadMember(member)
  }, [activeIndex, members, loadMember])

  const switchTo = useCallback((index: number) => {
    if (index >= 0 && index < members.length && index !== activeIndex) {
      setActiveIndex(index)
    }
  }, [members.length, activeIndex])

  // Cross-member navigation: intercept tlda-navigate when targetFile is a different member
  useEffect(() => {
    function handleMessage(e: MessageEvent) {
      if (e.data?.type !== 'tlda-navigate') return
      if (e.data.__bookRouted) return  // already dispatched by BookViewer
      const targetFile = e.data.targetFile as string | null
      if (!targetFile) return
      const targetIdx = members.findIndex(m => m.key === targetFile || m.name === targetFile)
      if (targetIdx === -1) return
      if (targetIdx === activeIndex) {
        // Same member: forward anchor navigation to HtmlPageShape
        if (e.data.anchor) {
          const activeMember = members[activeIndex]
          window.postMessage({ type: 'tlda-navigate', anchor: e.data.anchor, shapeId: null, targetFile: activeMember?.key || null, __bookRouted: true }, '*')
        }
        return
      }
      // Store anchor to navigate after member loads
      pendingAnchor.current = e.data.anchor || null
      switchTo(targetIdx)
    }
    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [members, activeIndex, switchTo])

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

  // Who is reading, if anyone enrolled is. Asked once, and only when the reader
  // arrived with an enrolment token — a book opened without one is an ordinary
  // book and must not start asking a classroom API about its reader.
  useEffect(() => {
    if (!new URLSearchParams(window.location.search).get('classroomToken')) return
    let cancelled = false
    classroomApi.me()
      .then(next => { if (!cancelled) setIdentity(next) })
      // Not enrolled, or the token no longer resolves. The book stays a book.
      .catch(() => { if (!cancelled) setIdentity(null) })
    return () => { cancelled = true }
  }, [])

  const ctx = useMemo<BookContextValue>(() => ({
    bookName,
    members,
    activeIndex,
    switchTo,
  }), [bookName, members, activeIndex, switchTo])

  const activeMember = members[activeIndex]
  const roomId = activeMember ? `doc-${activeMember.key}` : ''
  // Which course's roster a teacher flicks through. Read once: changing student
  // rewrites the URL, and re-reading it here would fight that.
  //
  // No default, deliberately, and this differs from the other two readers of
  // `?course=` — classroom registration and the gradebook both fall back to a
  // single named course. That is harmless while there is one course and becomes
  // a wrong roster with no error the moment there are two, which on this path
  // means showing a teacher the wrong students' work. Absent means absent here:
  // no course named, no roster, no overlay.
  const courseId = useMemo(() => new URLSearchParams(window.location.search).get('course') || '', [])

  const mineLayer = layers.layers.find(l => l.id === 'mine')
  const commonVisible = layers.layers.find(l => l.id === 'common')?.visible ?? true

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
      <div className="book-viewer">
        {loading && <div className="book-loading">Loading {activeMember?.name}...</div>}
        {!loading && document && (
          <SvgDocumentEditor
            key={activeMember.key}
            document={document}
            roomId={roomId}
            annotationsHidden={!commonVisible}
            onEditorMount={handleEditorMount}
          />
        )}
        {/* A student reading the book has two layers: the book's, which the
            whole class shares and everyone may write, and their own. Which one
            takes their marks is a selection they make — never inferred from the
            tool they picked. A reader without an enrolment token has one layer,
            so no overlay and no control, and the book is unchanged for them. */}
        {!loading && document && identity?.role === 'student' && (
          <>
            <StudentAnnotationOverlay
              key={`${activeMember.key}:${identity.studentId}`}
              bookRoomId={roomId}
              studentId={identity.studentId}
              bookEditor={bookEditor}
              visible={mineLayer?.visible ?? false}
              isWriteTarget={layers.target === 'mine'}
            />
            <BookLayersControl
              state={layers}
              onVisibilityChange={(id, visible) => setLayers(current => setLayerVisible(current, id, visible))}
              onTargetChange={id => setLayers(current => setWriteTarget(current, id))}
            />
          </>
        )}
        {/* The teacher reads one student's layer at a time, flicking between
            them. Only when a course is named — the book itself belongs to no
            course, so without one there is no roster to flick through. */}
        {!loading && document && identity?.role === 'instructor' && courseId && (
          <TeacherStudentOverlay
            key={`${activeMember.key}:${courseId}`}
            bookRoomId={roomId}
            courseId={courseId}
            bookEditor={bookEditor}
          />
        )}
      </div>
    </BookContext.Provider>
  )
}
