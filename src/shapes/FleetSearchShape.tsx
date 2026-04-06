/**
 * FleetSearchShape — tldraw canvas shape for searching fleet chat history.
 *
 * Supports inline keyword filters: from:name, agent:name, before:date, after:date
 * Boolean logic: AND, OR, parentheses, "quoted phrases" — passed through to FTS5.
 * Click a result to expand and show surrounding context inline.
 */
import {
  BaseBoxShapeUtil,
  HTMLContainer,
  T,
  stopEventPropagation,
  useEditor,
  useValue,
} from 'tldraw'
import { useState, useCallback, useRef, useMemo } from 'react'
import { searchFleet, fetchSharedDocs, useFleetAgents } from '../fleet-data-adapter'
import { appendToken } from '../authToken'
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
  const plain = text.replace(/<[^>]*>/g, '').replace(/[⟨⟩]{2}/g, '').replace(/\s+/g, ' ').trim()
  if (plain.length <= max) return plain
  return plain.slice(0, max) + '…'
}

// Parse inline keyword filters from query string
// Returns { query, filters } where query is the remaining FTS text
// and filters has from, agent, before, after fields
interface SearchFilters {
  from?: string
  agent?: string
  role?: string
  before?: string
  after?: string
}

function parseSearchQuery(raw: string): { query: string; filters: SearchFilters } {
  const filters: SearchFilters = {}
  // Extract filter keywords (from:xxx, agent:xxx, before:xxx, after:xxx, role:xxx)
  const remaining = raw.replace(/\b(from|agent|before|after|role):(\S+)/gi, (_, key, val) => {
    const k = key.toLowerCase()
    if (k === 'from') filters.from = val
    else if (k === 'agent') filters.agent = val
    else if (k === 'before') filters.before = val
    else if (k === 'after') filters.after = val
    else if (k === 'role') filters.role = val
    return ''
  }).trim()
  return { query: remaining, filters }
}

// Resolve time filter values to ISO timestamps
function resolveTimeFilter(val: string): string | null {
  const now = new Date()
  const lower = val.toLowerCase()
  if (lower === 'today') {
    const d = new Date(now); d.setHours(0, 0, 0, 0); return d.toISOString()
  }
  if (lower === 'yesterday') {
    const d = new Date(now); d.setDate(d.getDate() - 1); d.setHours(0, 0, 0, 0); return d.toISOString()
  }
  // Relative: 1h, 2d, 3w, 4m
  const relMatch = lower.match(/^(\d+)([hdwm])$/)
  if (relMatch) {
    const n = parseInt(relMatch[1])
    const unit = relMatch[2]
    const d = new Date(now)
    if (unit === 'h') d.setHours(d.getHours() - n)
    else if (unit === 'd') d.setDate(d.getDate() - n)
    else if (unit === 'w') d.setDate(d.getDate() - n * 7)
    else if (unit === 'm') d.setMonth(d.getMonth() - n)
    return d.toISOString()
  }
  // Try parsing as date
  const parsed = new Date(val)
  if (!isNaN(parsed.getTime())) return parsed.toISOString()
  return null
}

function FleetSearchComponent({ shape }: { shape: any }) {
  const editor = useEditor()
  const { w, h } = shape.props
  void useValue('editing', () => editor.getEditingShapeId() === shape.id, [editor, shape.id])
  const agents = useFleetAgents()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<any[]>([])
  const [docResults, setDocResults] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [searched, setSearched] = useState(false)
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null)
  const [contextMessages, setContextMessages] = useState<any[]>([])
  const [contextLoading, setContextLoading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Agent ID → display name lookup
  const agentName = useCallback((id: string) => {
    if (!id) return 'unknown'
    const a = agents.find((a: any) => a.id === id)
    if (a) return a.friendly_name || (a.id || '').replace('fleet:', '')
    return id.replace('fleet:', '')
  }, [agents])

  // Agent name → ID lookup (for from: filter matching)
  const agentIdByName = useMemo(() => {
    const map = new Map<string, string>()
    for (const a of agents) {
      const name = a.friendly_name || (a.id || '').replace('fleet:', '')
      map.set(name.toLowerCase(), a.id)
    }
    return map
  }, [agents])

  const doSearch = useCallback(async (q: string) => {
    if (!q.trim()) {
      setResults([])
      setDocResults([])
      setSearched(false)
      setExpandedIdx(null)
      return
    }

    const { query: ftsQuery, filters } = parseSearchQuery(q)

    // Need at least a query or a filter
    if (!ftsQuery && !filters.from && !filters.agent) {
      setResults([])
      setDocResults([])
      setSearched(false)
      return
    }

    setLoading(true)
    setSearched(true)
    setExpandedIdx(null)

    // Build search — pass FTS query to API, filter results client-side
    const searchQuery = ftsQuery || '*'
    const [res, allDocs] = await Promise.all([
      searchFleet(searchQuery.length >= 2 ? searchQuery : 'message', 100),
      fetchSharedDocs(),
    ])

    // Apply client-side filters
    let filtered = res
    if (filters.from) {
      const fromLower = filters.from.toLowerCase()
      const fromId = agentIdByName.get(fromLower)
      filtered = filtered.filter((r: any) => {
        const name = agentName(r.from).toLowerCase()
        return name === fromLower || name.includes(fromLower) || r.from === fromId
      })
    }
    if (filters.agent) {
      const agentLower = filters.agent.toLowerCase()
      const aId = agentIdByName.get(agentLower)
      filtered = filtered.filter((r: any) => {
        const fromName = agentName(r.from).toLowerCase()
        const toName = agentName(r.to).toLowerCase()
        return fromName.includes(agentLower) || toName.includes(agentLower) ||
               r.from === aId || r.to === aId
      })
    }
    if (filters.role) {
      filtered = filtered.filter((r: any) => r.role === filters.role)
    }
    if (filters.after) {
      const afterTs = resolveTimeFilter(filters.after)
      if (afterTs) {
        filtered = filtered.filter((r: any) => r.timestamp && r.timestamp >= afterTs)
      }
    }
    if (filters.before) {
      const beforeTs = resolveTimeFilter(filters.before)
      if (beforeTs) {
        filtered = filtered.filter((r: any) => r.timestamp && r.timestamp <= beforeTs)
      }
    }

    setResults(filtered.slice(0, 50))

    // Filter shared docs by title match (only if there's an FTS query)
    if (ftsQuery) {
      const ql = ftsQuery.toLowerCase()
      setDocResults(allDocs.filter(d => d.title?.toLowerCase().includes(ql) || d.doc?.toLowerCase().includes(ql)))
    } else {
      setDocResults([])
    }

    setLoading(false)
  }, [agentIdByName, agentName])

  // Load context around a search result (3 messages before/after)
  const loadContext = useCallback(async (result: any, idx: number) => {
    if (expandedIdx === idx) {
      setExpandedIdx(null)
      setContextMessages([])
      return
    }
    setExpandedIdx(idx)
    setContextLoading(true)

    // Search for messages near this timestamp from the same agent
    const fromName = agentName(result.from)
    try {
      const nearby = await searchFleet(`from:${fromName}`, 20)
      // Sort by timestamp and find messages around the target
      const sorted = nearby
        .filter((r: any) => r.timestamp)
        .sort((a: any, b: any) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
      const targetTs = new Date(result.timestamp).getTime()
      const targetIdx = sorted.findIndex((r: any) => Math.abs(new Date(r.timestamp).getTime() - targetTs) < 5000)
      const start = Math.max(0, targetIdx - 3)
      const end = Math.min(sorted.length, targetIdx + 4)
      setContextMessages(sorted.slice(start, end))
    } catch {
      setContextMessages([])
    }
    setContextLoading(false)
  }, [expandedIdx, agentName])

  const handleInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value
    setQuery(val)
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
      if (expandedIdx !== null) {
        setExpandedIdx(null)
        setContextMessages([])
      } else {
        editor.setEditingShape(null)
      }
    }
  }, [doSearch, query, editor, expandedIdx])

  // Parse current filters for display
  const { filters: activeFilters } = useMemo(() => parseSearchQuery(query), [query])

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
          borderRadius: 0,
          fontSize: 11,
          overflow: 'hidden',
          fontFamily: "'SF Mono', 'Menlo', 'Consolas', monospace",
          fontWeight: 300,
          lineHeight: 1.4,
          position: 'relative',
          color: 'var(--text, #8888a0)',
        }}
      >
        {/* Close + layout buttons */}
        <div className="fleet-btn-group" onPointerDown={(e) => e.stopPropagation()}>
          <button
            className="fleet-close-btn"
            onPointerUp={(e) => {
              e.stopPropagation()
              editor.deleteShapes([shape.id])
            }}
          >
            ×
          </button>
          <button
            className="fleet-layout-btn"
            onPointerUp={(e) => {
              e.stopPropagation()
              editor.select(shape.id)
            }}
            title="Resize / move"
          >
            ⊞
          </button>
        </div>

        {/* Search input */}
        <div
          className="fleet-search-input-area"
          style={{
            padding: 6,
            borderBottom: '1px solid rgba(128, 128, 128, 0.1)',
            flexShrink: 0,
          }}
        >
          <input
            ref={inputRef}
            type="text"
            placeholder="Search… (from:skip agent:apps before:1d)"
            value={query}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            onPointerDown={(e) => { stopEventPropagation(e) }}
            onFocus={(e) => { stopEventPropagation(e) }}
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
          {/* Active filter indicators */}
          {(activeFilters.from || activeFilters.agent || activeFilters.before || activeFilters.after) && (
            <div style={{ display: 'flex', gap: 4, marginTop: 3, flexWrap: 'wrap' }}>
              {activeFilters.from && <span className="fleet-search-filter-tag">from:{activeFilters.from}</span>}
              {activeFilters.agent && <span className="fleet-search-filter-tag">agent:{activeFilters.agent}</span>}
              {activeFilters.before && <span className="fleet-search-filter-tag">before:{activeFilters.before}</span>}
              {activeFilters.after && <span className="fleet-search-filter-tag">after:{activeFilters.after}</span>}
            </div>
          )}
        </div>

        {/* Results */}
        <div
          className="fleet-search-results"
          style={{
            flex: 1,
            overflowY: 'auto',
            scrollbarWidth: 'thin' as const,
            scrollbarColor: 'rgba(255,255,255,0.1) transparent',
          }}
        >
          {loading && (
            <div style={{ padding: '12px 10px', opacity: 0.3, textAlign: 'center', fontSize: 10 }}>
              searching…
            </div>
          )}
          {!loading && searched && results.length === 0 && docResults.length === 0 && (
            <div style={{ padding: '12px 10px', opacity: 0.3, textAlign: 'center', fontSize: 10 }}>
              no results
            </div>
          )}
          {/* Shared docs section */}
          {docResults.length > 0 && (
            <>
              <div className="fleet-search-section-header">Docs</div>
              {docResults.map((d: any, i: number) => (
                <div
                  key={`doc-${i}`}
                  className="fleet-search-doc-result"
                  onPointerDown={(e) => {
                    stopEventPropagation(e)
                    window.open(appendToken(`${window.location.origin}/?doc=${encodeURIComponent(d.doc)}`), '_blank')
                  }}
                >
                  <span style={{ fontSize: 12 }}>📄</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 11, fontWeight: 500, opacity: 0.8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {d.title || d.doc}
                    </div>
                    <div style={{ fontSize: 9, opacity: 0.4 }}>
                      {d.agent_name || d.agent} · {d.shared_at ? new Date(d.shared_at).toLocaleDateString() : ''}
                    </div>
                  </div>
                </div>
              ))}
            </>
          )}
          {results.length > 0 && (
            <div className="fleet-search-section-header">Messages</div>
          )}
          {!loading && !searched && (
            <div style={{ padding: '20px 10px', opacity: 0.4, textAlign: 'center', fontSize: 10 }}>
              type to search fleet history
            </div>
          )}
          {results.map((r: any, i: number) => (
            <div key={i}>
              <div
                className={`fleet-search-result${expandedIdx === i ? ' expanded' : ''}`}
                onPointerDown={(e) => { stopEventPropagation(e) }}
                onPointerUp={(e) => {
                  e.stopPropagation()
                  loadContext(r, i)
                }}
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
                {/* Message preview — show more lines when expanded */}
                <div style={{
                  fontSize: 10,
                  opacity: 0.7,
                  lineHeight: 1.3,
                  overflow: 'hidden',
                  textOverflow: expandedIdx === i ? undefined : 'ellipsis',
                  whiteSpace: expandedIdx === i ? 'pre-wrap' : 'nowrap',
                  maxHeight: expandedIdx === i ? 'none' : undefined,
                }}>
                  {expandedIdx === i
                    ? truncate(r.snippet || r.text || r.message || r.body || '', 500)
                    : truncate(r.snippet || r.text || r.message || r.body || '', 120)
                  }
                </div>
              </div>
              {/* Context messages when expanded */}
              {expandedIdx === i && (
                <div className="fleet-search-context">
                  {contextLoading && (
                    <div style={{ padding: '4px 10px', opacity: 0.3, fontSize: 9 }}>loading context…</div>
                  )}
                  {!contextLoading && contextMessages.length > 0 && (
                    <>
                      <div className="fleet-search-context-header">Context</div>
                      {contextMessages.map((cm: any, ci: number) => {
                        const isTarget = Math.abs(
                          new Date(cm.timestamp).getTime() - new Date(r.timestamp).getTime()
                        ) < 5000
                        return (
                          <div
                            key={ci}
                            className={`fleet-search-context-msg${isTarget ? ' target' : ''}`}
                          >
                            <span style={{ fontSize: 8, opacity: 0.4 }}>{formatTime(cm.timestamp)}</span>
                            {' '}
                            <span style={{ fontSize: 9, fontWeight: 500, opacity: 0.6 }}>{agentName(cm.from)}</span>
                            {cm.to && (
                              <>
                                <span style={{ fontSize: 7, opacity: 0.2 }}> → </span>
                                <span style={{ fontSize: 9, opacity: 0.4 }}>{agentName(cm.to)}</span>
                              </>
                            )}
                            <div style={{ fontSize: 9, opacity: isTarget ? 0.8 : 0.5, lineHeight: 1.3, marginTop: 1 }}>
                              {truncate(cm.snippet || cm.text || cm.message || cm.body || '', 200)}
                            </div>
                          </div>
                        )
                      })}
                    </>
                  )}
                </div>
              )}
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
          {searched ? `${results.length + docResults.length} result${results.length + docResults.length !== 1 ? 's' : ''}${docResults.length > 0 ? ` · ${docResults.length} doc${docResults.length !== 1 ? 's' : ''}` : ''}` : ''}
        </div>
      </div>
    </HTMLContainer>
  )
}
