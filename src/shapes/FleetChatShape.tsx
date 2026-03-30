/**
 * FleetChatShape — tldraw canvas shape that renders fleet chat messages.
 *
 * Uses fleet-data.mjs (via adapter) for live SSE updates — no polling.
 * Renders with chat-render.mjs from the fleet dashboard.
 */
import {
  BaseBoxShapeUtil,
  HTMLContainer,
  T,
  createShapeId,
  stopEventPropagation,
  useEditor,
  useValue,
} from 'tldraw'
import { useState, useEffect, useCallback, useRef, useMemo, useContext } from 'react'

import katex from 'katex'
import MarkdownIt from 'markdown-it'
// @ts-ignore — vanilla JS module
import { renderChatLine, esc } from 'fleet-dashboard/js/chat-render.mjs'
// @ts-ignore — vanilla JS module
import { renderActivityGroup } from 'fleet-dashboard/js/activity-render.mjs'
// @ts-ignore — vanilla JS module
import { highlightSyntax, langFromFilePath } from 'fleet-dashboard/js/utils.mjs'
// @ts-ignore — vanilla JS module
import { initVoice, setVoiceTarget, clearVoiceTarget, resetTranscript, toggleRecording, sendCurrentText } from 'fleet-dashboard/js/voice.mjs'
// @ts-ignore — vanilla JS module
import { initTrackpad } from 'fleet-dashboard/js/trackpad.mjs'
import { useFleetAgents, useFleetEvents, useFleetTasks, useFleetActivity, useFleetThinking, sendMessage, loadBefore } from '../fleet-data-adapter'
import { dropPillOnTarget, chatInsertBus, refStore, filterDropPreview } from './FleetPillShape'
import { DocContext } from '../PanelContext'
import { loadLookup, type LookupData } from '../synctexLookup'
import { linkifyDocRefs, linkifyArrowRefs, buildRefResolver, refToCanvas, type DocRef, type ResolvedRef, type LabelRegionInfo } from '../docLinks'
import { PDF_HEIGHT, PDF_WIDTH } from '../layoutConstants'
import './fleet-chat.css'

const DEFAULT_W = 400
const DEFAULT_H = 600

// --- Voice + trackpad input (global, one-time init) ---
initVoice()

let _tldaEditor: any = null
initTrackpad({
  getEditor: () => _tldaEditor,
  onDoubleClick: () => toggleRecording(),
  onTripleClick: () => sendCurrentText(),
})


// --- Markdown renderer using markdown-it + KaTeX ---

const md = new MarkdownIt({ html: true, breaks: true, linkify: true })

function tldaRenderMarkdown(escapedHtml: string): string {
  // Input is esc()'d — unescape for markdown-it
  let text = escapedHtml
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')

  // Strip system metadata tags
  text = text.replace(/<(?:task-notification|system-reminder|local-command-caveat|command-name|command-message|command-args|local-command-stdout)[^>]*>[\s\S]*?<\/(?:task-notification|system-reminder|local-command-caveat|command-name|command-message|command-args|local-command-stdout)>/g, '')

  // KaTeX: display math $$...$$
  text = text.replace(/\$\$([\s\S]*?)\$\$/g, (_, tex) => {
    try {
      return katex.renderToString(tex.trim(), { displayMode: true, throwOnError: false, strict: false })
    } catch { return `<div class="math-display">${esc(tex)}</div>` }
  })

  // KaTeX: inline math $...$
  text = text.replace(/(?<![\\$\w])\$([^$\n]+?)\$(?![\\$\w\d])/g, (_, tex) => {
    try {
      return katex.renderToString(tex.trim(), { displayMode: false, throwOnError: false, strict: false })
    } catch { return `<span class="math-inline">${esc(tex)}</span>` }
  })

  // Render markdown
  let result = md.render(text)

  // Unwrap single <p> for inline chat layout
  const trimmed = result.trim()
  if (trimmed.startsWith('<p>') && trimmed.endsWith('</p>') && trimmed.indexOf('<p>', 1) === -1) {
    result = trimmed.slice(3, -4)
  }

  // Make links open in new tab
  result = result.replace(/<a(?![^>]*target=)([^>]*href=")/g, '<a target="_blank"$1')

  return result
}

// --- Shape definition ---

export class FleetChatShapeUtil extends BaseBoxShapeUtil<any> {
  static override type = 'fleet-chat' as const
  static override props = {
    w: T.number,
    h: T.number,
    filter: T.arrayOf(T.arrayOf(T.arrayOf(T.string))),  // DNF of [role, label] tuples
  }

  getDefaultProps() {
    return { w: DEFAULT_W, h: DEFAULT_H, filter: [] }
  }

  override canEdit = () => false
  override canResize = () => true
  override canBind = () => false
  override hideRotateHandle = () => true
  override hideSelectionBoundsBg = () => true

  component(shape: any) {
    return <FleetChatComponent shape={shape} />
  }

  indicator() {
    return null
  }
}

// --- Nick color system (matches dashboard) ---

const nickColors = ['nick-agent-0','nick-agent-1','nick-agent-2','nick-agent-3','nick-agent-4','nick-agent-5']
const nickMap = new Map<string, string>()
let nickIdx = 0

function makeCtx(agents: any[], tasks: any[]) {
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
    if (id === 'keepalive') return 'nick-keepalive'
    if (!nickMap.has(id)) {
      nickMap.set(id, nickColors[nickIdx % nickColors.length])
      nickIdx++
    }
    return nickMap.get(id)!
  }
  return {
    agentLabel,
    getNickClass,
    isHumanId: (id: string) => {
      const a = agents.find((a: any) => a.id === id)
      return !!(a?.human)
    },
    getAgents: () => agents,
    getTasks: () => tasks,
    tldaToken: null as string | null,
    renderMarkdown: tldaRenderMarkdown,
    highlightSyntax,
    langFromFilePath,
  }
}

function FleetChatComponent({ shape }: { shape: any }) {
  const editor = useEditor()
  // Expose editor to trackpad input adapter
  _tldaEditor = editor
  const doc = useContext(DocContext)
  const { w, h, filter } = shape.props as { w: number; h: number; filter: [string, string][][] }
  void useValue('editing', () => editor.getEditingShapeId() === shape.id, [editor, shape.id])
  // Reactively track isLocked — tldraw memoizes shape components and won't
  // re-render when top-level fields (outside props) change.
  const isLocked = useValue('isLocked', () => editor.getShape(shape.id)?.isLocked ?? true, [editor, shape.id])
  const [filterOpen, setFilterOpen] = useState(false)
  const [filterOpenByPill, setFilterOpenByPill] = useState(false)

  // Close filter overlay on unlock
  useEffect(() => {
    if (!isLocked) {
      setFilterOpen(false)
      setFilterOpenByPill(false)
    }
  }, [isLocked])


  // DNF filter: [[a,b],[c]] means (a AND b) OR c
  const dnfFilter = (filter.length > 0 ? filter : null) as string[][] | null

  // Load lookup data for doc reference resolution
  const [lookup, setLookup] = useState<LookupData | null>(null)
  const [labelRegions, setLabelRegions] = useState<Record<string, LabelRegionInfo>>({})
  useEffect(() => {
    if (!doc?.docName) return
    loadLookup(doc.docName).then(setLookup)
    // Load proof-info.json for label regions (arrow refs)
    const ws = (import.meta as any).env?.VITE_SYNC_SERVER as string | undefined
    const base = ws ? ws.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace(/\/+$/, '') + '/' : (import.meta as any).env?.BASE_URL || '/'
    fetch(`${base}docs/${doc.docName}/proof-info.json?t=${Date.now()}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.labelRegions) setLabelRegions(data.labelRegions)
      })
      .catch(() => {})
  }, [doc?.docName])

  const refResolver = useMemo(() => lookup ? buildRefResolver(lookup) : null, [lookup])

  // Live data from fleet-data.mjs via SSE
  const agents = useFleetAgents()
  const liveEvents = useFleetEvents(dnfFilter)
  const activityEvents = useFleetActivity(dnfFilter)
  const tasks = useFleetTasks()
  const thinkingAgents = useFleetThinking(dnfFilter)
  const [olderEvents, setOlderEvents] = useState<any[]>([])

  // Input history (up/down arrow navigation like terminal)
  const sentHistoryRef = useRef<string[]>([])
  const historyIndexRef = useRef<number>(-1)

  // Merge older (scrollback) events with live events + activity events
  const events = useMemo(() => {
    const all = [...liveEvents, ...activityEvents]
    if (olderEvents.length === 0) return all
    // Deduplicate by _dbId or timestamp+from
    const seen = new Set(all.map((e: any) => e._dbId || `${e.timestamp}:${e.from}`))
    const unique = olderEvents.filter((e: any) => !seen.has(e._dbId || `${e.timestamp}:${e.from}`))
    return [...unique, ...all]
  }, [liveEvents, activityEvents, olderEvents])

  // Reset older events when filter changes
  const filterKey = JSON.stringify(filter)
  useEffect(() => { setOlderEvents([]) }, [filterKey])


  const chatLogRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Build context and render messages
  const ctx = useMemo(() => makeCtx(agents, tasks), [agents, tasks])

  const chatMessages = useMemo(() => {
    return events
      .filter((m: any) => {
        const t = m.type
        return t === 'chat' || t === 'delegate' || t === 'task_done' || t === 'activity'
      })
      .filter((m: any) => !m._timer) // skip timer-fired messages
      .sort((a: any, b: any) => {
        const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0
        const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0
        return ta - tb
      })
  }, [events])

  const renderedHtml = useMemo(() => {
    // Group consecutive activity events from the same agent into cards
    const parts: string[] = []
    let activityGroup: any[] = []

    function flushActivity() {
      if (activityGroup.length === 0) return
      parts.push(
        `<div class="chat-activity-inline-wrap">${renderActivityGroup(activityGroup, ctx)}</div>`
      )
      activityGroup = []
    }

    for (const m of chatMessages) {
      if (m._activity) {
        // Continue grouping if same agent, otherwise flush and start new group
        if (activityGroup.length > 0 && activityGroup[0].from !== m.from) {
          flushActivity()
        }
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

  // Post-process HTML to add clickable doc links
  const linkedHtml = useMemo(() => {
    let html = renderedHtml
    // Process [->ref] arrow links BEFORE auto-detection (linkifyDocRefs)
    // so that [->Theorem 3.2] is consumed before "Theorem 3.2" gets auto-linked
    if (doc && Object.keys(labelRegions).length > 0) {
      html = linkifyArrowRefs(html, labelRegions)
    }
    if (doc) html = linkifyDocRefs(html)
    // Turn «type:label» reference tokens into chips with hover preview
    html = html.replace(/«(.+?)»/g, (_match, inner) => {
      const token = `«${inner}»`
      const ref = refStore.get(token)
      // Display: strip the "type:" prefix, show just the label
      const colonIdx = inner.indexOf(':')
      const display = colonIdx >= 0 ? inner.slice(colonIdx + 1) : inner
      const displayEsc = display.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      const content = ref?.content || ''
      const contentEsc = content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      const preview = content ? `<span class="ref-chip-preview">${contentEsc}</span>` : ''
      return `<span class="ref-chip">${displayEsc}${preview}</span>`
    })
    return html
  }, [renderedHtml, doc, labelRegions])

  // Handle clicks on doc-link spans
  const handleDocLinkClick = useCallback((e: React.MouseEvent) => {
    const target = (e.target as HTMLElement).closest('.doc-link') as HTMLElement | null
    if (!target || !doc) return

    const refType = target.dataset.refType

    let resolved: ResolvedRef | null = null

    if (refType === 'label') {
      // Label-based ref — page/y are in data attributes
      const page = parseInt(target.dataset.refPage || '')
      const yTop = parseFloat(target.dataset.refYTop || '')
      if (!isNaN(page)) {
        resolved = { page, pdfY: !isNaN(yTop) ? yTop : undefined }
      }
    } else if (refResolver) {
      const refValue = target.dataset.refValue || ''
      const envType = target.dataset.envType
      const ref: DocRef = { type: refType as DocRef['type'], value: refValue, text: target.textContent || '', envType }
      resolved = refResolver(ref)
    }

    if (!resolved) return

    const canvasPos = refToCanvas(resolved, doc.pages, PDF_HEIGHT)
    if (!canvasPos) return

    e.stopPropagation()
    setDocLinkHover(null) // dismiss preview on click
    editor.centerOnPoint(canvasPos, { animation: { duration: 300 } })
  }, [doc, refResolver, editor])

  // Hover preview for doc-link spans
  const shapeContainerRef = useRef<HTMLDivElement>(null)
  const [docLinkHover, setDocLinkHover] = useState<{
    resolved: ResolvedRef
    /** Anchor position in shape-local coordinates */
    localX: number
    localY: number
    localW: number
    text: string
  } | null>(null)
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const logEl = chatLogRef.current
    if (!logEl) return

    function onMouseOver(e: MouseEvent) {
      const target = (e.target as HTMLElement).closest('.doc-link') as HTMLElement | null
      if (!target || !doc) return
      // Skip unresolved arrow refs
      if (target.classList.contains('doc-link-unresolved')) return

      // Debounce slightly to avoid flicker
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
      hoverTimerRef.current = setTimeout(() => {
        const refType = target.dataset.refType

        let resolved: ResolvedRef | null = null

        if (refType === 'label') {
          const page = parseInt(target.dataset.refPage || '')
          const yTop = parseFloat(target.dataset.refYTop || '')
          if (!isNaN(page)) {
            resolved = { page, pdfY: !isNaN(yTop) ? yTop : undefined }
          }
        } else if (refResolver) {
          const refValue = target.dataset.refValue || ''
          const envType = target.dataset.envType
          const ref: DocRef = { type: refType as DocRef['type'], value: refValue, text: target.textContent || '', envType }
          resolved = refResolver(ref)
        }
        if (!resolved) return

        // Convert screen coords → shape-local coords
        const containerEl = shapeContainerRef.current
        if (!containerEl) return
        const containerRect = containerEl.getBoundingClientRect()
        const anchorRect = target.getBoundingClientRect()
        const zoom = containerRect.width / w  // screen px per local px
        const localX = (anchorRect.left - containerRect.left) / zoom
        const localY = (anchorRect.top - containerRect.top) / zoom
        const localW = anchorRect.width / zoom

        setDocLinkHover({ resolved, localX, localY, localW, text: target.textContent || '' })
      }, 150)
    }

    function onMouseOut(e: MouseEvent) {
      const target = e.target as HTMLElement
      if (!target.closest('.doc-link')) return
      const related = e.relatedTarget as HTMLElement | null
      if (related?.closest('.doc-link-preview')) return
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
      setDocLinkHover(null)
    }

    logEl.addEventListener('mouseover', onMouseOver)
    logEl.addEventListener('mouseout', onMouseOut)
    return () => {
      logEl.removeEventListener('mouseover', onMouseOver)
      logEl.removeEventListener('mouseout', onMouseOut)
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
    }
  }, [doc, refResolver, w])

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (chatLogRef.current) {
      chatLogRef.current.scrollTop = chatLogRef.current.scrollHeight
    }
  }, [linkedHtml])

  const agentNames = useMemo(() => {
    const map: Record<string, string> = {}
    for (const a of agents) {
      if (a.id) map[a.id] = a.friendly_name || (a.id || '').replace('fleet:', '')
    }
    map['fleet:skip'] = 'skip'
    return map
  }, [agents])

  // Detect pill drag hovering over this chat — returns stable string to avoid flicker
  // Only agent/label pills trigger filter overlay, not content pills (msg, code, etc.)
  const pillOverKey = useValue('pill-over', () => {
    const pills = editor.getCurrentPageShapes().filter(s => (s.type as string) === 'fleet-pill') as any[]
    if (pills.length === 0) return ''
    const myBounds = editor.getShapePageBounds(shape.id)
    if (!myBounds) return ''
    for (const pill of pills) {
      const props = pill.props
      if (props.pillType !== 'agent' && props.pillType !== 'label') continue
      const pb = editor.getShapePageBounds(pill.id)
      if (!pb) continue
      const cx = pb.x + pb.w / 2
      const cy = pb.y + pb.h / 2
      if (cx >= myBounds.x && cx <= myBounds.x + myBounds.w &&
          cy >= myBounds.y && cy <= myBounds.y + myBounds.h) {
        const role = cy < myBounds.y + myBounds.h / 2 ? 'to' : 'from'
        return `${role}\0${props.value}\0${props.displayName}`
      }
    }
    return ''
  }, [editor, shape.id])
  const pillOver = useMemo(() => {
    if (!pillOverKey) return null
    const [role, value, displayName] = pillOverKey.split('\0')
    return { role, value, displayName }
  }, [pillOverKey])

  // Auto-open filter overlay when pill hovers over this chat
  useEffect(() => {
    if (pillOver && !filterOpen) {
      setFilterOpenByPill(true)
      setFilterOpen(true)
    } else if (!pillOver && filterOpenByPill) {
      setFilterOpenByPill(false)
      setFilterOpen(false)
    }
  }, [!!pillOver])

  // Derive send targets: unique agents in "to" clauses only
  const sendTargets = useMemo(() => {
    const seen = new Set<string>()
    for (const clause of filter) {
      for (const [role, label] of clause) {
        if (role === 'to') seen.add(label)
      }
    }
    return [...seen]
  }, [filterKey])

  // Derive a loadBefore agent: use first agent in filter
  const loadBeforeAgent = sendTargets[0] ?? undefined

  // Infinite scroll — load older messages
  const loadingMore = useRef(false)
  const handleScroll = useCallback(async (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    if (el.scrollTop > 50 || loadingMore.current || chatMessages.length === 0) return
    loadingMore.current = true
    const oldestTs = chatMessages[0]?.timestamp
    if (oldestTs) {
      const prevHeight = el.scrollHeight
      const older = await loadBefore(loadBeforeAgent, oldestTs, 50)
      if (older.length > 0) {
        setOlderEvents(prev => [...older, ...prev])
      }
      // Maintain scroll position
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight - prevHeight
      })
    }
    loadingMore.current = false
  }, [chatMessages, loadBeforeAgent])

  // --- Chat log drag → ghost pill ---
  // Uses native capture-phase listeners because tldraw intercepts React events
  const DRAG_THRESHOLD = 5
  const dragRef = useRef<{
    pillId: string | null
    pillType: string
    value: string
    displayName: string
    color: string
    content?: string
    startX: number
    startY: number
    started: boolean
    captureEl: HTMLElement | null
    pointerId: number
  } | null>(null)

  // Store agentNames in a ref so native listeners can access current value
  const agentNamesRef = useRef(agentNames)
  agentNamesRef.current = agentNames

  // Store shape.id in a ref so document-level listeners can access it
  const shapeIdRef = useRef(shape.id)
  shapeIdRef.current = shape.id

  useEffect(() => {
    const logEl = chatLogRef.current
    if (!logEl) return

    // Document-level capture listeners: fires before tldraw's tl-container
    // listener can intercept. We scope to this chat by checking if the target
    // is inside our logEl.

    function onPointerDown(e: PointerEvent) {
      const target = e.target as HTMLElement
      if (!logEl!.contains(target)) return

      const names = agentNamesRef.current

      // Only intercept on draggable elements
      const isDraggable = target.closest('.chat-nick span[class*="nick-"], .chat-ts, .chat-activity-card, .code-block-header, .tool-ref, .md-file-card, .tlda-card')
      if (!isDraggable) return

      let drag: typeof dragRef.current = null

      // Agent name
      const nickSpan = target.closest('.chat-nick span[class*="nick-"]') as HTMLElement
      if (nickSpan) {
        const line = nickSpan.closest('.chat-line') as HTMLElement
        const agentId = line?.dataset.msgFrom
        if (agentId) {
          drag = {
            pillId: null, pillType: 'agent', value: agentId,
            displayName: nickSpan.textContent?.replace(/:$/, '') || agentId,
            color: '#7a9ec8', startX: e.clientX, startY: e.clientY,
            started: false, captureEl: logEl, pointerId: e.pointerId,
          }
        }
      }

      // Timestamp → message reference
      if (!drag) {
        const tsEl = target.closest('.chat-ts') as HTMLElement
        if (tsEl) {
          const line = tsEl.closest('.chat-line') as HTMLElement
          if (line) {
            const from = line.dataset.msgFrom || ''
            const ts = line.dataset.msgTs || ''
            const text = line.textContent?.slice(0, 200)?.trim() || ''
            const nick = names[from] || from.replace('fleet:', '')
            drag = {
              pillId: null, pillType: 'msg', value: `msg:${from}:${ts}`,
              displayName: `${nick} ${tsEl.textContent || ''}`.trim(),
              color: '#8888a0', content: text,
              startX: e.clientX, startY: e.clientY,
              started: false, captureEl: logEl, pointerId: e.pointerId,
            }
          }
        }
      }

      // Activity card
      if (!drag) {
        const actCard = target.closest('.chat-activity-card') as HTMLElement
        if (actCard) {
          const agentId = actCard.dataset.agent || ''
          const ts = actCard.dataset.ts || ''
          const text = actCard.textContent?.slice(0, 300)?.trim() || ''
          const nick = names[agentId] || agentId.replace('fleet:', '')
          drag = {
            pillId: null, pillType: 'activity', value: `activity:${agentId}:${ts}`,
            displayName: `${nick} activity`,
            color: '#c8b060', content: text,
            startX: e.clientX, startY: e.clientY,
            started: false, captureEl: logEl, pointerId: e.pointerId,
          }
        }
      }

      // Code block header
      if (!drag) {
        const codeHeader = target.closest('.code-block-header') as HTMLElement
        if (codeHeader) {
          const wrap = codeHeader.closest('.code-block-wrap')
          const code = wrap?.querySelector('pre code')
          if (code) {
            const langEl = codeHeader.querySelector('.code-block-lang')
            drag = {
              pillId: null, pillType: 'code', value: 'code',
              displayName: langEl?.textContent || 'code',
              color: '#6aafb0', content: code.textContent || '',
              startX: e.clientX, startY: e.clientY,
              started: false, captureEl: logEl, pointerId: e.pointerId,
            }
          }
        }
      }

      // Tool ref
      if (!drag) {
        const toolRef = target.closest('.tool-ref') as HTMLElement
        if (toolRef) {
          const preview = toolRef.querySelector('.tool-ref-preview')
          drag = {
            pillId: null, pillType: 'tool', value: 'tool',
            displayName: toolRef.querySelector('.tool-ref-type')?.textContent || 'tool',
            color: '#c8b060', content: (preview?.textContent || toolRef.textContent || '').trim(),
            startX: e.clientX, startY: e.clientY,
            started: false, captureEl: logEl, pointerId: e.pointerId,
          }
        }
      }

      // MD file card or shared-doc card → drag as doc reference
      if (!drag) {
        const mdCard = target.closest('.md-file-card') as HTMLElement
        if (mdCard) {
          const filePath = mdCard.dataset.path || ''
          const name = mdCard.querySelector('.md-file-chip')?.textContent || filePath.split('/').pop() || 'file'
          drag = {
            pillId: null, pillType: 'doc' as any, value: `file:${filePath}`,
            displayName: name, color: '#9370db', content: filePath,
            startX: e.clientX, startY: e.clientY,
            started: false, captureEl: logEl, pointerId: e.pointerId,
          }
        }
      }
      if (!drag) {
        const tldaCard = target.closest('.tlda-card') as HTMLElement
        if (tldaCard) {
          const tldaId = tldaCard.dataset.tldaId || ''
          const docName = tldaCard.querySelector('.doc-name')?.textContent || tldaId
          drag = {
            pillId: null, pillType: 'doc' as any, value: `doc:${docName}`,
            displayName: docName, color: '#9370db', content: docName,
            startX: e.clientX, startY: e.clientY,
            started: false, captureEl: logEl, pointerId: e.pointerId,
          }
        }
      }

      if (!drag) return

      e.stopImmediatePropagation()
      e.preventDefault()
      dragRef.current = drag
    }

    function onPointerMove(e: PointerEvent) {
      const drag = dragRef.current
      if (!drag) return
      e.stopImmediatePropagation()
      e.preventDefault()
      const dx = e.clientX - drag.startX
      const dy = e.clientY - drag.startY
      if (!drag.started) {
        if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return
        drag.started = true
        const pagePos = editor.screenToPage({ x: e.clientX, y: e.clientY })
        const pillId = createShapeId()
        editor.createShape({
          id: pillId,
          type: 'fleet-pill' as any,
          x: pagePos.x - 35,
          y: pagePos.y - 9,
          props: {
            w: 70, h: 18,
            pillType: drag.pillType,
            value: drag.value,
            displayName: drag.displayName,
            color: drag.color,
          },
        })
        drag.pillId = pillId as unknown as string
      }
      if (drag.pillId) {
        const pagePos = editor.screenToPage({ x: e.clientX, y: e.clientY })
        editor.updateShape({
          id: drag.pillId as any,
          type: 'fleet-pill' as any,
          x: pagePos.x - 35,
          y: pagePos.y - 9,
        })
      }
    }

    function onPointerUp(e: PointerEvent) {
      const drag = dragRef.current
      if (!drag) return
      e.stopImmediatePropagation()
      dragRef.current = null
      if (!drag.started || !drag.pillId) return
      const pagePos = editor.screenToPage({ x: e.clientX, y: e.clientY })
      dropPillOnTarget(editor, drag.pillId as any, drag.value, pagePos, drag.content)
      try { editor.deleteShapes([drag.pillId as any]) } catch {}
    }

    document.addEventListener('pointerdown', onPointerDown, { capture: true })
    document.addEventListener('pointermove', onPointerMove, { capture: true })
    document.addEventListener('pointerup', onPointerUp, { capture: true })

    return () => {
      document.removeEventListener('pointerdown', onPointerDown, { capture: true })
      document.removeEventListener('pointermove', onPointerMove, { capture: true })
      document.removeEventListener('pointerup', onPointerUp, { capture: true })
    }
  }, [editor])

  // --- chatInsertBus listener: content drops insert into textarea ---
  useEffect(() => {
    const handler = (e: Event) => {
      const { chatId, text } = (e as CustomEvent).detail
      if (chatId !== shape.id) return
      const ta = inputRef.current as HTMLTextAreaElement | null
      if (!ta) return
      const pos = ta.selectionStart ?? ta.value.length
      const before = ta.value.slice(0, pos)
      const after = ta.value.slice(pos)
      const insert = (before && !before.endsWith('\n') ? '\n' : '') + text + (after && !after.startsWith('\n') ? '\n' : '')
      ta.value = before + insert + after
      ta.style.height = 'auto'
      ta.style.height = Math.min(ta.scrollHeight, 200) + 'px'
      ta.focus()
    }
    const filterHandler = (e: Event) => {
      const { chatId } = (e as CustomEvent).detail
      if (chatId !== shape.id) return
      setFilterOpen(false)
      setFilterOpenByPill(false)
    }
    chatInsertBus.addEventListener('insert', handler)
    chatInsertBus.addEventListener('filter-applied', filterHandler)
    return () => {
      chatInsertBus.removeEventListener('insert', handler)
      chatInsertBus.removeEventListener('filter-applied', filterHandler)
    }
  }, [shape.id])

  return (
    <HTMLContainer
      style={{
        width: w,
        height: h,
        pointerEvents: isLocked ? 'all' : 'none',
        overflow: 'visible',
      }}
    >
      <div
        ref={shapeContainerRef}
        className="fleet-shape fleet-chat-shape"
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          borderRadius: 0,
          fontSize: 11,
          overflow: 'visible',
          fontFamily: "'Helvetica Neue', 'Helvetica', 'Arial', sans-serif",
          fontWeight: 300,
          lineHeight: 1.4,
          position: 'relative',
        }}
      >
        {/* Close + filter edit buttons — pointer-events: auto (CSS), stop propagation on interaction */}
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
        <button
          className="fleet-filter-btn"
          onPointerDown={stopEventPropagation}
          onClick={() => setFilterOpen(prev => !prev)}
        >
          ⊞
        </button>

        {/* Filter editor — full overlay showing DNF expression */}
        {filterOpen && (
          <FilterOverlay
            filter={filter}
            agentNames={agentNames}
            shapeId={shape.id}
            editor={editor}
            onClose={() => setFilterOpen(false)}
          />
        )}

        {/* Messages — pointer-events: auto (CSS), stop propagation when locked so tldraw doesn't see chat interactions */}
        <div
          ref={chatLogRef}
          className="fleet-chat-log"
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '4px 0',
          }}
          onPointerDown={(e) => { if (isLocked) stopEventPropagation(e) }}
          onScroll={handleScroll}
          onClick={handleDocLinkClick}
        >
          {chatMessages.length === 0 ? (
            <div style={{
              padding: '20px 8px',
              opacity: 0.3,
              textAlign: 'center',
              fontSize: 10,
            }}>
              {filter.length > 0 ? 'No messages' : 'No filter set'}
            </div>
          ) : (
            <div dangerouslySetInnerHTML={{ __html: linkedHtml }} />
          )}
          {[...thinkingAgents].map(agentId => (
            <div key={agentId} className="chat-line chat-thinking">
              <span className={ctx.getNickClass(agentId)}>{ctx.agentLabel(agentId)}</span>
              {' '}<span className="thinking-text">thinking…</span>
            </div>
          ))}
        </div>

        {/* Doc-link hover preview — positioned relative to shape container */}
        {docLinkHover && doc && (
          <DocLinkPreview
            resolved={docLinkHover.resolved}
            localX={docLinkHover.localX}
            localY={docLinkHover.localY}
            text={docLinkHover.text}
            docName={doc.docName}
            shapeW={w}
            onDismiss={() => setDocLinkHover(null)}
          />
        )}

        {/* Input — pointer-events: auto (CSS), stop propagation when locked so tldraw doesn't see input interactions */}
        <div
          className="fleet-chat-input-area"
          onPointerDown={(e) => { if (isLocked) stopEventPropagation(e) }}
          style={{
            borderTop: '1px solid rgba(128, 128, 128, 0.15)',
            padding: 4,
            flexShrink: 0,
            position: 'relative',
          }}
        >
          <SendHint
            filter={filter}
            sendTargets={sendTargets}
            agentNames={agentNames}
            inputRef={inputRef}
          />
          <div style={{ position: 'relative' }}>
            {/* Highlight underlay — mirrors textarea text, highlights <<ref>> tokens */}
            <InputHighlightUnderlay inputRef={inputRef} />
            <textarea
              ref={inputRef as any}
              placeholder={sendTargets.length > 0 ? `→ ${sendTargets.map(t => agentNames[t] || t.replace('fleet:', '')).join(', ')}` : ''}
              rows={1}
              autoCorrect="off"
              autoCapitalize="off"
              autoComplete="off"
              spellCheck={false}
              onKeyDown={(e) => {
                stopEventPropagation(e)
                const ta = e.currentTarget
                if (e.key === 'ArrowUp') {
                  const history = sentHistoryRef.current
                  if (history.length === 0) return
                  if (historyIndexRef.current === -1 && ta.value !== '') return
                  e.preventDefault()
                  const nextIdx = historyIndexRef.current + 1
                  if (nextIdx < history.length) {
                    historyIndexRef.current = nextIdx
                    ta.value = history[history.length - 1 - nextIdx]
                    ta.style.height = 'auto'
                    ta.style.height = Math.min(ta.scrollHeight, 200) + 'px'
                    ta.setSelectionRange(ta.value.length, ta.value.length)
                  }
                  return
                }
                if (e.key === 'ArrowDown') {
                  if (historyIndexRef.current === -1) return
                  e.preventDefault()
                  const nextIdx = historyIndexRef.current - 1
                  historyIndexRef.current = nextIdx
                  if (nextIdx < 0) {
                    ta.value = ''
                    ta.style.height = 'auto'
                  } else {
                    const history = sentHistoryRef.current
                    ta.value = history[history.length - 1 - nextIdx]
                    ta.style.height = 'auto'
                    ta.style.height = Math.min(ta.scrollHeight, 200) + 'px'
                    ta.setSelectionRange(ta.value.length, ta.value.length)
                  }
                  return
                }
                if (e.key === 'Enter' && !e.shiftKey) {
                  const val = ta.value
                  if (val.trim() === '') {
                    e.preventDefault() // suppress on empty
                    return
                  }
                  // Get text before cursor on current line
                  const before = val.substring(0, ta.selectionStart || val.length)
                  const lastNewline = before.lastIndexOf('\n')
                  const lineText = before.substring(lastNewline + 1)

                  if (lineText.trim() === '') {
                    // Blank line (double-enter) = send
                    e.preventDefault()
                    const text = val.trim()
                    if (text && sendTargets.length > 0) {
                      for (const t of sendTargets) sendMessage(t, text)
                      sentHistoryRef.current = [...sentHistoryRef.current, text]
                      historyIndexRef.current = -1
                      ta.value = ''
                      ta.style.height = 'auto'
                      resetTranscript()
                    }
                  } else if (lineText.endsWith(' ')) {
                    // Trailing space = newline (let default happen)
                    return
                  } else {
                    // Non-blank, no trailing space = send
                    e.preventDefault()
                    const text = val.trim()
                    if (text && sendTargets.length > 0) {
                      for (const t of sendTargets) sendMessage(t, text)
                      sentHistoryRef.current = [...sentHistoryRef.current, text]
                      historyIndexRef.current = -1
                      ta.value = ''
                      ta.style.height = 'auto'
                      resetTranscript()
                    }
                  }
                }
              }}
              onInput={(e) => {
                // Auto-resize
                const ta = e.currentTarget
                ta.style.height = 'auto'
                ta.style.height = Math.min(ta.scrollHeight, 200) + 'px'
              }}
              onPointerDown={(e) => {
                if (isLocked) stopEventPropagation(e)
                // Register voice target on pointerdown — onFocus can be unreliable in tldraw
                setVoiceTarget(e.currentTarget, sendTargets, agentNames, (targets: string[], text: string) => {
                  for (const t of targets) sendMessage(t, text)
                })
              }}
              onFocus={(e) => {
                if (isLocked) stopEventPropagation(e)
                setVoiceTarget(e.currentTarget, sendTargets, agentNames, (targets: string[], text: string) => {
                  for (const t of targets) sendMessage(t, text)
                })
              }}
              style={{
                width: '100%',
                background: 'transparent',
                border: '1px solid rgba(128, 128, 128, 0.15)',
                borderRadius: 4,
                padding: '4px 8px',
                fontSize: 11,
                color: 'inherit',
                outline: 'none',
                resize: 'none',
                lineHeight: 1.4,
                fontFamily: 'inherit',
                position: 'relative',
                zIndex: 1,
              }}
              onDrop={async (e) => {
                e.preventDefault()
                e.stopPropagation()
                const ta = e.currentTarget

                // External file drops
                const files = [...(e.dataTransfer?.files || [])]
                if (files.length > 0) {
                  for (const file of files) {
                    if (file.type.startsWith('text/') || /\.(txt|md|tex|json|js|ts|py|r|css|html|csv|yaml|yml|toml|sh|sql|xml)$/i.test(file.name)) {
                      // Text file → read contents, insert as code block
                      const text = await file.text()
                      const ext = file.name.split('.').pop() || ''
                      const _block = `\`\`\`${ext}\n${text}\n\`\`\``; void _block
                      const token = `«file:${file.name}»`
                      refStore.set(token, { type: 'file', label: file.name, content: text })
                      const pos = ta.selectionStart || ta.value.length
                      ta.value = ta.value.slice(0, pos) + token + ta.value.slice(pos)
                      ta.dispatchEvent(new Event('input', { bubbles: true }))
                    } else if (file.type.startsWith('image/')) {
                      // Image → upload to fleet dashboard, insert markdown
                      try {
                        const buf = await file.arrayBuffer()
                        const res = await fetch('/api/upload', { method: 'POST', body: buf })
                        const data = await res.json()
                        if (data.url) {
                          const pos = ta.selectionStart || ta.value.length
                          ta.value = ta.value.slice(0, pos) + `![${file.name}](${data.url})` + ta.value.slice(pos)
                          ta.dispatchEvent(new Event('input', { bubbles: true }))
                        }
                      } catch {}
                    } else {
                      // Other file → insert path reference
                      const token = `«file:${file.name}»`
                      const pos = ta.selectionStart || ta.value.length
                      ta.value = ta.value.slice(0, pos) + token + ta.value.slice(pos)
                      ta.dispatchEvent(new Event('input', { bubbles: true }))
                    }
                  }
                  return
                }

                // Text/attachment drops (from other chat elements)
                const text = e.dataTransfer?.getData('text/plain') || ''
                if (text) {
                  const pos = ta.selectionStart || ta.value.length
                  ta.value = ta.value.slice(0, pos) + text + ta.value.slice(pos)
                }
              }}
              onDragOver={(e) => {
                e.preventDefault()
                e.stopPropagation()
              }}
          />
          </div>
        </div>
      </div>
    </HTMLContainer>
  )
}

/** Floating preview panel — shows a clipped SVG region on doc-link hover */
function DocLinkPreview({
  resolved,
  localX,
  localY,
  text,
  docName,
  shapeW,
  onDismiss,
}: {
  resolved: ResolvedRef
  localX: number
  localY: number
  text: string
  docName: string
  shapeW: number
  onDismiss: () => void
}) {
  // Compute the SVG region to show (in PDF coordinates)
  const PREVIEW_H_PDF = 150
  const pdfY = resolved.pdfY ?? PDF_HEIGHT * 0.3
  const yTop = Math.max(0, pdfY - PREVIEW_H_PDF / 2)
  const yBottom = Math.min(PDF_HEIGHT, yTop + PREVIEW_H_PDF)

  // SVG URL
  const ws = (import.meta as any).env?.VITE_SYNC_SERVER as string | undefined
  const base = ws ? ws.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace(/\/+$/, '') + '/' : (import.meta as any).env?.BASE_URL || '/'
  const svgUrl = `${base}docs/${docName}/page-${resolved.page}.svg`

  // Preview dimensions — fit within the shape width
  const PREVIEW_W = Math.min(320, shapeW - 16)
  const scale = PREVIEW_W / PDF_WIDTH
  const previewH = (yBottom - yTop) * scale
  const labelH = 20

  // Position above the hovered link, clamped to shape bounds
  const left = Math.max(4, Math.min(localX, shapeW - PREVIEW_W - 4))
  const top = localY - previewH - labelH - 6

  return (
    <div
      className="doc-link-preview"
      style={{
        position: 'absolute',
        left,
        top: Math.max(0, top),
        width: PREVIEW_W,
        zIndex: 50,
      }}
      onMouseLeave={onDismiss}
    >
      <div className="doc-link-preview-label">
        <span>{text}</span>
        <span className="doc-link-preview-page">p.{resolved.page}</span>
      </div>
      <div
        className="doc-link-preview-clip"
        style={{
          width: PREVIEW_W,
          height: previewH,
          overflow: 'hidden',
        }}
      >
        <img
          src={svgUrl}
          alt=""
          style={{
            display: 'block',
            width: PREVIEW_W,
            height: PDF_HEIGHT * scale,
            transform: `translateY(${-yTop * scale}px)`,
            pointerEvents: 'none',
          }}
        />
      </div>
    </div>
  )
}

function SendHint({
  filter: _filter,
  sendTargets,
  agentNames,
  inputRef,
}: {
  filter: [string, string][][]
  sendTargets: string[]
  agentNames: Record<string, string>
  inputRef: React.RefObject<HTMLInputElement | null>
}) {
  const [hint, setHint] = useState('')

  const targetLabel = useMemo(() => {
    if (sendTargets.length === 0) return ''
    return sendTargets.map(t => agentNames[t] || t.replace('fleet:', '')).join(' + ')
  }, [sendTargets, agentNames])

  const update = useCallback(() => {
    const el = inputRef.current as HTMLTextAreaElement | null
    if (!el) {
      setHint(targetLabel ? `→ ${targetLabel}` : '')
      return
    }
    const val = el.value
    if (!val) {
      setHint(targetLabel ? `→ ${targetLabel}` : '')
      return
    }
    const pos = el.selectionStart ?? val.length
    const lineStart = val.lastIndexOf('\n', pos - 1) + 1
    const currentLine = val.slice(lineStart, pos)
    if (currentLine.endsWith(' ')) {
      setHint('↵ newline')
    } else {
      setHint(targetLabel ? `↵ → ${targetLabel}` : '↵')
    }
  }, [targetLabel, inputRef])

  useEffect(() => {
    update()
  }, [targetLabel, update])

  useEffect(() => {
    const el = inputRef.current as HTMLTextAreaElement | null
    if (!el) return
    const handler = () => update()
    el.addEventListener('input', handler)
    el.addEventListener('keyup', handler)
    el.addEventListener('focus', handler)
    el.addEventListener('blur', handler)
    return () => {
      el.removeEventListener('input', handler)
      el.removeEventListener('keyup', handler)
      el.removeEventListener('focus', handler)
      el.removeEventListener('blur', handler)
    }
  }, [inputRef, update])

  if (!hint) return null

  return (
    <span className="fleet-chat-send-hint">
      {hint}
    </span>
  )
}

/** Filter overlay — uses native click listeners to bypass tldraw event interception */
/** Simplify a DNF expression: dedup within groups, dedup identical groups, absorption */
function simplifyDnf(dnf: [string, string][][]): [string, string][][] {
  // Dedup within each AND group
  let groups = dnf.map(g => {
    const seen = new Set<string>()
    return g.filter(([r, l]) => {
      const key = `${r}\0${l}`
      if (seen.has(key)) return false
      seen.add(key); return true
    })
  })
  // Dedup identical OR groups
  const seenGroups = new Set<string>()
  groups = groups.filter(g => {
    const key = g.map(([r, l]) => `${r}\0${l}`).sort().join('\n')
    if (seenGroups.has(key)) return false
    seenGroups.add(key); return true
  })
  // Absorption: if group A ⊆ group B, drop B (A is less restrictive)
  return groups.filter((g, i) =>
    !groups.some((other, j) => i !== j && other.length < g.length &&
      other.every(([r, l]) => g.some(([gr, gl]) => gr === r && gl === l)))
  )
}

/** Build preview DNF: add a new term at andGroupIdx (AND) or as new OR clause (andGroupIdx < 0) */
function buildFilterPreview(
  filter: [string, string][][],
  role: string,
  value: string,
  andGroupIdx: number,
): [string, string][][] {
  const newTerm: [string, string] = [role, value]
  if (filter.length === 0) return [[newTerm]]
  // Already exists in the target group?
  if (andGroupIdx >= 0 && filter[andGroupIdx]) {
    if (filter[andGroupIdx].some(([r, l]) => r === role && l === value)) return filter
    const result = filter.map((cl, i) => i === andGroupIdx ? [...cl, newTerm] : cl)
    return simplifyDnf(result)
  }
  // New OR clause
  return simplifyDnf([...filter, [newTerm]])
}

function FilterOverlay({
  filter,
  agentNames,
  shapeId,
  editor,
  onClose,
}: {
  filter: [string, string][][]
  agentNames: Record<string, string>
  shapeId: any
  editor: any
  onClose: () => void
}) {
  // Native click delegation on document capture — bypasses tldraw completely
  const overlayRef = useRef<HTMLDivElement>(null)
  const filterRef = useRef(filter)
  filterRef.current = filter

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      const target = e.target as HTMLElement
      const overlay = overlayRef.current
      if (!overlay || !overlay.contains(target)) return

      // Close button
      if (target.closest('.fleet-filter-overlay-close')) {
        onClose()
        return
      }

      // Remove term ×
      const termX = target.closest('.fleet-filter-term-x') as HTMLElement
      if (termX) {
        const ci = parseInt(termX.dataset.clause || '0', 10)
        const ti = parseInt(termX.dataset.term || '0', 10)
        const f = filterRef.current
        const newFilter = f.map((cl, i) => {
          if (i !== ci) return cl
          return cl.filter((_, j) => j !== ti)
        }).filter(cl => cl.length > 0)
        editor.updateShape({
          id: shapeId,
          type: 'fleet-chat',
          props: { filter: newFilter },
        })
        return
      }

      // Clear all
      if (target.closest('.fleet-filter-clear')) {
        editor.updateShape({
          id: shapeId,
          type: 'fleet-chat',
          props: { filter: [] },
        })
        return
      }
    }
    document.addEventListener('click', handleClick, { capture: true })
    return () => document.removeEventListener('click', handleClick, { capture: true })
  }, [shapeId, editor, onClose])

  // Detect pill hovering over the shape — show two-pane drop preview
  const pillOverKey = useValue('filter-pill-over', () => {
    const pills = editor.getCurrentPageShapes().filter((s: any) => s.type === 'fleet-pill')
    if (pills.length === 0) return ''
    const pill = pills[0] as any
    const pb = editor.getShapePageBounds(pill.id)
    if (!pb) return ''
    const cx = pb.x + pb.w / 2
    const cy = pb.y + pb.h / 2
    const shapeBounds = editor.getShapePageBounds(shapeId)
    if (!shapeBounds || cx < shapeBounds.x || cx > shapeBounds.x + shapeBounds.w ||
        cy < shapeBounds.y || cy > shapeBounds.y + shapeBounds.h) return ''
    return `${pill.props.value}\0${pill.props.displayName}`
  }, [editor, shapeId])

  const pillOver = useMemo(() => {
    if (!pillOverKey) return null
    const [value, displayName] = pillOverKey.split('\0')
    return { value, displayName }
  }, [pillOverKey])

  // AND-group hover detection via pill shape position vs DOM bounding rects.
  // Pointer events don't work during drag because FleetAgentsShape holds pointer capture.
  // Instead, poll the pill's screen position each frame and check against clause box rects.
  const toPaneRef = useRef<HTMLDivElement>(null)
  const fromPaneRef = useRef<HTMLDivElement>(null)

  // AND-group hover detection with hysteresis to prevent oscillation.
  // Once hovering a group, stick to it until the pill clearly leaves (EXIT_PAD away).
  // Enter a group with ENTER_PAD tolerance.
  const lastGroupRef = useRef<{ pane: string; idx: number; rect: DOMRect } | null>(null)

  const hoveredGroup = useValue('filter-hovered-group', () => {
    if (!pillOver) { lastGroupRef.current = null; return null }
    const pills = editor.getCurrentPageShapes().filter((s: any) => s.type === 'fleet-pill')
    if (pills.length === 0) { lastGroupRef.current = null; return null }
    const pill = pills[0]
    const pb = editor.getShapePageBounds(pill.id)
    if (!pb) return null
    const screenPt = editor.pageToScreen({ x: pb.x + pb.w / 2, y: pb.y + pb.h / 2 })

    const ENTER_PAD = 8
    const EXIT_PAD = 30

    // If we have a sticky group, check if pill is still near it
    const last = lastGroupRef.current
    if (last) {
      const r = last.rect
      if (screenPt.x >= r.x - EXIT_PAD && screenPt.x <= r.x + r.width + EXIT_PAD &&
          screenPt.y >= r.y - EXIT_PAD && screenPt.y <= r.y + r.height + EXIT_PAD) {
        return { pane: last.pane as 'to' | 'from', idx: last.idx }
      }
      lastGroupRef.current = null
    }

    // Check each pane
    for (const [pane, ref] of [['to', toPaneRef], ['from', fromPaneRef]] as const) {
      const paneEl = ref.current
      if (!paneEl) continue
      const paneRect = paneEl.getBoundingClientRect()
      if (screenPt.x < paneRect.x || screenPt.x > paneRect.x + paneRect.width ||
          screenPt.y < paneRect.y || screenPt.y > paneRect.y + paneRect.height) continue
      // Inside this pane — check clause boxes
      const clauseEls = paneEl.querySelectorAll('.fleet-filter-and-group')
      let foundIdx = -1
      for (let i = 0; i < clauseEls.length; i++) {
        const r = clauseEls[i].getBoundingClientRect()
        if (screenPt.x >= r.x - ENTER_PAD && screenPt.x <= r.x + r.width + ENTER_PAD &&
            screenPt.y >= r.y - ENTER_PAD && screenPt.y <= r.y + r.height + ENTER_PAD) {
          foundIdx = i
          lastGroupRef.current = { pane, idx: i, rect: DOMRect.fromRect(r) }
          break
        }
      }
      return { pane, idx: foundIdx }
    }
    return null
  }, [editor, pillOver])

  // Compute preview DNF for each pane based on hovered AND group
  const toGroupIdx = hoveredGroup?.pane === 'to' ? hoveredGroup.idx : -1
  const fromGroupIdx = hoveredGroup?.pane === 'from' ? hoveredGroup.idx : -1

  const toPreview = useMemo(() => {
    if (!pillOver) return null
    return buildFilterPreview(filter, 'to', pillOver.value, toGroupIdx)
  }, [pillOver, filter, toGroupIdx])

  const fromPreview = useMemo(() => {
    if (!pillOver) return null
    return buildFilterPreview(filter, 'from', pillOver.value, fromGroupIdx)
  }, [pillOver, filter, fromGroupIdx])

  // Highlight index: if hovering a group, that group; if new OR clause, the last group
  const toHighlightIdx = toGroupIdx >= 0 ? toGroupIdx : (toPreview && toPreview.length > filter.length ? toPreview.length - 1 : -1)
  const fromHighlightIdx = fromGroupIdx >= 0 ? fromGroupIdx : (fromPreview && fromPreview.length > filter.length ? fromPreview.length - 1 : -1)

  // Publish preview state so dropPillOnTarget can apply the right filter on release
  useEffect(() => {
    if (pillOver) {
      filterDropPreview.shapeId = shapeId
      filterDropPreview.toPreview = toPreview
      filterDropPreview.fromPreview = fromPreview
      filterDropPreview.activePaneRole = hoveredGroup?.pane ?? null
    } else {
      filterDropPreview.shapeId = null
      filterDropPreview.toPreview = null
      filterDropPreview.fromPreview = null
      filterDropPreview.activePaneRole = null
    }
    return () => {
      filterDropPreview.shapeId = null
      filterDropPreview.toPreview = null
      filterDropPreview.fromPreview = null
      filterDropPreview.activePaneRole = null
    }
  }, [pillOver, toPreview, fromPreview, hoveredGroup, shapeId])

  // Render a single chip (role:label) — matches dashboard's chipHtml
  function renderChip(role: string, label: string, opts?: { ghost?: boolean; x?: { ci: number; ti: number } }) {
    const display = agentNames[label] || label.replace('fleet:', '')
    return (
      <span className={`fleet-filter-chip fleet-filter-chip-${role}${opts?.ghost ? ' fleet-filter-chip-ghost' : ''}`}>
        <span className="fleet-filter-chip-role">{role}:</span>
        <span className="fleet-filter-chip-label">{display}</span>
        {opts?.x && (
          <span className="fleet-filter-term-x" data-clause={opts.x.ci} data-term={opts.x.ti}>×</span>
        )}
      </span>
    )
  }

  // Render AND group box — vertical stack of chips, matching dashboard's .filter-and-group
  function renderAndGroup(
    clause: [string, string][],
    ci: number,
    opts?: { highlight?: boolean; ghostRole?: string; ghostValue?: string; showX?: boolean },
  ) {
    const cls = opts?.highlight
      ? 'fleet-filter-and-group fleet-filter-and-group-highlight'
      : 'fleet-filter-and-group fleet-filter-and-group-normal'
    return (
      <div className={cls} data-group-idx={ci}>
        {clause.map(([role, label], ti) => (
          <div key={ti}>
            {renderChip(role, label, opts?.showX ? { x: { ci, ti } } : undefined)}
          </div>
        ))}
        {opts?.ghostRole && opts?.ghostValue && (
          <div>{renderChip(opts.ghostRole, opts.ghostValue, { ghost: true })}</div>
        )}
      </div>
    )
  }

  // Render full DNF as AND group boxes separated by "or"
  function renderDnfExpression(
    dnf: [string, string][][],
    opts?: {
      showX?: boolean
      highlightIdx?: number
      ghostRole?: string
      ghostValue?: string
    },
  ) {
    const groups = dnf.map((clause, ci) => {
      const isHighlighted = opts?.highlightIdx === ci
      return (
        <div key={ci} className="fleet-filter-group-row">
          {ci > 0 && <span className="fleet-filter-or-sep">or</span>}
          {renderAndGroup(clause, ci, {
            highlight: isHighlighted,
            ghostRole: isHighlighted ? opts?.ghostRole : undefined,
            ghostValue: isHighlighted ? opts?.ghostValue : undefined,
            showX: opts?.showX,
          })}
        </div>
      )
    })

    // Show new OR group when ghosting and not highlighting any existing group
    const showNewGroup = opts?.ghostRole && opts?.ghostValue &&
      (opts?.highlightIdx === undefined || opts?.highlightIdx < 0) && dnf.length > 0

    return (
      <div className="fleet-filter-group-container">
        {groups}
        {showNewGroup && (
          <div className="fleet-filter-group-row">
            <span className="fleet-filter-or-sep">or</span>
            <div className="fleet-filter-and-group fleet-filter-and-group-highlight">
              {renderChip(opts!.ghostRole!, opts!.ghostValue!, { ghost: true })}
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div ref={overlayRef} className="fleet-filter-overlay" onPointerDown={stopEventPropagation}>
      {pillOver ? (
        /* Two-pane drop preview: top = to, bottom = from */
        <div className="fleet-filter-drop-panes">
          <div
            ref={toPaneRef}
            className={`fleet-filter-drop-pane fleet-filter-pane-to${hoveredGroup?.pane === 'to' ? ' fleet-filter-pane-active' : ''}`}
          >
            <span className="fleet-filter-pane-label">to</span>
            {toPreview ? renderDnfExpression(toPreview, {
              highlightIdx: toHighlightIdx,
            }) : (
              <div className="fleet-filter-and-group fleet-filter-and-group-highlight">
                {renderChip('to', pillOver.value, { ghost: true })}
              </div>
            )}
          </div>
          <div
            ref={fromPaneRef}
            className={`fleet-filter-drop-pane fleet-filter-pane-from${hoveredGroup?.pane === 'from' ? ' fleet-filter-pane-active' : ''}`}
          >
            <span className="fleet-filter-pane-label">from</span>
            {fromPreview ? renderDnfExpression(fromPreview, {
              highlightIdx: fromHighlightIdx,
            }) : (
              <div className="fleet-filter-and-group fleet-filter-and-group-highlight">
                {renderChip('from', pillOver.value, { ghost: true })}
              </div>
            )}
          </div>
        </div>
      ) : (
        /* Normal edit mode */
        <>
          <div className="fleet-filter-overlay-header">
            <span style={{ fontSize: 9, opacity: 0.5, textTransform: 'uppercase', letterSpacing: 0.5 }}>Filter</span>
            <span className="fleet-filter-overlay-close">×</span>
          </div>
          {filter.length === 0 ? (
            <div className="fleet-filter-empty">
              No filter — drag agent pills here
            </div>
          ) : (
            <>
              {renderDnfExpression(filter, { showX: true })}
              <div className="fleet-filter-footer">
                <span className="fleet-filter-clear">Clear all</span>
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}

/** Underlay div that mirrors textarea content, highlighting <<ref>> tokens */
function InputHighlightUnderlay({ inputRef }: { inputRef: React.RefObject<HTMLInputElement | null> }) {
  const [html, setHtml] = useState('')

  useEffect(() => {
    const el = inputRef.current as HTMLTextAreaElement | null
    if (!el) return
    const sync = () => {
      const val = el.value
      if (!val || !val.includes('«')) {
        setHtml('')
        return
      }
      // Escape HTML, then highlight «...» tokens
      const escaped = val
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
      const highlighted = escaped.replace(
        /(«.+?»)/g,
        '<span class="ref-chip-underlay">$1</span>'
      )
      setHtml(highlighted)
    }
    el.addEventListener('input', sync)
    // Also sync on external value changes (chatInsertBus)
    const observer = new MutationObserver(sync)
    observer.observe(el, { attributes: true })
    sync()
    return () => {
      el.removeEventListener('input', sync)
      observer.disconnect()
    }
  }, [inputRef])

  if (!html) return null

  return (
    <div
      className="fleet-chat-input-underlay"
      aria-hidden
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
