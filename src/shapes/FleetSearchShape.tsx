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
import { useState, useCallback, useRef, useMemo, useLayoutEffect, memo } from 'react'
import { searchFleet, fetchSharedDocs, useFleetAgents, useFleetEvents, useFleetTasks } from '../fleet-data-adapter'
import katex from 'katex'
import { getActiveMacros } from '../katexMacros'
import MarkdownIt from 'markdown-it'
// @ts-ignore — vanilla JS module
import { renderChatLine, esc } from '../fleet/chat-render.mjs'
// @ts-ignore — vanilla JS module
import { renderActivityGroup } from '../fleet/activity-render.mjs'
// @ts-ignore — vanilla JS module
import { highlightSyntax, langFromFilePath } from '../fleet/utils.mjs'
import { appendToken } from '../authToken'
import { useLayoutMode } from './HudLayoutMode'
import { useIsInViewport } from './useIsInViewport'
import './fleet-chat.css'

const DEFAULT_W = 360
const DEFAULT_H = 500

// --- Markdown renderer (shared with FleetChatShape) ---
const md = new MarkdownIt({ html: true, breaks: true, linkify: true })
md.renderer.rules.fence = (tokens: any[], idx: number) => {
  const token = tokens[idx]
  const lang = token.info.trim()
  const code = token.content
  const langLabel = lang ? `<span class="code-block-lang">${lang}</span>` : ''
  const escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return `<div class="code-block-wrap"><div class="code-block-header">${langLabel}<span class="code-block-copy" title="Copy">⎘</span></div><pre><code>${escaped}</code></pre></div>`
}

function searchRenderMarkdown(escapedHtml: string): string {
  let text = escapedHtml
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  text = text.replace(/<(?:task-notification|system-reminder|local-command-caveat|command-name|command-message|command-args|local-command-stdout)[^>]*>[\s\S]*?<\/(?:task-notification|system-reminder|local-command-caveat|command-name|command-message|command-args|local-command-stdout)>/g, '')
  const macros = getActiveMacros()
  // throwOnError: true → catch fires on bad LaTeX, fall back to raw text
  text = text.replace(/\$\$([\s\S]*?)\$\$/g, (_, tex: string) => {
    try { return katex.renderToString(tex.trim(), { displayMode: true, throwOnError: true, strict: false, macros }) }
    catch { return `<div class="math-display">$$${esc(tex)}$$</div>` }
  })
  text = text.replace(/(?<![\\$\w])\$([^$\n]+?)\$(?![\\$\w\d])/g, (_, tex: string) => {
    try { return katex.renderToString(tex.trim(), { displayMode: false, throwOnError: true, strict: false, macros }) }
    catch { return `<span class="math-inline">$${esc(tex)}$</span>` }
  })
  let result = md.render(text)
  const trimmed = result.trim()
  if (trimmed.startsWith('<p>') && trimmed.endsWith('</p>') && trimmed.indexOf('<p>', 1) === -1) {
    result = trimmed.slice(3, -4)
  }
  result = result.replace(/<a(?![^>]*target=)([^>]*href=")/g, '<a target="_blank"$1')
  return result
}

// Nick color system for embedded chat
const nickColors = ['nick-agent-0','nick-agent-1','nick-agent-2','nick-agent-3','nick-agent-4','nick-agent-5']
const nickHex = ['#7a9ec8','#9370db','#c8956a','#6aafb0','#b87a95','#c8b060']
const nickMap = new Map<string, string>()
const nickHexMap = new Map<string, string>()
let nickIdx = 0

function makeChatCtx(agents: any[], tasks: any[]) {
  const agentLabel = (id: string) => {
    if (!id) return '[unknown]'
    const a = agents.find((a: any) => a.id === id)
    if (a) return a.friendly_name || a.id
    return typeof id === 'string' ? id : String(id)
  }
  const getNickClass = (id: string) => {
    if (!id) return 'nick-agent-0'
    const a = agents.find((a: any) => a.id === id)
    if (a?.human) return 'nick-human'
    if (!nickMap.has(id)) {
      const idx = nickIdx % nickColors.length
      nickMap.set(id, nickColors[idx])
      nickHexMap.set(id, nickHex[idx])
      nickIdx++
    }
    return nickMap.get(id)!
  }
  return {
    agentLabel, getNickClass,
    getAgentColor: (id: string) => nickHexMap.get(id) || '#9370db',
    isHumanId: (id: string) => !!(agents.find((a: any) => a.id === id)?.human),
    getAgents: () => agents,
    getTasks: () => tasks,
    tldaToken: null as string | null,
    renderMarkdown: searchRenderMarkdown,
    highlightSyntax,
    langFromFilePath,
    preambleMacros: {},
  }
}

// --- Embedded chat view for search results ---
function EmbeddedChatView({ agentFilter, scrollToTs, onBack }: {
  agentFilter: [string, string][][]
  scrollToTs?: string
  onBack: () => void
}) {
  const agents = useFleetAgents()
  const tasks = useFleetTasks()
  const events = useFleetEvents(agentFilter)
  const chatLogRef = useRef<HTMLDivElement>(null)
  const scrolledRef = useRef(false)

  const ctx = useMemo(() => makeChatCtx(agents, tasks), [agents, tasks])

  const chatMessages = useMemo(() => {
    return events
      .filter((m: any) => {
        const t = m.type
        return t === 'chat' || t === 'delegate' || t === 'task_done' || t === 'activity'
      })
      .filter((m: any) => !m._timer)
      .sort((a: any, b: any) => {
        const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0
        const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0
        return ta - tb
      })
  }, [events])

  const renderedHtml = useMemo(() => {
    const parts: string[] = []
    let activityGroup: any[] = []
    function flushActivity() {
      if (activityGroup.length === 0) return
      parts.push(`<div class="chat-activity-inline-wrap">${renderActivityGroup(activityGroup, ctx)}</div>`)
      activityGroup = []
    }
    for (const m of chatMessages) {
      if (m._activity) {
        if (activityGroup.length > 0 && activityGroup[0].from !== m.from) flushActivity()
        activityGroup.push(m)
      } else {
        flushActivity()
        const line = renderChatLine(m, ctx)
        if (line) parts.push(line)
      }
    }
    flushActivity()
    return parts.join('')
  }, [chatMessages, ctx])

  // Scroll to target timestamp after render
  useLayoutEffect(() => {
    if (!scrollToTs || !chatLogRef.current || scrolledRef.current) return
    const targetTs = new Date(scrollToTs).getTime()
    // Find the chat-line closest to this timestamp
    const lines = chatLogRef.current.querySelectorAll('[data-msg-ts]')
    let closest: Element | null = null
    let closestDiff = Infinity
    for (const line of lines) {
      const ts = new Date((line as HTMLElement).dataset.msgTs || '').getTime()
      const diff = Math.abs(ts - targetTs)
      if (diff < closestDiff) { closestDiff = diff; closest = line }
    }
    if (closest) {
      closest.scrollIntoView({ block: 'center' })
      closest.classList.add('chat-line-highlight')
      setTimeout(() => closest!.classList.remove('chat-line-highlight'), 3000)
      scrolledRef.current = true
    }
  }, [renderedHtml, scrollToTs])

  return (
    <div className="fleet-search-embedded-chat">
      <div
        className="fleet-search-chat-back"
        onPointerDown={(e) => e.stopPropagation()}
        onPointerUp={(e) => { e.stopPropagation(); onBack() }}
      >
        ← back to results
      </div>
      <div
        ref={chatLogRef}
        className="fleet-chat-log"
        dangerouslySetInnerHTML={{ __html: renderedHtml }}
        style={{ flex: 1, overflowY: 'auto', fontSize: 10 }}
      />
    </div>
  )
}

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

function FleetSearchInner({ shape }: { shape: any }) {
  const editor = useEditor()
  const layoutMode = useLayoutMode()
  const { w, h } = shape.props
  void useValue('editing', () => editor.getEditingShapeId() === shape.id, [editor, shape.id])
  const agents = useFleetAgents()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<any[]>([])
  const [docResults, setDocResults] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [searched, setSearched] = useState(false)
  // When a result is clicked, show the real chat view for that agent
  const [chatView, setChatView] = useState<{ agentFilter: [string, string][][]; scrollToTs: string } | null>(null)
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
      setChatView(null)
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
    setChatView(null)

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

  // Build a DNF filter for the agent involved in a search result
  const openChatForResult = useCallback((result: any) => {
    // Build filter: [[["name", agentFriendlyName]]]
    const name = agentName(result.from)
    const filter: [string, string][][] = [[['name', name]]]
    setChatView({ agentFilter: filter, scrollToTs: result.timestamp })
  }, [agentName])

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
      if (chatView) {
        setChatView(null)
      } else {
        editor.setEditingShape(null)
      }
    }
  }, [doSearch, query, editor, chatView])

  // Parse current filters for display
  const { filters: activeFilters } = useMemo(() => parseSearchQuery(query), [query])

  return (
    <HTMLContainer
      style={{
        width: w,
        height: h,
        pointerEvents: layoutMode ? 'none' : 'all',
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
              editor.setCurrentTool('select')
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

        {/* Results or embedded chat */}
        {chatView ? (
          <EmbeddedChatView
            agentFilter={chatView.agentFilter}
            scrollToTs={chatView.scrollToTs}
            onBack={() => setChatView(null)}
          />
        ) : (
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
            <div
              key={i}
              className="fleet-search-result"
              onPointerDown={(e) => { stopEventPropagation(e) }}
              onPointerUp={(e) => {
                e.stopPropagation()
                openChatForResult(r)
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
              {/* Message preview */}
              <div style={{
                fontSize: 10,
                opacity: 0.7,
                lineHeight: 1.3,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}>
                {truncate(r.snippet || r.text || r.message || r.body || '', 120)}
              </div>
            </div>
          ))}
        </div>
        )}

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

const FleetSearchComponent = memo(function FleetSearchComponent({ shape }: { shape: any }) {
  const { w, h } = shape.props as { w: number; h: number }
  const isInViewport = useIsInViewport(shape.id)
  if (!isInViewport) {
    return <HTMLContainer id={shape.id}><div style={{ width: w, height: h }} /></HTMLContainer>
  }
  return <FleetSearchInner shape={shape} />
}, (prev, next) => prev.shape.props === next.shape.props)
