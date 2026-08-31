/**
 * BookViewer — renders a collection of existing docs as a tabbed book.
 *
 * Each member doc keeps its own sync room and annotations.
 * The viewer mounts one SvgDocumentEditor at a time; switching tabs
 * unmounts the current editor and mounts the new one.
 */
import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { Tldraw, react } from 'tldraw'
import { SvgDocumentEditor } from './SvgDocument'
import { STORE_HTTP } from './activeConfig'
import { createHtmlDocumentFromPageInfo, createSvgDocumentLayout, loadHtmlDocument, loadSlidesDocument } from './svgDocumentLoader'
import { clearDocumentStores } from './stores'
import { BookContext, type BookMember, type BookContextValue, type BookLayersValue } from './BookContext'
import { findBookMemberIndex } from './bookMemberNavigation'
import { StudentAnnotationOverlay } from './classroom/StudentAnnotationOverlay'
import { TeacherStudentOverlay } from './classroom/TeacherStudentOverlay'
import { readerLayers, studentLayers, teacherLayers, setLayerVisible, setWriteTarget, type BookLayerState, type BookLayerId } from './classroom/bookLayers'
import { moveShapesToLayer, layerStore } from './classroom/moveBetweenLayers'
import { classroomApi, type ClassroomIdentity } from './classroom/api'
import { ClassroomIdentityBadge } from './classroom/ClassroomIdentityBadge'
import { isClassroomSurface } from './classroom/classroomSurface'
import type { SvgDocument } from './loaders/types'
import { HTML_PAGE_FORMATS, viewFormat } from '../shared/document-formats.mjs'
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
  //
  // Starts at the one layer every reader has. What else they have depends on
  // identity, and identity is asked for asynchronously, so this is the state
  // before the answer arrives rather than a guess at it.
  const [layers, setLayers] = useState<BookLayerState>(readerLayers)
  // The student an instructor is currently reading, reported up by the overlay
  // that flicks through them. It is a layer of theirs, so the layer state has
  // to know about it.
  const [readStudent, setReadStudent] = useState<{ id: string; displayName: string } | null>(null)
  const [overlayEditor, setOverlayEditor] = useState<Editor | null>(null)
  const [trackedSelectionCount, setTrackedSelectionCount] = useState(0)
  const [moveError, setMoveError] = useState('')
  // Why a member failed to load. Without it a refused member renders as a book
  // with nothing in it, which is indistinguishable from a member that is empty.
  const [loadError, setLoadError] = useState('')
  // Pending cross-member anchor navigation: set before switchTo, consumed after load
  const pendingAnchor = useRef<string | null>(null)

  const loadMember = useCallback(async (member: BookMember) => {
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
      const shownAs = viewFormat(member)
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
      const targetIdx = findBookMemberIndex(members, targetFile, e.data.targetPath)
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

  // Who is reading, asked once.
  //
  // Identity follows the CREDENTIAL, not a query parameter. This used to run
  // only when the URL carried `classroomToken`, which silently excluded the one
  // reader who never has one: an instructor authenticates with the RW bearer
  // token, so identity stayed null and the teacher view never mounted. No error,
  // no message — the feature simply was not there, which reads as never built.
  //
  // `/api/classroom/me` is the authority on this and answers from whatever
  // credential the request carries: instructor for an RW token, a student for an
  // enrolment token, and 401 for a reader with neither — which is an ordinary
  // reader, and the catch below leaves them an ordinary book.
  useEffect(() => {
    let cancelled = false
    classroomApi.me()
      .then(next => { if (!cancelled) setIdentity(next) })
      // 401 for a reader with no classroom credential, which is most readers.
      // The book stays a book: no overlay, no control, nothing changed for them.
      .catch(() => { if (!cancelled) setIdentity(null) })
    return () => { cancelled = true }
  }, [])

  // Which layers this reader has. Derived from what rooms they actually have,
  // not from their role: a student has the book's and their own; an instructor
  // reading a student has the book's and that student's; everyone else has the
  // book's alone. The control that offers the choice keys on this set, so an
  // instructor is offered exactly the choices an instructor has rather than
  // being excluded from the feature.
  //
  // The set is derived; the two selections over it are the reader's and are
  // held. So the base is computed, and the held selections are dropped at the
  // moment the base changes — during render rather than in an effect, so no
  // frame is ever drawn offering choices from the previous reader's layers.
  const baseLayers = useMemo(() => {
    if (identity?.role === 'student') return studentLayers()
    if (identity?.role === 'instructor' && readStudent) return teacherLayers(readStudent.id, readStudent.displayName)
    return readerLayers()
  }, [identity?.role, readStudent])

  const [layersBase, setLayersBase] = useState(baseLayers)
  if (layersBase !== baseLayers) {
    setLayersBase(baseLayers)
    setLayers(baseLayers)
  }

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
  const studentLayer = layers.layers.find(l => l.id === 'student')
  const commonVisible = layers.layers.find(l => l.id === 'common')?.visible ?? true

  // Which canvas holds which layer. Named rather than derived by complement:
  // "the other editor" is only the right destination while there are exactly
  // two layers, and a teacher's view already has three. This stays correct when
  // one is added; a complement silently moves the work to the wrong place.
  const editorForLayer = useCallback((id: BookLayerId) => (
    id === 'common' ? bookEditor : overlayEditor
  ), [bookEditor, overlayEditor])

  // Only the write target takes pointer input, so it is the only layer a
  // selection can be on — which is what makes "move the selection" unambiguous
  // about where it is moving FROM, with no rule needed to say so.
  const targetEditor = editorForLayer(layers.target)

  // Watch the selection on the write target, so the control can become a
  // move-to-layer menu when there is one. Writing state from inside the
  // subscription callback rather than the effect body is the point: the count
  // is external state we are following, not something to recompute on render.
  //
  // A failed move's message is cleared here too, because a changed selection is
  // exactly when it stops describing anything — it reported the annotations that
  // were attempted, not the ones now in hand.
  useEffect(() => {
    if (!targetEditor) return
    return react('selection on the write target', () => {
      setTrackedSelectionCount(targetEditor.getSelectedShapeIds().length)
      setMoveError('')
    })
  }, [targetEditor])

  // No write target mounted yet means nothing can be selected on it. Derived
  // rather than stored, so there is no moment where a stale count is readable.
  const selectionCount = targetEditor ? trackedSelectionCount : 0

  const moveSelectionToLayer = useCallback((destination: BookLayerId) => {
    const destinationEditor = editorForLayer(destination)
    if (!targetEditor || !destinationEditor || destination === layers.target) return
    const ids = targetEditor.getSelectedShapeIds()
    try {
      moveShapesToLayer(layerStore(targetEditor), layerStore(destinationEditor), ids)
      setMoveError('')
      // The destination is now where the work is, so that is where he is writing.
      setLayers(current => setWriteTarget(current, destination))
    } catch (error) {
      // The move refused rather than half-completing: the annotations are still
      // on the layer they were on. Say so, because "nothing happened" and
      // "something was lost" look identical from here.
      setMoveError((error as Error).message)
    }
  }, [targetEditor, editorForLayer, layers.target])

  // The layer state and the two selections over it, handed to the surface that
  // draws the ordinary controls. Nothing here is conditional on who is reading:
  // one layer means the control has nothing to offer and does not appear, which
  // is the same rule for every reader.
  const layersValue = useMemo<BookLayersValue>(() => ({
    state: layers,
    setVisible: (id, visible) => setLayers(current => setLayerVisible(current, id, visible)),
    setTarget: id => { setMoveError(''); setLayers(current => setWriteTarget(current, id)) },
    selectionCount,
    moveSelection: moveSelectionToLayer,
    moveError,
  }), [layers, selectionCount, moveSelectionToLayer, moveError])

  const ctx = useMemo<BookContextValue>(() => ({
    bookName,
    members,
    activeIndex,
    switchTo,
    layers: layersValue,
  }), [bookName, members, activeIndex, switchTo, layersValue])

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
          <StudentAnnotationOverlay
            key={`${activeMember.key}:${identity.studentId}`}
            bookRoomId={roomId}
            studentId={identity.studentId}
            bookEditor={bookEditor}
            visible={mineLayer?.visible ?? false}
            isWriteTarget={layers.target === 'mine'}
            onEditorMount={setOverlayEditor}
          />
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
            visible={studentLayer?.visible ?? true}
            onStudentChange={setReadStudent}
          />
        )}
      </div>
    </BookContext.Provider>
  )
}
