/**
 * FleetSearchShape — tldraw canvas shape for searching fleet chat history.
 *
 * Search input at top, scrollable results below with timestamp/sender/preview.
 * Uses editing mode for text input interaction (same pattern as FleetChatShape).
 */
import {
  BaseBoxShapeUtil,
  HTMLContainer,
  T,
  stopEventPropagation,
  useEditor,
  useValue,
} from 'tldraw'
import { useState, useCallback, useRef } from 'react'
import { searchFleet, useFleetAgents } from '../fleet-data-adapter'
import './fleet-chat.css'

const DEFAULT_W = 360
const DEFAULT_H = 500

export class FleetSearchShapeUtil extends BaseBoxShapeUtil<any> {
  static override type = 'fleet-search' as const
  static override props = {
    w: T.number,
    h: T.number,
  }

  getDefaultProps() {
    return { w: DEFAULT_W, h: DEFAULT_H }
  }

  override canEdit = () => true
  override canResize = () => true
  override canBind = () => false
  override hideRotateHandle = () => true
  override hideSelectionBoundsBg = () => true
  override hideSelectionBoundsFg = () => true

  component(shape: any) {
    return <FleetSearchComponent shape={shape} />
  }

  indicator() {
    return null
  }
}

function formatTime(ts: string | number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) +
    ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function truncate(text: string, max: number): string {
  if (!text) return ''
  // Strip HTML tags for preview
  const plain = text.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
  if (plain.length <= max) return plain
  return plain.slice(0, max) + '…'
}

function FleetSearchComponent({ shape }: { shape: any }) {
  const editor = useEditor()
  const { w, h } = shape.props
  const isEditing = useValue('editing', () => editor.getEditingShapeId() === shape.id, [editor, shape.id])
  const agents = useFleetAgents()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [searched, setSearched] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>()

  const agentName = useCallback((id: string) => {
    if (!id) return 'unknown'
    const a = agents.find((a: any) => a.id === id)
    if (a) return a.friendly_name || (a.id || '').replace('fleet:', '')
    return id.replace('fleet:', '')
  }, [agents])

  const doSearch = useCallback(async (q: string) => {
    if (!q.trim()) {
      setResults([])
      setSearched(false)
      return
    }
    setLoading(true)
    setSearched(true)
    const res = await searchFleet(q.trim(), 50)
    setResults(res)
    setLoading(false)
  }, [])

  const handleInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value
    setQuery(val)
    // Debounce search
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => doSearch(val), 300)
  }, [doSearch])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    e.stopPropagation()
    ;(e.nativeEvent as any).stopImmediatePropagation?.()
    if (e.key === 'Enter') {
      e.preventDefault()
      if (debounceRef.current) clearTimeout(debounceRef.current)
      doSearch(query)
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      editor.setEditingShape(null)
    }
  }, [doSearch, query, editor])

  return (
    <HTMLContainer
      style={{
        width: w,
        height: h,
        pointerEvents: 'all',
        overflow: 'visible',
      }}
    >
      <div
        className="fleet-shape fleet-search-shape"
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          borderRadius: 8,
          fontSize: 11,
          overflow: 'hidden',
          fontFamily: "'SF Mono', 'Menlo', 'Consolas', monospace",
          fontWeight: 300,
          lineHeight: 1.4,
          position: 'relative',
          color: 'var(--text, #8888a0)',
        }}
      >
        {/* Close button */}
        <button
          className="fleet-close-btn"
          onPointerDown={stopEventPropagation}
          onPointerUp={(e) => {
            stopEventPropagation(e)
            editor.deleteShapes([shape.id])
          }}
        >
          ×
        </button>

        {/* Search input */}
        <div style={{
          padding: 6,
          borderBottom: '1px solid rgba(128, 128, 128, 0.1)',
          flexShrink: 0,
        }}>
          <input
            ref={inputRef}
            type="text"
            placeholder="Search messages…"
            value={query}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            onPointerDown={stopEventPropagation}
            onFocus={stopEventPropagation}
            style={{
              width: '100%',
              background: 'rgba(128, 128, 128, 0.08)',
              border: '1px solid rgba(128, 128, 128, 0.15)',
              borderRadius: 4,
              padding: '4px 8px',
              fontSize: 11,
              color: 'inherit',
              outline: 'none',
              fontFamily: 'inherit',
            }}
          />
        </div>

        {/* Results */}
        <div style={{
          flex: 1,
          overflowY: 'auto',
          scrollbarWidth: 'thin' as const,
          scrollbarColor: 'rgba(255,255,255,0.1) transparent',
        }}>
          {loading && (
            <div style={{ padding: '12px 10px', opacity: 0.3, textAlign: 'center', fontSize: 10 }}>
              searching…
            </div>
          )}
          {!loading && searched && results.length === 0 && (
            <div style={{ padding: '12px 10px', opacity: 0.3, textAlign: 'center', fontSize: 10 }}>
              no results
            </div>
          )}
          {!loading && !searched && (
            <div style={{ padding: '20px 10px', opacity: 0.4, textAlign: 'center', fontSize: 10 }}>
              type to search fleet history
            </div>
          )}
          {results.map((r: any, i: number) => (
            <div
              key={i}
              style={{
                padding: '4px 10px',
                borderBottom: '1px solid rgba(128, 128, 128, 0.06)',
                cursor: 'pointer',
                transition: 'background 0.1s',
              }}
              onPointerDown={stopEventPropagation}
              onPointerUp={stopEventPropagation}
              onMouseOver={(e) => { e.currentTarget.style.background = 'rgba(128, 128, 128, 0.06)' }}
              onMouseOut={(e) => { e.currentTarget.style.background = 'transparent' }}
            >
              {/* Timestamp + sender */}
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                marginBottom: 1,
              }}>
                <span style={{ fontSize: 9, opacity: 0.5 }}>
                  {formatTime(r.timestamp)}
                </span>
                <span style={{
                  fontSize: 10,
                  fontWeight: 500,
                  opacity: 0.7,
                }}>
                  {agentName(r.from)}
                </span>
                {r.to && (
                  <>
                    <span style={{ fontSize: 8, opacity: 0.25 }}>→</span>
                    <span style={{ fontSize: 10, opacity: 0.5 }}>
                      {agentName(r.to)}
                    </span>
                  </>
                )}
              </div>
              {/* Message preview */}
              <div style={{
                fontSize: 10,
                opacity: 0.7,
                lineHeight: 1.3,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}>
                {truncate(r.text || r.message || r.body || '', 120)}
              </div>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div style={{
          height: 20,
          padding: '0 10px',
          display: 'flex',
          alignItems: 'center',
          borderTop: '1px solid rgba(128, 128, 128, 0.08)',
          fontSize: 9,
          opacity: 0.4,
          flexShrink: 0,
        }}>
          {searched ? `${results.length} result${results.length !== 1 ? 's' : ''}` : ''}
        </div>
      </div>
    </HTMLContainer>
  )
}
