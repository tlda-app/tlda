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
  type Editor,
  type TLShapeId,
} from 'tldraw'
import * as autocompleteCore from '@algolia/autocomplete-core'
import { beginFleetDragWithoutSnap, createFleetShape, agentDisplayLabel, endFleetDragWithoutSnap } from './fleet-utils'
import { FleetPanelButtonGroup } from './FleetPanelChrome'
import { fleetSearchProps } from '../../shared/shapes/fleet-panel-schema.mjs'
import { useState, useCallback, useRef, useMemo, useEffect, memo } from 'react'
import { flushSync } from 'react-dom'
import { searchFleet, useFleetAgents, useFleetProjects, useFleetTasks } from '../fleet-data-adapter'
import { fleetSearchResultAgentChatFilter, fleetSearchResultParticipantLabel } from '../../shared/filter-semantics.mjs'
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
import { buildFleetSearchFilters, groupFleetSearchResults, parseSearchQuery, rankSearchResults, type FleetSearchResultGroup } from '../fleet/search-query'
import {
  SEARCH_AUTOCOMPLETE_INITIAL_VIEW_STATE,
  applySearchAutocompleteSuggestion,
  activeSearchAutocompleteToken,
  searchAutocompleteViewState,
  searchAutocompleteSuggestions,
  type SearchAutocompleteSuggestion,
} from '../fleet/search-autocomplete'
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
type SearchPillType = 'agent' | 'msg'
interface DragState {
  pillId: string | null; pillType: SearchPillType
  value: string; displayName: string; color: string
  content?: string
  startX: number; startY: number; started: boolean
  onTap?: (e: PointerEvent) => void
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

  const startDrag = useCallback((
    e: React.PointerEvent,
    pillType: SearchPillType,
    value: string,
    displayName: string,
    color: string,
    content?: string,
    onTap?: (e: PointerEvent) => void,
  ) => {
    stopEventPropagation(e)
    e.preventDefault()
    dragRef.current = { pillId: null, pillType, value, displayName, color, content, startX: e.clientX, startY: e.clientY, started: false, onTap }
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
            editor.createShape({
              id: pillId,
              type: 'fleet-pill',
              x: pagePos.x - pw / 2,
              y: pagePos.y - ph / 2,
              props: transientFleetPillProps({ w: pw, h: ph, pillType: drag.pillType, value: drag.value, displayName: drag.displayName, color: drag.color }),
            } as unknown as Parameters<Editor['createShape']>[0])
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
        releaseRef.current = null
        if (!drag) return
        if (!drag.started || !drag.pillId) {
          drag.onTap?.(ev)
          return
        }
        markFleetPillInactive(String(drag.pillId))
        const id = drag.pillId as TLShapeId
        const pagePos = fleetPointerEventPagePoint(editor, frame, ev)
        dropPillOnTarget(editor, id, drag.value, pagePos, drag.content)
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

function searchResultMessageDrag(result: any, text: string, ctx: ReturnType<typeof makeChatCtx>, agents: any[]) {
  const fromId = result.from || result.agentId || result.agent || ''
  const label = fleetSearchResultParticipantLabel(result, fromId, { agents }) || ctx.agentLabel(fromId)
  const ts = result.timestamp || ''
  const time = ts ? new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''
  const id = result.source === 'session'
    ? (result.id ? `session:${result.id}` : `session:${fromId}:${ts}`)
    : (result.id ? `msg:${result.id}` : `msg:${fromId}:${ts}`)
  // The pill's identity is `id`; this is the prose a person reads once the pill
  // lands in the composer, so it gets the reader's own clock rather than the
  // raw UTC stamp the API returned.
  const stamped = ts ? new Date(ts) : null
  const readableTs = stamped && !Number.isNaN(stamped.getTime()) ? stamped.toLocaleString() : ts
  const content = [
    ts ? `[${readableTs}]` : '',
    label ? `${label}:` : '',
    text,
  ].filter(Boolean).join(' ')
  return {
    value: id,
    displayName: `${label} ${time} search`.trim(),
    color: '#8888a0',
    content,
  }
}

function renderProjectAgentSearchLine(result: any, ctx: ReturnType<typeof makeChatCtx>, agents: any[]) {
  const agentId = result.agentId || result.agent_id || result.from || ''
  const label = fleetSearchResultParticipantLabel(result, agentId, { agents }) || ctx.agentLabel(agentId)
  const cls = ctx.getNickClass(agentId)
  const latest = result.latest_activity || {}
  const ts = result.latest_relevant_at || result.timestamp || ''
  const latestType = latest.type || result.type || 'activity'
  const summary = latest.summary || result.snippet || result.text || result.cwd || ''
  const body = summary ? searchRenderMarkdown(esc(summary)) : esc(result.cwd || '')
  return `<div class="chat-line" data-msg-ts="${esc(ts)}" data-msg-from="${esc(agentId)}">
    <span class="chat-ts" draggable="true">${timeShort(ts)}</span>
    <span class="chat-nick"><span class="agent-nick ${cls}" data-agent-id="${esc(agentId)}">${esc(label)}:</span></span>
    <span class="pretty-search-source">${esc(latestType)}</span>
    <span class="pretty-search-snippet">${body}</span>
  </div>`
}

function renderDocumentContentSearchLine(result: any) {
  const project = result.project || result.doc || ''
  const title = result.title || project || 'document'
  const where = [
    project,
    result.page ? `page ${result.page}` : '',
    result.label && result.label !== result.file ? result.label : '',
    result.file || '',
  ].filter(Boolean).join(' · ')
  const snippet = result.snippet || result.text || ''
  return `<div class="chat-line fleet-search-document-line">
    <span class="pretty-search-source">doc</span>
    <span class="pretty-search-snippet">
      <span class="fleet-search-document-title">${esc(title)}</span>
      ${where ? `<span class="fleet-search-document-where">${esc(where)}</span>` : ''}
      ${snippet ? `<span class="fleet-search-document-snippet">${searchRenderMarkdown(esc(snippet))}</span>` : ''}
    </span>
  </div>`
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
const SEARCH_GROUP_INITIAL_LIMIT = 6

function searchQueryReadout(query: string) {
  const trimmed = query.trim()
  if (!trimmed) return []
  const parsed = parseSearchQuery(trimmed)
  const filters = parsed.filters
  const chips: string[] = []
  const structured: string[] = []
  if (parsed.query) chips.push(`text:${displayImplicitAnd(parsed.query)}`)
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

function displayImplicitAnd(query: string) {
  const tokens = query.trim().match(/<>|[()&|!]|[^\s()&|!]+/g) || []
  const display: string[] = []
  for (const token of tokens) {
    const prev = display[display.length - 1]
    if (needsImplicitAnd(prev, token)) display.push('&')
    display.push(token)
  }
  return display.join(' ')
}

function needsImplicitAnd(prev: string | undefined, next: string) {
  if (!prev) return false
  const prevEndsOperand = prev !== '&' && prev !== '|' && prev !== '!' && prev !== '('
  const nextStartsOperand = next !== '&' && next !== '|' && next !== ')' && next !== '<>'
  return prevEndsOperand && nextStartsOperand
}

export class FleetSearchShapeUtil extends BaseBoxShapeUtil<any> {
  static override type = 'fleet-search' as const
  static override props = fleetSearchProps

  getDefaultProps() {
    return { w: DEFAULT_W, h: DEFAULT_H, userId: '', deviceId: '' }
  }

  override canEdit = () => true
  override canResize = () => true
  override onTranslateStart = () => beginFleetDragWithoutSnap(this.editor)
  override onTranslateEnd = () => endFleetDragWithoutSnap(this.editor)
  override onTranslateCancel = () => endFleetDragWithoutSnap(this.editor)
  override canSnap = () => true
  override canBind = () => false
  override hideRotateHandle = () => true

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
  const projects = useFleetProjects()
  const tasks = useFleetTasks()
  const ctx = useMemo(() => makeChatCtx(agents, tasks), [agents, tasks])
  const { startDrag } = usePillDrag()
  const [query, setQuery] = useState('')
  const [autocomplete, setAutocomplete] = useState(SEARCH_AUTOCOMPLETE_INITIAL_VIEW_STATE)
  const autocompleteRef = useRef(autocomplete)
  const autocompleteApiRef = useRef<ReturnType<typeof autocompleteCore.createAutocomplete<SearchAutocompleteSuggestion, React.SyntheticEvent, React.MouseEvent, React.KeyboardEvent>> | null>(null)
  const [results, setResults] = useState<any[]>([])
  const [expandedSearchGroups, setExpandedSearchGroups] = useState<Record<string, boolean>>({})
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
  const restoringAcceptedSuggestionRef = useRef(false)
  const autocompleteId = useMemo(() => `fleet-search-autocomplete-${String(shape.id).replace(/[^A-Za-z0-9_-]/g, '_')}`, [shape.id])
  const currentProject = typeof window !== 'undefined'
    ? new URLSearchParams(window.location.search).get('project') || undefined
    : undefined
  const autocompleteContext = useMemo(() => ({ agents, projects, currentProject }), [agents, projects, currentProject])
  useEffect(() => {
    autocompleteRef.current = autocomplete
  }, [autocomplete])

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
      try {
        editor.run(() => { editor.deleteShapes([chatShapeId as TLShapeId]) }, { history: 'ignore' })
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        setQueryError(`Could not close chat panel: ${message}`)
        return
      }
    }
    setQueryError(null)
    setChatShapeId(null)
  }, [editor, chatShapeId])

  const doSearch = useCallback(async (q: string) => {
    if (!q.trim()) {
      setResults([])
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
      setSearched(false)
      setLoading(false)
      setQueryError((e as Error).message || 'Invalid search query')
      closeChat()
      return
    }
    const { query: ftsQuery, filters } = parsed
    setQueryError(null)

    const serverFilters = buildFleetSearchFilters(filters)
    const hasSearchInput = !!ftsQuery || Object.keys(serverFilters).some(key => key !== 'currentProject')
    if (!hasSearchInput) {
      setResults([])
      setSearched(false)
      setLoading(false)
      return
    }

    setLoading(true)
    setSearched(true)
    closeChat()

    try {
      const currentProject = new URLSearchParams(window.location.search).get('project') || undefined
      const res = await searchFleet(ftsQuery || '', 100, { ...serverFilters, currentProject, historyOnly: !ftsQuery })
      setResults(rankSearchResults(res, ftsQuery))
      setExpandedSearchGroups({})
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

  const acceptAutocompleteSuggestion = useCallback((suggestion?: SearchAutocompleteSuggestion) => {
    const current = autocompleteRef.current
    const selected = suggestion || current.suggestions[current.highlightedIndex]
    if (!selected || current.status !== 'open') return false
    const applied = applySearchAutocompleteSuggestion(query, current.token, selected)
    setQuery(applied.query)
    const closed = { ...current, status: 'closed' as const, suggestions: [], highlightedIndex: -1 }
    autocompleteRef.current = closed
    autocompleteApiRef.current?.setIsOpen(false)
    autocompleteApiRef.current?.setQuery(applied.query)
    setAutocomplete(closed)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => doSearch(applied.query), 300)
    restoringAcceptedSuggestionRef.current = true
    requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.setSelectionRange(applied.cursor, applied.cursor)
      window.setTimeout(() => { restoringAcceptedSuggestionRef.current = false }, 0)
    })
    return true
  }, [doSearch, query])

  useEffect(() => {
    const input = inputRef.current
    if (!input) return
    const onKeyDown = (e: KeyboardEvent) => {
      const current = autocompleteRef.current
      if (current.status !== 'open') return
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const len = current.suggestions.length
        if (len === 0) return
        e.preventDefault()
        e.stopPropagation()
        e.stopImmediatePropagation()
        const next = e.key === 'ArrowDown'
          ? (current.highlightedIndex < 0 ? 0 : (current.highlightedIndex + 1) % len)
          : ((current.highlightedIndex < 0 ? 0 : current.highlightedIndex) - 1 + len) % len
        const nextState = { ...current, highlightedIndex: next }
        autocompleteRef.current = nextState
        flushSync(() => setAutocomplete(nextState))
        return
      }
      if (e.key === 'Tab' || e.key === 'Enter') {
        if (current.highlightedIndex < 0) return
        e.preventDefault()
        e.stopPropagation()
        e.stopImmediatePropagation()
        acceptAutocompleteSuggestion()
      }
    }
    input.addEventListener('keydown', onKeyDown, true)
    return () => input.removeEventListener('keydown', onKeyDown, true)
  }, [acceptAutocompleteSuggestion])

  const handleAutocompleteKeyDownCapture = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    const current = autocompleteRef.current
    if (current.status !== 'open') return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const len = current.suggestions.length
      if (len === 0) return
      e.preventDefault()
      e.stopPropagation()
      e.nativeEvent.stopImmediatePropagation()
      const next = e.key === 'ArrowDown'
        ? (current.highlightedIndex < 0 ? 0 : (current.highlightedIndex + 1) % len)
        : ((current.highlightedIndex < 0 ? 0 : current.highlightedIndex) - 1 + len) % len
      const nextState = { ...current, highlightedIndex: next }
      autocompleteRef.current = nextState
      flushSync(() => setAutocomplete(nextState))
      return
    }
    if (e.key === 'Tab' || e.key === 'Enter') {
      if (current.highlightedIndex < 0) return
      e.preventDefault()
      e.stopPropagation()
      e.nativeEvent.stopImmediatePropagation()
      acceptAutocompleteSuggestion()
    }
  }, [acceptAutocompleteSuggestion])

  const autocompleteApi = useMemo(() => autocompleteCore.createAutocomplete<SearchAutocompleteSuggestion, React.SyntheticEvent, React.MouseEvent, React.KeyboardEvent>({
    id: autocompleteId,
    defaultActiveItemId: 0,
    openOnFocus: true,
    shouldPanelOpen: ({ state }) => state.collections.some((collection) => collection.items.length > 0),
    onStateChange: ({ state }) => {
      const cursor = inputRef.current?.selectionStart ?? state.query.length
      const next = searchAutocompleteViewState(state, cursor)
      autocompleteRef.current = next
      setAutocomplete(next)
    },
    getSources({ query: currentQuery }) {
      const cursor = inputRef.current?.selectionStart ?? currentQuery.length
      return [
        {
          sourceId: 'fleet-search-suggestions',
          getItems() {
            return searchAutocompleteSuggestions(currentQuery, cursor, autocompleteContext)
          },
          getItemInputValue({ item }) {
            const token = activeSearchAutocompleteToken(currentQuery, cursor)
            return applySearchAutocompleteSuggestion(currentQuery, token, item).query
          },
          onSelect({ item }) {
            acceptAutocompleteSuggestion(item)
          },
        },
      ]
    },
  }), [acceptAutocompleteSuggestion, autocompleteContext, autocompleteId])
  autocompleteApiRef.current = autocompleteApi

  const syncAutocompleteInput = useCallback((value: string, cursor: number, open = true) => {
    if (restoringAcceptedSuggestionRef.current) return
    autocompleteApi.setQuery(value)
    autocompleteApi.setIsOpen(open)
    void autocompleteApi.refresh().then(() => {
      const latestCursor = inputRef.current?.selectionStart ?? cursor
      setAutocomplete((prev) => ({
        ...prev,
        query: value,
        cursor: latestCursor,
      }))
    })
  }, [autocompleteApi])

  const handleInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value
    const cursor = e.target.selectionStart ?? val.length
    setQuery(val)
    syncAutocompleteInput(val, cursor)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => doSearch(val), 300)
  }, [doSearch, syncAutocompleteInput])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    e.stopPropagation()
    ;(e.nativeEvent as any).stopImmediatePropagation?.()
    const currentAutocomplete = autocompleteRef.current
    if (currentAutocomplete.status === 'open') {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        const current = autocompleteRef.current
        const len = current.suggestions.length
        if (len > 0) {
          const next = current.highlightedIndex < 0 ? 0 : (current.highlightedIndex + 1) % len
          setAutocomplete((prev) => ({ ...prev, highlightedIndex: next }))
        }
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        const current = autocompleteRef.current
        const len = current.suggestions.length
        if (len > 0) {
          const active = current.highlightedIndex < 0 ? 0 : current.highlightedIndex
          const next = (active - 1 + len) % len
          setAutocomplete((prev) => ({ ...prev, highlightedIndex: next }))
        }
        return
      }
      if (e.key === 'Tab') {
        e.preventDefault()
        acceptAutocompleteSuggestion()
        return
      }
      if (e.key === 'Enter' && currentAutocomplete.highlightedIndex >= 0) {
        e.preventDefault()
        acceptAutocompleteSuggestion()
        return
      }
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      if (debounceRef.current) clearTimeout(debounceRef.current)
      doSearch(query)
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      if (autocomplete.status === 'open') {
        autocompleteApi.setIsOpen(false)
        const closed = { ...autocompleteRef.current, status: 'closed' as const, suggestions: [], highlightedIndex: -1 }
        autocompleteRef.current = closed
        setAutocomplete(closed)
      } else if (chatShapeId) {
        closeChat()
      } else {
        editor.setEditingShape(null)
      }
    }
  }, [acceptAutocompleteSuggestion, autocomplete.status, autocompleteApi, doSearch, query, editor, chatShapeId, closeChat])

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
  const resultGroups = useMemo<FleetSearchResultGroup[]>(() => groupFleetSearchResults(results), [results])
  const visibleResultCount = useMemo(() => resultGroups.reduce((total, group) => {
    if (expandedSearchGroups[group.id]) return total + group.results.length
    return total + Math.min(group.results.length, SEARCH_GROUP_INITIAL_LIMIT)
  }, 0), [expandedSearchGroups, resultGroups])
  const renderResult = useCallback((r: any, i: number, groupId: string) => {
    // text comes from new server; fall back to snippet for old server
    const text = r.text ?? r.snippet ?? ''
    // Build a proper event object for renderChatLine
    const rawEvent = r.source === 'session'
      ? { type: r.role === 'user' ? 'terminal_user' : 'terminal_assistant', from: r.agentId, to: null, text, timestamp: r.timestamp, id: r.id }
      : { ...r, text, id: r.id }
    const lineHtml = r.type === 'project_agent'
      ? renderProjectAgentSearchLine(r, ctx, agents)
      : r.type === 'document_content'
        ? renderDocumentContentSearchLine(r)
        : renderChatLine(convertChatEvent(rawEvent), ctx)
    if (!lineHtml) return null
    const openDocument = r.type === 'document_content'
      ? () => window.open(appendToken(`${window.location.origin}/?project=${encodeURIComponent(r.project || r.doc)}`), '_blank')
      : null
    return (
      <div
        key={`${groupId}-${r.source || 'result'}-${r.type || r.role || 'row'}-${r.id || i}`}
        className={`fleet-search-result fleet-search-result-${groupId}`}
        title={r.type === 'document_content' ? 'Open document' : undefined}
        onPointerDown={(e) => {
          stopEventPropagation(e)
          if (openDocument) return
          // Delegate nick drags to startDrag
          const nick = (e.target as HTMLElement).closest('[data-agent-id]') as HTMLElement | null
          if (nick) {
            const agentId = nick.dataset.agentId || ''
            const historicalName = fleetSearchResultParticipantLabel(r, agentId, { agents })
            const value = historicalName || agentFilterName(agentId)
            const name = historicalName || agentName(agentId)
            const color = ctx.getAgentColor(agentId)
            startDrag(e, 'agent', value, name, color)
            return
          }
          const tsEl = (e.target as HTMLElement).closest('.chat-ts, .pretty-search-ts, .pretty-ts') as HTMLElement | null
          if (tsEl) {
            const drag = searchResultMessageDrag(r, text, ctx, agents)
            startDrag(e, 'msg', drag.value, drag.displayName, drag.color, drag.content)
          }
        }}
        onPointerUp={(e) => {
          if (!openDocument) return
          stopEventPropagation(e)
          openDocument()
        }}
      >
        <div dangerouslySetInnerHTML={{ __html: lineHtml }} />
        {r.type !== 'document_content' && (
          <span
            className="search-result-open"
            onPointerUp={(e) => { e.stopPropagation(); openChatForResult(r) }}
            title="Open in chat"
          >↗</span>
        )}
      </div>
    )
  }, [agentFilterName, agentName, agents, ctx, openChatForResult, startDrag])

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
            position: 'relative',
          }}
        >
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={autocomplete.status === 'open'}
            aria-controls={autocompleteId}
            aria-activedescendant={autocomplete.status === 'open' && autocomplete.highlightedIndex >= 0 ? `${autocompleteId}-${autocomplete.highlightedIndex}` : undefined}
            placeholder="Search... (agent:(skip | guidance) from:me)"
            value={query}
            onChange={handleInput}
            onKeyDownCapture={handleAutocompleteKeyDownCapture}
            onKeyDown={handleKeyDown}
            onClick={(e) => syncAutocompleteInput(query, e.currentTarget.selectionStart ?? query.length)}
            onSelect={(e) => syncAutocompleteInput(query, e.currentTarget.selectionStart ?? query.length)}
            onPointerDown={(e) => { stopEventPropagation(e) }}
            onFocus={(e) => { stopEventPropagation(e); syncAutocompleteInput(query, e.currentTarget.selectionStart ?? query.length) }}
            onBlur={() => {
              window.setTimeout(() => {
                const closed = { ...autocompleteRef.current, status: 'closed' as const, suggestions: [], highlightedIndex: -1 }
                autocompleteRef.current = closed
                setAutocomplete(closed)
              }, 120)
            }}
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
          {autocomplete.status === 'open' && (
            <div
              id={autocompleteId}
              className="fleet-search-autocomplete"
              role="listbox"
              onPointerDown={(e) => stopEventPropagation(e)}
            >
              {autocomplete.suggestions.map((suggestion, index) => (
                <div
                  key={suggestion.id}
                  id={`${autocompleteId}-${index}`}
                  className={`fleet-search-autocomplete-option${index === autocomplete.highlightedIndex ? ' active' : ''}`}
                  role="option"
                  aria-selected={index === autocomplete.highlightedIndex}
                  onPointerEnter={() => {
                    const next = { ...autocompleteRef.current, highlightedIndex: index }
                    autocompleteRef.current = next
                    setAutocomplete(next)
                  }}
                  onPointerDown={(e) => {
                    stopEventPropagation(e)
                    e.preventDefault()
                    acceptAutocompleteSuggestion(suggestion)
                  }}
                >
                  <span className="fleet-search-autocomplete-label">{suggestion.label}</span>
                  {suggestion.detail && <span className="fleet-search-autocomplete-detail">{suggestion.detail}</span>}
                </div>
              ))}
            </div>
          )}
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
          {!loading && searched && results.length === 0 && (
            <div style={{ padding: '12px 10px', opacity: 0.3, textAlign: 'center', fontSize: 10 }}>
              no results
            </div>
          )}
          {results.length > 0 && (
            <div className="fleet-search-results-summary">
              {results.length} ranked result{results.length !== 1 ? 's' : ''} across {resultGroups.length} type{resultGroups.length !== 1 ? 's' : ''}
            </div>
          )}
          {!loading && !searched && (
            <div style={{ padding: '20px 10px', opacity: 0.4, textAlign: 'center', fontSize: 10 }}>
              type to search fleet history
            </div>
          )}
          {resultGroups.map((group) => {
            const expanded = !!expandedSearchGroups[group.id]
            const visible = expanded ? group.results : group.results.slice(0, SEARCH_GROUP_INITIAL_LIMIT)
            const hidden = group.results.length - visible.length
            return (
              <section key={group.id} className={`fleet-search-result-group fleet-search-result-group-${group.id}`}>
                <div className="fleet-search-section-header">
                  <span className="fleet-search-section-label">{group.label}</span>
                  <span className="fleet-search-section-count">{group.results.length}</span>
                  <span className="fleet-search-section-detail">{group.detail}</span>
                </div>
                {visible.map((r: any, i: number) => renderResult(r, i, group.id))}
                {hidden > 0 && (
                  <button
                    type="button"
                    className="fleet-search-group-more"
                    onPointerDown={(e) => stopEventPropagation(e)}
                    onPointerUp={(e) => {
                      stopEventPropagation(e)
                      setExpandedSearchGroups(prev => ({ ...prev, [group.id]: true }))
                    }}
                  >
                    Show {hidden} more {group.label.toLowerCase()}
                  </button>
                )}
              </section>
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
          {searched ? `${visibleResultCount}/${results.length} visible${results.some(r => r.type === 'document_content') ? ` · ${results.filter(r => r.type === 'document_content').length} doc${results.filter(r => r.type === 'document_content').length !== 1 ? 's' : ''}` : ''}` : ''}
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
