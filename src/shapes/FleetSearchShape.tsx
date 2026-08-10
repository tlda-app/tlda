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
import { createFleetShape, agentDisplayLabel } from './fleet-utils'
import { FleetPanelButtonGroup } from './FleetPanelChrome'
import { fleetSearchProps } from '../../shared/shapes/fleet-panel-schema.mjs'
import { useState, useCallback, useRef, useMemo, useEffect, memo } from 'react'
import { createPortal, flushSync } from 'react-dom'
import { searchFleet, useFleetAgents, useFleetProjects, useFleetTasks } from '../fleet-data-adapter'
import { fleetSearchResultAgentChatFilter } from '../../shared/filter-semantics.mjs'
import katex from 'katex'
import { getActiveMacros } from '../katexMacros'
import MarkdownIt from 'markdown-it'
// @ts-ignore — vanilla JS module
import { esc } from '../fleet/chat-render.mjs'
// @ts-ignore — vanilla JS module
import { highlightSyntax, langFromFilePath } from '../fleet/utils.mjs'
import { buildFleetSearchFilters, groupFleetSearchResults, parseSearchQuery, rankSearchResults } from '../fleet/search-query'
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
import { deleteFleetPill } from './fleet-pill-forensics'
import { markFleetPillActive, markFleetPillInactive, transientFleetPillProps } from './fleet-pill-transient'
import { dragCoordinator } from './dragCoordinator'
import { fleetInteractionFrame, fleetPointerEventPagePoint } from '../wm/fleet-interaction-frame'
import { FleetSearchResultsView, visibleFleetSearchResultCount } from './FleetSearchResultsView'
import './fleet-chat.css'

const DEFAULT_W = 360
const DEFAULT_H = 500
const SEARCH_AUTOCOMPLETE_GAP = 4

type SearchAutocompleteAnchor = {
  left: number
  bottom: number
  width: number
}

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
    const id = drag.pillId as TLShapeId
    // Delete (and so record) before clearing ACTIVE — see fleet-pill-forensics.
    editor.run(() => {
      deleteFleetPill(editor, id, 'drag-cancel', { surface: 'search' })
    }, { history: 'ignore' })
    markFleetPillInactive(String(drag.pillId))
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
          deleteFleetPill(editor, id, 'drag-drop', { surface: 'search' })
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
type ReadoutSegment = { text: string; implied: boolean }

function searchQueryReadout(query: string): ReadoutSegment[][] {
  const trimmed = query.trim()
  if (!trimmed) return []
  const parsed = parseSearchQuery(trimmed, { autoConjoin: true })
  const filters = parsed.filters
  const chips: ReadoutSegment[][] = []
  const structured: string[] = []
  // The expression as it parsed, with the conjunctions the editor supplied
  // marked so they can be shown ghosted. This is the query saying how it read
  // itself — the cheapest possible parse error is a ghost where you did not
  // expect one.
  const implied = (parsed.explicitSegments as ReadoutSegment[]).some(s => s.implied)
  if (implied) chips.push([{ text: 'query:', implied: false }, ...(parsed.explicitSegments as ReadoutSegment[])])
  if (parsed.query) chips.push([{ text: `text:${displayImplicitAnd(parsed.query)}`, implied: false }])
  if (filters.filterExpression) structured.push(filters.filterExpression)
  else {
    if (filters.from) structured.push(`from:${filters.from}`)
    if (filters.to) structured.push(`to:${filters.to}`)
    if (filters.agent) structured.push(`agent:${filters.agent}`)
  }
  if (filters.type && !structured.includes(`type:${filters.type}`)) structured.push(`type:${filters.type}`)
  if (filters.role) structured.push(`role:${filters.role}`)
  if (!parsed.query && filters.naturalAgentQuery) structured.push(`agent:${filters.naturalAgentQuery}`)
  if (structured.length > 0) chips.push([{ text: `filters:${structured.join(' ')}`, implied: false }])
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
  const [autocompleteAnchor, setAutocompleteAnchor] = useState<SearchAutocompleteAnchor | null>(null)
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

  useEffect(() => {
    if (autocomplete.status !== 'open') {
      setAutocompleteAnchor(null)
      return
    }
    let raf = 0
    const update = () => {
      const input = inputRef.current
      if (!input) {
        setAutocompleteAnchor(null)
        return
      }
      const rect = input.getBoundingClientRect()
      const next = {
        left: Math.round(rect.left),
        bottom: Math.round(window.innerHeight - rect.top + SEARCH_AUTOCOMPLETE_GAP),
        width: Math.round(rect.width),
      }
      setAutocompleteAnchor(prev => (
        prev && prev.left === next.left && prev.bottom === next.bottom && prev.width === next.width
          ? prev
          : next
      ))
    }
    const tick = () => {
      update()
      raf = window.requestAnimationFrame(tick)
    }
    tick()
    const observer = new ResizeObserver(update)
    if (inputRef.current) observer.observe(inputRef.current)
    if (containerRef.current) observer.observe(containerRef.current)
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.cancelAnimationFrame(raf)
      observer.disconnect()
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [autocomplete.status])

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
      // The box takes a bare space between terms; the language does not. The
      // space is an input convenience, so the conjunction is written in here and
      // the explicit form is what gets parsed and sent. The readout below shows
      // the result, so you can see what your space became.
      parsed = parseSearchQuery(q, { autoConjoin: true })
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
      return parseSearchQuery(query, { autoConjoin: true }).filters
    } catch {
      return {}
    }
  }, [query])
  const queryReadout = useMemo<ReadoutSegment[][]>(() => {
    try {
      return searchQueryReadout(query)
    } catch {
      return []
    }
  }, [query])
  const resultGroups = useMemo(() => groupFleetSearchResults(results), [results])
  const visibleResultCount = useMemo(
    () => visibleFleetSearchResultCount(resultGroups, expandedSearchGroups),
    [expandedSearchGroups, resultGroups],
  )
  const autocompleteList = autocomplete.status === 'open' && autocompleteAnchor && typeof document !== 'undefined'
    ? createPortal((
      <div className="fleet-chat-shape" style={{ display: 'contents' }}>
        <div
          id={autocompleteId}
          className="fleet-search-autocomplete"
          role="listbox"
          style={{
            position: 'fixed',
            left: autocompleteAnchor.left,
            right: 'auto',
            top: 'auto',
            bottom: autocompleteAnchor.bottom,
            width: autocompleteAnchor.width,
          }}
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
      </div>
    ), document.body)
    : null

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
          {autocompleteList}
          {queryReadout.length > 0 && (
            <div className="fleet-search-query-readout" aria-label="Parsed search query">
              {queryReadout.map((chip, i) => (
                <span key={i} className="fleet-search-query-chip">
                  {chip.map((seg, j) => (
                    <span
                      key={j}
                      className={seg.implied ? 'fleet-search-query-chip-implied' : undefined}
                      title={seg.implied ? 'implied — type & to write it yourself' : undefined}
                    >
                      {j > 0 ? ` ${seg.text}` : seg.text}
                    </span>
                  ))}
                </span>
              ))}
            </div>
          )}
          {/* Active filter indicators */}
          {/* since:/before: are terms inside the expression now, so they show in
              the readout above rather than as tags that can no longer be set. */}
          {(activeFilters.from || activeFilters.to || activeFilters.agent || activeFilters.type) && (
            <div style={{ display: 'flex', gap: 4, marginTop: 3, flexWrap: 'wrap' }}>
              {activeFilters.from && <span className="fleet-search-filter-tag">from:{activeFilters.from}</span>}
              {activeFilters.to && <span className="fleet-search-filter-tag">to:{activeFilters.to}</span>}
              {activeFilters.agent && <span className="fleet-search-filter-tag">agent:{activeFilters.agent}</span>}
              {activeFilters.type && <span className="fleet-search-filter-tag">type:{activeFilters.type}</span>}
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
          <FleetSearchResultsView
            results={results}
            loading={loading}
            searched={searched}
            queryError={queryError}
            expandedSearchGroups={expandedSearchGroups}
            setExpandedSearchGroups={setExpandedSearchGroups}
            ctx={ctx}
            agents={agents}
            onOpenChatForResult={openChatForResult}
            onStartDrag={startDrag}
          />
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
