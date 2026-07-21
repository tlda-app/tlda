/**
 * FleetSearchShape — tldraw canvas shape for searching fleet chat history.
 *
 * Supports the fleet query language: literal text plus event filters such as
 * from:, to:, agent:, type:, since:, before:, and grouped agent-set expressions.
 * Click a result to expand and show surrounding context inline.
 */
import {
  BaseBoxShapeUtil,
  HTMLContainer,
  stopEventPropagation,
  useEditor,
  useValue,
  createShapeId,
  type TLShapeId,
} from 'tldraw'
import { beginNativeSnapDrag, createFleetShape, agentDisplayLabel, endNativeSnapDrag } from './fleet-utils'
import { FleetPanelButtonGroup } from './FleetPanelChrome'
import { fleetSearchProps } from '../../shared/shapes/fleet-panel-schema.mjs'
import { useState, useCallback, useRef, useMemo, useEffect, memo } from 'react'
import { searchFleet, fetchSharedDocs, useFleetAgents, useFleetTasks } from '../fleet-data-adapter'
import { fleetSearchResultAgentChatFilter } from '../fleet/filter-semantics.mjs'
import katex from 'katex'
import { getActiveMacros } from '../katexMacros'
import MarkdownIt from 'markdown-it'
// @ts-ignore — vanilla JS module
import { renderChatLine, esc, timeShort } from '../fleet/chat-render.mjs'
// @ts-ignore — vanilla JS module
import { renderActivityGroup } from '../fleet/activity-render.mjs'
// @ts-ignore — vanilla JS module
import { highlightSyntax, langFromFilePath } from '../fleet/utils.mjs'
// @ts-ignore — vanilla JS module
import { convertChatEvent } from '../fleet/fleet-data.mjs'
import { appendToken } from '../authToken'
import { buildFleetSearchFilters, parseSearchQuery, rankSearchResults } from '../fleet/search-query'
import { useIsInViewport, useVisibilityViewportId } from './useIsInViewport'
import { dropPillOnTarget } from './FleetPillShape'
import { markFleetPillActive, markFleetPillInactive, transientFleetPillProps } from './fleet-pill-transient'
import { dragCoordinator } from './dragCoordinator'
import { fleetInteractionFrame, fleetPointerEventPagePoint } from '../wm/fleet-interaction-frame'
import './fleet-chat.css'

const DEFAULT_W = 360
const DEFAULT_H = 500

function copySourceTemplate(text: string): string {
  return `<template class="code-block-copy-source">${esc(text)}</template>`
}

// --- Markdown renderer (shared with FleetChatShape) ---
const md = new MarkdownIt({ html: true, breaks: true, linkify: true })
md.renderer.rules.fence = (tokens: any[], idx: number) => {
  const token = tokens[idx]
  const lang = token.info.trim()
  const code = token.content
  const langLabel = lang ? `<span class="code-block-lang">${lang}</span>` : ''
  const escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return `<div class="code-block-wrap"><div class="code-block-header">${langLabel}<span class="code-block-copy" title="Copy">⎘</span></div>${copySourceTemplate(code)}<pre><code>${escaped}</code></pre></div>`
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


const DRAG_THRESHOLD = 4
interface DragState {
  pillId: string | null; pillType: 'agent'
  value: string; displayName: string; color: string
  startX: number; startY: number; started: boolean
}

function usePillDrag() {
  const editor = useEditor()
  const viewportId = useVisibilityViewportId()
  const frame = useMemo(() => fleetInteractionFrame(viewportId), [viewportId])
  const dragRef = useRef<DragState | null>(null)
  const releaseRef = useRef<null | (() => void)>(null)
  const cancelDrag = useCallback(() => {
    const drag = dragRef.current
    dragRef.current = null
    if (!drag?.pillId) return
    markFleetPillInactive(String(drag.pillId))
    const id = drag.pillId as TLShapeId
    editor.run(() => {
      if (editor.getShape(id)) editor.deleteShapes([id])
    }, { history: 'ignore' })
  }, [editor])

  const startDrag = useCallback((e: React.PointerEvent, value: string, displayName: string, color: string) => {
    stopEventPropagation(e)
    e.preventDefault()
    dragRef.current = { pillId: null, pillType: 'agent', value, displayName, color, startX: e.clientX, startY: e.clientY, started: false }
    releaseRef.current = dragCoordinator.claim(
      (ev: PointerEvent) => {
        const drag = dragRef.current
        if (!drag) return
        const dx = ev.clientX - drag.startX, dy = ev.clientY - drag.startY
        if (!drag.started) {
          if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return
          drag.started = true
          const pagePos = fleetPointerEventPagePoint(editor, frame, ev)
          const measureEl = document.createElement('span')
          measureEl.style.cssText = "position:absolute;visibility:hidden;font:500 9px 'SF Mono',Menlo,Consolas,monospace;white-space:nowrap;padding:1px 6px;border:1px solid transparent"
          measureEl.textContent = drag.displayName
          document.body.appendChild(measureEl)
          const pw = measureEl.offsetWidth, ph = measureEl.offsetHeight
          document.body.removeChild(measureEl)
          const pillId = createShapeId()
          editor.run(() => {
            editor.createShape({ id: pillId, type: 'fleet-pill' as any, x: pagePos.x - pw / 2, y: pagePos.y - ph / 2, props: transientFleetPillProps({ w: pw, h: ph, pillType: 'agent', value: drag.value, displayName: drag.displayName, color: drag.color }) })
          }, { history: 'ignore' })
          drag.pillId = pillId as unknown as string
          markFleetPillActive(String(pillId))
          editor.cancel()
          return
        }
        if (drag.pillId) {
          const pagePos = fleetPointerEventPagePoint(editor, frame, ev)
          const id = drag.pillId as TLShapeId
          const pillShape = editor.getShape(id) as { props?: { w?: number; h?: number } } | undefined
          const pw = pillShape?.props?.w || 70, ph = pillShape?.props?.h || 18
          const update = { id, type: 'fleet-pill', x: pagePos.x - pw / 2, y: pagePos.y - ph / 2 } as unknown as Parameters<typeof editor.updateShape>[0]
          editor.run(() => { editor.updateShape(update) }, { history: 'ignore' })
        }
      },
      (ev: PointerEvent) => {
        const drag = dragRef.current
        dragRef.current = null
        if (!drag || !drag.started || !drag.pillId) return
        markFleetPillInactive(String(drag.pillId))
        const id = drag.pillId as TLShapeId
        const pagePos = fleetPointerEventPagePoint(editor, frame, ev)
        dropPillOnTarget(editor, id, drag.value, pagePos)
        editor.run(() => {
          if (editor.getShape(id)) editor.deleteShapes([id])
        }, { history: 'ignore' })
      },
      cancelDrag,
    )
  }, [cancelDrag, editor, frame])
  useEffect(() => () => {
    releaseRef.current?.()
    releaseRef.current = null
    cancelDrag()
  }, [cancelDrag])
  return { startDrag }
}

function makeChatCtx(agents: any[], tasks: any[]) {
  const agentLabel = (id: string) => {
    if (!id) return '[unknown]'
    const a = agents.find((a: any) => a.id === id)
    if (a) return agentDisplayLabel(a)
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

const CHAT_HEADER_H = 30

function searchQueryReadout(query: string) {
  const trimmed = query.trim()
  if (!trimmed) return []
  const parsed = parseSearchQuery(trimmed)
  const filters = parsed.filters
  const chips: string[] = []
  const structured: string[] = []
  if (parsed.query) chips.push(`text:${parsed.query}`)
  if (filters.filterExpression) structured.push(filters.filterExpression)
  else {
    if (filters.from) structured.push(`from:${filters.from}`)
    if (filters.to) structured.push(`to:${filters.to}`)
    if (filters.agent) structured.push(`agent:${filters.agent}`)
  }
  if (filters.type && !structured.includes(`type:${filters.type}`)) structured.push(`type:${filters.type}`)
  if (filters.role) structured.push(`role:${filters.role}`)
  if (filters.since) structured.push(`since:${filters.since}`)
  if (filters.after) structured.push(`after:${filters.after}`)
  if (filters.before) structured.push(`before:${filters.before}`)
  if (!parsed.query && filters.naturalAgentQuery) structured.push(`agent:${filters.naturalAgentQuery}`)
  if (structured.length > 0) chips.push(`filters:${structured.join(' ')}`)
  return chips
}

export class FleetSearchShapeUtil extends BaseBoxShapeUtil<any> {
  static override type = 'fleet-search' as const
  static override props = fleetSearchProps

  getDefaultProps() {
    return { w: DEFAULT_W, h: DEFAULT_H, userId: '', deviceId: '' }
  }

  override canEdit = () => true
  override canResize = () => true
  override canSnap = () => true
  override canBind = () => false
  override hideRotateHandle = () => true
  override onTranslateStart = () => beginNativeSnapDrag(this.editor)
  override onTranslateEnd = () => endNativeSnapDrag(this.editor)
  override onTranslateCancel = () => endNativeSnapDrag(this.editor)

  component(shape: any) {
    return <FleetSearchComponent shape={shape} />
  }

  getIndicatorPath() {
    return undefined
  }

  indicator() {
    return null
  }
}




function FleetSearchInner({ shape }: { shape: any }) {
  const editor = useEditor()
  const { w, h } = shape.props
  void useValue('editing', () => editor.getEditingShapeId() === shape.id, [editor, shape.id])
  const containerRef = useRef<HTMLDivElement>(null)
  const isSelectedRef = useRef(false)
  isSelectedRef.current = useValue('isSelected', () => editor.getSelectedShapeIds().includes(shape.id), [editor, shape.id])

  // Capture-phase pointerdown: fires before tldraw's tl-container listener
  // can intercept. Marks clicks as handled so tldraw skips setPointerCapture.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    function onPointerDown(e: PointerEvent) {
      const target = e.target as HTMLElement
      if (!el!.contains(target)) return
      if (isSelectedRef.current) return
      editor.markEventAsHandled(e)
    }

    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [editor])

  const agents = useFleetAgents()
  const tasks = useFleetTasks()
  const ctx = useMemo(() => makeChatCtx(agents, tasks), [agents, tasks])
  const { startDrag } = usePillDrag()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<any[]>([])
  const [docResults, setDocResults] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [searched, setSearched] = useState(false)
  const [queryError, setQueryError] = useState<string | null>(null)
  // When ↗ is clicked, a real fleet-chat shape is created on top of us
  const [chatShapeId, setChatShapeId] = useState<string | null>(null)

  // If the chat shape was deleted externally, clear our state
  const chatShapeExists = useValue('chatShapeExists', () => {
    if (!chatShapeId) return false
    return !!editor.getShape(chatShapeId as any)
  }, [editor, chatShapeId])
  useEffect(() => {
    if (chatShapeId && !chatShapeExists) setChatShapeId(null)
  }, [chatShapeId, chatShapeExists])
  const inputRef = useRef<HTMLInputElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const agentFilterName = useCallback((id: string) => {
    if (!id) return 'unknown'
    const a = agents.find((a: any) => a.id === id)
    if (a) return a.friendly_name || (a.id || '').replace('fleet:', '')
    return id.replace('fleet:', '')
  }, [agents])
  const agentName = useCallback((id: string) => {
    if (!id) return 'unknown'
    const a = agents.find((a: any) => a.id === id)
    if (a) return agentDisplayLabel(a)
    return id.replace('fleet:', '')
  }, [agents])

  const closeChat = useCallback(() => {
    if (chatShapeId) {
      try { editor.run(() => { editor.deleteShapes([chatShapeId as any]) }, { history: 'ignore' }) } catch {}
    }
    setChatShapeId(null)
  }, [editor, chatShapeId])

  const doSearch = useCallback(async (q: string) => {
    if (!q.trim()) {
      setResults([])
      setDocResults([])
      setSearched(false)
      setLoading(false)
      setQueryError(null)
      closeChat()
      return
    }

    let parsed: ReturnType<typeof parseSearchQuery>
    try {
      parsed = parseSearchQuery(q)
    } catch (e) {
      setResults([])
      setDocResults([])
      setSearched(false)
      setLoading(false)
      setQueryError((e as Error).message || 'Invalid search query')
      closeChat()
      return
    }
    const { query: ftsQuery, filters } = parsed
    setQueryError(null)

    // Need at least a query or a filter
    if (!ftsQuery && !filters.from && !filters.to && !filters.agent && !filters.filterExpression) {
      setResults([])
      setDocResults([])
      setSearched(false)
      setLoading(false)
      return
    }

    setLoading(true)
    setSearched(true)
    closeChat()

    try {
      const serverFilters = buildFleetSearchFilters(filters)
      const [res, allDocs] = await Promise.all([
        searchFleet(ftsQuery || '', 100, serverFilters),
        fetchSharedDocs(),
      ])

      setResults(rankSearchResults(res, ftsQuery).slice(0, 50))

      // Filter shared docs by title match (only if there's an FTS query)
      if (ftsQuery) {
        const ql = ftsQuery.toLowerCase()
        setDocResults(allDocs.filter(d => d.title?.toLowerCase().includes(ql) || d.doc?.toLowerCase().includes(ql)))
      } else {
        setDocResults([])
      }
    } finally {
      setLoading(false)
    }
  }, [closeChat])

  // Create a real fleet-chat shape on top of this search shape, filtered to the result's agent
  const openChatForResult = useCallback(async (result: any) => {
    const filter = fleetSearchResultAgentChatFilter(result, { agents }) as [string, string][][]
    if (!filter.length) return
    const rec = editor.getShape(shape.id) as any
    if (!rec) return
    const newId = await createFleetShape(editor, 'fleet-chat', rec.x, rec.y + CHAT_HEADER_H, {
      w: rec.props.w,
      h: rec.props.h - CHAT_HEADER_H,
      filter,
    })
    if (!newId) return
    editor.bringToFront([newId as any])
    setChatShapeId(newId)
  }, [agents, editor, shape.id])

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
      if (chatShapeId) {
        closeChat()
      } else {
        editor.setEditingShape(null)
      }
    }
  }, [doSearch, query, editor, chatShapeId, closeChat])

  // Parse current filters for display
  const activeFilters = useMemo<Record<string, any>>(() => {
    try {
      return parseSearchQuery(query).filters
    } catch {
      return {}
    }
  }, [query])
  const queryReadout = useMemo<string[]>(() => {
    try {
      return searchQueryReadout(query)
    } catch {
      return []
    }
  }, [query])

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
        ref={containerRef}
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
        {/* Chat-open mode: show only the back button bar — fleet-chat shape sits below */}
        {chatShapeId ? (
          <div
            style={{
              height: CHAT_HEADER_H,
              display: 'flex',
              alignItems: 'center',
              borderBottom: '1px solid rgba(128, 128, 128, 0.12)',
              flexShrink: 0,
            }}
            onPointerDown={(e) => stopEventPropagation(e)}
          >
            <button
              className="fleet-search-chat-back"
              onPointerUp={(e) => { stopEventPropagation(e); closeChat() }}
            >
              ← back to results
            </button>
          </div>
        ) : <>

        <FleetPanelButtonGroup editor={editor} shape={shape} />

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
            placeholder="Search... (agent:(skip | guidance) from:me)"
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
          {queryReadout.length > 0 && (
            <div className="fleet-search-query-readout" aria-label="Parsed search query">
              {queryReadout.map((chip, i) => <span key={`${chip}-${i}`} className="fleet-search-query-chip">{chip}</span>)}
            </div>
          )}
          {/* Active filter indicators */}
          {(activeFilters.from || activeFilters.to || activeFilters.agent || activeFilters.before || activeFilters.after || activeFilters.since || activeFilters.type) && (
            <div style={{ display: 'flex', gap: 4, marginTop: 3, flexWrap: 'wrap' }}>
              {activeFilters.from && <span className="fleet-search-filter-tag">from:{activeFilters.from}</span>}
              {activeFilters.to && <span className="fleet-search-filter-tag">to:{activeFilters.to}</span>}
              {activeFilters.agent && <span className="fleet-search-filter-tag">agent:{activeFilters.agent}</span>}
              {activeFilters.type && <span className="fleet-search-filter-tag">type:{activeFilters.type}</span>}
              {activeFilters.before && <span className="fleet-search-filter-tag">before:{activeFilters.before}</span>}
              {activeFilters.after && <span className="fleet-search-filter-tag">after:{activeFilters.after}</span>}
              {activeFilters.since && <span className="fleet-search-filter-tag">since:{activeFilters.since}</span>}
            </div>
          )}
        </div>

        {/* Results */}
        {(
        <div
          className="fleet-search-results fleet-chat-shape"
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
          {!loading && queryError && (
            <div style={{ padding: '12px 10px', opacity: 0.55, textAlign: 'center', fontSize: 10, color: 'var(--color-accent, #c8956a)' }}>
              {queryError}
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
          {results.map((r: any, i: number) => {
            // text comes from new server; fall back to snippet for old server
            const text = r.text ?? r.snippet ?? ''
            // Build a proper event object for renderChatLine
            const rawEvent = r.source === 'session'
              ? { type: r.role === 'user' ? 'terminal_user' : 'terminal_assistant', from: r.agentId, to: null, text, timestamp: r.timestamp, id: r.id }
              : { ...r, text, id: r.id }
            const msgObj = convertChatEvent(rawEvent)
            const lineHtml = renderChatLine(msgObj, ctx)
            if (!lineHtml) return null
            return (
              <div
                key={i}
                className="fleet-search-result"
                onPointerDown={(e) => {
                  stopEventPropagation(e)
                  // Delegate nick drags to startDrag
                  const nick = (e.target as HTMLElement).closest('[data-agent-id]') as HTMLElement | null
                  if (nick) {
                    const agentId = nick.dataset.agentId || ''
                    const value = agentFilterName(agentId)
                    const name = agentName(agentId)
                    const color = ctx.getAgentColor(agentId)
                    startDrag(e, value, name, color)
                  }
                }}
              >
                <div dangerouslySetInnerHTML={{ __html: lineHtml }} />
                <span
                  className="search-result-open"
                  onPointerUp={(e) => { e.stopPropagation(); openChatForResult(r) }}
                  title="Open in chat"
                >↗</span>
              </div>
            )
          })}
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

        </>}
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
