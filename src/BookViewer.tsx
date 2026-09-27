/**
 * BookViewer — renders a collection of existing docs as a tabbed book.
 *
 * Each member doc keeps its own sync room and annotations.
 * The viewer mounts one SvgDocumentEditor at a time; switching tabs
 * unmounts the current editor and mounts the new one.
 *
 * A teleport carries the reader's fleet layout into a bare room and records
 * the departure for back/forward; a chapter the reader already arranged keeps
 * its own layout and is never touched.
 */
import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { Tldraw } from 'tldraw'
import { SvgDocumentEditor } from './SvgDocument'
import { fetchDocumentManifest, loadDocumentByFormat, projectInfoUrl } from './loaders/documentFormatLoader'
import { STORE_HTTP } from './activeConfig'
import { clearDocumentStores } from './stores'
import { BookContext, type BookMember, type BookContextValue } from './BookContext'
import { LayersContext } from './classroom/layersContext'
import { useDocumentLayers } from './classroom/useDocumentLayers'
import { findBookMemberIndex } from './bookMemberNavigation'
import { ClassroomIdentityBadge } from './classroom/ClassroomIdentityBadge'
import { isClassroomSurface } from './classroom/classroomSurface'
import type { SvgDocument } from './loaders/types'
import type { Editor } from 'tldraw'
import { cacheProjectsForOffline } from './airplaneMode'
import type { AirplaneState } from './BookContext'
import {
  consumePendingMemberCamera,
  recordPlaceDeparture,
  registerPlaceMemberResolver,
  registerPlaceMemberSwitcher,
} from './placeStack'
import {
  carryFleetLayoutToEditor,
  snapshotOwnedFleetLayout,
  type FleetCarrySnapshot,
} from './bookFleetCarry'
import { dispatchFleetHudWrap } from './wm/editor-host-bridge'

interface BookViewerProps {
  bookName: string
  members: BookMember[]
  onEditorMount?: (editor: Editor | null) => void
}

/**
 * Settle one teleport carry: recreate the outgoing layout around the arrival
 * chapter, then adopt it with the wrap dispatch. The document reconciles after
 * the sync handshake, so a not-ready room retries on page-shape arrivals until
 * the deadline; a room that already holds the session's layout keeps it and
 * settles silently. Loud on deadline: a dropped carry must not read as a bare
 * chapter.
 */
function attemptFleetCarry(editor: Editor, snapshot: FleetCarrySnapshot) {
  const deadline = Date.now() + 5000
  let settled = false
  let unsub: (() => void) | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  const cleanup = () => {
    unsub?.()
    unsub = null
    if (timer !== null) clearTimeout(timer)
    timer = null
  }
  const attempt = () => {
    if (settled) return
    const result = carryFleetLayoutToEditor(editor, snapshot)
    if (result.status === 'carried') {
      settled = true
      cleanup()
      // Adopt, not translate: the panels were just created at their wrapped
      // positions and the anchor must follow even when the plan did not move
      // (same-size chapters), so this fires without the moves gate the
      // same-room path applies.
      dispatchFleetHudWrap({ dx: result.plan.dx, dy: result.plan.dy })
      return
    }
    if (result.status === 'kept') {
      settled = true
      cleanup()
      return
    }
    if (Date.now() >= deadline) {
      settled = true
      cleanup()
      console.warn('[bookFleetCarry] arrival never produced document bounds; layout not carried')
    }
  }
  attempt()
  if (!settled) {
    unsub = editor.store.listen(({ changes }) => {
      const isDocumentPageRecord = (record: unknown): boolean => {
        if (typeof record !== 'object' || record === null) return false
        const { typeName, type } = record as { typeName?: unknown; type?: unknown }
        return typeName === 'shape' && (type === 'svg-page' || type === 'html-page')
      }
      const hasPageChange =
        Object.values(changes.added).some(isDocumentPageRecord) ||
        Object.values(changes.updated).some((pair) => isDocumentPageRecord(pair[1]))
      if (hasPageChange) attempt()
    }, { source: 'all', scope: 'document' })
    timer = setTimeout(attempt, Math.max(0, deadline - Date.now()))
  }
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
  // Pending fleet carry: snapshotted from the outgoing editor before switchTo,
  // consumed by the arrival mount. A traversal switch (place-stack back /
  // forward) sets neither this nor a departure — its own stack step is the
  // record, and the arrival camera comes from the place instead.
  const pendingCarry = useRef<FleetCarrySnapshot | null>(null)
  const traversalSwitch = useRef(false)
  // Stable mirrors for the place-stack bridge, which is registered once but
  // must read the current member, members, and switcher at gesture time.
  const bookEditorRef = useRef<Editor | null>(null)
  const activeIndexRef = useRef(activeIndex)
  const activeMemberKeyRef = useRef<string | null>(null)
  const membersRef = useRef(members)
  const switchToRef = useRef<(index: number, variant?: 'slides') => void>(() => {})

  const loadMember = useCallback(async (member: BookMember, variant: 'slides' | null) => {
    setLoading(true)
    setLoadError('')
    clearDocumentStores()

    try {
      const manifest = await fetchDocumentManifest(member.basePath)
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
      const shownAs = variant || manifest.view.kind
      if (shownAs === 'html-pages') {
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
          doc = await loadDocumentByFormat({ name: member.key, basePath: member.basePath, manifest, pages: pair })
        } else {
          doc = await loadDocumentByFormat({ name: member.key, basePath: member.basePath, manifest })
        }
      } else {
        const info = await fetch(projectInfoUrl(STORE_HTTP, member.key))
          .then(r => (r.ok ? r.json() : null))
          .catch(() => null)
        const targets = info?.targets?.map((t: { texBase: string; pages: number }) => ({
          name: t.texBase, title: t.texBase.replace(/_/g, ' '), pages: t.pages, basePath: member.basePath,
        }))
        doc = await loadDocumentByFormat({
          name: member.key,
          basePath: member.basePath,
          manifest,
          targets,
          viewKind: variant || undefined,
        })
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
    // A member change is a departure from the chapter being left: record it
    // for back/forward and snapshot the reader's fleet layout for the arrival.
    // Same-member variant switches stay in the room and take neither.
    if (index !== activeIndex && !traversalSwitch.current) {
      const outgoing = bookEditorRef.current
      if (outgoing) {
        recordPlaceDeparture(outgoing)
        pendingCarry.current = snapshotOwnedFleetLayout(outgoing)
      }
    }
    traversalSwitch.current = false
    setActiveVariant(variant || null)
    if (index !== activeIndex) setActiveIndex(index)
  }, [members.length, activeIndex])

  // Mirrors for the place-stack bridge. Effects, not render writes: the bridge
  // reads them at gesture time, strictly between commits.
  useEffect(() => {
    activeIndexRef.current = activeIndex
    activeMemberKeyRef.current = members[activeIndex]?.key ?? null
    membersRef.current = members
    switchToRef.current = switchTo
  }, [members, activeIndex, switchTo])

  // Back/forward across chapters: the stack records member-keyed places (see
  // switchTo) and this bridge performs the room switch the stack cannot.
  useEffect(() => {
    registerPlaceMemberResolver(() => activeMemberKeyRef.current)
    registerPlaceMemberSwitcher((memberKey: string) => {
      const idx = membersRef.current.findIndex(member => member.key === memberKey)
      if (idx < 0 || idx === activeIndexRef.current) return false
      // A traversal preempts any in-flight anchor teleport: the place camera
      // is authoritative at arrival, not the abandoned switch's anchor.
      pendingAnchor.current = null
      traversalSwitch.current = true
      switchToRef.current(idx)
      return true
    })
    return () => {
      registerPlaceMemberResolver(null)
      registerPlaceMemberSwitcher(null)
    }
  }, [])

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
    // The remount race the release hook exists for: a teardown's null can land
    // after the replacement registered, so only arrivals move the mirror.
    if (editor) bookEditorRef.current = editor
    setBookEditor(editor)
    onEditorMount?.(editor)
    if (!editor) return
    // Traversal restore: the place camera a member switch owes this mount. The
    // room's own session restore runs ~500ms post-mount and would win, so this
    // waits for its signal, with a fallback in case it never comes.
    const placeCamera = consumePendingMemberCamera()
    if (placeCamera) {
      let applied = false
      const apply = () => {
        if (applied) return
        applied = true
        editor.setCamera(placeCamera, { animation: { duration: 300 } })
      }
      window.addEventListener('camera-restored', apply, { once: true })
      window.setTimeout(apply, 1200)
    }
    // Teleport carry: recreate the outgoing layout around this chapter when
    // the room has none of its own. Consumed by the first arrival mount, so a
    // chapter never carries twice.
    const snapshot = pendingCarry.current
    pendingCarry.current = null
    if (snapshot) attemptFleetCarry(editor, snapshot)
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
