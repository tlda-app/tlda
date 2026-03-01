/**
 * BookViewer — renders a collection of existing docs as a tabbed book.
 *
 * Each member doc keeps its own sync room and annotations.
 * The viewer mounts one SvgDocumentEditor at a time; switching tabs
 * unmounts the current editor and mounts the new one.
 */
import { useState, useEffect, useMemo, useCallback } from 'react'
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

  const loadMember = useCallback(async (member: BookMember) => {
    setLoading(true)
    clearDocumentStores()

    try {
      let doc: SvgDocument
      if (member.format === 'html') {
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
        <BookTabBar members={members} activeIndex={activeIndex} onSwitch={switchTo} />
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
  return (
    <div className="book-tab-bar">
      {members.map((member, i) => (
        <button
          key={member.key}
          className={`book-tab ${i === activeIndex ? 'book-tab--active' : ''}`}
          onClick={() => onSwitch(i)}
        >
          {member.name}
        </button>
      ))}
    </div>
  )
}
