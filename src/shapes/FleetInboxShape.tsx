/**
 * FleetInboxShape — a threaded, intentional message inbox for the fleet dashboard.
 *
 * Unlike the all-agent chat firehose, this panel is scoped to messages to/from
 * the logged-in human (getHumanId), grouped into per-correspondent threads. You
 * open a thread on purpose (master/detail drill-in), read it, and its unread
 * clears. Read-only in v1; the conversation view reserves a composer slot so a
 * reply box drops in cleanly later.
 *
 * Reuses renderChatLine (identical chip/math/link rendering to FleetChatShape)
 * and the fleet-data event store via useFleetEvents.
 */
import {
  BaseBoxShapeUtil,
  HTMLContainer,
  T,
  stopEventPropagation,
  useEditor,
  useValue,
} from 'tldraw'
import { agentDisplayName } from './fleet-utils'
import { usePillDrag } from './FleetAgentsShape'
import { ChatComposer } from './ChatComposer'
import { useState, useCallback, useRef, useMemo, useEffect, useContext, memo } from 'react'
import { useFleetAgents, useFleetTasks, useFleetEvents, useFleetUnreadCounts, useFleetIdentity, sendMessage, injectOptimisticEvent, updateOptimisticEvent } from '../fleet-data-adapter'
import { DocContext } from '../PanelContext'
import { fetchProofInfo } from '../docInfoCache'
import { onReloadSignal } from '../useYjsSync'
import { invalidationFromRanges } from '../invalidationGraph'
import type { DirectNode, CascadeNode } from '../invalidationGraph'
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
import './fleet-chat.css'
import './fleet-inbox.css'

const DEFAULT_W = 360
const DEFAULT_H = 560
const FLEET_API = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:5176'

// --- Markdown renderer (same shape as FleetSearchShape's) ---
const md = new MarkdownIt({ html: true, breaks: true, linkify: true })
md.renderer.rules.fence = (tokens: any[], idx: number) => {
  const token = tokens[idx]
  const lang = token.info.trim()
  const code = token.content
  const langLabel = lang ? `<span class="code-block-lang">${lang}</span>` : ''
  const escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return `<div class="code-block-wrap"><div class="code-block-header">${langLabel}<span class="code-block-copy" title="Copy">⎘</span></div><pre><code>${escaped}</code></pre></div>`
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
    if (a) return agentDisplayName(a)
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
  | { kind: 'task'; key: string; time: number; task: RibbonTask }
  | { kind: 'node'; key: string; time: number; node: NodeTask }
  | { kind: 'note'; key: string; time: number; note: DocNote }
  | { kind: 'message'; key: string; time: number; thread: Thread }

type SortMode = 'time' | 'type'

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

export class FleetInboxShapeUtil extends BaseBoxShapeUtil<any> {
  static override type = 'fleet-inbox' as const
  static override props = {
    w: T.number,
    h: T.number,
    userId: T.optional(T.string),
    deviceId: T.optional(T.string),
  }

  getDefaultProps() {
    return { w: DEFAULT_W, h: DEFAULT_H, userId: '', deviceId: '' }
  }

  override canEdit = () => true
  override canResize = () => true
  override canBind = () => false
  override hideRotateHandle = () => true

  component(shape: any) {
    return <FleetInboxComponent shape={shape} />
  }

  indicator() {
    return null
  }
}

function FleetInboxInner({ shape }: { shape: any }) {
  const editor = useEditor()
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
    () => (myName ? [[['to', myName]], [['from', myName]]] : null),
    [myName],
  )
  const events = useFleetEvents(filter)
  const unreadCounts = useFleetUnreadCounts()

  // Which thread is open (partnerId), or null = thread list.
  const [openPartner, setOpenPartner] = useState<string | null>(null)

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
      const from = ev.from
      const to = ev.to
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
      const partnerName = a ? agentDisplayName(a) : partnerId.replace('fleet:', '')
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
      })
    }
    // Newest thread on top (inbox order).
    out.sort((a, b) => (a.lastTs < b.lastTs ? 1 : -1))
    return out
  }, [events, myId, agents, ctx, unreadCounts])

  const totalUnread = useMemo(() => threads.reduce((n, t) => n + t.unread, 0), [threads])

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

  // Hover a task → preview the span in the annotation viewer (the same hover→
  // pin→go mechanism chat references use); the viewer handles pin/navigation
  // itself when clicked. A task click never moves the main doc.
  const showTaskPreview = useCallback(
    (t: RibbonTask, el: HTMLElement) => {
      const me = (typeof window !== 'undefined' && (window as any).__tldraw_editor__) || editor
      const pages = me.getCurrentPageShapes().filter((s: any) => s.type === 'svg-page')
      let pb: any = null
      for (const p of pages) {
        const b = me.getShapePageBounds(p.id)
        if (b && t.pageY1 >= b.minY - 4 && t.pageY1 <= b.maxY + 4) { pb = b; break }
      }
      if (!pb && pages.length) pb = me.getShapePageBounds(pages[0].id)
      if (!pb) return
      const PAD = 40
      const bounds = { x: pb.x, y: t.pageY1 - PAD, w: pb.w, h: Math.max(t.pageY2 - t.pageY1, 20) + PAD * 2 }
      const r = el.getBoundingClientRect()
      window.dispatchEvent(new CustomEvent('annotation-viewer-show', {
        detail: {
          bounds, shapeIds: [], label: `lines ${t.lo}–${t.hi}`,
          chipRect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height },
        },
      }))
    },
    [editor],
  )
  const hideTaskPreview = useCallback((e: React.MouseEvent) => {
    const related = e.relatedTarget as HTMLElement | null
    if (related?.closest?.('.annotation-viewer')) return
    window.dispatchEvent(new CustomEvent('annotation-viewer-hide'))
  }, [])

  // Hover a directly-stale node → preview the stale span over its statement (the
  // same hover→pin→go path the line-range tasks use). Cascade nodes have no span
  // of their own, so they don't preview here — navigating the cascade is the
  // graph render's job.
  const showNodePreview = useCallback(
    (task: NodeTask, el: HTMLElement) => {
      const span = task.spans?.[0]
      if (span) showTaskPreview(span, el)
    },
    [showTaskPreview],
  )

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

  // Hover a note → preview it in the annotation viewer (same hover→pin→go path as
  // the tasks and as chat references). The viewer targets the note shape itself,
  // so it frames the note in place; a note click never moves the main doc.
  const showNotePreview = useCallback(
    (n: DocNote, el: HTMLElement) => {
      const me = (typeof window !== 'undefined' && (window as any).__tldraw_editor__) || editor
      const b = me.getShapePageBounds(n.id)
      if (!b) return
      const PAD = 40
      const bounds = { x: b.x - PAD, y: b.y - PAD, w: b.w + PAD * 2, h: b.h + PAD * 2 }
      const r = el.getBoundingClientRect()
      window.dispatchEvent(new CustomEvent('annotation-viewer-show', {
        detail: {
          bounds, shapeIds: [n.id], label: n.line != null ? `note · line ${n.line}` : 'note',
          chipRect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height },
        },
      }))
    },
    [editor],
  )

  const openThread = useCallback((t: Thread) => {
    setOpenPartner(t.partnerId)
    // Mark-as-read: clear unread for incoming messages in this thread.
    const unread = t.messages.filter(
      (e: any) => e.to === myId && e.read !== true && (e._dbId || e.id),
    )
    for (const e of unread) {
      fetch(`${FLEET_API}/api/mark-event-read`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event_id: e._dbId || e.id, agent: myId }),
      }).catch(() => {})
    }
  }, [myId])

  const activeThread = useMemo(
    () => (openPartner ? threads.find(t => t.partnerId === openPartner) || null : null),
    [openPartner, threads],
  )

  // The interleaved stream: every row as a typed item, newest first. Items with
  // no usable time (undated notes, tasks with no staleAt) sink to the bottom but
  // keep their relative order. Messages use last-activity time.
  const timeItems = useMemo<InboxItem[]>(() => {
    const items: InboxItem[] = [
      ...proofTasks.direct.map((n): InboxItem => ({ kind: 'node', key: `node:${n.id}`, time: n.time, node: n })),
      ...proofTasks.cascade.map((n): InboxItem => ({ kind: 'node', key: `node:${n.id}`, time: n.time, node: n })),
      ...proofTasks.spanTasks.map((t): InboxItem => ({ kind: 'task', key: `task:${t.id}`, time: t.staleAt, task: t })),
      ...docNotes.map((n: DocNote): InboxItem => ({ kind: 'note', key: `note:${n.id}`, time: n.createdAt, note: n })),
      ...threads.map((t): InboxItem => ({ kind: 'message', key: `msg:${t.partnerId}`, time: Date.parse(t.lastTs) || 0, thread: t })),
    ]
    return items.sort((a, b) => b.time - a.time)
  }, [proofTasks, docNotes, threads])

  // Total revalidation tasks (node + plain-span) — drives the header badge.
  const taskCount = proofTasks.direct.length + proofTasks.cascade.length + proofTasks.spanTasks.length

  return (
    <HTMLContainer style={{ width: w, height: h, pointerEvents: 'all', overflow: 'visible' }}>
      <div
        ref={containerRef}
        className="fleet-shape fleet-inbox-shape"
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
            onPointerUp={(e) => { e.stopPropagation(); editor.deleteShapes([shape.id]) }}
          >×</button>
          <button
            className="fleet-layout-btn"
            onPointerUp={(e) => { e.stopPropagation(); editor.setCurrentTool('select'); editor.select(shape.id) }}
            title="Resize / move"
          >⊞</button>
        </div>

        {/* Header */}
        <div className="fleet-inbox-header" onPointerDown={(e) => stopEventPropagation(e)}>
          {activeThread ? (
            <button className="fleet-inbox-back" onPointerUp={(e) => { stopEventPropagation(e); setOpenPartner(null) }}>
              ← inbox
            </button>
          ) : (
            <span className="fleet-inbox-title">Inbox</span>
          )}
          {activeThread ? (
            <span
              className={`fleet-inbox-thread-name fleet-inbox-pill ${activeThread.nickClass}`}
              style={{ cursor: 'grab', touchAction: 'none' }}
              onPointerDown={(e) => { e.stopPropagation(); startDrag(e, 'agent', activeThread.friendly, activeThread.partnerName, activeThread.color) }}
            >{activeThread.partnerName}</span>
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
          <ConversationView thread={activeThread} ctx={ctx} myId={myId} myName={myName} />
        ) : (
          <InboxList
            sortMode={sortMode}
            timeItems={timeItems}
            threads={threads}
            directNodes={proofTasks.direct}
            cascadeNodes={proofTasks.cascade}
            spanTasks={proofTasks.spanTasks}
            notes={docNotes}
            onTaskHover={showTaskPreview}
            onNodeHover={showNodePreview}
            onApprove={approveNode}
            onNoteHover={showNotePreview}
            onItemLeave={hideTaskPreview}
            onOpen={openThread}
            onStartDrag={startDrag}
          />
        )}
      </div>
    </HTMLContainer>
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

function TaskRow({ t, onHover, onLeave }: { t: RibbonTask; onHover: (t: RibbonTask, el: HTMLElement) => void; onLeave: (e: React.MouseEvent) => void }) {
  return (
    <div className="fleet-inbox-task" onMouseEnter={(e) => onHover(t, e.currentTarget)} onMouseLeave={onLeave}>
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
function NodeRow({ task, onApprove, onHover, onLeave }: {
  task: NodeTask
  onApprove: (t: NodeTask) => void
  onHover: (t: NodeTask, el: HTMLElement) => void
  onLeave: (e: React.MouseEvent) => void
}) {
  if (task.stale === 'cascade') {
    return (
      <div className="fleet-inbox-node fleet-inbox-node-cascade">
        <div className="fleet-inbox-node-row">
          <span className="fleet-inbox-node-icon cascade">↯</span>
          <span className="fleet-inbox-node-title">{task.title}</span>
        </div>
        <div className="fleet-inbox-node-sub">depends on {task.viaTitle}{task.depth && task.depth > 1 ? ` · ${task.depth} hops` : ''}</div>
      </div>
    )
  }
  return (
    <div
      className="fleet-inbox-node fleet-inbox-node-direct"
      onMouseEnter={(e) => onHover(task, e.currentTarget)}
      onMouseLeave={onLeave}
    >
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

function NoteRow({ n, onHover, onLeave }: { n: DocNote; onHover: (n: DocNote, el: HTMLElement) => void; onLeave: (e: React.MouseEvent) => void }) {
  return (
    <div className="fleet-inbox-note" onMouseEnter={(e) => onHover(n, e.currentTarget)} onMouseLeave={onLeave}>
      <div className="fleet-inbox-note-row">
        <span className="fleet-inbox-note-dot" style={n.color ? { color: n.color } : undefined}>●</span>
        <span className="fleet-inbox-note-text">{n.preview || '(empty note)'}</span>
      </div>
      <div className="fleet-inbox-note-sub">open{n.line != null ? ` · line ${n.line}` : ''}{n.file ? ` · ${n.file}` : ''}</div>
    </div>
  )
}

function MessageRow({ t, onOpen, onStartDrag }: { t: Thread; onOpen: (t: Thread) => void; onStartDrag: StartDrag }) {
  return (
    <div
      className={`fleet-inbox-thread${t.unread > 0 ? ' unread' : ''}`}
      onPointerUp={(e) => { stopEventPropagation(e); onOpen(t) }}
    >
      <div className="fleet-inbox-thread-row">
        <span
          className={`fleet-inbox-thread-partner fleet-inbox-pill ${t.nickClass}`}
          style={{ cursor: 'grab', touchAction: 'none' }}
          onPointerDown={(e) => { e.stopPropagation(); onStartDrag(e, 'agent', t.friendly, t.partnerName, t.color) }}
        >{t.partnerName}</span>
        <span className="fleet-inbox-thread-time">{timeShort(t.lastTs)}</span>
        {t.unread > 0 && <span className="fleet-inbox-thread-badge">{t.unread}</span>}
      </div>
      <div className="fleet-inbox-thread-preview">{t.preview || '…'}</div>
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
  onTaskHover: (t: RibbonTask, el: HTMLElement) => void
  onNodeHover: (t: NodeTask, el: HTMLElement) => void
  onApprove: (t: NodeTask) => void
  onNoteHover: (n: DocNote, el: HTMLElement) => void
  onItemLeave: (e: React.MouseEvent) => void
  onOpen: (t: Thread) => void
  onStartDrag: StartDrag
}

function InboxList(props: InboxListProps) {
  const { sortMode, timeItems, threads, directNodes, cascadeNodes, spanTasks, notes, onTaskHover, onNodeHover, onApprove, onNoteHover, onItemLeave, onOpen, onStartDrag } = props
  const listRef = useRef<HTMLDivElement>(null)
  useWheelScroll(listRef)

  const empty = threads.length === 0 && directNodes.length === 0 && cascadeNodes.length === 0 && spanTasks.length === 0 && notes.length === 0

  const renderItem = (it: InboxItem) => {
    if (it.kind === 'task') return <TaskRow key={it.key} t={it.task} onHover={onTaskHover} onLeave={onItemLeave} />
    if (it.kind === 'node') return <NodeRow key={it.key} task={it.node} onApprove={onApprove} onHover={onNodeHover} onLeave={onItemLeave} />
    if (it.kind === 'note') return <NoteRow key={it.key} n={it.note} onHover={onNoteHover} onLeave={onItemLeave} />
    return <MessageRow key={it.key} t={it.thread} onOpen={onOpen} onStartDrag={onStartDrag} />
  }

  return (
    <div ref={listRef} className="fleet-inbox-list">
      {empty && <div className="fleet-inbox-empty">no messages yet</div>}

      {sortMode === 'time' ? (
        // Interleaved stream — every kind, newest first.
        timeItems.map(renderItem)
      ) : (
        // Grouped by type — Tasks (direct + plain spans), Cascade, Notes, Messages.
        <>
          {(directNodes.length > 0 || spanTasks.length > 0) && (
            <div className="fleet-inbox-tasks">
              <div className="fleet-inbox-group-label">Tasks</div>
              {directNodes.map((t) => <NodeRow key={t.id} task={t} onApprove={onApprove} onHover={onNodeHover} onLeave={onItemLeave} />)}
              {spanTasks.map((t) => <TaskRow key={t.id} t={t} onHover={onTaskHover} onLeave={onItemLeave} />)}
            </div>
          )}
          {cascadeNodes.length > 0 && (
            <div className="fleet-inbox-cascade">
              <div className="fleet-inbox-group-label">Cascade</div>
              {cascadeNodes.map((t) => <NodeRow key={t.id} task={t} onApprove={onApprove} onHover={onNodeHover} onLeave={onItemLeave} />)}
            </div>
          )}
          {notes.length > 0 && (
            <div className="fleet-inbox-notes">
              <div className="fleet-inbox-group-label">Notes</div>
              {notes.map((n) => <NoteRow key={n.id} n={n} onHover={onNoteHover} onLeave={onItemLeave} />)}
            </div>
          )}
          {threads.length > 0 && (
            <div className="fleet-inbox-messages">
              <div className="fleet-inbox-group-label">Messages</div>
              {threads.map((t) => <MessageRow key={t.partnerId} t={t} onOpen={onOpen} onStartDrag={onStartDrag} />)}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function ConversationView({ thread, ctx, myId, myName }: { thread: Thread; ctx: any; myId: string | null; myName: string }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  // Outer thread scroll — and when the pointer's over an open mini-chat's body,
  // scroll THAT instead (the mini-chat's own scroll → dual context).
  useWheelScroll(scrollRef, '.fleet-inbox-inline-body')
  // Which message has its inline chat open (one at a time — opening a new one
  // replaces the old, per Skip's design).
  const [inlineOpenId, setInlineOpenId] = useState<string | null>(null)
  // Pin to bottom when the thread opens (newest message visible, like a chat).
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [thread.partnerId, thread.messages.length])
  // Close the inline chat when switching threads.
  useEffect(() => { setInlineOpenId(null) }, [thread.partnerId])

  return (
    <>
      <div ref={scrollRef} className="fleet-inbox-conv fleet-chat-shape">
        {thread.messages.map((m, i) => {
          const key = m._dbId || m.id || String(i)
          // Open: the clicked message is REPLACED in place by the chat, anchored
          // on that line (not a chat inserted below).
          if (inlineOpenId === key) {
            return (
              <InlineConvoChat
                key={key}
                thread={thread}
                ctx={ctx}
                myId={myId}
                myName={myName}
                anchorKey={key}
                onClose={() => setInlineOpenId(null)}
              />
            )
          }
          const lineHtml = renderChatLine(m, ctx)
          if (!lineHtml) return null
          const mine = m.from === myId
          return (
            <div key={key} className={`fleet-inbox-msg${mine ? ' mine' : ''}`}>
              <div dangerouslySetInnerHTML={{ __html: lineHtml }} />
              {/* ↗ — open a chat in place of this message. Bottom-right so it's
                  reachable on a long message (hidden until the message is hovered). */}
              <span
                className="fleet-inbox-open-arrow"
                title="Open chat here"
                onPointerUp={(e) => { stopEventPropagation(e); setInlineOpenId(key) }}
              >↗</span>
            </div>
          )
        })}
      </div>
      {/* Composer slot — read-only in v1; a reply box drops in here. */}
      <div className="fleet-inbox-composer-slot" />
    </>
  )
}

// A live chat for this conversation, rendered inline in the flow as a
// message-shaped block (Piece 3, model A). It's Skip's primary send surface: a
// live message list (renderChatLine over the convo events) + the shared
// ChatComposer (same textarea + voice registration + send-on-enter the fleet
// chat shape uses). The drag handle detaches it onto the canvas as a real,
// persistent fleet-chat — reusing the same pill-drag → fleet-chat path the
// partner names use, so the dropped chat is owned + filtered to this convo.
const COMPOSER_STYLE: React.CSSProperties = {
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
} as any
const _isTouchDevice = (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0)

function InlineConvoChat({ thread, ctx, myId, myName, anchorKey, onClose }: {
  thread: Thread
  ctx: any
  myId: string | null
  myName: string
  anchorKey: string
  onClose: () => void
}) {
  const bodyRef = useRef<HTMLDivElement>(null)
  // (Wheel scroll for this body is handled by the parent ConversationView's
  // single delegating handler — see useWheelScroll(innerSelector) — so there's
  // no competing nested listener here.)
  // Anchor on the message the chat opened from: scroll so that line sits at the
  // top of the window (the message you clicked is what you see), and the
  // "back to the message" control re-runs this.
  const scrollToAnchor = useCallback(() => {
    const el = bodyRef.current
    if (!el) return
    const target = el.querySelector(`[data-msg-key="${CSS.escape(anchorKey)}"]`) as HTMLElement | null
    el.scrollTop = target ? Math.max(0, target.offsetTop - 4) : el.scrollHeight
  }, [anchorKey])
  useEffect(() => { scrollToAnchor() }, [scrollToAnchor])

  // Sending in this conversation goes to the partner. (Matches the chat shape's
  // sendTargets = the filter's "to" labels; here that's the partner's name.)
  const sendTargets = useMemo(() => [thread.friendly], [thread.friendly])
  const agentNames = useMemo(() => {
    const map: Record<string, string> = { [thread.partnerId]: thread.partnerName }
    if (myId) map[myId] = myName || 'user'
    return map
  }, [thread.partnerId, thread.partnerName, myId, myName])

  // The send executor — optimistic echo + retrying send via the same primitives
  // the fleet chat uses (sendMessage). Keyboard and voice share it (the inline
  // chat has none of the chat shape's keyboard/voice divergence).
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

  return (
    <div className="fleet-inbox-inline-chat fleet-chat-shape" onPointerDown={(e) => stopEventPropagation(e)}>
      <div ref={bodyRef} className="fleet-inbox-inline-body">
        {thread.messages.map((m, i) => {
          const lineHtml = renderChatLine(m, ctx)
          if (!lineHtml) return null
          const mine = m.from === myId
          const key = m._dbId || m.id || String(i)
          return (
            <div key={key} data-msg-key={key} className={`fleet-inbox-msg${mine ? ' mine' : ''}${key === anchorKey ? ' anchor' : ''}`}>
              <div dangerouslySetInnerHTML={{ __html: lineHtml }} />
            </div>
          )
        })}
      </div>
      <div className="fleet-inbox-inline-composer">
        <ChatComposer
          sendTargets={sendTargets}
          agentNames={agentNames}
          onKeyboardSend={send}
          onVoiceSend={(targets, text) => send(text, targets)}
          isTouchDevice={_isTouchDevice}
          style={COMPOSER_STYLE}
        />
      </div>
      {/* Tiny, faint controls in the bottom corners (Skip: same size as the ×,
          undistracting). Left = back to the message; right = close. */}
      <span
        className="fleet-inbox-inline-reset"
        title="Back to the message"
        onPointerUp={(e) => { stopEventPropagation(e); scrollToAnchor() }}
      >⤺</span>
      <span
        className="fleet-inbox-inline-close"
        title="Close"
        onPointerUp={(e) => { stopEventPropagation(e); onClose() }}
      >×</span>
    </div>
  )
}

const FleetInboxComponent = memo(function FleetInboxComponent({ shape }: { shape: any }) {
  const { w, h } = shape.props as { w: number; h: number }
  const isInViewport = useIsInViewport(shape.id)
  if (!isInViewport) {
    return <HTMLContainer id={shape.id}><div style={{ width: w, height: h }} /></HTMLContainer>
  }
  return <FleetInboxInner shape={shape} />
}, (prev, next) => prev.shape.props === next.shape.props)
