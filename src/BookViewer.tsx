/**
 * BookViewer — renders a collection of existing docs as a tabbed book.
 *
 * Each member doc keeps its own sync room and annotations.
 * The viewer mounts one SvgDocumentEditor at a time; switching tabs
 * unmounts the current editor and mounts the new one.
 */
import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { SvgDocumentEditor } from './SvgDocument'
import { createSvgDocumentLayout, loadHtmlDocument } from './svgDocumentLoader'
import { clearDocumentStores } from './stores'
import { BookContext, type BookMember, type BookContextValue } from './BookContext'
import type { SvgDocument } from './loaders/types'

interface BookViewerProps {
  bookName: string
  members: BookMember[]
}

export function BookViewer({ bookName, members }: BookViewerProps) {
  const [activeIndex, setActiveIndex] = useState(0)
  const [document, setDocument] = useState<SvgDocument | null>(null)
  const [loading, setLoading] = useState(true)
  // Pending cross-member anchor navigation: set before switchTo, consumed after load
  const pendingAnchor = useRef<string | null>(null)

  const loadMember = useCallback(async (member: BookMember) => {
    setLoading(true)
    clearDocumentStores()

    try {
      let doc: SvgDocument
      if (member.format === 'html' || member.format === 'markdown') {
        doc = await loadHtmlDocument(member.name, member.basePath)
      } else {
        // SVG: create layout immediately, pages fetched async after editor mounts
        doc = createSvgDocumentLayout(member.key, member.pages, member.basePath)
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

  // After a cross-member switch completes, navigate to pending anchor
  useEffect(() => {
    if (loading || !pendingAnchor.current) return
    const anchor = pendingAnchor.current
    pendingAnchor.current = null
    // Include targetFile so HtmlPageShape can find the shape by URL
    const activeMember = members[activeIndex]
    window.postMessage({ type: 'tlda-navigate', anchor, shapeId: null, targetFile: activeMember?.key || null, __bookRouted: true }, '*')
  }, [loading, members, activeIndex])

  const ctx = useMemo<BookContextValue>(() => ({
    bookName,
    members,
    activeIndex,
    switchTo,
  }), [bookName, members, activeIndex, switchTo])

  const activeMember = members[activeIndex]
  const roomId = activeMember ? `doc-${activeMember.key}` : ''

  return (
    <BookContext.Provider value={ctx}>
      <div className="book-viewer">
        {loading && <div className="book-loading">Loading {activeMember?.name}...</div>}
        {!loading && document && (
          <SvgDocumentEditor key={activeMember.key} document={document} roomId={roomId} />
        )}
      </div>
    </BookContext.Provider>
  )
}

function BookTabBar({ members, activeIndex, onSwitch }: {
  members: BookMember[]
  activeIndex: number
  onSwitch: (index: number) => void
}) {
  // Hot session: most recently pushed member with a sessionAt tag
  const hotIdx = useMemo(() => {
    let best = -1, bestAt = 0
    members.forEach((m, i) => {
      if (m.sessionAt && m.sessionAt > bestAt) { bestAt = m.sessionAt; best = i }
    })
    return best
  }, [members])

  return (
    <div className="book-tab-bar">
      {members.map((member, i) => (
        <button
          key={member.key}
          className={`book-tab ${i === activeIndex ? 'book-tab--active' : ''} ${i === hotIdx ? 'book-tab--hot' : ''}`}
          onClick={() => onSwitch(i)}
        >
          {i === hotIdx && <span className="book-tab-hot-dot" title="Active session" />}
          {member.name}
        </button>
      ))}
    </div>
  )
}
