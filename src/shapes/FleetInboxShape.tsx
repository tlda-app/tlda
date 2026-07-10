/**
 * FleetInboxShape — a threaded, intentional message inbox for the fleet dashboard.
 *
 * Unlike the all-agent chat firehose, this panel is scoped to messages to/from
 * the logged-in human (getHumanId), grouped into per-correspondent threads. You
 * open a thread on purpose (master/detail drill-in), read it, and its unread
 * clears. The conversation view keeps one reply composer pinned below the
 * thread.
 *
 * Reuses renderChatLine (identical chip/math/link rendering to FleetChatShape)
 * and the fleet-data event store via useFleetEvents.
 */
import {
  BaseBoxShapeUtil,
  HTMLContainer,
  stopEventPropagation,
  useEditor,
  useValue,
} from 'tldraw'
import { fleetInboxProps } from '../../shared/shapes/fleet-panel-schema.mjs'
import { labelsForAgent } from '../../shared/fleet-labels.mjs'
import type { Editor, TLShapeId } from 'tldraw'
import { agentDisplayLabel, beginNativeSnapDrag, endNativeSnapDrag } from './fleet-utils'
import { FleetPanelButtonGroup } from './FleetPanelChrome'
import { isPhoneLayoutInboxShapeForOwner, pushPhonePinnedChatPane, pushPhonePinnedMarkdownPane, type FleetFilter } from './phone-pane-stack'
import { usePillDrag } from './FleetAgentsShape'
import { ChatComposer } from './ChatComposer'
import { useState, useCallback, useRef, useMemo, useEffect, useContext, memo, type CSSProperties, type Dispatch, type ReactNode, type SetStateAction } from 'react'
import { useFleetAgents, useFleetTasks, useFleetEvents, useFleetUnreadCounts, useFleetIdentity, useFleetContext, sendMessage, injectOptimisticEvent, updateOptimisticEvent, loadFleetHistoryForAgents } from '../fleet-data-adapter'
import { DocContext } from '../PanelContext'
import { fetchProofInfo } from '../docInfoCache'
import { onReloadSignal } from '../useYjsSync'
import { invalidationFromRanges } from '../invalidationGraph'
import type { DirectNode, CascadeNode } from '../invalidationGraph'
import { CascadeGraph } from './CascadeGraph'
import { FilterOverlay } from './FleetChatShape'
import katex from 'katex'
import { getActiveMacros } from '../katexMacros'
import MarkdownIt from 'markdown-it'
// @ts-ignore — vanilla JS module
import { renderChatLine, esc, timeShort } from '../fleet/chat-render.mjs'
// @ts-ignore — vanilla JS module
import { highlightSyntax, langFromFilePath } from '../fleet/utils.mjs'
// @ts-ignore — vanilla JS module
import { getHumanId } from '../fleet/fleet-data.mjs'
import { useIsInViewport } from './useIsInViewport'
import { DATABASE_HTTP } from '../activeConfig'
import { fetchMarkdownChipText, openChatMarkdownColumn, openMarkdownChipFromTarget } from './fleet-chat-markdown-open'
import { createTemporaryMarkdownPageUrl } from './FleetPillShape'
import {
  PHONE_LANE_DRAG_IDLE,
  phoneLaneCommitPx,
  rememberPhoneLanePortraitWidth,
  setPhoneGestureCandidate,
  setPhoneGestureProgress,
  setPhoneLaneDrag,
  snapToPhoneLaneIndex,
} from '../overlays/useFleetGestures'
import {
  phoneLaneDragDecision,
  phoneStackGestureCommits,
  phoneStackGestureDecision,
  phoneStackGestureProgress,
  phoneStackPopCommitPx,
} from '../wm'
import './fleet-chat.css'
import './fleet-inbox.css'

const DEFAULT_W = 360
const DEFAULT_H = 560
const FLEET_API = DATABASE_HTTP
const PHONE_ROW_FLICK_COMMIT_PX = 64
const PHONE_ROW_DOC_FLICK_COMMIT_PX = 240
const PHONE_INBOX_POP_COMMIT_PX = 56
type PhoneChatShape = {
  id: TLShapeId
  type: 'fleet-chat'
  x: number
  y: number
  props?: { filter?: FleetFilter }
}

type PhoneThreadEjectGesture = {
  pointerId: number
  mode: 'pending' | 'dragging'
  action?: 'push' | 'pop'
  x0: number
  y0: number
  startXInViewport?: number
  viewportW?: number
  lastDx: number
  lastDy: number
  maxUp: number
}

type PhoneThreadRowGesture = {
  pointerId: number
  mode: 'pending' | 'dragging'
  action?: 'stack' | 'dismiss'
  x0: number
  y0: number
  startXInViewport: number
  viewportW: number
  lastDx: number
  lastDy: number
}

type PhoneInboxAgent = {
  id: string
  name: string
  display: string
  active: string
  contextPct?: number
  labels: string[]
  unread: number
  taskText: string
}

type PhoneAgentSortMode = 'unread' | 'active' | 'name' | 'context'

function phoneAgentFilter(agentName: string): FleetFilter {
  return [[['from', agentName]], [['to', agentName]]]
}

function primaryAgentNameFromFilter(filter: FleetFilter | undefined, agents: PhoneInboxAgent[]): string {
  if (!filter?.length) return ''
  for (const clause of filter) {
    for (const [, label] of clause) {
      const agent = agents.find((a) => a.name === label || a.id === label || a.display === label)
      if (agent) return agent.name
    }
  }
  return ''
}

function phoneAgentActivity(agent: any): string {
  const ts = agent.last_active || agent.last_seen || agent.registered_at
  if (!ts) return ''
  const time = new Date(ts).getTime()
  if (!Number.isFinite(time) || time <= 0) return ''
  const age = Math.max(0, Date.now() - time)
  if (age < 60_000) return 'now'
  if (age < 3_600_000) return `${Math.floor(age / 60_000)}m`
  if (age < 86_400_000) return `${Math.floor(age / 3_600_000)}h`
  return `${Math.floor(age / 86_400_000)}d`
}

function isAtScrollBottom(el: HTMLElement, epsilon = 8): boolean {
  return el.scrollTop + el.clientHeight >= el.scrollHeight - epsilon
}

function nearestScrollableModalTarget(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null
  return target.closest(
    '.fleet-inbox-conv, .fleet-inbox-agents-mini-chat-log, .fleet-inbox-phone-agents, .fleet-inbox-detail',
  ) as HTMLElement | null
}

function canStartPhoneUpPop(target: EventTarget | null): boolean {
  if (target instanceof Element && target.closest('.fleet-inbox-pop-zone, .fleet-inbox-pop-arrow')) return true
  const scroller = nearestScrollableModalTarget(target)
  if (!scroller) return true
  if (scroller.scrollHeight <= scroller.clientHeight + 1) return true
  return isAtScrollBottom(scroller)
}

function phoneInboxPopCommitPx(): number {
  return Math.min(phoneStackPopCommitPx(phoneLaneCommitPx()), PHONE_INBOX_POP_COMMIT_PX)
}

function PhoneInboxPopZone() {
  return (
    <div className="fleet-inbox-pop-zone" aria-hidden="true">
      <div className="fleet-inbox-pop-arrow" />
    </div>
  )
}

function copySourceTemplate(text: string): string {
  return `<template class="code-block-copy-source">${esc(text)}</template>`
}

// --- Markdown renderer (same shape as FleetSearchShape's) ---
const md = new MarkdownIt({ html: true, breaks: true, linkify: true })
md.renderer.rules.fence = (tokens: any[], idx: number) => {
  const token = tokens[idx]
  const lang = token.info.trim()
  const code = token.content
  const langLabel = lang ? `<span class="code-block-lang">${lang}</span>` : ''
  const escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return `<div class="code-block-wrap"><div class="code-block-header">${langLabel}<span class="code-block-copy" title="Copy">⎘</span></div>${copySourceTemplate(code)}<pre><code>${escaped}</code></pre></div>`
}

function inboxRenderMarkdown(escapedHtml: string): string {
  let text = escapedHtml
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  text = text.replace(/<(?:task-notification|system-reminder|local-command-caveat|command-name|command-message|command-args|local-command-stdout)[^>]*>[\s\S]*?<\/(?:task-notification|system-reminder|local-command-caveat|command-name|command-message|command-args|local-command-stdout)>/g, '')
  const macros = getActiveMacros()
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

// Nick color system (mirrors FleetSearchShape's embedded chat)
const nickColors = ['nick-agent-0','nick-agent-1','nick-agent-2','nick-agent-3','nick-agent-4','nick-agent-5']
const nickHex = ['#7a9ec8','#9370db','#c8956a','#6aafb0','#b87a95','#c8b060']
const nickMap = new Map<string, string>()
const nickHexMap = new Map<string, string>()
let nickIdx = 0

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
    renderMarkdown: inboxRenderMarkdown,
    highlightSyntax,
    langFromFilePath,
    preambleMacros: {},
  }
}

function canonicalFleetParticipantId(
  value: unknown,
  agents: any[],
  myId: string | null,
  myName: string,
): string | null {
  if (typeof value !== 'string' || !value) return null
  if (myId && (value === myId || value === myName)) return myId
  const direct = agents.find((agent: any) => agent.id === value || agent.friendly_name === value)
  if (direct?.id) return direct.id
  const labelMatches = agents.filter((agent: any) => labelsForAgent(agent).includes(value))
  return labelMatches.length === 1 && labelMatches[0]?.id ? labelMatches[0].id : value
}

interface RibbonTask {
  id: string
  file: string
  lo: number
  hi: number
  pageY1: number
  pageY2: number
  staleAt: number       // when the span went stale (0 if unknown) — sort key
}

interface DocNote {
  id: string            // the math-note shape id (also the annotation-viewer target)
  text: string          // full note body, rendered in the detail view
  preview: string       // one-line text preview
  file: string
  line: number | null
  color: string
  createdAt: number     // note creation time (0 if undated) — sort key
}

// A revalidation task derived from the proof-dependency graph (structural
// invalidation). `direct` = the node's own statement source changed (it has its
// own stale ribbon span you can re-approve). `cascade` = a node it depends on
// changed, so its vetting rests on something that moved — it has no stale span
// of its own and clears when its upstream `via` node is re-approved.
interface NodeTask {
  id: string                  // proof pair id (e.g. "prop:matching-cost")
  title: string               // human title (e.g. "Proposition 8.2")
  stale: 'direct' | 'cascade'
  lo: number                  // statement start line
  hi: number                  // statement end line
  time: number                // staleAt of the originating change (sort key)
  // direct only — the stale ribbon span(s) over this node's statement, which the
  // approve action re-vets. (A node's statement can be covered by >1 span.)
  spans?: RibbonTask[]
  // cascade only — the upstream node that reached this one, and the hop count.
  via?: string
  viaTitle?: string
  depth?: number
}

// One row of the inbox, regardless of kind. The unified model behind both the
// time-interleaved stream and the grouped-by-type view.
type InboxItem =
  | { kind: 'agents'; key: 'agents'; time: number }
  | { kind: 'task'; key: string; time: number; task: RibbonTask }
  | { kind: 'node'; key: string; time: number; node: NodeTask }
  | { kind: 'note'; key: string; time: number; note: DocNote }
  | { kind: 'message'; key: string; time: number; thread: Thread }

type DetailItem =
  | { kind: 'agents'; key: 'agents' }
  | { kind: 'task'; key: string; task: RibbonTask }
  | { kind: 'node'; key: string; node: NodeTask }
  | { kind: 'note'; key: string; note: DocNote }

type SortMode = 'time' | 'type' | 'graph'

interface Thread {
  partnerId: string
  partnerName: string
  friendly: string      // stable filter value for drag-to-chat (friendly name)
  color: string         // nick hex for the drag pill
  nickClass: string
  messages: any[]       // chat events in this thread, oldest → newest
  last: any             // newest message
  lastTs: string
  unread: number
  preview: string
  markdownTag?: InboxMarkdownTag
}

interface InboxMarkdownTag {
  label: string
  path: string
  url: string
}

// Strip markdown / math / chips down to a one-line preview for the thread list.
function previewText(text: string): string {
  if (!text) return ''
  return text
    .replace(/```[\s\S]*?```/g, '⟨code⟩')
    .replace(/\$\$[\s\S]*?\$\$/g, '⟨math⟩')
    .replace(/\$[^$\n]+\$/g, '⟨math⟩')
    .replace(/[*_`#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function isMarkdownTarget(value: unknown): boolean {
  if (typeof value !== 'string' || !value) return false
  let decoded = value
  try { decoded = decodeURIComponent(value) } catch { /* keep raw */ }
  return /\.(?:md|markdown)(?:$|[?#\s)])/i.test(decoded)
}

function pathFromMarkdownUrl(value: string): string {
  try {
    const url = new URL(value, 'https://tlda.local')
    return url.searchParams.get('path') || url.searchParams.get('file') || ''
  } catch {
    const match = value.match(/[?&](?:path|file)=([^&#]+)/)
    if (!match) return ''
    try { return decodeURIComponent(match[1]) } catch { return match[1] }
  }
}

function normalizeMarkdownTag(input: { label?: unknown; path?: unknown; url?: unknown }): InboxMarkdownTag | null {
  const rawPath = typeof input.path === 'string' ? input.path.trim() : ''
  const rawUrl = typeof input.url === 'string' ? input.url.trim() : ''
  const path = rawPath || (rawUrl ? pathFromMarkdownUrl(rawUrl) : '')
  const target = path || rawUrl
  if (!isMarkdownTarget(target)) return null
  const labelSource = typeof input.label === 'string' && input.label.trim()
    ? input.label.trim()
    : target.split('/').pop() || target
  return {
    label: labelSource,
    path,
    url: rawUrl,
  }
}

function markdownTagFromAttachment(a: any): InboxMarkdownTag | null {
  if (!a || typeof a !== 'object') return null
  const path = typeof a.path === 'string' ? a.path : ''
  const url = typeof a.url === 'string' ? a.url : ''
  const name = typeof a.name === 'string' ? a.name : ''
  const title = typeof a.title === 'string' ? a.title : ''
  const rawTarget = path || url || name || title
  if (!isMarkdownTarget(rawTarget) && a.type !== 'text/markdown') return null
  return normalizeMarkdownTag({
    label: title || name || rawTarget,
    path: path || (isMarkdownTarget(url) ? pathFromMarkdownUrl(url) : ''),
    url,
  })
}

function markdownTagFromText(text: unknown): InboxMarkdownTag | null {
  if (typeof text !== 'string' || !text) return null
  const markdownLink = text.match(/\[([^\]]+)\]\(([^)\s]+(?:\.md|\.markdown)(?:[?#][^)\s]*)?)\)/i)
  if (markdownLink) {
    const url = markdownLink[2]
    return normalizeMarkdownTag({ label: markdownLink[1], path: pathFromMarkdownUrl(url), url })
  }
  const bare = text.match(/((?:https?:\/\/|\/api\/(?:read-file|file)\?|\/)[^\s)]+(?:\.md|\.markdown)(?:[?#][^\s)]*)?)/i)
  if (!bare) return null
  const url = bare[1]
  return normalizeMarkdownTag({ path: pathFromMarkdownUrl(url), url })
}

function markdownTagFromMessage(m: any): InboxMarkdownTag | null {
  const attachments = [
    ...(Array.isArray(m?.attachments) ? m.attachments : []),
    ...(Array.isArray(m?.metadata?.attachments) ? m.metadata.attachments : []),
    ...(Array.isArray(m?._inlineAttachments) ? m._inlineAttachments : []),
    ...(Array.isArray(m?.metadata?.inline_attachments) ? m.metadata.inline_attachments : []),
  ]
  for (const attachment of attachments) {
    const tag = markdownTagFromAttachment(attachment)
    if (tag) return tag
  }
  return markdownTagFromText(m?.text)
}

function markdownTagForThread(messages: any[]): InboxMarkdownTag | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const tag = markdownTagFromMessage(messages[i])
    if (tag) return tag
  }
  return undefined
}

export class FleetInboxShapeUtil extends BaseBoxShapeUtil<any> {
  static override type = 'fleet-inbox' as const
  static override props = fleetInboxProps

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
    return <FleetInboxComponent shape={shape} />
  }

  getIndicatorPath() {
    return undefined
  }

  indicator() {
    return null
  }
}

function FleetInboxInner({ shape }: { shape: any }) {
  const editor = useEditor()
  const mainEd = (typeof window !== 'undefined'
    ? (window as Window & { __tldraw_editor__?: Editor }).__tldraw_editor__
    : undefined) || editor
  const docCtx = useContext(DocContext)
  const docName = docCtx?.docName || ''
  const { w, h } = shape.props

  // Proof-dependency graph for this doc (proof-info.json `pairs[]`). The cascade
  // engine runs over it client-side, so structural invalidation needs no server
  // round-trip. Reloaded on a rebuild (the shared cache clears on signal:reload).
  const [proofInfo, setProofInfo] = useState<{ pairs?: any[] } | null>(null)
  useEffect(() => {
    if (!docName) return
    let live = true
    const load = () => { fetchProofInfo(docName).then((d) => { if (live) setProofInfo(d || null) }) }
    load()
    const off = onReloadSignal(load)
    return () => { live = false; if (typeof off === 'function') off() }
  }, [docName])
  void useValue('editing', () => editor.getEditingShapeId() === shape.id, [editor, shape.id])
  const containerRef = useRef<HTMLDivElement>(null)
  const isSelectedRef = useRef(false)
  isSelectedRef.current = useValue('isSelected', () => editor.getSelectedShapeIds().includes(shape.id), [editor, shape.id])

  // Capture-phase pointerdown so clicks inside the panel don't get hijacked by
  // tldraw's setPointerCapture (mirrors FleetSearchShape).
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    function onPointerDown(e: PointerEvent) {
      const target = e.target as HTMLElement
      if (!el!.contains(target)) return
      if (isSelectedRef.current) return
      // Let draggable names handle their own pointerdown (they start a pill drag).
      if (target.closest('.fleet-inbox-pill')) return
      editor.markEventAsHandled(e)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [editor])

  const identity = useFleetIdentity()
  const myId = identity.id || getHumanId()
  const myName = identity.name || ''

  const agents = useFleetAgents()
  const tasks = useFleetTasks()
  const ctx = useMemo(() => makeChatCtx(agents, tasks), [agents, tasks])
  // Drag a partner name → spawn a filtered chat (same pill drag as the agents panel).
  const { startDrag } = usePillDrag()

  // Scope to messages to/from me. The DNF filter resolves my labels (name + id).
  const filter = useMemo<[string, string][][] | null>(
    () => (myName || myId ? [[['to', myName || myId!]], [['from', myName || myId!]]] : null),
    [myId, myName],
  )
  const events = useFleetEvents(filter)
  const unreadCounts = useFleetUnreadCounts()
  const loadedInboxHistoryRef = useRef(new Set<string>())

  useEffect(() => {
    const ids = [myId, myName].filter((id): id is string => !!id)
    if (ids.length === 0) return
    const key = ids.join('\n')
    if (loadedInboxHistoryRef.current.has(key)) return
    loadedInboxHistoryRef.current.add(key)
    void loadFleetHistoryForAgents(ids, 500).catch((e) => {
      loadedInboxHistoryRef.current.delete(key)
      console.warn('[fleet-inbox] scoped history fetch failed:', e?.message || e)
    })
  }, [myId, myName])

  // Which thread is open (partnerId), or null = thread list.
  const [openPartner, setOpenPartner] = useState<string | null>(null)
  const [dismissedThreadKeys, setDismissedThreadKeys] = useState<Set<string>>(() => new Set())
  const [dismissedInboxItemKeys, setDismissedInboxItemKeys] = useState<Set<string>>(() => new Set())
  const [phoneAgentTarget, setPhoneAgentTarget] = useState<string>('')
  const [filterOpen, setFilterOpen] = useState(false)
  const [filterOpenByPill, setFilterOpenByPill] = useState(false)
  const [filterTargetId, setFilterTargetId] = useState<TLShapeId | null>(null)
  const [openItemKey, setOpenItemKey] = useState<string | null>(null)
  const isPhoneSurface = useValue('phone-stack-inbox-surface', () => {
    const userId = shape.props?.userId
    const deviceId = shape.props?.deviceId
    if (!userId || !deviceId) return false
    return isPhoneLayoutInboxShapeForOwner(mainEd, shape, userId, deviceId)
  }, [mainEd, shape])

  // Sort mode — time (one interleaved stream, newest first) or type (grouped
  // sections). Persisted so it sticks across reloads. Default: time.
  const [sortMode, setSortMode] = useState<SortMode>(() => {
    try { return (localStorage.getItem('fleet-inbox-sort') as SortMode) || 'time' } catch { return 'time' }
  })
  const setSort = useCallback((m: SortMode) => {
    setSortMode(m)
    try { localStorage.setItem('fleet-inbox-sort', m) } catch { /* private mode */ }
  }, [])

  // Group chat messages into per-correspondent threads.
  const threads = useMemo<Thread[]>(() => {
    if (!myId) return []
    const byPartner = new Map<string, any[]>()
    for (const ev of events) {
      if (ev.type !== 'chat') continue
      const from = canonicalFleetParticipantId(ev.from || ev.from_id || ev.agent, agents, myId, myName)
      const to = canonicalFleetParticipantId(ev.to || ev.to_id, agents, myId, myName)
      // Determine the non-me party.
      let partner: string | null = null
      if (to === myId) partner = from
      else if (from === myId) partner = to
      else continue // neither side is me (shouldn't happen given the filter)
      if (!partner || partner === myId) continue
      if (!byPartner.has(partner)) byPartner.set(partner, [])
      byPartner.get(partner)!.push(ev)
    }
    const out: Thread[] = []
    for (const [partnerId, msgs] of byPartner) {
      msgs.sort((a, b) => ((a.timestamp || '') < (b.timestamp || '') ? -1 : 1))
      const last = msgs[msgs.length - 1]
      const a = agents.find((x: any) => x.id === partnerId)
      const partnerName = a ? agentDisplayLabel(a) : partnerId.replace('fleet:', '')
      out.push({
        partnerId,
        partnerName,
        // Filters resolve friendly names, never IDs (see app-development), so the
        // drag value is the friendly name, falling back to the display name.
        friendly: (a?.friendly_name as string) || partnerName,
        nickClass: ctx.getNickClass(partnerId),
        color: ctx.getAgentColor(partnerId),
        messages: msgs,
        last,
        lastTs: last?.timestamp || '',
        unread: unreadCounts[partnerId] || 0,
        preview: previewText(last?.text || ''),
        markdownTag: markdownTagForThread(msgs),
      })
    }
    // Newest thread on top (inbox order).
    out.sort((a, b) => (a.lastTs < b.lastTs ? 1 : -1))
    return out
  }, [events, myId, myName, agents, ctx, unreadCounts])

  const threadDismissKey = useCallback((t: Thread) => `${t.partnerId}\0${t.lastTs}`, [])
  const visibleThreads = useMemo(
    () => threads.filter((t) => !dismissedThreadKeys.has(threadDismissKey(t))),
    [dismissedThreadKeys, threadDismissKey, threads],
  )
  const totalUnread = useMemo(() => visibleThreads.reduce((n, t) => n + t.unread, 0), [visibleThreads])
  const dismissInboxItem = useCallback((key: string) => {
    setDismissedInboxItemKeys((prev) => {
      const next = new Set(prev)
      next.add(key)
      return next
    })
    if (openItemKey === key) setOpenItemKey(null)
  }, [openItemKey])

  const resolvePhoneChat = useCallback((): PhoneChatShape | null => {
    const userId = shape.props?.userId
    const deviceId = shape.props?.deviceId
    if (!userId || !deviceId) return null
    const chats = mainEd.getCurrentPageShapes().filter((s: any) =>
      s.type === 'fleet-chat' &&
      s.props?.userId === userId &&
      s.props?.deviceId === deviceId,
    ) as unknown as PhoneChatShape[]
    if (chats.length === 0) return null
    if (chats.length === 1) return chats[0]

    const inboxRight = shape.x + (shape.props?.w || 0)
    const inboxTop = shape.y
    const inboxBottom = shape.y + (shape.props?.h || 0)
    const score = (chat: PhoneChatShape) => {
      const props = chat.props as { w?: number; h?: number } | undefined
      const chatTop = chat.y
      const chatBottom = chat.y + (props?.h || 0)
      const overlapsY = chatBottom > inboxTop && chatTop < inboxBottom
      const isRight = chat.x >= inboxRight - 1
      const slotPenalty = String(chat.id).includes('fleet-chat-0-') ? 0 : 100000
      return (
        (isRight ? 0 : 1000000) +
        (overlapsY ? 0 : 10000) +
        slotPenalty +
        Math.abs(chat.x - inboxRight) +
        Math.abs(chat.y - inboxTop) / 1000
      )
    }
    return [...chats].sort((a, b) => score(a) - score(b) || String(a.id).localeCompare(String(b.id)))[0]
  }, [mainEd, shape.props?.userId, shape.props?.deviceId])

  const phoneChat = useValue(
    'phone-inbox-chat-filter-target',
    (): PhoneChatShape | null => {
      const target = filterTargetId ? mainEd.getShape(filterTargetId) : resolvePhoneChat()
      return target?.type === 'fleet-chat' ? (target as unknown as PhoneChatShape) : null
    },
    [mainEd, filterTargetId, resolvePhoneChat],
  )

  const ensurePhoneChat = useCallback((nextFilter?: FleetFilter): PhoneChatShape | null => {
    let target = resolvePhoneChat()
    if (!target) {
      const result = pushPhonePinnedChatPane(mainEd, shape, nextFilter || [])
      if (!result.ok) return null
      const created = mainEd.getShape(result.createdId as TLShapeId) as any
      target = created?.type === 'fleet-chat' ? (created as unknown as PhoneChatShape) : null
    } else if (nextFilter) {
      const wasLocked = !!(target as any).isLocked
      if (wasLocked) mainEd.updateShape({ id: target.id, type: 'fleet-chat' as any, isLocked: false } as any)
      mainEd.updateShape({
        id: target.id,
        type: 'fleet-chat' as any,
        props: { filter: nextFilter },
      } as any)
      if (wasLocked) mainEd.updateShape({ id: target.id, type: 'fleet-chat' as any, isLocked: true } as any)
    }
    if (target) setFilterTargetId(target.id)
    return target
  }, [mainEd, resolvePhoneChat, shape])

  // Dragging an agent/label pill over the inbox pops the CHAT's filter overlay on
  // the inbox surface (the inbox is just a drop target — the overlay edits the
  // chat's filter). Mirrors the chat's own pill-over auto-open (FleetChatShape).
  const pillOverKey = useValue('inbox-pill-over', () => {
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

  useEffect(() => {
    if (pillOver && !filterOpen) {
      const target = ensurePhoneChat()
      if (!target) return
      setFilterTargetId(target.id)
      setFilterOpenByPill(true)
      setFilterOpen(true)
    } else if (!pillOver && filterOpenByPill) {
      setFilterOpenByPill(false)
      setFilterOpen(false)
    }
  }, [!!pillOver, ensurePhoneChat, filterOpen, filterOpenByPill])

  // Tasks group — a live projection of the understanding-ribbon's stale spans.
  // Reading the ribbon shape inside useValue keeps this reactive: re-approving a
  // span un-stales it (the ribbon shape updates), so its task auto-resolves with
  // no separate store, dedup, or clear logic. Doc-scoped: the inbox lives in this
  // doc's room, so it shows this doc's revalidation tasks.
  // Fleet panels render in a SEPARATE HUD editor, so useEditor() here is NOT the
  // doc editor. The understanding-ribbon lives in the main doc editor — read it
  // (and scroll it) via the global main editor, the same pattern FleetChatShape
  // uses. tldraw signals are reactive across editors, so useValue still re-runs
  // when the main-editor ribbon changes → tasks auto-resolve on re-approve.
  const ribbonTasks = useValue(
    'ribbon-tasks',
    () => {
      const me = (typeof window !== 'undefined' && (window as any).__tldraw_editor__) || editor
      const r = me.getShape('shape:understanding-ribbon')
      if (!r?.props?.segments) return [] as RibbonTask[]
      let segs: any[]
      try { segs = JSON.parse(r.props.segments) } catch { return [] as RibbonTask[] }
      const ribbonY = r.y
      return segs
        .filter((s) => s.stale && s.status === 'approved')
        .map((s) => {
          const lo = Math.min(s.startLine, s.endLine)
          const hi = Math.max(s.startLine, s.endLine)
          const file = (s.startFile as string) || ''
          return { id: `${file}:${lo}-${hi}`, file, lo, hi, pageY1: ribbonY + s.y1, pageY2: ribbonY + s.y2, staleAt: typeof s.staleAt === 'number' ? s.staleAt : 0 } as RibbonTask
        })
        // Stable order: topmost span first.
        .sort((a, b) => a.pageY1 - b.pageY1)
    },
    [editor],
  )

  // Structural invalidation — project the proof-dependency graph onto the live
  // stale spans. A directly-stale node is one whose own statement a stale span
  // covers; a cascade-stale node (transitively) depends on a directly-stale one,
  // so its vetting rests on something that moved. Derived, so it auto-resolves:
  // re-approving a span un-stales its node AND clears the cascade beneath it (the
  // cascade recomputes from whatever spans are still stale).
  const proofTasks = useMemo(() => {
    const ranges = ribbonTasks.map((t) => ({ lo: t.lo, hi: t.hi }))
    const { directlyStale, cascadeStale } = invalidationFromRanges(proofInfo, ranges)
    const titleOf = (n: { id: string; title?: string }) => n.title || n.id
    const titleById = new Map((proofInfo?.pairs || []).map((p: any) => [p.id, p.title || p.id]))

    const direct: NodeTask[] = directlyStale.map((n: DirectNode) => {
      const lo = n.statementLines?.[0] ?? 0
      const hi = n.statementLines?.[1] ?? 0
      // The stale span(s) over this statement — what the approve action re-vets.
      const spans = ribbonTasks.filter((t) => t.lo <= Math.max(lo, hi) && t.hi >= Math.min(lo, hi))
      const time = spans.reduce((m, s) => Math.max(m, s.staleAt), 0)
      return { id: n.id, title: titleOf(n), stale: 'direct', lo, hi, time, spans }
    })
    const timeByNode = new Map(direct.map((d) => [d.id, d.time]))
    const cascade: NodeTask[] = cascadeStale.map((n: CascadeNode) => ({
      id: n.id,
      title: titleOf(n),
      stale: 'cascade',
      lo: n.statementLines?.[0] ?? 0,
      hi: n.statementLines?.[1] ?? 0,
      via: n.via,
      viaTitle: titleById.get(n.via) || n.via,
      depth: n.depth,
      // Sort a cascade node next to the change that caused it.
      time: timeByNode.get(n.via) ?? 0,
    }))

    // Stale spans that map to no proof node stay as plain line-range tasks — they
    // are real un-vetted regions, just not a named theorem/lemma/prop statement.
    const covered = (t: RibbonTask) =>
      direct.some((d) => d.lo <= Math.max(t.lo, t.hi) && d.hi >= Math.min(t.lo, t.hi))
    const spanTasks = ribbonTasks.filter((t) => !covered(t))

    return { direct, cascade, spanTasks }
  }, [ribbonTasks, proofInfo])

  // Re-vet a directly-stale node: clear the stale flag on its originating span(s)
  // and re-anchor them to the version currently shown. Because the cascade is
  // derived, this clears the node AND every cascade node beneath it in one act —
  // Skip's approve-upstream-clears-downstream. Written through the MAIN editor
  // (fleet panels live in the HUD editor) so it persists via Yjs.
  const approveNode = useCallback((task: NodeTask) => {
    if (task.stale !== 'direct' || !task.spans?.length) return
    const me = (typeof window !== 'undefined' && (window as any).__tldraw_editor__) || editor
    const ribbon = me.getShape('shape:understanding-ribbon')
    if (!ribbon?.props?.segments) return
    const sentinel = me.getShape('shape:doc-version--sentinel')
    const commit = sentinel?.props?.commitHash && sentinel.props.commitHash !== 'unknown'
      ? String(sentinel.props.commitHash) : null
    let segs: any[]
    try { segs = JSON.parse(ribbon.props.segments) } catch { return }
    const lo = Math.min(task.lo, task.hi)
    const hi = Math.max(task.lo, task.hi)
    let changed = false
    const next = segs.map((s) => {
      if (!(s.stale && s.status === 'approved')) return s
      const slo = Math.min(s.startLine, s.endLine)
      const shi = Math.max(s.startLine, s.endLine)
      if (slo <= hi && shi >= lo) {
        changed = true
        return { ...s, stale: false, staleAt: undefined, ...(commit ? { approvedAtCommit: commit } : {}) }
      }
      return s
    })
    if (!changed) return
    me.store.update('shape:understanding-ribbon', (sh: any) => ({
      ...sh, props: { ...sh.props, segments: JSON.stringify(next) },
    }))
  }, [editor])

  // Notes group — a live projection of the doc's open (unaddressed) annotations.
  // Same pattern as the ribbon tasks: read math-note shapes from the MAIN editor
  // (fleet panels render in a separate HUD editor), keep it inside useValue so it
  // stays reactive, and let it auto-resolve — reply_note sets meta.addressed, so
  // an answered note drops out with no separate store. Doc-scoped: the inbox lives
  // in this doc's room, so these are this doc's open notes.
  const docNotes = useValue(
    'doc-notes',
    () => {
      const me = (typeof window !== 'undefined' && (window as any).__tldraw_editor__) || editor
      const shapes = me.getCurrentPageShapes().filter((s: any) => s.type === 'math-note' && s.meta?.addressed !== true)
      return shapes
        .map((s: any) => {
          const anchor = s.meta?.sourceAnchor
          return {
            id: s.id,
            text: String(s.props?.text || ''),
            preview: previewText(s.props?.text || ''),
            file: (anchor?.file as string) || '',
            line: (anchor?.line as number) ?? null,
            color: (s.props?.color as string) || '',
            createdAt: typeof s.meta?.createdAt === 'number' ? s.meta.createdAt : 0,
            _y: typeof s.y === 'number' ? s.y : 0,
          }
        })
        // Stable order: topmost note first.
        .sort((a: any, b: any) => a._y - b._y)
        .map(({ _y, ...n }: any) => n as DocNote)
    },
    [editor],
  )

  const markThreadRead = useCallback((t: Thread) => {
    const unread = t.messages.filter(
      (e: any) => canonicalFleetParticipantId(e.to || e.to_id, agents, myId, myName) === myId && e.read !== true && (e._dbId || e.id),
    )
    for (const e of unread) {
      fetch(`${FLEET_API}/api/mark-event-read`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event_id: e._dbId || e.id, agent: myId }),
      }).catch(() => {})
    }
  }, [agents, myId, myName])

  const openThread = useCallback((t: Thread) => {
    setOpenPartner(t.partnerId)
    markThreadRead(t)
  }, [markThreadRead])

  const activeThread = useMemo(
    () => (openPartner ? threads.find(t => t.partnerId === openPartner) || null : null),
    [openPartner, threads],
  )
  const contextPercent = useFleetContext(null)
  const phoneInboxAgents = useMemo<PhoneInboxAgent[]>(() => {
    const pendingTasks = tasks.filter((t: any) => t.status === 'pending' || t.status === 'in_progress')
    return agents
      .filter((agent: any) => !agent.human && !agent.dead && agent.friendly_name)
      .map((agent: any) => {
        const task = pendingTasks.find((t: any) => {
          const assignee = t.agent || t.assignee || ''
          return assignee === agent.id || assignee === agent.friendly_name
        })
        return {
          id: agent.id,
          name: agent.friendly_name,
          display: agentDisplayLabel(agent, agents),
          active: phoneAgentActivity(agent),
          contextPct: contextPercent.get(agent.id),
          labels: labelsForAgent(agent).filter((label: string) => label !== agent.friendly_name).slice(0, 8),
          unread: unreadCounts[agent.id] || 0,
          taskText: task?.description || task?.title || '',
        }
      })
      .sort((a, b) => (b.unread - a.unread) || a.display.localeCompare(b.display))
  }, [agents, contextPercent, tasks, unreadCounts])
  const ejectGestureRef = useRef<PhoneThreadEjectGesture | null>(null)

  const resetThreadEjectGesture = useCallback(() => {
    ejectGestureRef.current = null
    setPhoneLaneDrag(PHONE_LANE_DRAG_IDLE)
  }, [])

  const startThreadEjectGesture = useCallback((e: React.PointerEvent) => {
    if (!isPhoneSurface || !activeThread) return
    if (!e.isPrimary) return
    if (e.pointerType === 'mouse' && e.button !== 0) return
    const target = e.target instanceof Element ? e.target : null
    if (target?.closest('.fleet-inbox-composer-slot, .fleet-inbox-back, .fleet-inbox-filter-btn')) return
    const canPopUp = canStartPhoneUpPop(e.target)
    if (!canPopUp) return
    rememberPhoneLanePortraitWidth(mainEd)
    const commit = phoneInboxPopCommitPx()
    setPhoneGestureCandidate('up', commit, 'stack-pop')
    ejectGestureRef.current = {
      pointerId: e.pointerId,
      mode: 'pending',
      x0: e.clientX,
      y0: e.clientY,
      lastDx: 0,
      lastDy: 0,
      maxUp: 0,
      action: 'pop',
    }
    try { (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId) } catch {
      // Synthetic/offscreen pointer events may not be capturable; move/up still dispatch to this handler.
    }
    stopEventPropagation(e)
  }, [activeThread, isPhoneSurface, mainEd])

  const moveThreadEjectGesture = useCallback((e: React.PointerEvent) => {
    const gesture = ejectGestureRef.current
    if (!gesture || gesture.pointerId !== e.pointerId || !activeThread) return
    const dx = e.clientX - gesture.x0
    const dy = e.clientY - gesture.y0
    gesture.lastDx = dx
    gesture.lastDy = dy
    gesture.maxUp = Math.max(gesture.maxUp, -dy)
    const commit = phoneInboxPopCommitPx()
    const decision = gesture.mode === 'pending' ? phoneStackGestureDecision('stack-pop', dx, dy) : 'dragging'
    if (decision === 'abort') {
      resetThreadEjectGesture()
      return
    }
    if (dy <= 0 || decision === 'dragging') {
      e.preventDefault()
      stopEventPropagation(e)
    }
    setPhoneGestureProgress('up', phoneStackGestureProgress('stack-pop', dx, dy, commit), commit, 'stack-pop')
    if (gesture.mode === 'pending') {
      if (decision === 'pending') return
      gesture.mode = 'dragging'
      gesture.action = 'pop'
    }

    e.preventDefault()
    stopEventPropagation(e)
    if (gesture.action === 'pop') {
      setPhoneGestureProgress('up', phoneStackGestureProgress('stack-pop', dx, dy, commit), commit, 'stack-pop')
    }
  }, [activeThread, resetThreadEjectGesture])

  const finishThreadEjectGesture = useCallback((e: React.PointerEvent) => {
    const gesture = ejectGestureRef.current
    if (!gesture || gesture.pointerId !== e.pointerId) return
    const active = activeThread
    const commit = phoneInboxPopCommitPx()
    const shouldPop = active && gesture.mode === 'dragging' && gesture.action === 'pop' && phoneStackGestureCommits('stack-pop', gesture.lastDx, gesture.lastDy, commit)
    e.preventDefault()
    stopEventPropagation(e)
    resetThreadEjectGesture()
    if (!active) return
    if (shouldPop) {
      setOpenPartner(null)
      return
    }
    return
  }, [activeThread, mainEd, resetThreadEjectGesture, shape])

  const flickThreadToStack = useCallback((thread: Thread) => {
    const filter: FleetFilter = [[['from', thread.friendly]], [['to', thread.friendly]]]
    const result = pushPhonePinnedChatPane(mainEd, shape, filter)
    if (!result.ok) {
      console.warn('[phone-pane-stack] push-to-eject failed', result)
      return
    }
    if (openPartner === thread.partnerId) setOpenPartner(null)
    snapToPhoneLaneIndex(mainEd, result.docLeftPage, result.newIndex)
  }, [mainEd, openPartner, shape])

  const dismissThread = useCallback((thread: Thread) => {
    setDismissedThreadKeys((prev) => {
      const next = new Set(prev)
      next.add(threadDismissKey(thread))
      return next
    })
    markThreadRead(thread)
    if (openPartner === thread.partnerId) setOpenPartner(null)
  }, [markThreadRead, openPartner, threadDismissKey])

  const openInboxMarkdownTag = useCallback((tag: InboxMarkdownTag, sourceEl: HTMLElement) => {
    fetchMarkdownChipText(tag.url, tag.path)
      .then((text) => {
        const baseUrl = tag.url ? tag.url.substring(0, tag.url.lastIndexOf('/') + 1) : ''
        const markdown = baseUrl ? text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, src) => {
          if (src.startsWith('http') || src.startsWith('/')) return match
          return `![${alt}](${baseUrl}${src})`
        }) : text
        if (isPhoneSurface) {
          return createTemporaryMarkdownPageUrl(tag.label, markdown)
            .then((url) => {
              const result = pushPhonePinnedMarkdownPane(mainEd, shape, url, tag.label)
              if (!result.ok) {
                console.warn('[phone-pane-stack] push-markdown failed', result)
                return
              }
              snapToPhoneLaneIndex(mainEd, result.docLeftPage, result.newIndex)
            })
        }
        openChatMarkdownColumn({
          editor,
          sourceShapeId: shape.id,
          title: tag.label,
          markdown,
          sourceEl,
          placementEl: containerRef.current,
          logPrefix: 'fleet-inbox',
        })
      })
      .catch(() => {
        const markdown = `# Failed to load\n\n${tag.url || tag.path || tag.label}`
        if (isPhoneSurface) {
          createTemporaryMarkdownPageUrl(tag.label, markdown)
            .then((url) => {
              const result = pushPhonePinnedMarkdownPane(mainEd, shape, url, tag.label)
              if (!result.ok) {
                console.warn('[phone-pane-stack] push-markdown failed', result)
                return
              }
              snapToPhoneLaneIndex(mainEd, result.docLeftPage, result.newIndex)
            })
            .catch((err) => console.warn('[fleet-inbox] markdown phone pane create failed:', err?.message || err))
          return
        }
        openChatMarkdownColumn({
          editor,
          sourceShapeId: shape.id,
          title: tag.label,
          markdown,
          sourceEl,
          placementEl: containerRef.current,
          logPrefix: 'fleet-inbox',
        })
    })
  }, [editor, isPhoneSurface, mainEd, shape])

  const applyPhoneAgentFilter = useCallback((agent: PhoneInboxAgent) => {
    setPhoneAgentTarget(agent.name)
    ensurePhoneChat(phoneAgentFilter(agent.name))
  }, [ensurePhoneChat])

  const openableItems = useMemo<DetailItem[]>(() => [
    ...proofTasks.direct.map((n): DetailItem => ({ kind: 'node', key: `node:${n.id}`, node: n })),
    ...proofTasks.cascade.map((n): DetailItem => ({ kind: 'node', key: `node:${n.id}`, node: n })),
    ...proofTasks.spanTasks.map((t): DetailItem => ({ kind: 'task', key: `task:${t.id}`, task: t })),
    ...docNotes.map((n: DocNote): DetailItem => ({ kind: 'note', key: `note:${n.id}`, note: n })),
    ...(isPhoneSurface ? [{ kind: 'agents' as const, key: 'agents' as const }] : []),
  ], [isPhoneSurface, proofTasks, docNotes])

  const visibleDirectNodes = useMemo(
    () => proofTasks.direct.filter((n: NodeTask) => !dismissedInboxItemKeys.has(`node:${n.id}`)),
    [dismissedInboxItemKeys, proofTasks.direct],
  )
  const visibleCascadeNodes = useMemo(
    () => proofTasks.cascade.filter((n: NodeTask) => !dismissedInboxItemKeys.has(`node:${n.id}`)),
    [dismissedInboxItemKeys, proofTasks.cascade],
  )
  const visibleSpanTasks = useMemo(
    () => proofTasks.spanTasks.filter((t: RibbonTask) => !dismissedInboxItemKeys.has(`task:${t.id}`)),
    [dismissedInboxItemKeys, proofTasks.spanTasks],
  )
  const visibleDocNotes = useMemo(
    () => docNotes.filter((n: DocNote) => !dismissedInboxItemKeys.has(`note:${n.id}`)),
    [dismissedInboxItemKeys, docNotes],
  )

  const activeItem = useMemo(
    () => (openItemKey ? openableItems.find((it) => it.key === openItemKey) || null : null),
    [openItemKey, openableItems],
  )

  useEffect(() => {
    if (openItemKey && !activeItem) setOpenItemKey(null)
  }, [openItemKey, activeItem])

  const modalPopGestureRef = useRef<PhoneThreadEjectGesture | null>(null)
  const resetModalPopGesture = useCallback(() => {
    modalPopGestureRef.current = null
    setPhoneLaneDrag(PHONE_LANE_DRAG_IDLE)
  }, [])
  const startModalPopGesture = useCallback((e: React.PointerEvent) => {
    if (!isPhoneSurface || !activeItem) return
    if (!e.isPrimary) return
    if (e.pointerType === 'mouse' && e.button !== 0) return
    const target = e.target instanceof Element ? e.target : null
    if (target?.closest('.fleet-inbox-composer-slot, .fleet-inbox-back, .fleet-inbox-agents-filter-btn, .fleet-filter-overlay')) return
    if (!canStartPhoneUpPop(e.target)) return
    rememberPhoneLanePortraitWidth(mainEd)
    const commit = phoneInboxPopCommitPx()
    setPhoneGestureCandidate('up', commit, 'stack-pop')
    modalPopGestureRef.current = {
      pointerId: e.pointerId,
      mode: 'pending',
      action: 'pop',
      x0: e.clientX,
      y0: e.clientY,
      lastDx: 0,
      lastDy: 0,
      maxUp: 0,
    }
    try { (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId) } catch {
      // Synthetic/offscreen pointer events may not be capturable.
    }
  }, [activeItem, isPhoneSurface, mainEd])
  const moveModalPopGesture = useCallback((e: React.PointerEvent) => {
    const gesture = modalPopGestureRef.current
    if (!gesture || gesture.pointerId !== e.pointerId || !activeItem) return
    const dx = e.clientX - gesture.x0
    const dy = e.clientY - gesture.y0
    gesture.lastDx = dx
    gesture.lastDy = dy
    gesture.maxUp = Math.max(gesture.maxUp, -dy)
    const commit = phoneInboxPopCommitPx()
    const decision = gesture.mode === 'pending' ? phoneStackGestureDecision('stack-pop', dx, dy) : 'dragging'
    if (decision === 'abort') {
      resetModalPopGesture()
      return
    }
    if (dy <= 0 || decision === 'dragging') {
      e.preventDefault()
      stopEventPropagation(e)
    }
    setPhoneGestureProgress('up', phoneStackGestureProgress('stack-pop', dx, dy, commit), commit, 'stack-pop')
    if (gesture.mode === 'pending') {
      if (decision === 'pending') return
      gesture.mode = 'dragging'
    }
    setPhoneGestureProgress('up', phoneStackGestureProgress('stack-pop', dx, dy, commit), commit, 'stack-pop')
  }, [activeItem, resetModalPopGesture])
  const finishModalPopGesture = useCallback((e: React.PointerEvent) => {
    const gesture = modalPopGestureRef.current
    if (!gesture || gesture.pointerId !== e.pointerId) return
    const commit = phoneInboxPopCommitPx()
    const shouldPop = gesture.mode === 'dragging' && phoneStackGestureCommits('stack-pop', gesture.lastDx, gesture.lastDy, commit)
    e.preventDefault()
    stopEventPropagation(e)
    resetModalPopGesture()
    if (shouldPop) setOpenItemKey(null)
  }, [resetModalPopGesture])

  const activeTitle = activeThread
    ? activeThread.partnerName
    : activeItem?.kind === 'agents'
      ? 'agents'
    : activeItem?.kind === 'node'
      ? activeItem.node.title
      : activeItem?.kind === 'task'
        ? `lines ${activeItem.task.lo}-${activeItem.task.hi}`
        : activeItem?.kind === 'note'
          ? 'note'
          : null

  // The interleaved stream: every row as a typed item, newest first. Items with
  // no usable time (undated notes, tasks with no staleAt) sink to the bottom but
  // keep their relative order. Messages use last-activity time.
  const timeItems = useMemo<InboxItem[]>(() => {
    const items: InboxItem[] = [
      ...visibleDirectNodes.map((n): InboxItem => ({ kind: 'node', key: `node:${n.id}`, time: n.time, node: n })),
      ...visibleCascadeNodes.map((n): InboxItem => ({ kind: 'node', key: `node:${n.id}`, time: n.time, node: n })),
      ...visibleSpanTasks.map((t): InboxItem => ({ kind: 'task', key: `task:${t.id}`, time: t.staleAt, task: t })),
      ...visibleDocNotes.map((n: DocNote): InboxItem => ({ kind: 'note', key: `note:${n.id}`, time: n.createdAt, note: n })),
      ...visibleThreads.map((t): InboxItem => ({ kind: 'message', key: `msg:${t.partnerId}`, time: Date.parse(t.lastTs) || 0, thread: t })),
    ]
    return items.sort((a, b) => b.time - a.time)
  }, [visibleDirectNodes, visibleCascadeNodes, visibleSpanTasks, visibleDocNotes, visibleThreads])

  // Total revalidation tasks (node + plain-span) — drives the header badge.
  const taskCount = visibleDirectNodes.length + visibleCascadeNodes.length + visibleSpanTasks.length

  return (
    <HTMLContainer style={{ width: w, height: h, pointerEvents: 'all', overflow: 'visible' }}>
      <div
        ref={containerRef}
        className={`fleet-shape fleet-inbox-shape${isPhoneSurface ? ' phone-inbox-surface' : ''}`}
        data-phone-open-thread={activeThread ? 'true' : undefined}
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
        <FleetPanelButtonGroup editor={editor} shape={shape} />

        {filterOpen && phoneChat && activeItem?.kind !== 'agents' && (
          <FilterOverlay
            filter={phoneChat.props?.filter || []}
            shapeId={phoneChat.id}
            editor={mainEd}
            onClose={() => setFilterOpen(false)}
            externalPillOver={pillOver}
            agents={agents}
            sendTargets={[]}
          />
        )}

        {/* Header */}
        <div className="fleet-inbox-header" onPointerDown={(e) => stopEventPropagation(e)}>
          {activeThread || activeItem ? (
            <button className="fleet-inbox-back" onPointerUp={(e) => { stopEventPropagation(e); setOpenPartner(null); setOpenItemKey(null) }}>
              ← inbox
            </button>
          ) : (
            <>
              <span className="fleet-inbox-title">Inbox</span>
              {isPhoneSurface && (
                <button
                  className={`fleet-inbox-filter-btn${filterOpen ? ' active' : ''}`}
                  onPointerUp={(e) => {
                    stopEventPropagation(e)
                    const target = ensurePhoneChat()
                    if (!target) return
                    setFilterTargetId(target.id)
                    setFilterOpen(prev => !prev)
                  }}
                  title="Edit chat filter"
                >
                  <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M1 2h14M3 7h10M6 12h4"/></svg>
                </button>
              )}
            </>
          )}
          {activeThread || activeItem ? (
            activeThread ? (
              <span
                className={`fleet-inbox-thread-name fleet-inbox-pill ${activeThread.nickClass}`}
                style={{ cursor: 'grab', touchAction: 'none' }}
                onPointerDown={(e) => { e.stopPropagation(); startDrag(e, 'agent', activeThread.friendly, activeThread.partnerName, activeThread.color) }}
              >{activeThread.partnerName}</span>
            ) : (
              <span className="fleet-inbox-detail-title">{activeTitle}</span>
            )
          ) : (
            <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              {/* Sort toggle — time (interleaved) ↔ type (grouped). */}
              <span className="fleet-inbox-sort" title="Sort by">
                <button
                  className={`fleet-inbox-sort-btn${sortMode === 'time' ? ' active' : ''}`}
                  onPointerUp={(e) => { stopEventPropagation(e); setSort('time') }}
                >time</button>
                <button
                  className={`fleet-inbox-sort-btn${sortMode === 'type' ? ' active' : ''}`}
                  onPointerUp={(e) => { stopEventPropagation(e); setSort('type') }}
                >type</button>
                <button
                  className={`fleet-inbox-sort-btn${sortMode === 'graph' ? ' active' : ''}`}
                  title="Cascade graph — the invalidated proof nodes and their dependency edges"
                  onPointerUp={(e) => { stopEventPropagation(e); setSort('graph') }}
                >graph</button>
              </span>
              {taskCount > 0 && (
                <span className="fleet-inbox-task-total" title="Revalidation tasks">{taskCount}</span>
              )}
              {docNotes.length > 0 && (
                <span className="fleet-inbox-note-total" title="Open notes">{docNotes.length}</span>
              )}
              {totalUnread > 0 && <span className="fleet-inbox-unread-total">{totalUnread}</span>}
            </span>
          )}
        </div>

        {/* Body */}
        {activeThread ? (
          <ConversationView
            shapeId={shape.id}
            thread={activeThread}
            ctx={ctx}
            myId={myId}
            myName={myName}
            onEjectPointerDown={startThreadEjectGesture}
            onEjectPointerMove={moveThreadEjectGesture}
            onEjectPointerUp={finishThreadEjectGesture}
            onEjectPointerCancel={resetThreadEjectGesture}
          />
        ) : activeItem?.kind === 'agents' ? (
          <div
            className="fleet-inbox-agents-detail"
            onPointerDown={startModalPopGesture}
            onPointerMove={moveModalPopGesture}
            onPointerUp={finishModalPopGesture}
            onPointerCancel={resetModalPopGesture}
          >
            <PhoneInboxPopZone />
            <PhoneAgentsPanel
              agents={phoneInboxAgents}
              selectedTarget={phoneAgentTarget}
              onSelectTarget={applyPhoneAgentFilter}
              onStartDrag={startDrag}
              ctx={ctx}
              myId={myId}
              myName={myName}
              phoneChat={phoneChat}
              mainEd={mainEd}
              filterOpen={filterOpen}
              setFilterOpen={setFilterOpen}
              onOpenFilter={() => {
                const target = ensurePhoneChat(phoneAgentTarget ? phoneAgentFilter(phoneAgentTarget) : undefined)
                if (target) setFilterOpen(prev => !prev)
              }}
              pillOver={pillOver}
            />
          </div>
        ) : activeItem ? (
          <div
            className="fleet-inbox-modal-pop-wrap"
            onPointerDown={startModalPopGesture}
            onPointerMove={moveModalPopGesture}
            onPointerUp={finishModalPopGesture}
            onPointerCancel={resetModalPopGesture}
          >
            <PhoneInboxPopZone />
            <ItemDetail item={activeItem} onApprove={approveNode} />
          </div>
        ) : (
          <InboxList
            sortMode={sortMode}
            timeItems={timeItems}
            threads={visibleThreads}
            directNodes={visibleDirectNodes}
            cascadeNodes={visibleCascadeNodes}
            spanTasks={visibleSpanTasks}
            notes={visibleDocNotes}
            onApprove={approveNode}
            onOpen={openThread}
            onFlickThreadToStack={flickThreadToStack}
            onFlickThreadToDismiss={dismissThread}
            onOpenMarkdownTag={openInboxMarkdownTag}
            onDismissItem={dismissInboxItem}
            onOpenItem={setOpenItemKey}
            onStartDrag={startDrag}
            isPhoneSurface={isPhoneSurface}
            agentCount={phoneInboxAgents.length}
            selectedAgentTarget={phoneAgentTarget}
            showAgentsRow={!dismissedInboxItemKeys.has('agents')}
          />
        )}
      </div>
    </HTMLContainer>
  )
}

function PhoneAgentsPanel({
  agents,
  selectedTarget,
  onSelectTarget,
  onStartDrag,
  ctx,
  myId,
  myName,
  phoneChat,
  mainEd,
  filterOpen,
  setFilterOpen,
  onOpenFilter,
  pillOver,
}: {
  agents: PhoneInboxAgent[]
  selectedTarget: string
  onSelectTarget: (agent: PhoneInboxAgent) => void
  onStartDrag: ReturnType<typeof usePillDrag>['startDrag']
  ctx: any
  myId: string | null
  myName: string
  phoneChat: PhoneChatShape | null
  mainEd: Editor
  filterOpen: boolean
  setFilterOpen: Dispatch<SetStateAction<boolean>>
  onOpenFilter: () => void
  pillOver: { role: string; value: string; displayName: string } | null
}) {
  const committedFilter = phoneChat?.props?.filter || []
  const filterTarget = primaryAgentNameFromFilter(committedFilter, agents)
  const effectiveSelectedTarget = filterTarget || selectedTarget
  const selected = agents.find(agent => agent.name === effectiveSelectedTarget) || null
  const [sortMode, setSortMode] = useState<PhoneAgentSortMode>('unread')
  const filter = committedFilter.length > 0 ? committedFilter : selected ? phoneAgentFilter(selected.name) : null
  const miniEvents = useFleetEvents(filter)
  const miniChatRef = useRef<HTMLDivElement>(null)
  useWheelScroll(miniChatRef)
  const sendTargets = useMemo(() => selected ? [selected.name] : [], [selected])
  const agentNames = useMemo(() => {
    const map: Record<string, string> = {}
    if (selected) {
      map[selected.id] = selected.display
      map[selected.name] = selected.display
    }
    if (myId) map[myId] = myName || 'user'
    return map
  }, [myId, myName, selected])
  const send = useCallback((text: string, targets: string[]) => {
    if (!text || targets.length === 0) return
    const tempId = `opt-inbox-agents-${Date.now()}-${Math.random().toString(36).slice(2)}`
    injectOptimisticEvent({
      _tempId: tempId,
      type: 'chat',
      event_type: 'chat',
      from: getHumanId(),
      to: targets[0],
      text,
      timestamp: new Date().toISOString(),
      read: false,
    })
    const sendWithRetry = (attempt: number) => {
      Promise.all(targets.map((t) => sendMessage(t, text, { _tempId: tempId })))
        .then((results: { ok: boolean; event_id: number }[]) => {
          if (!results.every((r) => r.ok)) throw new Error('send failed')
        })
        .catch(() => {
          if (attempt < 3) setTimeout(() => sendWithRetry(attempt + 1), 2000 * attempt)
          else updateOptimisticEvent(tempId, { _failed: true })
        })
    }
    sendWithRetry(1)
  }, [])
  const sortedAgents = useMemo(() => {
    const activityRank = (value: string) => {
      const v = value.toLowerCase()
      if (v.includes('working') || v.includes('running')) return 0
      if (v.includes('idle')) return 1
      if (v.includes('stale')) return 2
      if (v.includes('dead') || v.includes('offline')) return 4
      return 3
    }
    return [...agents].sort((a, b) => {
      if (sortMode === 'name') return a.display.localeCompare(b.display)
      if (sortMode === 'context') return ((b.contextPct ?? -1) - (a.contextPct ?? -1)) || a.display.localeCompare(b.display)
      if (sortMode === 'active') return (activityRank(a.active) - activityRank(b.active)) || (b.unread - a.unread) || a.display.localeCompare(b.display)
      return (b.unread - a.unread) || activityRank(a.active) - activityRank(b.active) || a.display.localeCompare(b.display)
    })
  }, [agents, sortMode])
  return (
    <div className="fleet-inbox-agents-panel" data-selected-target={effectiveSelectedTarget || undefined}>
      <div className="fleet-inbox-agents-mini-chat">
        <button
          className={`fleet-inbox-agents-filter-btn${filterOpen && phoneChat ? ' active' : ''}`}
          onPointerUp={(e) => {
            stopEventPropagation(e)
            onOpenFilter()
          }}
          title="Edit chat filter"
        >
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M1 2h14M3 7h10M6 12h4"/></svg>
        </button>
        {filterOpen && phoneChat && (
          <FilterOverlay
            filter={phoneChat.props?.filter || []}
            shapeId={phoneChat.id}
            editor={mainEd}
            onClose={() => setFilterOpen(false)}
            externalPillOver={pillOver}
            agents={agents}
            sendTargets={sendTargets}
          />
        )}
        <div ref={miniChatRef} className="fleet-inbox-agents-mini-chat-log fleet-chat-shape">
          {selected ? (
            miniEvents.length > 0 ? miniEvents.map((m: any, i: number) => {
              const key = m._dbId || m.id || String(i)
              const lineHtml = renderChatLine(m, ctx)
              if (!lineHtml) return null
              const mine = m.from === myId
              return (
                <div key={key} className={`fleet-inbox-msg${mine ? ' mine' : ''}`}>
                  <div dangerouslySetInnerHTML={{ __html: lineHtml }} />
                </div>
              )
            }) : (
              <div className="fleet-inbox-agents-mini-empty">no messages</div>
            )
          ) : (
            <div className="fleet-inbox-agents-mini-empty">no filter set</div>
          )}
        </div>
        <div className="fleet-inbox-agents-composer" onPointerDown={(e) => stopEventPropagation(e)}>
          <ChatComposer
            sendTargets={sendTargets}
            agentNames={agentNames}
            onKeyboardSend={send}
            onVoiceSend={(targets, text) => send(text, targets)}
            isTouchDevice={_isTouchDevice}
            className="fleet-inbox-composer-textarea"
            placeholder={selected ? '' : 'choose agent'}
            style={COMPOSER_STYLE}
          />
        </div>
      </div>
      <div className="fleet-inbox-phone-agents-header">
        <span className="fleet-inbox-phone-agents-header-label">sort</span>
        {(['name', 'active', 'context', 'unread'] as PhoneAgentSortMode[]).map(mode => (
          <button
            key={mode}
            className={`fleet-inbox-phone-agents-sort-btn${sortMode === mode ? ' active' : ''}`}
            onPointerUp={(e) => { stopEventPropagation(e); setSortMode(mode) }}
          >
            {mode}
          </button>
        ))}
      </div>
      <div className="fleet-inbox-phone-agents">
        {agents.length === 0 ? (
          <div className="fleet-inbox-phone-agents-empty">no agents</div>
        ) : sortedAgents.map(agent => (
          <AgentPanelRow
            key={agent.id}
            agent={agent}
            selected={agent.name === effectiveSelectedTarget}
            onSelect={onSelectTarget}
            onStartDrag={onStartDrag}
          />
        ))}
      </div>
    </div>
  )
}

function AgentPanelRow({
  agent,
  selected,
  onSelect,
  onStartDrag,
}: {
  agent: PhoneInboxAgent
  selected: boolean
  onSelect: (agent: PhoneInboxAgent) => void
  onStartDrag: StartDrag
}) {
  const fallbackDragValue = agent.labels[0] || agent.name
  const fallbackDragType = agent.labels[0] ? 'label' : 'agent'
  const fallbackDragDisplay = agent.labels[0] || agent.display
  const fallbackDragColor = agent.labels[0] ? '#9370db' : '#7a9ec8'

  return (
    <div
      className={`fleet-inbox-phone-agent${selected ? ' selected' : ''}`}
      style={{ touchAction: 'pan-y' }}
    >
      <div
        className="fleet-inbox-phone-agent-name-zone fleet-inbox-pill"
        onPointerDown={(e) => onStartDrag(e, 'agent', agent.name, agent.display, '#7a9ec8')}
      >
        <span className="fleet-inbox-phone-agent-name">{agent.display}</span>
      </div>
      <div
        className="fleet-inbox-phone-agent-scroll-zone"
        onPointerUp={(e) => { stopEventPropagation(e); onSelect(agent) }}
      >
        <span className="fleet-inbox-phone-agent-activity">{agent.active}</span>
        {agent.contextPct != null && <span className="fleet-inbox-phone-agent-context">{Math.round(agent.contextPct)}%</span>}
        {agent.unread > 0 && <span className="fleet-inbox-phone-agent-unread">{agent.unread}</span>}
      </div>
      <div
        className="fleet-inbox-phone-agent-label-zone fleet-inbox-pill"
        onPointerDown={(e) => {
          const target = e.target instanceof Element ? e.target : null
          const label = target?.closest<HTMLElement>('.fleet-inbox-phone-agent-label')?.dataset.label || fallbackDragValue
          const pillType = agent.labels.includes(label) ? 'label' : fallbackDragType
          const display = pillType === 'label' ? label : fallbackDragDisplay
          const color = pillType === 'label' ? '#9370db' : fallbackDragColor
          onStartDrag(e, pillType, label, display, color)
        }}
      >
        {agent.labels.length > 0 ? (
          <span className="fleet-inbox-phone-agent-labels">
            {agent.labels.map(label => (
              <span
                key={label}
                className="fleet-inbox-phone-agent-label"
                data-label={label}
              >{label}</span>
            ))}
          </span>
        ) : agent.taskText ? (
          <span className="fleet-inbox-phone-agent-task">{agent.taskText}</span>
        ) : (
          <span className="fleet-inbox-phone-agent-label-placeholder" />
        )}
      </div>
    </div>
  )
}

// Scroll like a chat: TLDraw grabs the wheel in the capture phase for canvas
// pan/zoom, so a panel's overflow div never scrolls on its own. Intercept the
// wheel on the container in the capture phase and scroll it ourselves — same
// pattern FleetChatShape uses for its backscroll.
// TLDraw grabs the wheel in the capture phase for canvas pan/zoom, so a panel's
// overflow div never scrolls on its own — this intercepts the wheel and scrolls
// it ourselves. `innerSelector`: when the pointer is over a NESTED scroller that
// matches it (e.g. an open mini-chat's body inside the thread), scroll THAT
// element instead of this one. One reliable handler (this outer one is the one
// that actually fires) rather than relying on a fragile nested-listener hand-off.
function useWheelScroll(ref: { current: HTMLDivElement | null }, innerSelector?: string) {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const inner = innerSelector && e.target instanceof Element
        ? (e.target.closest(innerSelector) as HTMLElement | null)
        : null
      if (inner && inner.scrollHeight > inner.clientHeight) inner.scrollTop += e.deltaY
      else el.scrollTop += e.deltaY
    }
    el.addEventListener('wheel', onWheel, { capture: true, passive: false })
    return () => el.removeEventListener('wheel', onWheel, { capture: true } as any)
  }, [ref, innerSelector])
}

type StartDrag = (e: React.PointerEvent, pillType: 'agent' | 'label', value: string, displayName: string, color: string) => void

// --- Row components — one per kind, shared by both the grouped and the
// interleaved renderers so the two views can't visually drift. ---

function TaskRow({ t, onOpen }: { t: RibbonTask; onOpen?: () => void }) {
  return (
    <div className="fleet-inbox-task" onPointerUp={onOpen ? (e) => { stopEventPropagation(e); onOpen() } : undefined}>
      <div className="fleet-inbox-task-row">
        <span className="fleet-inbox-task-icon">⟳</span>
        <span className="fleet-inbox-task-text">Re-vet lines {t.lo}–{t.hi}</span>
      </div>
      <div className="fleet-inbox-task-sub">changed since you approved{t.file ? ` · ${t.file}` : ''}</div>
    </div>
  )
}

// A proof-graph revalidation task. Direct = its own statement changed (offers an
// approve action that re-vets it and clears its cascade); cascade = it depends on
// a changed node (shows the `via` link, resolves when the upstream is approved).
function NodeRow({ task, onApprove, onOpen }: {
  task: NodeTask
  onApprove: (t: NodeTask) => void
  onOpen?: () => void
}) {
  if (task.stale === 'cascade') {
    return (
      <div className="fleet-inbox-node fleet-inbox-node-cascade" onPointerUp={onOpen ? (e) => { stopEventPropagation(e); onOpen() } : undefined}>
        <div className="fleet-inbox-node-row">
          <span className="fleet-inbox-node-icon cascade">↯</span>
          <span className="fleet-inbox-node-title">{task.title}</span>
        </div>
        <div className="fleet-inbox-node-sub">depends on {task.viaTitle}{task.depth && task.depth > 1 ? ` · ${task.depth} hops` : ''}</div>
      </div>
    )
  }
  return (
    <div className="fleet-inbox-node fleet-inbox-node-direct" onPointerUp={onOpen ? (e) => { stopEventPropagation(e); onOpen() } : undefined}>
      <div className="fleet-inbox-node-row">
        <span className="fleet-inbox-node-icon">⟳</span>
        <span className="fleet-inbox-node-title">{task.title}</span>
        <button
          className="fleet-inbox-node-approve"
          title="Re-vet — clears this and everything downstream"
          onPointerUp={(e) => { stopEventPropagation(e); onApprove(task) }}
        >approve</button>
      </div>
      <div className="fleet-inbox-node-sub">statement changed · lines {task.lo}–{task.hi}</div>
    </div>
  )
}

function NoteRow({ n, onOpen }: { n: DocNote; onOpen?: () => void }) {
  return (
    <div className="fleet-inbox-note" onPointerUp={onOpen ? (e) => { stopEventPropagation(e); onOpen() } : undefined}>
      <div className="fleet-inbox-note-row">
        <span className="fleet-inbox-note-dot" style={n.color ? { color: n.color } : undefined}>●</span>
        <span className="fleet-inbox-note-text">{n.preview || '(empty note)'}</span>
      </div>
      <div className="fleet-inbox-note-sub">open{n.line != null ? ` · line ${n.line}` : ''}{n.file ? ` · ${n.file}` : ''}</div>
    </div>
  )
}

function AgentsRow({ count, selectedTarget, onOpen }: { count: number; selectedTarget: string; onOpen: () => void }) {
  return (
    <div className="fleet-inbox-agents-row" onPointerUp={(e) => { stopEventPropagation(e); onOpen() }}>
      <div className="fleet-inbox-agents-row-main">
        <span className="fleet-inbox-agents-row-icon">◎</span>
        <span className="fleet-inbox-agents-row-title">Agents</span>
        <span className="fleet-inbox-agents-row-count">{count}</span>
      </div>
      <div className="fleet-inbox-agents-row-sub">
        {selectedTarget ? `filtered to ${selectedTarget}` : 'filter existing chat'}
      </div>
    </div>
  )
}

function PhoneDismissibleInboxRow({
  itemKey,
  enabled,
  onDismiss,
  onPush,
  onTap,
  children,
}: {
  itemKey: string
  enabled: boolean
  onDismiss: (key: string) => void
  onPush?: (key: string) => void
  onTap?: (key: string) => void
  children: ReactNode
}) {
  const editor = useEditor()
  const gestureRef = useRef<PhoneThreadRowGesture | null>(null)
  const yieldedPointerRef = useRef<number | null>(null)
  const [progress, setProgress] = useState(0)
  const [action, setAction] = useState<'stack' | 'dismiss' | null>(null)
  const resetGesture = useCallback(() => {
    gestureRef.current = null
    setProgress(0)
    setAction(null)
  }, [])
  const handlePointerDownCapture = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!enabled || !e.isPrimary) return
    if (e.pointerType === 'mouse' && e.button !== 0) return
    const target = e.target instanceof Element ? e.target : null
    if (target?.closest('button, input, textarea, select, .fleet-inbox-pill, .ref-chip, .md-file-card')) return
    const viewport = editor.getViewportScreenBounds()
    yieldedPointerRef.current = null
    gestureRef.current = {
      pointerId: e.pointerId,
      mode: 'pending',
      x0: e.clientX,
      y0: e.clientY,
      startXInViewport: e.clientX - viewport.x,
      viewportW: viewport.w || window.innerWidth || 0,
      lastDx: 0,
      lastDy: 0,
    }
    try { e.currentTarget.setPointerCapture?.(e.pointerId) } catch {
      // Synthetic/offscreen pointer events may not be capturable.
    }
  }, [editor, enabled])
  const handlePointerMoveCapture = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== e.pointerId) return
    const dx = e.clientX - gesture.x0
    const dy = e.clientY - gesture.y0
    gesture.lastDx = dx
    gesture.lastDy = dy
    if (gesture.mode === 'pending') {
      const decision = phoneLaneDragDecision(dx, dy)
      if (decision === 'abort') {
        resetGesture()
        return
      }
      if (decision === 'pending') return
      gesture.mode = 'dragging'
      gesture.action = dx < 0 ? 'stack' : 'dismiss'
      setAction(gesture.action)
    }
    const actionDx = gesture.action === 'stack' ? Math.max(0, -dx) : Math.max(0, dx)
    if (actionDx <= 0) {
      setProgress(0)
      return
    }
    e.preventDefault()
    stopEventPropagation(e)
    setProgress(Math.min(1, actionDx / PHONE_ROW_FLICK_COMMIT_PX))
  }, [resetGesture])
  const handlePointerUpCapture = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (yieldedPointerRef.current === e.pointerId) {
      yieldedPointerRef.current = null
      return
    }
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== e.pointerId) return
    const shouldDismiss = gesture.mode === 'dragging' && gesture.action === 'dismiss' && gesture.lastDx >= PHONE_ROW_FLICK_COMMIT_PX
    const shouldPush = gesture.mode === 'dragging' && gesture.action === 'stack' && -gesture.lastDx >= PHONE_ROW_FLICK_COMMIT_PX
    const shouldTap = gesture.mode === 'pending'
    if (gesture.mode === 'dragging') {
      e.preventDefault()
      stopEventPropagation(e)
    }
    resetGesture()
    if (shouldDismiss) onDismiss(itemKey)
    else if (shouldPush) onPush?.(itemKey)
    else if (shouldTap) onTap?.(itemKey)
  }, [itemKey, onDismiss, onPush, onTap, resetGesture])
  return (
    <div
      className={`fleet-inbox-dismissible-row${progress > 0 && action ? ` phone-row-${action}${progress >= 1 ? ' action-armed' : ''}` : ''}`}
      style={{
        touchAction: 'pan-y',
        '--phone-row-progress': String(progress),
      } as CSSProperties}
      onPointerDownCapture={handlePointerDownCapture}
      onPointerMoveCapture={handlePointerMoveCapture}
      onPointerUpCapture={handlePointerUpCapture}
      onPointerCancelCapture={(e) => {
        if (yieldedPointerRef.current === e.pointerId) yieldedPointerRef.current = null
        resetGesture()
      }}
    >
      <div className="fleet-inbox-thread-action fleet-inbox-thread-action-stack" aria-hidden="true">
        <span className="fleet-inbox-thread-action-icon">
          <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12H8" />
            <path d="m12 6-6 6 6 6" />
          </svg>
        </span>
      </div>
      <div className="fleet-inbox-thread-action fleet-inbox-thread-action-dismiss" aria-hidden="true">
        <span className="fleet-inbox-thread-action-icon">
          <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 12h10" />
            <path d="m9 8 4 4-4 4" />
            <path d="M15 6h6" />
            <path d="M17 6V4h2v2" />
            <path d="m20 6-.7 14h-4.6L14 6" />
          </svg>
        </span>
      </div>
      {children}
    </div>
  )
}

function MessageRow({
  t,
  onOpen,
  onFlickToStack,
  onFlickToDismiss,
  onOpenMarkdownTag,
  onStartDrag,
  isPhoneSurface,
}: {
  t: Thread
  onOpen: (t: Thread) => void
  onFlickToStack: (t: Thread) => void
  onFlickToDismiss: (t: Thread) => void
  onOpenMarkdownTag: (tag: InboxMarkdownTag, sourceEl: HTMLElement) => void
  onStartDrag: StartDrag
  isPhoneSurface: boolean
}) {
  const editor = useEditor()
  const gestureRef = useRef<PhoneThreadRowGesture | null>(null)
  const yieldedPointerRef = useRef<number | null>(null)
  const [rowGesture, setRowGesture] = useState<{ action: 'stack' | 'dismiss'; progress: number; armed: boolean; docProgress: number; docArmed: boolean } | null>(null)
  const resetGesture = useCallback(() => {
    gestureRef.current = null
    setRowGesture(null)
  }, [])
  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!isPhoneSurface || !e.isPrimary) return
    if (e.pointerType === 'mouse' && e.button !== 0) return
    const target = e.target instanceof Element ? e.target : null
    if (!isPhoneSurface && target?.closest('.fleet-inbox-pill')) return
    yieldedPointerRef.current = null
    const viewport = editor.getViewportScreenBounds()
    const startXInViewport = e.clientX - viewport.x
    const viewportW = viewport.w || window.innerWidth || 0
    gestureRef.current = {
      pointerId: e.pointerId,
      mode: 'pending',
      x0: e.clientX,
      y0: e.clientY,
      startXInViewport,
      viewportW,
      lastDx: 0,
      lastDy: 0,
    }
    try { e.currentTarget.setPointerCapture?.(e.pointerId) } catch {
      // Synthetic/offscreen pointer events may not be capturable.
    }
  }, [editor, isPhoneSurface])
  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== e.pointerId) return
    const dx = e.clientX - gesture.x0
    const dy = e.clientY - gesture.y0
    gesture.lastDx = dx
    gesture.lastDy = dy
    if (gesture.mode === 'pending') {
      const decision = phoneLaneDragDecision(dx, dy)
      if (decision === 'abort') {
        resetGesture()
        return
      }
      if (decision === 'pending') return
      gesture.mode = 'dragging'
      gesture.action = dx < 0 ? 'stack' : 'dismiss'
    }

    if (!gesture.action) return
    const actionDx = gesture.action === 'stack' ? Math.max(0, -dx) : Math.max(0, dx)
    if (actionDx <= 0) {
      setRowGesture(null)
      return
    }
    e.preventDefault()
    stopEventPropagation(e)
    const progress = Math.min(1, actionDx / PHONE_ROW_FLICK_COMMIT_PX)
    const docProgress = gesture.action === 'stack' && t.markdownTag
      ? Math.min(1, Math.max(0, (actionDx - PHONE_ROW_FLICK_COMMIT_PX) / (PHONE_ROW_DOC_FLICK_COMMIT_PX - PHONE_ROW_FLICK_COMMIT_PX)))
      : 0
    setRowGesture({ action: gesture.action, progress, armed: progress >= 1, docProgress, docArmed: docProgress >= 1 })
  }, [resetGesture, t.markdownTag])
  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const target = e.target instanceof Element ? e.target : null
    if (!isPhoneSurface && target?.closest('.fleet-inbox-pill')) return
    if (yieldedPointerRef.current === e.pointerId) {
      yieldedPointerRef.current = null
      return
    }
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== e.pointerId) {
      stopEventPropagation(e)
      onOpen(t)
      return
    }
    const distance = gesture.action === 'stack'
      ? Math.max(0, -gesture.lastDx)
      : gesture.action === 'dismiss'
        ? Math.max(0, gesture.lastDx)
        : 0
    const shouldCommit = gesture.mode === 'dragging' && distance >= PHONE_ROW_FLICK_COMMIT_PX
    const wasDragging = gesture.mode === 'dragging'
    const action = gesture.action
    const shouldCommitDoc = gesture.mode === 'dragging' && action === 'stack' && !!t.markdownTag && distance >= PHONE_ROW_DOC_FLICK_COMMIT_PX
    resetGesture()
    stopEventPropagation(e)
    if (shouldCommitDoc && t.markdownTag) onOpenMarkdownTag(t.markdownTag, e.currentTarget)
    else if (shouldCommit && action === 'stack') onFlickToStack(t)
    else if (shouldCommit && action === 'dismiss') onFlickToDismiss(t)
    else if (!wasDragging) onOpen(t)
  }, [isPhoneSurface, onFlickToDismiss, onFlickToStack, onOpen, onOpenMarkdownTag, resetGesture, t])

  return (
    <div
      className={`fleet-inbox-thread${t.unread > 0 ? ' unread' : ''}${rowGesture ? ` phone-row-${rowGesture.action}${rowGesture.armed ? ' action-armed' : ''}${rowGesture.docArmed ? ' doc-action-armed' : ''}` : ''}`}
      data-markdown-tag={t.markdownTag ? 'true' : undefined}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={(e) => {
        if (yieldedPointerRef.current === e.pointerId) yieldedPointerRef.current = null
        resetGesture()
      }}
      style={{
        touchAction: 'pan-y',
        '--phone-row-progress': rowGesture ? String(rowGesture.progress) : '0',
        '--phone-row-doc-progress': rowGesture ? String(rowGesture.docProgress) : '0',
      } as CSSProperties}
    >
      {isPhoneSurface && (
        <>
          <div className="fleet-inbox-thread-action fleet-inbox-thread-action-stack" aria-hidden="true">
            <span className="fleet-inbox-thread-action-icon">
              <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 12H5" />
                <path d="M12 5 5 12l7 7" />
                <path d="M19 6h2v12h-2" />
              </svg>
            </span>
            {t.markdownTag && <span className="fleet-inbox-thread-action-doc-head" />}
          </div>
          <div className="fleet-inbox-thread-action fleet-inbox-thread-action-dismiss" aria-hidden="true">
            <span className="fleet-inbox-thread-action-icon">
              <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 12h10" />
                <path d="m9 8 4 4-4 4" />
                <path d="M15 6h6" />
                <path d="M17 6V4h2v2" />
                <path d="m20 6-.7 14h-4.6L14 6" />
              </svg>
            </span>
          </div>
        </>
      )}
      <div className="fleet-inbox-thread-row">
        <span
          className={`fleet-inbox-thread-partner fleet-inbox-pill ${t.nickClass}`}
          style={isPhoneSurface ? undefined : { cursor: 'grab', touchAction: 'none' }}
          onPointerDown={isPhoneSurface ? undefined : (e) => { e.stopPropagation(); onStartDrag(e, 'agent', t.friendly, t.partnerName, t.color) }}
        >{t.partnerName}</span>
        <span className="fleet-inbox-thread-time">{timeShort(t.lastTs)}</span>
        {t.unread > 0 && <span className="fleet-inbox-thread-badge">{t.unread}</span>}
      </div>
      <div className="fleet-inbox-thread-preview-row">
        {t.markdownTag && (
          <span
            className="fleet-inbox-markdown-chip"
            title={t.markdownTag.path || t.markdownTag.url || t.markdownTag.label}
          >
            <span className="fleet-inbox-markdown-chip-icon">doc</span>
            <span className="fleet-inbox-markdown-chip-label">{t.markdownTag.label}</span>
          </span>
        )}
        <span className="fleet-inbox-thread-preview">
          {t.markdownTag && /\{\{att:\d+\}\}/.test(t.preview) ? 'markdown attachment' : (t.preview || '…')}
        </span>
      </div>
    </div>
  )
}

interface InboxListProps {
  sortMode: SortMode
  timeItems: InboxItem[]
  threads: Thread[]
  directNodes: NodeTask[]
  cascadeNodes: NodeTask[]
  spanTasks: RibbonTask[]
  notes: DocNote[]
  onApprove: (t: NodeTask) => void
  onOpen: (t: Thread) => void
  onFlickThreadToStack: (t: Thread) => void
  onFlickThreadToDismiss: (t: Thread) => void
  onOpenMarkdownTag: (tag: InboxMarkdownTag, sourceEl: HTMLElement) => void
  onDismissItem: (key: string) => void
  onOpenItem: (key: string) => void
  onStartDrag: StartDrag
  isPhoneSurface: boolean
  agentCount: number
  selectedAgentTarget: string
  showAgentsRow: boolean
}

function InboxList(props: InboxListProps) {
  const { sortMode, timeItems, threads, directNodes, cascadeNodes, spanTasks, notes, onApprove, onOpen, onFlickThreadToStack, onFlickThreadToDismiss, onOpenMarkdownTag, onDismissItem, onOpenItem, onStartDrag, isPhoneSurface, agentCount, selectedAgentTarget, showAgentsRow } = props
  const listRef = useRef<HTMLDivElement>(null)
  useWheelScroll(listRef)

  const empty = threads.length === 0 && directNodes.length === 0 && cascadeNodes.length === 0 && spanTasks.length === 0 && notes.length === 0

  const renderItem = (it: InboxItem) => {
    if (it.kind === 'agents') return null
    if (it.kind === 'task') return <PhoneDismissibleInboxRow key={it.key} itemKey={it.key} enabled={isPhoneSurface} onDismiss={onDismissItem} onPush={onOpenItem} onTap={onOpenItem}><TaskRow t={it.task} onOpen={() => onOpenItem(it.key)} /></PhoneDismissibleInboxRow>
    if (it.kind === 'node') return <PhoneDismissibleInboxRow key={it.key} itemKey={it.key} enabled={isPhoneSurface} onDismiss={onDismissItem} onPush={onOpenItem} onTap={onOpenItem}><NodeRow task={it.node} onApprove={onApprove} onOpen={() => onOpenItem(it.key)} /></PhoneDismissibleInboxRow>
    if (it.kind === 'note') return <PhoneDismissibleInboxRow key={it.key} itemKey={it.key} enabled={isPhoneSurface} onDismiss={onDismissItem} onPush={onOpenItem} onTap={onOpenItem}><NoteRow n={it.note} onOpen={() => onOpenItem(it.key)} /></PhoneDismissibleInboxRow>
    return <MessageRow key={it.key} t={it.thread} onOpen={onOpen} onFlickToStack={onFlickThreadToStack} onFlickToDismiss={onFlickThreadToDismiss} onOpenMarkdownTag={onOpenMarkdownTag} onStartDrag={onStartDrag} isPhoneSurface={isPhoneSurface} />
  }

  return (
    <div ref={listRef} className="fleet-inbox-list">
      {isPhoneSurface && showAgentsRow && (
        <PhoneDismissibleInboxRow itemKey="agents" enabled={isPhoneSurface} onDismiss={onDismissItem} onPush={onOpenItem} onTap={onOpenItem}>
          <AgentsRow count={agentCount} selectedTarget={selectedAgentTarget} onOpen={() => onOpenItem('agents')} />
        </PhoneDismissibleInboxRow>
      )}
      {empty && !isPhoneSurface && sortMode !== 'graph' && <div className="fleet-inbox-empty">no messages yet</div>}

      {sortMode === 'graph' ? (
        // The cascade rendered as an actual dependency graph — directly-stale
        // roots up top, the nodes that rest on them below, edges following the
        // cascade. Approve a root to re-vet it and clear everything beneath it.
        <div className="fleet-inbox-graph-wrap">
          <CascadeGraph
            nodes={[...directNodes, ...cascadeNodes]}
            width={336}
            onApprove={(id) => { const t = directNodes.find((d) => d.id === id); if (t) onApprove(t) }}
          />
        </div>
      ) : sortMode === 'time' ? (
        // Interleaved stream — every kind, newest first.
        timeItems.map(renderItem)
      ) : (
        // Grouped by type — Tasks (direct + plain spans), Cascade, Notes, Messages.
        <>
          {(directNodes.length > 0 || spanTasks.length > 0) && (
            <div className="fleet-inbox-tasks">
              <div className="fleet-inbox-group-label">Tasks</div>
              {directNodes.map((t) => <PhoneDismissibleInboxRow key={t.id} itemKey={`node:${t.id}`} enabled={isPhoneSurface} onDismiss={onDismissItem} onPush={onOpenItem} onTap={onOpenItem}><NodeRow task={t} onApprove={onApprove} onOpen={() => onOpenItem(`node:${t.id}`)} /></PhoneDismissibleInboxRow>)}
              {spanTasks.map((t) => <PhoneDismissibleInboxRow key={t.id} itemKey={`task:${t.id}`} enabled={isPhoneSurface} onDismiss={onDismissItem} onPush={onOpenItem} onTap={onOpenItem}><TaskRow t={t} onOpen={() => onOpenItem(`task:${t.id}`)} /></PhoneDismissibleInboxRow>)}
            </div>
          )}
          {cascadeNodes.length > 0 && (
            <div className="fleet-inbox-cascade">
              <div className="fleet-inbox-group-label">Cascade</div>
              {cascadeNodes.map((t) => <PhoneDismissibleInboxRow key={t.id} itemKey={`node:${t.id}`} enabled={isPhoneSurface} onDismiss={onDismissItem} onPush={onOpenItem} onTap={onOpenItem}><NodeRow task={t} onApprove={onApprove} onOpen={() => onOpenItem(`node:${t.id}`)} /></PhoneDismissibleInboxRow>)}
            </div>
          )}
          {notes.length > 0 && (
            <div className="fleet-inbox-notes">
              <div className="fleet-inbox-group-label">Notes</div>
              {notes.map((n) => <PhoneDismissibleInboxRow key={n.id} itemKey={`note:${n.id}`} enabled={isPhoneSurface} onDismiss={onDismissItem} onPush={onOpenItem} onTap={onOpenItem}><NoteRow n={n} onOpen={() => onOpenItem(`note:${n.id}`)} /></PhoneDismissibleInboxRow>)}
            </div>
          )}
          {threads.length > 0 && (
            <div className="fleet-inbox-messages">
              <div className="fleet-inbox-group-label">Messages</div>
              {threads.map((t) => <MessageRow key={t.partnerId} t={t} onOpen={onOpen} onFlickToStack={onFlickThreadToStack} onFlickToDismiss={onFlickThreadToDismiss} onOpenMarkdownTag={onOpenMarkdownTag} onStartDrag={onStartDrag} isPhoneSurface={isPhoneSurface} />)}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function ItemDetail({ item, onApprove }: { item: Exclude<DetailItem, { kind: 'agents' }>; onApprove: (t: NodeTask) => void }) {
  const detailRef = useRef<HTMLDivElement>(null)
  useWheelScroll(detailRef)

  if (item.kind === 'note') {
    const note = item.note
    const html = inboxRenderMarkdown(esc(note.text || note.preview || '(empty note)'))
    return (
      <div ref={detailRef} className="fleet-inbox-detail">
        <div className="fleet-inbox-detail-kicker">Open note</div>
        <div className="fleet-inbox-detail-body" dangerouslySetInnerHTML={{ __html: html }} />
        <div className="fleet-inbox-detail-meta">{note.line != null ? `line ${note.line}` : 'unanchored'}{note.file ? ` · ${note.file}` : ''}</div>
      </div>
    )
  }

  if (item.kind === 'task') {
    const task = item.task
    return (
      <div ref={detailRef} className="fleet-inbox-detail">
        <div className="fleet-inbox-detail-kicker">Revalidation task</div>
        <div className="fleet-inbox-detail-heading">Re-vet lines {task.lo}-{task.hi}</div>
        <div className="fleet-inbox-detail-meta">{task.file || 'current source'}</div>
        <div className="fleet-inbox-detail-copy">This approved span changed after vetting. It stays in the stack until the live ribbon span is re-approved.</div>
      </div>
    )
  }

  const node = item.node
  const cascade = node.stale === 'cascade'
  return (
    <div ref={detailRef} className="fleet-inbox-detail">
      <div className="fleet-inbox-detail-kicker">{cascade ? 'Cascade task' : 'Revalidation task'}</div>
      <div className="fleet-inbox-detail-heading">{node.title}</div>
      <div className="fleet-inbox-detail-meta">lines {node.lo}-{node.hi}</div>
      {cascade ? (
        <div className="fleet-inbox-detail-copy">Depends on {node.viaTitle || node.via}{node.depth && node.depth > 1 ? ` through ${node.depth} hops` : ''}. It clears when the upstream proof node is re-approved.</div>
      ) : (
        <>
          <div className="fleet-inbox-detail-copy">The statement source changed after approval. Re-approving it clears this task and downstream cascade entries.</div>
          <button
            className="fleet-inbox-detail-approve"
            onPointerUp={(e) => { stopEventPropagation(e); onApprove(node) }}
          >approve</button>
        </>
      )}
    </div>
  )
}

function ConversationView({
  shapeId,
  thread,
  ctx,
  myId,
  myName,
  onEjectPointerDown,
  onEjectPointerMove,
  onEjectPointerUp,
  onEjectPointerCancel,
}: {
  shapeId: TLShapeId
  thread: Thread
  ctx: any
  myId: string | null
  myName: string
  onEjectPointerDown: (e: React.PointerEvent) => void
  onEjectPointerMove: (e: React.PointerEvent) => void
  onEjectPointerUp: (e: React.PointerEvent) => void
  onEjectPointerCancel: () => void
}) {
  const editor = useEditor()
  const scrollRef = useRef<HTMLDivElement>(null)
  const wasNearBottomRef = useRef(true)
  const downTargetRef = useRef<HTMLElement | null>(null)
  const suppressNativeChipClickUntilRef = useRef(0)
  useWheelScroll(scrollRef)

  const updateNearBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    wasNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
  }, [])

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [])

  // Pin to bottom when switching threads.
  useEffect(() => {
    wasNearBottomRef.current = true
    scrollToBottom()
  }, [thread.partnerId, scrollToBottom])

  // Follow new/local messages only while the user is already reading the bottom.
  useEffect(() => {
    if (wasNearBottomRef.current) scrollToBottom()
  }, [thread.messages.length, scrollToBottom])

  const sendTargets = useMemo(() => [thread.friendly], [thread.friendly])
  const agentNames = useMemo(() => {
    const map: Record<string, string> = { [thread.partnerId]: thread.partnerName }
    if (myId) map[myId] = myName || 'user'
    return map
  }, [thread.partnerId, thread.partnerName, myId, myName])

  const send = useCallback((text: string, targets: string[]) => {
    if (!text || targets.length === 0) return
    const tempId = `opt-inbox-${Date.now()}-${Math.random().toString(36).slice(2)}`
    injectOptimisticEvent({
      _tempId: tempId,
      type: 'chat',
      event_type: 'chat',
      from: getHumanId(),
      to: targets[0],
      text,
      timestamp: new Date().toISOString(),
      read: false,
    })
    wasNearBottomRef.current = true
    setTimeout(scrollToBottom, 0)
    const sendWithRetry = (attempt: number) => {
      Promise.all(targets.map((t) => sendMessage(t, text, { _tempId: tempId })))
        .then((results: { ok: boolean; event_id: number }[]) => {
          if (!results.every((r) => r.ok)) throw new Error('send failed')
        })
        .catch(() => {
          if (attempt < 3) setTimeout(() => sendWithRetry(attempt + 1), 2000 * attempt)
          else updateOptimisticEvent(tempId, { _failed: true })
        })
    }
    sendWithRetry(1)
  }, [scrollToBottom])

  const openMarkdownColumn = useCallback((title: string, markdown: string, sourceEl: HTMLElement) => {
    openChatMarkdownColumn({
      editor,
      sourceShapeId: shapeId,
      title,
      markdown,
      sourceEl,
      placementEl: scrollRef.current,
      logPrefix: 'fleet-inbox',
    })
  }, [editor, shapeId])

  const openMarkdownChipFromEventTarget = useCallback((target: EventTarget | null, stopPropagation: () => void) => {
    if (!(target instanceof HTMLElement)) return false
    return openMarkdownChipFromTarget({ target, stopPropagation, openMarkdownColumn })
  }, [openMarkdownColumn])

  const handleConversationClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (Date.now() < suppressNativeChipClickUntilRef.current) return
    if (openMarkdownChipFromEventTarget(e.target, () => e.stopPropagation())) return
  }, [openMarkdownChipFromEventTarget])

  const handleConversationPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const target = e.target instanceof HTMLElement ? e.target.closest('.ref-chip-doc, .md-file-card') as HTMLElement | null : null
    downTargetRef.current = target
  }, [])

  const handleConversationPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const target = downTargetRef.current
    downTargetRef.current = null
    if (!target) return
    if (!e.currentTarget.contains(target)) return
    if (openMarkdownChipFromEventTarget(target, () => stopEventPropagation(e))) {
      suppressNativeChipClickUntilRef.current = Date.now() + 700
    }
  }, [openMarkdownChipFromEventTarget])

  return (
    <>
      <div
        ref={scrollRef}
        className="fleet-inbox-conv fleet-chat-shape"
        onScroll={updateNearBottom}
        onClick={handleConversationClick}
        onPointerDown={(e) => {
          handleConversationPointerDown(e)
          onEjectPointerDown(e)
        }}
        onPointerMove={onEjectPointerMove}
        onPointerUp={(e) => {
          handleConversationPointerUp(e)
          onEjectPointerUp(e)
        }}
        onPointerCancel={onEjectPointerCancel}
        style={{ touchAction: 'pan-y' }}
      >
        {thread.messages.map((m, i) => {
          const key = m._dbId || m.id || String(i)
          const lineHtml = renderChatLine(m, ctx)
          if (!lineHtml) return null
          const mine = m.from === myId
          return (
            <div key={key} className={`fleet-inbox-msg${mine ? ' mine' : ''}`}>
              <div dangerouslySetInnerHTML={{ __html: lineHtml }} />
            </div>
          )
        })}
      </div>
      <div
        className="fleet-inbox-thread-pop-layer"
        onPointerDown={onEjectPointerDown}
        onPointerMove={onEjectPointerMove}
        onPointerUp={onEjectPointerUp}
        onPointerCancel={onEjectPointerCancel}
      >
        <PhoneInboxPopZone />
      </div>
      <div className="fleet-inbox-composer-slot" onPointerDown={(e) => stopEventPropagation(e)}>
        <ChatComposer
          sendTargets={sendTargets}
          agentNames={agentNames}
          onKeyboardSend={send}
          onVoiceSend={(targets, text) => send(text, targets)}
          isTouchDevice={_isTouchDevice}
          className="fleet-inbox-composer-textarea"
          style={COMPOSER_STYLE}
        />
      </div>
    </>
  )
}

type ComposerStyle = React.CSSProperties & { fieldSizing?: 'content' }

const COMPOSER_STYLE: ComposerStyle = {
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
  fieldSizing: 'content',
  minHeight: 'calc(1.4em + 10px)',
  maxHeight: 200,
}
const _isTouchDevice = (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0)

const FleetInboxComponent = memo(function FleetInboxComponent({ shape }: { shape: any }) {
  const { w, h } = shape.props as { w: number; h: number }
  const isInViewport = useIsInViewport(shape.id)
  if (!isInViewport) {
    return <HTMLContainer id={shape.id}><div style={{ width: w, height: h }} /></HTMLContainer>
  }
  return <FleetInboxInner shape={shape} />
}, (prev, next) => prev.shape.props === next.shape.props)
