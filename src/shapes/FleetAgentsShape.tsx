/**
 * FleetAgentsShape — tldraw canvas shape showing fleet agents as a clean HTML table.
 *
 * Uses fleet-data.mjs (via adapter) for live SSE updates — no polling.
 * Agent names and label chips are draggable — on pointerdown, an ephemeral
 * fleet-pill shape is created and follows the pointer. Dropping on a
 * fleet-chat updates its filter; dropping on empty canvas creates a new chat.
 */
import {
  BaseBoxShapeUtil,
  HTMLContainer,
  T,
  stopEventPropagation,
  useEditor,
  useValue,
  createShapeId,
} from 'tldraw'
import { useState, useCallback, useMemo, useRef, useEffect, memo } from 'react'
import { useFleetAgents, useFleetTasks, useFleetUnreadCounts, useFleetContext, searchFleet, hibernateSession, spawnAgent } from '../fleet-data-adapter'
import { dropPillOnTarget } from './FleetPillShape'
import { agentDisplayName } from './fleet-utils'
import { AgentName } from './PhaseIcon'
import { dragCoordinator } from './dragCoordinator'
import { useIsInViewport } from './useIsInViewport'


const DEFAULT_W = 340
const DEFAULT_H = 400

const MODEL_SHORTHANDS: Record<string, string> = {
  'opus': 'opus', 'opus45': 'opus45', 'opus46': 'opus46', 'opus47': 'opus47', 'opus48': 'opus48',
  'sonnet': 'sonnet', 'haiku': 'haiku',
  '45': 'opus45', '46': 'opus46', '47': 'opus47', '48': 'opus48',
  's': 'sonnet', 'h': 'haiku',
  'o45': 'opus45', 'o46': 'opus46', 'o47': 'opus47', 'o48': 'opus48',
}

const ALL_MODELS = ['opus', 'opus45', 'opus46', 'opus47', 'opus48', 'sonnet', 'haiku']
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']
const EFFORT_SHORTHANDS: Record<string, string> = {
  'lo': 'low', 'low': 'low', 'l': 'low',
  'med': 'medium', 'medium': 'medium', 'm': 'medium',
  'hi': 'high', 'high': 'high', 'h': 'high',
  'xhi': 'xhigh', 'xhigh': 'xhigh', 'xh': 'xhigh', 'x': 'xhigh',
  'max': 'max',
}
const DEFAULT_MODEL = 'opus48'
const DEFAULT_EFFORT = 'medium'
const CAT_NAMES = [
  'whiskers', 'mittens', 'shadow', 'luna', 'mochi', 'pepper', 'nugget', 'biscuit',
  'pickles', 'waffles', 'noodle', 'tofu', 'gizmo', 'beans', 'ziggy', 'cleo',
  'fig', 'olive', 'pixel', 'sprout', 'taco', 'chai', 'dumpling', 'mango',
  'pebble', 'sage', 'jinx', 'kiwi', 'marble', 'rumble',
]

function parseSpawnInput(raw: string): { doc: string; name: string | undefined; model: string | undefined; effort: string | undefined } {
  const parts = raw.split(':')
  const doc = parts[0]
  if (parts.length === 2 && MODEL_SHORTHANDS[parts[1]]) {
    return { doc, name: undefined, model: MODEL_SHORTHANDS[parts[1]], effort: undefined }
  }
  const name = parts[1] || undefined
  const modelRaw = parts[2] || undefined
  const model = modelRaw ? (MODEL_SHORTHANDS[modelRaw] || modelRaw) : undefined
  const effortRaw = parts[3] || undefined
  const effort = effortRaw ? (EFFORT_SHORTHANDS[effortRaw] || undefined) : undefined
  return { doc, name, model, effort }
}

const ALL_COMPLETABLE = [...ALL_MODELS, ...Object.keys(MODEL_SHORTHANDS)]
  .filter((v, i, a) => a.indexOf(v) === i)
const ALL_EFFORT_COMPLETABLE = [...EFFORT_LEVELS, ...Object.keys(EFFORT_SHORTHANDS)]
  .filter((v, i, a) => a.indexOf(v) === i)

function completeSegment(typed: string, candidates: string[]): string {
  if (!typed) return ''
  const match = candidates.find(c => c.startsWith(typed) && c !== typed)
  return match ? match.slice(typed.length) : ''
}

function getGhostCompletion(input: string, projects: string[], catName: string): string {
  const defaults = [projects[0] || 'doc', catName, DEFAULT_MODEL, DEFAULT_EFFORT]
  if (!input) return defaults.join(':')

  const parts = input.split(':')
  const lastPart = parts[parts.length - 1]
  const pos = parts.length // 1-based: 1=project, 2=name, 3=model, 4=effort

  let segCompletion = ''
  if (!lastPart) {
    segCompletion = defaults[pos - 1] || ''
  } else if (pos === 1) {
    segCompletion = completeSegment(lastPart, projects)
  } else if (pos === 2) {
    segCompletion = completeSegment(lastPart, CAT_NAMES)
  } else if (pos === 3) {
    segCompletion = completeSegment(lastPart, ALL_COMPLETABLE)
  } else if (pos === 4) {
    segCompletion = completeSegment(lastPart, ALL_EFFORT_COMPLETABLE)
  }

  const remaining = defaults.slice(pos)
  if (remaining.length > 0) {
    return segCompletion + ':' + remaining.join(':')
  }
  return segCompletion
}

const SEG_LABELS = ['project', 'name', 'model', 'effort']

// Candidate list for the segment the cursor is currently in (the last colon-part).
// Shows canonical values only (not shorthand aliases) so the dropdown stays readable.
function getSegmentCandidates(input: string, projects: string[]): { pos: number; prefix: string; candidates: string[] } {
  const parts = input.split(':')
  const pos = parts.length // 1=project, 2=name, 3=model, 4=effort
  const prefix = parts[parts.length - 1]
  let pool: string[] = []
  if (pos === 1) pool = projects
  else if (pos === 2) pool = CAT_NAMES
  else if (pos === 3) pool = ALL_MODELS
  else if (pos === 4) pool = EFFORT_LEVELS
  const lower = prefix.toLowerCase()
  const candidates = prefix
    ? pool.filter(c => c.toLowerCase().startsWith(lower) && c !== prefix)
    : pool
  return { pos, prefix, candidates }
}

// Replace the current (last) segment's typed prefix with the chosen candidate.
function applyCandidate(input: string, candidate: string): string {
  const parts = input.split(':')
  parts[parts.length - 1] = candidate
  return parts.join(':')
}

// --- Nick color system (shared with FleetChatShape) ---
const NICK_COLORS = ['#7a9ec8', '#9370db', '#c8956a', '#6aafb0', '#b87a95', '#c8b060']
const nickMap = new Map<string, string>()
let nickIdx = 0

function getNickColor(id: string, isManager?: boolean): string {
  if (isManager) return '#7ab8a0'
  if (!id) return NICK_COLORS[0]
  if (!nickMap.has(id)) {
    nickMap.set(id, NICK_COLORS[nickIdx % NICK_COLORS.length])
    nickIdx++
  }
  return nickMap.get(id)!
}

// --- Label colors (matches dashboard hash) ---
const LABEL_COLORS = ['#9370db', '#7ab8a0', '#c8b060', '#7a9ec8', '#c8956a', '#6aafb0', '#b87a95', '#8bc87a']
function labelColor(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = ((h << 5) - h + name.charCodeAt(i)) | 0
  return LABEL_COLORS[Math.abs(h) % LABEL_COLORS.length]
}

type SortKey = 'active' | 'name' | 'status'

function agentCategory(agent: any): 'awake' | 'hibernating' {
  if (agent.status === 'human') return 'awake'
  if (agent.status === 'human-away') return 'hibernating'
  return agent.status === 'awake' ? 'awake' : 'hibernating'
}

function formatModel(model: string | null | undefined): string {
  if (!model) return ''
  const m = model.match(/claude-(\w+)-(\d+)-(\d+)/)
  if (!m) return model.replace('claude-', '')
  return `${m[1]}${m[2]}${m[3]}`
}

function formatEffort(effort: string): string {
  return `${effort} effort`
}


// agentDisplayName imported from ./fleet-utils — single source of truth so the
// panel and the chat target chip can't drift.

function formatRelativeTime(ts: number | undefined): string {
  if (!ts) return ''
  const delta = Date.now() - ts
  if (delta < 60_000) return 'now'
  if (delta < 3600_000) return `${Math.floor(delta / 60_000)}m`
  if (delta < 86400_000) return `${Math.floor(delta / 3600_000)}h`
  return `${Math.floor(delta / 86400_000)}d`
}

// --- Shape definition ---

export class FleetAgentsShapeUtil extends BaseBoxShapeUtil<any> {
  static override type = 'fleet-agents' as const
  static override props = {
    w: T.number,
    h: T.number,
    userId: T.optional(T.string),
  }

  getDefaultProps() {
    return { w: DEFAULT_W, h: DEFAULT_H, userId: '' }
  }

  override canEdit = () => false
  override canResize = () => true
  override canBind = () => false
  override hideRotateHandle = () => true

  component(shape: any) {
    return <FleetAgentsComponent shape={shape} />
  }

  indicator() {
    return null
  }
}

// --- Drag-to-create-pill handler ---

interface DragState {
  pillId: string | null
  pillType: 'agent' | 'label'
  value: string
  displayName: string
  color: string
  startX: number
  startY: number
  started: boolean
}

const DRAG_THRESHOLD = 5

function usePillDrag() {
  const editor = useEditor()
  const dragRef = useRef<DragState | null>(null)

  const startDrag = useCallback((
    e: React.PointerEvent,
    pillType: 'agent' | 'label',
    value: string,
    displayName: string,
    color: string,
  ) => {
    stopEventPropagation(e)
    e.preventDefault()
    dragRef.current = {
      pillId: null, pillType, value, displayName, color,
      startX: e.clientX, startY: e.clientY, started: false,
    }

    // Claim the shared drag coordinator — one global listener pair handles
    // move/up events, eliminating capture-phase registration races.
    dragCoordinator.claim(
      // onMove
      (ev: PointerEvent) => {
        const drag = dragRef.current
        if (!drag) return

        const dx = ev.clientX - drag.startX
        const dy = ev.clientY - drag.startY

        if (!drag.started) {
          if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return
          drag.started = true

          const pagePos = editor.screenToPage({ x: ev.clientX, y: ev.clientY })
          const measureEl = document.createElement('span')
          measureEl.style.cssText = "position:absolute;visibility:hidden;font:500 9px 'SF Mono',Menlo,Consolas,monospace;white-space:nowrap;padding:1px 6px;border:1px solid transparent"
          measureEl.textContent = drag.displayName
          document.body.appendChild(measureEl)
          const pw = measureEl.offsetWidth
          const ph = measureEl.offsetHeight
          document.body.removeChild(measureEl)
          const pillId = createShapeId()
          editor.run(() => {
            editor.createShape({
              id: pillId,
              type: 'fleet-pill' as any,
              x: pagePos.x - pw / 2,
              y: pagePos.y - ph / 2,
              props: { w: pw, h: ph, pillType: drag.pillType, value: drag.value, displayName: drag.displayName, color: drag.color },
            })
          }, { history: 'ignore' })
          drag.pillId = pillId as unknown as string
          editor.cancel()
          return
        }

        if (drag.pillId) {
          const pagePos = editor.screenToPage({ x: ev.clientX, y: ev.clientY })
          const pillShape = editor.getShape(drag.pillId as any) as any
          const pw = pillShape?.props?.w || 70
          const ph = pillShape?.props?.h || 18
          editor.run(() => {
            editor.updateShape({
              id: drag.pillId as any,
              type: 'fleet-pill' as any,
              x: pagePos.x - pw / 2,
              y: pagePos.y - ph / 2,
            })
          }, { history: 'ignore' })
        }
      },
      // onUp
      (ev: PointerEvent) => {
        const drag = dragRef.current
        dragRef.current = null
        if (!drag || !drag.started || !drag.pillId) return

        const pagePos = editor.screenToPage({ x: ev.clientX, y: ev.clientY })
        dropPillOnTarget(editor, drag.pillId as any, drag.value, pagePos)
        editor.run(() => {
          try { editor.deleteShapes([drag.pillId as any]) } catch {}
        }, { history: 'ignore' })
      },
    )
  }, [editor])

  return { startDrag }
}


// Fetch last message per agent from search API (batched, cached)
const lastMessageCache = new Map<string, { text: string; ts: number; fetched: number }>()

async function fetchLastMessage(agentName: string): Promise<{ text: string; ts: number } | null> {
  const cached = lastMessageCache.get(agentName)
  if (cached && Date.now() - cached.fetched < 30_000) return cached
  // /api/logs/search doesn't exist on the unified server yet — skip to avoid 404 spam
  return null
  try {
    // Search for the agent name — the API does FTS, then we filter client-side
    const results = await searchFleet(agentName, 20)
    // Find messages actually from this agent
    const fromAgent = results.filter((r: any) => {
      const fromName = (r.from || '').replace('fleet:', '')
      return fromName === agentName || fromName.includes(agentName)
    })
    const match = fromAgent[0] || results[0]
    if (match) {
      const text = (match.snippet || match.text || match.message || match.body || '').replace(/<[^>]*>/g, '').replace(/[⟨⟩]{2}/g, '').replace(/\s+/g, ' ').trim()
      const ts = match.timestamp ? new Date(match.timestamp).getTime() : Date.now()
      const entry = { text, ts, fetched: Date.now() }
      lastMessageCache.set(agentName, entry)
      return entry
    }
  } catch {}
  return null
}

function useLastMessages(agents: any[]): Record<string, string> {
  const [messages, setMessages] = useState<Record<string, string>>({})

  useEffect(() => {
    let mounted = true
    const names = agents.map(a => agentDisplayName(a, agents))
    Promise.all(names.map(async (name) => {
      const msg = await fetchLastMessage(name)
      return [name, msg?.text || ''] as const
    })).then(pairs => {
      if (!mounted) return
      const map: Record<string, string> = {}
      for (const [name, text] of pairs) if (text) map[name] = text
      setMessages(map)
    })
    return () => { mounted = false }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents.length])

  return messages
}

function FleetAgentsInner({ shape }: { shape: any }) {
  const editor = useEditor()
  const { w, h } = shape.props
  const containerRef = useRef<HTMLDivElement>(null)
  const isSelectedRef = useRef(false)
  isSelectedRef.current = useValue('isSelected', () => editor.getSelectedShapeIds().includes(shape.id), [editor, shape.id])

  // Capture-phase pointerdown: fires before tldraw's tl-container listener
  // can intercept. Marks non-drag clicks as handled so tldraw skips
  // setPointerCapture (which would steal the event from shape content).
  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    function onPointerDown(e: PointerEvent) {
      const target = e.target as HTMLElement
      if (!el!.contains(target)) return
      // If shape is selected for drag/resize, let tldraw handle everything
      if (isSelectedRef.current) return
      // Let pill-drag elements handle their own events (they call stopEventPropagation)
      const isDraggable = target.closest('.fleet-agents-pill, .fleet-agents-label-chip')
      if (isDraggable) return
      // Mark handled on BOTH this editor and the main editor — each editor
      // tracks handled events independently, and the main editor's capture
      // listener fires before the overlay editor's (higher in DOM tree).
      editor.markEventAsHandled(e)
    }

    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [editor])

  const frameId = shape.parentId as string | undefined
  const agents = useFleetAgents(frameId)
  const tasks = useFleetTasks(frameId)
  const { startDrag } = usePillDrag()
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [sortKey, setSortKey] = useState<SortKey>('active')
  const [sortAsc, setSortAsc] = useState(false)

  // Spawn input — always visible, fetches projects for autocomplete
  const currentDoc = useMemo(() => new URLSearchParams(window.location.search).get('doc') || '', [])
  const [spawnDoc, setSpawnDoc] = useState(currentDoc)
  const [projectList, setProjectList] = useState<string[]>([])
  const [catName] = useState(() => CAT_NAMES[Math.floor(Math.random() * CAT_NAMES.length)])
  const spawnInputRef = useRef<HTMLInputElement>(null)
  const [spawnFocused, setSpawnFocused] = useState(false)
  const [dropdownIdx, setDropdownIdx] = useState(-1) // -1 = nothing highlighted
  const [dropdownDismissed, setDropdownDismissed] = useState(false)
  const { pos: segPos, candidates: segCandidates } = useMemo(
    () => getSegmentCandidates(spawnDoc, projectList),
    [spawnDoc, projectList],
  )
  const dropdownOpen = spawnFocused && !dropdownDismissed && segCandidates.length > 0
  const acceptCandidate = useCallback((candidate: string) => {
    setSpawnDoc(applyCandidate(spawnDoc, candidate))
    setDropdownIdx(-1)
    setDropdownDismissed(true)
    spawnInputRef.current?.focus()
  }, [spawnDoc])
  useEffect(() => {
    fetch('/api/projects').then(r => r.ok ? r.json() : { projects: [] }).then((data: any) => {
      const projects = Array.isArray(data) ? data : (data.projects || [])
      setProjectList(projects.map((p: any) => p.name).sort())
    }).catch(e => console.warn('[fleet-agents] projects fetch failed:', e.message))
  }, [])

  // Build task lookup: agent id → active task
  const activeTasks = useMemo(() => {
    return tasks.filter((t: any) => t.status === 'pending' || t.status === 'in_progress')
  }, [tasks])

  const getTasksForAgent = useCallback((agentId: string): any[] => {
    const shortId = agentId.replace(/-.*$/, '')
    const matches = activeTasks.filter((t: any) => {
      const assignee = t.agent || t.assignee || ''
      if (assignee === agentId) return true
      return assignee.replace(/-.*$/, '') === shortId
    })
    // Prefer non-synthetic tasks, but include all
    return matches.length > 0 ? matches : []
  }, [activeTasks])

  // Per-agent state for the "Active" sort: the agent's current *displayed* time
  // bucket ("now"/"1m"/"2m"/…) and WHEN it entered it. The Active sort is a stable
  // sort keyed on that displayed bucket — agents in the same bucket keep their
  // order (no reshuffling while everyone reads "now"), and an agent only moves
  // when its displayed value actually ticks over, jumping to the TOP of the new
  // bucket.
  const bandStateRef = useRef<Map<string, { band: string; enteredAt: number }>>(new Map())

  const sortedAgents = useMemo(() => {
    const now = Date.now()
    const liveIds = new Set<string>()
    const list: any[] = []
    for (const a of agents) {
      if (a.dead) continue
      const ts = a.last_active ? new Date(a.last_active).getTime() : 0
      // The band IS the displayed time bucket — same value the row shows.
      const band = formatRelativeTime(ts)
      liveIds.add(a.id)
      const prev = bandStateRef.current.get(a.id)
      if (!prev || prev.band !== band) bandStateRef.current.set(a.id, { band, enteredAt: now })
      const enteredAt = bandStateRef.current.get(a.id)!.enteredAt
      list.push({ ...a, _ts: ts, _band: band, _bandEnteredAt: enteredAt })
    }
    // Drop state for agents that have left the list so the map doesn't grow.
    for (const id of bandStateRef.current.keys()) if (!liveIds.has(id)) bandStateRef.current.delete(id)
    const dir = sortAsc ? 1 : -1
    list.sort((a, b) => {
      if (sortKey === 'name') return dir * agentDisplayName(a, agents).localeCompare(agentDisplayName(b, agents))
      if (sortKey === 'status') {
        const order: Record<string, number> = { awake: 0, hibernating: 1 }
        const ca = order[agentCategory(a)] ?? 2
        const cb = order[agentCategory(b)] ?? 2
        return dir * (ca - cb) || b._ts - a._ts
      }
      // "Active": stable sort keyed on the displayed time bucket. Different
      // buckets order by recency (the coarse continuum); within the SAME bucket,
      // keep order stable by entry time, so a freshly-jumped agent lands on top
      // and nothing else reshuffles while the display is identical.
      if (a._band !== b._band) return dir * (a._ts - b._ts)
      return dir * (a._bandEnteredAt - b._bandEnteredAt)
    })
    return list
  }, [agents, sortKey, sortAsc])

  const hibernatingCount = useMemo(() => sortedAgents.filter(a => agentCategory(a) === 'hibernating').length, [sortedAgents])
  const awakeCount = sortedAgents.length - hibernatingCount

  // Fetch last messages for visible agents
  const lastMessages = useLastMessages(sortedAgents)

  const unreadCounts = useFleetUnreadCounts()
  const contextPercent = useFleetContext(null, frameId)

  // Clean up any permanent pill shapes that were children of this panel (legacy)
  const cleanedRef = useRef(false)
  if (!cleanedRef.current) {
    cleanedRef.current = true
    const orphanPills = editor.getCurrentPageShapes()
      .filter((s: any) => s.type === 'fleet-pill' && s.parentId === shape.id)
    if (orphanPills.length > 0) {
      editor.deleteShapes(orphanPills.map((s: any) => s.id))
    }
  }

  return (
    <HTMLContainer
      style={{
        width: w,
        height: h,
        pointerEvents: 'all',
        overflow: 'hidden',
      }}
    >
      <div
        ref={containerRef}
        className="fleet-shape fleet-agents-shape"
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          borderRadius: 0,
          fontSize: 9,
          overflow: 'hidden',
          fontFamily: "'SF Mono', 'Menlo', 'Consolas', monospace",
          position: 'relative',
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

        {/* Header with sort toggle */}
        <div
          className="fleet-agents-header"
          onPointerDown={(e) => stopEventPropagation(e)}
        >
          <span className="fleet-agents-unread-dot" />
          <span style={{ width: 18, flexShrink: 0 }} />
          <span className="fleet-agents-col-name fleet-agents-sort-header"
            onPointerUp={(e) => { e.stopPropagation(); if (sortKey === 'name') setSortAsc(p => !p); else { setSortKey('name'); setSortAsc(false) } }}
            style={{ cursor: 'pointer' }}
          >Agent {sortKey === 'name' ? (sortAsc ? '▴' : '▾') : ''}</span>
          <span className="fleet-agents-col-seen fleet-agents-sort-header"
            onPointerUp={(e) => { e.stopPropagation(); if (sortKey === 'active') setSortAsc(p => !p); else { setSortKey('active'); setSortAsc(false) } }}
            style={{ cursor: 'pointer' }}
          >Active {sortKey === 'active' ? (sortAsc ? '▴' : '▾') : ''}</span>
          <span className="fleet-agents-col-ctx">Ctx</span>
          <span className="fleet-agents-col-task fleet-agents-sort-header"
            onPointerUp={(e) => { e.stopPropagation(); if (sortKey === 'status') setSortAsc(p => !p); else { setSortKey('status'); setSortAsc(false) } }}
            style={{ cursor: 'pointer' }}
          >Task {sortKey === 'status' ? (sortAsc ? '▴' : '▾') : ''}</span>
          <span className="fleet-agents-col-labels">Labels</span>
        </div>

        {/* Agent rows — scrollable flat list */}
        <div className="fleet-agents-body">
          {sortedAgents.length === 0 ? (
            <div className="fleet-agents-empty">No agents</div>
          ) : sortedAgents.map((agent: any) => (
            <AgentRow
              key={agent.id}
              agent={agent}
              allAgents={agents}
              tasks={getTasksForAgent(agent.id)}
              unreadCount={unreadCounts[agent.id] || 0}
              contextPct={contextPercent.get(agent.id)}
              dimmed={agentCategory(agent) === 'hibernating'}
              expanded={expandedId === agent.id}
              lastMessage={lastMessages[agentDisplayName(agent, agents)] || ''}
              onToggleExpand={() => setExpandedId(expandedId === agent.id ? null : agent.id)}
              onStartDrag={startDrag}
            />
          ))}
        </div>

        {/* Footer */}
        <div className="fleet-agents-footer">
          <span>
            <span
              style={{ cursor: 'grab' }}
              onPointerDown={(e) => { e.stopPropagation(); startDrag(e, 'label', 'awake', 'awake', labelColor('awake')) }}
            >{awakeCount} awake</span>
            {hibernatingCount > 0 && (
              <span style={{ marginLeft: 6 }}>·{' '}
                <span
                  style={{ cursor: 'grab' }}
                  onPointerDown={(e) => { e.stopPropagation(); startDrag(e, 'label', 'hibernating', 'hibernating', labelColor('hibernating')) }}
                >{hibernatingCount} hibernating</span>
              </span>
            )}
          </span>
          <span className="fleet-agents-spawn-btns" onPointerDown={(e) => e.stopPropagation()}>
            <span className="fleet-agents-spawn-input-wrap">
              <input
                ref={spawnInputRef}
                className="fleet-agents-spawn-search"
                value={spawnDoc}
                onFocus={() => setSpawnFocused(true)}
                onBlur={() => { setSpawnFocused(false); setDropdownIdx(-1) }}
                onChange={(e) => { setSpawnDoc(e.target.value); setDropdownIdx(-1); setDropdownDismissed(false) }}
                onKeyDown={(e) => {
                  e.stopPropagation()
                  if (e.key === 'ArrowDown') {
                    e.preventDefault()
                    setDropdownDismissed(false)
                    if (segCandidates.length) setDropdownIdx(i => Math.min(i + 1, segCandidates.length - 1))
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault()
                    setDropdownIdx(i => Math.max(i - 1, -1))
                  } else if (e.key === 'Escape') {
                    if (dropdownOpen) { e.preventDefault(); setDropdownDismissed(true); setDropdownIdx(-1) }
                  } else if (e.key === 'Tab') {
                    if (dropdownOpen && dropdownIdx >= 0) {
                      e.preventDefault()
                      acceptCandidate(segCandidates[dropdownIdx])
                    } else {
                      const ghost = getGhostCompletion(spawnDoc, projectList, catName)
                      if (ghost) { e.preventDefault(); setSpawnDoc(spawnDoc + ghost); setDropdownDismissed(true) }
                    }
                  } else if (e.key === 'Enter') {
                    e.preventDefault()
                    if (dropdownOpen && dropdownIdx >= 0) {
                      acceptCandidate(segCandidates[dropdownIdx])
                    } else {
                      const { doc, name, model, effort } = parseSpawnInput(spawnDoc)
                      spawnAgent(model || DEFAULT_MODEL, doc || undefined, name, effort || DEFAULT_EFFORT)
                    }
                  }
                }}
                placeholder=""
              />
              <span className="fleet-agents-spawn-ghost"><span style={{ visibility: 'hidden' }}>{spawnDoc}</span>{getGhostCompletion(spawnDoc, projectList, catName)}</span>
              {dropdownOpen && (
                <ul className="fleet-agents-spawn-dropdown" onPointerDown={(e) => e.stopPropagation()}>
                  <li className="fleet-agents-spawn-dropdown-label">{SEG_LABELS[segPos - 1]}</li>
                  {segCandidates.map((c, i) => (
                    <li
                      key={c}
                      className={'fleet-agents-spawn-dropdown-item' + (i === dropdownIdx ? ' is-active' : '')}
                      onMouseEnter={() => setDropdownIdx(i)}
                      onMouseDown={(e) => { e.preventDefault(); acceptCandidate(c) }}
                    >{c}</li>
                  ))}
                </ul>
              )}
            </span>
            <button
              className="fleet-agents-spawn-btn"
              title="Spawn agent"
              onPointerUp={(e) => {
                e.stopPropagation()
                const { doc, name, model, effort } = parseSpawnInput(spawnDoc)
                spawnAgent(model || DEFAULT_MODEL, doc || undefined, name, effort || DEFAULT_EFFORT)
              }}
            >+</button>
          </span>
        </div>
      </div>
    </HTMLContainer>
  )
}

const FleetAgentsComponent = memo(function FleetAgentsComponent({ shape }: { shape: any }) {
  const { w, h } = shape.props as { w: number; h: number }
  const isInViewport = useIsInViewport(shape.id)
  if (!isInViewport) {
    return <HTMLContainer id={shape.id}><div style={{ width: w, height: h }} /></HTMLContainer>
  }
  return <FleetAgentsInner shape={shape} />
}, (prev, next) => prev.shape.props === next.shape.props)

function AgentRow({
  agent,
  allAgents,
  tasks,
  dimmed,
  unreadCount,
  contextPct,
  expanded,
  lastMessage,
  onToggleExpand,
  onStartDrag,
}: {
  agent: any
  allAgents: any[]
  tasks: any[]
  dimmed?: boolean
  unreadCount: number
  contextPct?: number
  expanded: boolean
  lastMessage: string
  onToggleExpand: () => void
  onStartDrag: (e: React.PointerEvent, pillType: 'agent' | 'label', value: string, displayName: string, color: string) => void
}) {
  const firstTask = tasks[0]
  const taskDesc = firstTask?.title || firstTask?.description || ''
  const name = agentDisplayName(agent, allAgents)
  const color = getNickColor(agent.id, agent.is_manager)
  const labels: string[] = agent.labels || []
  const ago = formatRelativeTime(agent._ts)
  const meta = agent.metadata || {}
  const modelStr = formatModel(meta.model)
  const effortStr = formatEffort(meta.effort || 'medium')

  const secsAgo = agent._ts ? (Date.now() - agent._ts) / 1000 : Infinity
  const nameOpacity = secsAgo < 120 ? 1.0 : secsAgo < 600 ? 0.85 : 0.65

  return (
    <div className={`fleet-agents-row${dimmed ? ' dimmed' : ''}${expanded ? ' expanded' : ''}`}>
      {/* Line 1: compact row */}
      <div
        className="fleet-agents-row-main"
        onPointerDown={(e) => stopEventPropagation(e)}
        onPointerUp={(e) => {
          e.stopPropagation()
          onToggleExpand()
        }}
      >
        <span className={`fleet-agents-unread-dot${unreadCount > 0 ? ' active' : ''}`} />

        {/* Hibernate button — shown on hover, kills session but keeps agent in panel */}
        <span
          className="fleet-agents-kill-btn"
          onPointerDown={(e) => e.stopPropagation()}
          onPointerUp={(e) => { e.stopPropagation(); hibernateSession(agent.id) }}
          title="Hibernate agent"
        >
          ×
        </span>

        {/* Agent name — draggable, with phase icon for dawn/dusk */}
        <span
          className="fleet-agents-col-name fleet-agents-pill"
          style={{ color, opacity: nameOpacity, display: 'flex', alignItems: 'center' }}
          onPointerDown={(e) => { e.stopPropagation(); onStartDrag(e, 'agent', agent.friendly_name || name, name, color) }}
        >
          {/* Fixed-width glyph slot (blank for dawn) so base names column-align */}
          <AgentName name={agent.friendly_name} slotWidth={15} />
        </span>

        <span className="fleet-agents-col-seen">{ago}</span>

        <span
          className="fleet-agents-col-ctx"
          style={contextPct != null ? { color: contextPct <= 15 ? '#e57373' : contextPct <= 30 ? '#ffb74d' : '#81c784' } : undefined}
        >
          {contextPct != null ? `${contextPct}%` : ''}
        </span>

        <span className="fleet-agents-col-task" title={taskDesc}>
          {taskDesc ? taskDesc.substring(0, 50) : ''}
        </span>

        {/* Labels — draggable chips */}
        <span className="fleet-agents-col-labels" onPointerDown={(e) => e.stopPropagation()}>
          {labels.map((label: string) => (
            <span
              key={label}
              className="fleet-agents-label-chip"
              style={{ background: labelColor(label) }}
              onPointerDown={(e) => onStartDrag(e, 'label', label, label, labelColor(label))}
            >
              {label}
            </span>
          ))}
        </span>
      </div>

      {/* Expanded detail: first task inline with model/effort, remaining tasks, last message */}
      {expanded && (
        <div className="fleet-agents-row-detail" onPointerDown={(e) => stopEventPropagation(e)}>
          <div className="fleet-agents-detail-task fleet-agents-detail-firstrow">
            {modelStr && <span className="fleet-agents-detail-model">{modelStr}</span>}
            {effortStr && <span className="fleet-agents-detail-effort">{effortStr}</span>}
            <span>
              {tasks.length === 0
                ? '(no task)'
                : tasks[0].title || tasks[0].description || '(untitled task)'}
            </span>
          </div>
          {tasks.slice(1).map((t: any, i: number) => (
            <div key={t.id || i} className="fleet-agents-detail-task">
              {t.title || t.description || '(untitled task)'}
            </div>
          ))}
          {lastMessage && (
            <div className="fleet-agents-detail-message">
              "{lastMessage.length > 80 ? lastMessage.substring(0, 80) + '…' : lastMessage}"
            </div>
          )}
        </div>
      )}
    </div>
  )
}
